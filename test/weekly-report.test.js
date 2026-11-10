import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_ATTEMPTS_PER_DAY, buildWeeklyReport, cleanSubject, escapeHtml, isDue, localParts, renderReportEmail, reportWindow, validateScheduleInput } from "../src/weeklyReport.js";
import { EmailError, emailConfig, sendEmail } from "../src/emailSender.js";

const NOW = new Date("2026-11-09T12:00:00Z"); // segunda-feira 09:00 em São Paulo
const WIN = reportWindow(NOW);

test("partes locais: fuso de São Paulo, dia da semana ISO", () => {
  assert.deepEqual(localParts(NOW), { day: "2026-11-09", weekday: 1, hour: 9 });
  assert.deepEqual(localParts(new Date("2026-11-09T02:00:00Z")), { day: "2026-11-08", weekday: 7, hour: 23 }); // domingo à noite
});

test("janela: 7 dias completos até ontem e os 7 anteriores", () => {
  assert.deepEqual(WIN, { cur: { since: "2026-11-02", until: "2026-11-08" }, prev: { since: "2026-10-26", until: "2026-11-01" } });
});

const campaigns = [{ id: "a", name: "Alfa", status: "ativa" }, { id: "b", name: "Beta", status: "ativa" }, { id: "z", name: "Parada", status: "pausada" }];
const m = (c, day, spend, extra = {}) => ({ campaign_id: c, report_date: day, amount_spent: spend, impressions: 10000, clicks: 200, source: "manual", ...extra });
const l = (c, day, status = "novo") => ({ campaign_id: c, created_day: day, status });

const metricRows = [
  m("a", "2026-11-03", 300), m("a", "2026-11-04", 300),            // 600 na semana
  m("b", "2026-11-05", 150),                                        // gasto sem leads
  m("a", "2026-10-28", 400),                                        // semana anterior
  m("a", "2026-11-04", 999, { source: "meta_api" }),                // Meta vence o manual do mesmo dia
  m("a", "2026-11-20", 5000),                                       // fora da janela
];
const leadRows = [l("a", "2026-11-03", "qualificado"), l("a", "2026-11-04", "enviado_crm"), l("a", "2026-11-05"), l("a", "2026-11-06"), l("a", "2026-10-28"), l("a", "2026-10-29")];

test("relatório: totais da semana, comparação, campanhas e atenção", () => {
  const r = buildWeeklyReport({ campaigns, metricRows, leadRows, window: WIN, ruleEvents: [{ message: "Regra X disparou", created_day: "2026-11-05" }, { message: "antiga", created_day: "2026-10-01" }] });
  // gasto: manual 300 (dia 03) + Meta 999 (dia 04; o manual de 300 do mesmo dia é ignorado) + 150 (b) = 1.449
  assert.equal(r.cur.spend, 300 + 999 + 150);
  assert.equal(r.cur.leads, 4);
  assert.equal(r.cur.qualified, 2);
  assert.equal(r.cur.crm, 1);
  assert.equal(r.cur.cpl, (300 + 999 + 150) / 4);
  assert.equal(r.prev.spend, 400);
  assert.equal(r.prev.leads, 2);
  assert.ok(r.deltas.spend > 0);
  assert.deepEqual(r.attention, [{ name: "Beta", spend: 150 }]);
  assert.deepEqual(r.campaigns.map((c) => c.name), ["Alfa", "Beta"]); // 'Parada' sem movimento fica de fora
  assert.deepEqual(r.ruleEvents.map((e) => e.message), ["Regra X disparou"]);
  assert.equal(r.empty, false);
});

test("semana sem movimento → relatório vazio", () => {
  const r = buildWeeklyReport({ campaigns, metricRows: [], leadRows: [], window: WIN });
  assert.equal(r.empty, true);
  assert.equal(renderReportEmail(r).text.includes("Não houve investimento nem leads"), true);
});

test("limita a 8 campanhas e informa quantas ficaram de fora", () => {
  const many = Array.from({ length: 12 }, (_, i) => ({ id: `c${i}`, name: `C${i}`, status: "ativa" }));
  const rows = many.map((c, i) => m(c.id, "2026-11-03", 10 + i));
  const r = buildWeeklyReport({ campaigns: many, metricRows: rows, leadRows: [], window: WIN });
  assert.equal(r.campaigns.length, 8);
  assert.equal(r.hiddenCampaigns, 4);
  assert.match(renderReportEmail(r).html, /e mais 4 campanha/);
});

test("e-mail: TODO texto dinâmico é escapado (nome de campanha malicioso não injeta HTML)", () => {
  const evil = [{ id: "x", name: '<img src=x onerror="alert(1)">', status: "ativa" }];
  const r = buildWeeklyReport({ campaigns: evil, metricRows: [m("x", "2026-11-03", 100)], leadRows: [], window: WIN, ruleEvents: [{ message: "<script>alert(2)</script>", created_day: "2026-11-03" }] });
  const { html, subject } = renderReportEmail(r, { orgName: "Empresa <b>X</b>", appUrl: "https://app.exemplo.com/" });
  assert.ok(!html.includes("<img src=x"), "tag não escapada");
  assert.ok(!html.includes("<script>"), "script não escapado");
  assert.ok(!html.includes("<b>X</b>"));
  assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
  assert.match(html, /EMPRESA &lt;B&gt;X&lt;\/B&gt;/);
  assert.match(html, /href="https:\/\/app\.exemplo\.com\/paid-traffic"/);
  assert.ok(subject.includes("Empresa <b>X</b>")); // assunto é texto puro, não HTML
});

