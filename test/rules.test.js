import { test } from "node:test";
import assert from "node:assert/strict";
import {
  canAct, compareValue, computeSnapshot, dayInTimezone, dedupeMetricRows, describeTrigger, evaluateRule,
  formatMetricValue, shiftDay, validateRuleInput
} from "../src/rulesEngine.js";

const TODAY = "2026-11-10";
const campaign = { id: "c1", name: "Campanha A", created_day: "2026-10-01", start_date: "2026-10-01", current_balance: null };
const m = (day, over = {}) => ({ campaign_id: "c1", report_date: day, amount_spent: 100, impressions: 10000, clicks: 200, source: "manual", ...over });
const lead = (day, status = "novo") => ({ created_day: day, status });

test("datas: fuso de São Paulo e deslocamento de dias", () => {
  // 02:00 UTC de 10/11 ainda é 09/11 em São Paulo (UTC-3)
  assert.equal(dayInTimezone(new Date("2026-11-10T02:00:00Z"), "America/Sao_Paulo"), "2026-11-09");
  assert.equal(dayInTimezone(new Date("2026-11-10T12:00:00Z"), "America/Sao_Paulo"), "2026-11-10");
  assert.equal(shiftDay("2026-11-01", -1), "2026-10-31");
  assert.equal(shiftDay("2026-12-31", 1), "2027-01-01");
});

test("dedupe: dia com linha da Meta ignora o manual do mesmo dia", () => {
  const rows = [m("2026-11-09", { source: "manual", amount_spent: 100 }), m("2026-11-09", { source: "meta_api", amount_spent: 90 }), m("2026-11-08")];
  assert.equal(dedupeMetricRows(rows).length, 2);
  const rows2 = [m("2026-11-09")];
  assert.equal(dedupeMetricRows(rows2), rows2);
});

test("snapshot: janela, CPL pelos leads do funil, taxas a partir das somas", () => {
  const snap = computeSnapshot({
    campaign, today: TODAY, windowDays: 3,
    metricRows: [m("2026-11-10"), m("2026-11-09"), m("2026-11-08"), m("2026-11-05", { amount_spent: 999 })], // o último fica fora
    leadRows: [lead("2026-11-10"), lead("2026-11-09", "qualificado"), lead("2026-11-08", "quente"), lead("2026-11-01")]
  });
  assert.equal(snap.spend, 300);
  assert.equal(snap.leads, 3);
  assert.equal(snap.qualified, 2);
  assert.equal(snap.cpl, 100);
  assert.equal(snap.costPerQualified, 150);
  assert.equal(snap.ctr, 2);       // 600 / 30000
  assert.equal(snap.cpc, 0.5);     // 300 / 600
  assert.equal(snap.daysWithoutLeads, 0);
});

test("snapshot: dias sem leads usa o último lead, ou o início da campanha", () => {
  const a = computeSnapshot({ campaign, today: TODAY, windowDays: 3, metricRows: [], leadRows: [lead("2026-11-06")] });
  assert.equal(a.daysWithoutLeads, 4);
  const b = computeSnapshot({ campaign: { ...campaign, start_date: "2026-11-05" }, today: TODAY, windowDays: 3, metricRows: [], leadRows: [] });
  assert.equal(b.daysWithoutLeads, 5);
  // lead anterior ao início da campanha não conta como referência
  const c = computeSnapshot({ campaign: { ...campaign, start_date: "2026-11-05" }, today: TODAY, windowDays: 3, metricRows: [], leadRows: [lead("2026-10-01")] });
  assert.equal(c.daysWithoutLeads, 5);
});

test("snapshot: saldo = último lançamento com saldo, senão o cadastrado", () => {
  const withMetric = computeSnapshot({ campaign: { ...campaign, current_balance: 500 }, today: TODAY, windowDays: 3, leadRows: [],
    metricRows: [m("2026-11-01", { remaining_balance: "300" }), m("2026-11-08", { remaining_balance: "120.5" }), m("2026-11-09", { remaining_balance: null })] });
  assert.equal(withMetric.balance, 120.5);
  const fallback = computeSnapshot({ campaign: { ...campaign, current_balance: 500 }, today: TODAY, windowDays: 3, leadRows: [], metricRows: [m("2026-11-09")] });
  assert.equal(fallback.balance, 500);
  assert.equal(computeSnapshot({ campaign, today: TODAY, windowDays: 3, leadRows: [], metricRows: [] }).balance, null);
});

test("operadores", () => {
  assert.equal(compareValue(5, ">", 4), true);
  assert.equal(compareValue(4, ">", 4), false);
  assert.equal(compareValue(4, ">=", 4), true);
  assert.equal(compareValue(3, "<", 4), true);
  assert.equal(compareValue(4, "<=", 4), true);
  assert.equal(compareValue(Infinity, ">", 1000), true);
  assert.equal(compareValue(1, "!=", 1), false);
});

const snapWith = (over) => ({ spend: 0, impressions: 0, clicks: 0, leads: 0, qualified: 0, cpl: null, costPerQualified: null, ctr: null, cpc: null, daysWithoutLeads: 0, balance: null, ...over });