test("e-mail: link só com URL http(s) e nunca com javascript:", () => {
  const r = buildWeeklyReport({ campaigns, metricRows, leadRows, window: WIN });
  assert.ok(!renderReportEmail(r, { appUrl: "javascript:alert(1)" }).html.includes("javascript:"));
  assert.ok(!renderReportEmail(r, {}).html.includes("Abrir no be2bdr"));
});

test("e-mail: valores em reais e variação com cores coerentes (CPL menor é bom)", () => {
  const r = buildWeeklyReport({ campaigns, metricRows, leadRows, window: WIN });
  const { html, text, subject } = renderReportEmail(r, { orgName: "Be2B" });
  assert.match(html, /R\$\s?1\.449,00/);
  assert.match(text, /Investimento: R\$\s?1\.449,00/);
  assert.equal(subject, "Relatório semanal de tráfego pago — Be2B (02/11 a 08/11)");
});

test("assunto sem quebra de linha (injeção de cabeçalho)", () => {
  assert.equal(cleanSubject("Olá\r\nBcc: alguem@x.com"), "Olá Bcc: alguem@x.com");
  assert.equal(cleanSubject("x".repeat(500)).length, 200);
  assert.equal(escapeHtml(`&<>"'`), "&amp;&lt;&gt;&quot;&#39;");
});

test("validação do agendamento", () => {
  const ok = validateScheduleInput({ recipients: [" A@x.com ", "a@x.com", "b@y.com.br"], weekday: 1, hour: 8, is_active: true, org_name: " Be2B\n " });
  assert.deepEqual(ok, { ok: true, value: { recipients: ["a@x.com", "b@y.com.br"], weekday: 1, hour: 8, is_active: true, org_name: "Be2B" } });
  assert.equal(validateScheduleInput({ recipients: ["sem-arroba"] }).ok, false);
  assert.equal(validateScheduleInput({ recipients: ["a@x.com\r\nBcc:b@y.com"] }).ok, false);
  assert.equal(validateScheduleInput({ recipients: ["<a@x.com>"] }).ok, false);
  assert.equal(validateScheduleInput({ recipients: Array.from({ length: 6 }, (_, i) => `u${i}@x.com`) }).ok, false);
  assert.equal(validateScheduleInput({ weekday: 0 }).ok, false);
  assert.equal(validateScheduleInput({ weekday: 8 }).ok, false);
  assert.equal(validateScheduleInput({ hour: 24 }).ok, false);
  assert.equal(validateScheduleInput({ is_active: "sim" }).ok, false);
  assert.deepEqual(validateScheduleInput({}), { ok: true, value: {} });
});

const sched = (over = {}) => ({ is_active: true, recipients: ["a@x.com"], weekday: 1, hour: 8, timezone: "America/Sao_Paulo", last_sent_at: null, attempts_day: null, attempts: 0, ...over });

test("isDue: só no dia e hora certos, uma vez por dia, com limite de tentativas", () => {
  assert.equal(isDue(sched(), NOW), true);                                              // segunda 09h ≥ 08h
  assert.equal(isDue(sched({ hour: 10 }), NOW), false);                                 // ainda não deu a hora
  assert.equal(isDue(sched({ weekday: 2 }), NOW), false);                               // outro dia
  assert.equal(isDue(sched({ is_active: false }), NOW), false);
  assert.equal(isDue(sched({ recipients: [] }), NOW), false);
  assert.equal(isDue(sched({ last_sent_at: "2026-11-09T11:00:00Z" }), NOW), false);     // já enviou hoje
  assert.equal(isDue(sched({ last_sent_at: "2026-11-02T11:00:00Z" }), NOW), true);      // semana passada
  assert.equal(isDue(sched({ attempts_day: "2026-11-09", attempts: MAX_ATTEMPTS_PER_DAY }), NOW), false);
  assert.equal(isDue(sched({ attempts_day: "2026-11-08", attempts: MAX_ATTEMPTS_PER_DAY }), NOW), true); // tentativas de ontem não contam
});

test("e-mail via Resend: header de autorização, corpo e erros claros", async () => {
  const env = { RESEND_API_KEY: "re_123", REPORT_FROM_EMAIL: "Be2B <relatorios@be2b.tech>" };
  let seen;
  const ok = await sendEmail({ to: ["a@x.com"], subject: "S", html: "<p>x</p>", text: "x" }, { env, fetchImpl: async (url, init) => { seen = { url, init }; return { ok: true, status: 200, json: async () => ({ id: "em_1" }) }; } });
  assert.deepEqual(ok, { id: "em_1" });
  assert.equal(seen.url, "https://api.resend.com/emails");
  assert.equal(seen.init.headers.Authorization, "Bearer re_123");
  assert.deepEqual(JSON.parse(seen.init.body), { from: "Be2B <relatorios@be2b.tech>", to: ["a@x.com"], subject: "S", html: "<p>x</p>", text: "x" });

  await assert.rejects(sendEmail({ to: ["a@x.com"], subject: "S", html: "", text: "" }, { env: {} }), /não configurado/);
  await assert.rejects(sendEmail({ to: [], subject: "S", html: "", text: "" }, { env }), /Sem destinatários/);
  await assert.rejects(sendEmail({ to: ["a@x.com"], subject: "S", html: "", text: "" }, { env, fetchImpl: async () => ({ ok: false, status: 422, json: async () => ({ message: "domínio não verificado" }) }) }),
    (e) => e instanceof EmailError && e.status === 422 && /domínio não verificado/.test(e.message));
  await assert.rejects(sendEmail({ to: ["a@x.com"], subject: "S", html: "", text: "" }, { env, fetchImpl: async () => { throw new Error("ECONNRESET"); } }), /Falha de rede/);
  assert.equal(emailConfig({ RESEND_API_KEY: "k" }).enabled, false);
  assert.equal(emailConfig(env).enabled, true);
});