test("CPL alto dispara; sem evidência mínima de gasto NÃO avalia", () => {
  const rule = { name: "CPL alto", metric: "cpl", operator: ">", threshold: 50, min_spend: 100 };
  assert.deepEqual(evaluateRule(rule, snapWith({ spend: 300, leads: 3, cpl: 100 })), { evaluable: true, triggered: true, value: 100 });
  assert.equal(evaluateRule(rule, snapWith({ spend: 300, leads: 10, cpl: 30 })).triggered, false);
  const low = evaluateRule(rule, snapWith({ spend: 40, leads: 0 }));
  assert.equal(low.evaluable, false);
  assert.match(low.reason, /abaixo do mínimo/);
});

test("gasto alto com ZERO leads: CPL é infinito (dispara '>' e não dispara '<')", () => {
  const gt = evaluateRule({ metric: "cpl", operator: ">", threshold: 50, min_spend: 100 }, snapWith({ spend: 200, leads: 0 }));
  assert.equal(gt.triggered, true);
  assert.equal(gt.value, Infinity);
  const lt = evaluateRule({ metric: "cpl", operator: "<", threshold: 50, min_spend: 100 }, snapWith({ spend: 200, leads: 0 }));
  assert.equal(lt.triggered, false);
  // sem gasto nenhum e sem leads: nada a avaliar
  assert.equal(evaluateRule({ metric: "cpl", operator: ">", threshold: 50, min_spend: 0 }, snapWith({})).evaluable, false);
});

test("'leads <= 0' só dispara com gasto: campanha ativa sem investimento não é 'gasto sem leads'", () => {
  const rule = { name: "Gasto sem leads", metric: "leads", operator: "<=", threshold: 0, min_spend: 50 };
  assert.equal(evaluateRule(rule, snapWith({ spend: 0, leads: 0 })).evaluable, false);
  assert.equal(evaluateRule(rule, snapWith({ spend: 20, leads: 0 })).evaluable, false);
  assert.deepEqual(evaluateRule(rule, snapWith({ spend: 80, leads: 0 })), { evaluable: true, triggered: true, value: 0 });
  assert.equal(evaluateRule(rule, snapWith({ spend: 80, leads: 3 })).triggered, false);
});

test("saldo baixo e dias sem leads não dependem de gasto mínimo", () => {
  assert.equal(evaluateRule({ metric: "balance", operator: "<", threshold: 100, min_spend: 500 }, snapWith({ balance: 80 })).triggered, true);
  assert.equal(evaluateRule({ metric: "balance", operator: "<", threshold: 100 }, snapWith({ balance: null })).evaluable, false);
  assert.equal(evaluateRule({ metric: "days_without_leads", operator: ">=", threshold: 3 }, snapWith({ daysWithoutLeads: 4 })).triggered, true);
});

test("métrica desconhecida não avalia", () => {
  assert.equal(evaluateRule({ metric: "foo", operator: ">", threshold: 1 }, snapWith({})).evaluable, false);
});

test("cooldown e limite diário", () => {
  const rule = { cooldown_hours: 24, max_actions_per_day: 2 };
  const now = new Date("2026-11-10T12:00:00Z");
  assert.equal(canAct(rule, { lastActionAt: null, actionsLast24h: 0, now }).ok, true);
  assert.deepEqual(canAct(rule, { lastActionAt: "2026-11-10T00:00:00Z", actionsLast24h: 1, now }), { ok: false, reason: "em cooldown" });
  assert.equal(canAct(rule, { lastActionAt: "2026-11-08T00:00:00Z", actionsLast24h: 1, now }).ok, true);
  assert.match(canAct(rule, { lastActionAt: null, actionsLast24h: 2, now }).reason, /limite diário/);
});

test("mensagens legíveis", () => {
  assert.equal(formatMetricValue("cpl", 12.5), "R$ 12,50");
  assert.equal(formatMetricValue("ctr", 1.234), "1,23%");
  assert.equal(formatMetricValue("cpl", Infinity), "sem leads (∞)");
  const msg = describeTrigger({ name: "CPL alto", metric: "cpl", operator: ">", threshold: 50 }, 80, "Campanha A", 3);
  assert.match(msg, /CPL nos últimos 3 dia\(s\) = R\$ 80,00 \(> R\$ 50,00\)/);
});

test("validação: aplica padrões seguros (notificar, cooldown 24h, máx. 3/dia)", () => {
  const r = validateRuleInput({ name: " CPL alto ", metric: "cpl", operator: ">", threshold: "50" });
  assert.equal(r.ok, true);
  assert.deepEqual(r.value, { name: "CPL alto", metric: "cpl", operator: ">", threshold: 50, window_days: 3, cooldown_hours: 24, max_actions_per_day: 3, min_spend: 0, action: "notify", campaign_id: null });
});

test("validação: rejeita entradas inválidas com mensagens claras", () => {
  const r = validateRuleInput({ name: "", metric: "foo", operator: "=", threshold: "abc", window_days: 99, action: "delete", campaign_id: "x", max_actions_per_day: 0 });
  assert.equal(r.ok, false);
  assert.equal(r.errors.length, 8);
  assert.equal(validateRuleInput({ name: "x", metric: "cpl", operator: ">", threshold: "" }).ok, false);
});

test("validação parcial só confere o que veio (PATCH)", () => {
  assert.deepEqual(validateRuleInput({ is_active: false }, { partial: true }), { ok: true, value: { is_active: false } });
  assert.equal(validateRuleInput({ threshold: "x" }, { partial: true }).ok, false);
  assert.equal(validateRuleInput({ is_active: "sim" }, { partial: true }).ok, false);
});
