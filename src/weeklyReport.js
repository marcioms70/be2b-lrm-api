/**
 * Relatório semanal de tráfego pago — funções PURAS (sem banco, sem rede):
 * janela de datas, métricas, agendamento, validação e montagem do e-mail.
 */
import { dedupeMetricRows, shiftDay } from "./rulesEngine.js";

const QUALIFIED = new Set(["qualificado", "quente", "enviado_crm"]);
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const div = (a, b) => (b > 0 ? a / b : null);

// ---------------------------------------------------------------------------
// Datas
// ---------------------------------------------------------------------------
/** Partes da data/hora locais no fuso: { day:'yyyy-MM-dd', weekday:1..7 (seg..dom), hour:0..23 }. */
export function localParts(date, timeZone = "America/Sao_Paulo") {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short", hour: "2-digit", hourCycle: "h23" })
    .formatToParts(date).reduce((o, p) => { o[p.type] = p.value; return o; }, {});
  const weekday = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }[parts.weekday];
  return { day: `${parts.year}-${parts.month}-${parts.day}`, weekday, hour: Number(parts.hour) };
}

/** Últimos 7 dias COMPLETOS (até ontem) e os 7 anteriores. */
export function reportWindow(now = new Date(), timeZone = "America/Sao_Paulo") {
  const today = localParts(now, timeZone).day;
  const until = shiftDay(today, -1);
  const since = shiftDay(until, -6);
  const prevUntil = shiftDay(since, -1);
  return { cur: { since, until }, prev: { since: shiftDay(prevUntil, -6), until: prevUntil } };
}

const inWin = (d, w) => d >= w.since && d <= w.until;

// ---------------------------------------------------------------------------
// Dados do relatório
// ---------------------------------------------------------------------------
function summarize(metricRows, leadRows, win) {
  let spend = 0, impressions = 0, clicks = 0;
  for (const m of dedupeMetricRows(metricRows)) if (inWin(m.report_date, win)) { spend += num(m.amount_spent); impressions += num(m.impressions); clicks += num(m.clicks); }
  const leads = leadRows.filter((l) => inWin(l.created_day, win));
  const qualified = leads.filter((l) => QUALIFIED.has(l.status)).length;
  const crm = leads.filter((l) => l.status === "enviado_crm" || l.sent_to_crm).length;
  return { spend, leads: leads.length, qualified, crm, cpl: div(spend, leads.length), costPerQualified: div(spend, qualified), ctr: impressions > 0 ? (clicks / impressions) * 100 : null };
}

export function delta(cur, prev) {
  if (cur === null || prev === null || !prev) return null;
  return ((cur - prev) / Math.abs(prev)) * 100;
}

/**
 * @param {{ campaigns: {id,name,status}[], metricRows: object[], leadRows: object[], ruleEvents?: {message:string, created_day:string}[], window: ReturnType<typeof reportWindow> }} input
 */
export function buildWeeklyReport({ campaigns, metricRows, leadRows, ruleEvents = [], window }) {
  const cur = summarize(metricRows, leadRows, window.cur);
  const prev = summarize(metricRows, leadRows, window.prev);

  const rows = campaigns.map((c) => {
    const s = summarize(metricRows.filter((m) => m.campaign_id === c.id), leadRows.filter((l) => l.campaign_id === c.id), window.cur);
    return { id: c.id, name: c.name, status: c.status, spend: s.spend, leads: s.leads, qualified: s.qualified, cpl: s.cpl };
  }).filter((r) => r.spend > 0 || r.leads > 0).sort((a, b) => b.spend - a.spend);

  // Atenção: campanhas que gastaram e não geraram NENHUM lead na semana.
  const attention = rows.filter((r) => r.spend > 0 && r.leads === 0).map((r) => ({ name: r.name, spend: r.spend }));

  return {
    window, cur, prev,
    deltas: {
      spend: delta(cur.spend, prev.spend), leads: delta(cur.leads, prev.leads), cpl: delta(cur.cpl, prev.cpl),
      qualified: delta(cur.qualified, prev.qualified), cost_per_qualified: delta(cur.costPerQualified, prev.costPerQualified), crm: delta(cur.crm, prev.crm),
    },
    campaigns: rows.slice(0, 8), hiddenCampaigns: Math.max(0, rows.length - 8),
    attention,
    ruleEvents: ruleEvents.filter((e) => inWin(e.created_day, window.cur)).slice(0, 8),
    empty: cur.spend === 0 && cur.leads === 0,
  };
}

// ---------------------------------------------------------------------------
// E-mail
// ---------------------------------------------------------------------------
export function escapeHtml(v) {
  return String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/** Assunto numa linha só (evita injeção de cabeçalho por quebra de linha) e com tamanho limitado. */
export const cleanSubject = (s) => String(s ?? "").replace(/[\r\n]+/g, " ").trim().slice(0, 200);

const brl = (v) => (v === null || v === undefined ? "—" : v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" }));
const int = (v) => (v === null || v === undefined ? "—" : Math.round(v).toLocaleString("pt-BR"));
const pt = (d) => d.split("-").reverse().join("/");
const short = (d) => d.split("-").reverse().slice(0, 2).join("/");

const LOWER_IS_BETTER = new Set(["cpl", "cost_per_qualified"]);
function deltaCell(key, d) {
  if (d === null || d === undefined || !Number.isFinite(d)) return ""; // sem base de comparação: não mostra nada (nunca "NaN%")
  const good = LOWER_IS_BETTER.has(key) ? d < 0 : d > 0;
  const neutral = key === "spend";
  const color = Math.abs(d) < 0.05 || neutral ? "#6b7280" : good ? "#15803d" : "#b91c1c";
  return `<span style="color:${color};font-size:12px;">${d > 0 ? "▲" : d < 0 ? "▼" : "•"} ${Math.abs(d).toFixed(1).replace(".", ",")}%</span>`;
}

/**
 * @returns {{ subject: string, html: string, text: string }}
 * Todo texto dinâmico (empresa, campanhas, regras) passa por escapeHtml.
 */
export function renderReportEmail(report, { orgName, appUrl } = {}) {
  const w = report.window.cur;
  const org = (orgName || "").trim();
  const subject = cleanSubject(`Relatório semanal de tráfego pago${org ? ` — ${org}` : ""} (${short(w.since)} a ${short(w.until)})`);

  const kpi = (label, value, key) => `<td style="padding:10px 12px;border:1px solid #e5e7eb;border-radius:6px;width:33%;vertical-align:top;">
      <div style="font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:.04em;">${escapeHtml(label)}</div>
      <div style="font-size:20px;font-weight:600;margin-top:4px;">${escapeHtml(value)}</div>
      <div>${deltaCell(key, report.deltas[key])}</div></td>`;

  const c = report.cur;
  const campaignRows = report.campaigns.map((r) => `<tr>
      <td style="padding:6px 8px;border-bottom:1px solid #f1f5f9;">${escapeHtml(r.name)}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #f1f5f9;text-align:right;">${escapeHtml(brl(r.spend))}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #f1f5f9;text-align:right;">${escapeHtml(int(r.leads))}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #f1f5f9;text-align:right;">${escapeHtml(int(r.qualified))}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #f1f5f9;text-align:right;">${escapeHtml(brl(r.cpl))}</td></tr>`).join("");

  const section = (title, body) => `<h2 style="font-size:15px;margin:24px 0 8px;">${escapeHtml(title)}</h2>${body}`;
  const list = (items) => `<ul style="margin:0;padding-left:18px;font-size:14px;line-height:1.5;">${items.map((i) => `<li>${i}</li>`).join("")}</ul>`;

  const body = report.empty
    ? `<p style="font-size:14px;">Não houve investimento nem leads nesta semana.</p>`
    : `<table role="presentation" cellpadding="0" cellspacing="6" style="width:100%;border-collapse:separate;"><tr>
          ${kpi("Investimento", brl(c.spend), "spend")}${kpi("Leads", int(c.leads), "leads")}${kpi("CPL", brl(c.cpl), "cpl")}</tr><tr>
          ${kpi("Qualificados", int(c.qualified), "qualified")}${kpi("Custo por qualificado", brl(c.costPerQualified), "cost_per_qualified")}${kpi("Enviados ao CRM", int(c.crm), "crm")}</tr></table>`
      + (report.campaigns.length ? section("Campanhas da semana", `<table style="width:100%;border-collapse:collapse;font-size:14px;"><thead><tr style="color:#6b7280;font-size:12px;text-align:right;">
          <th style="padding:6px 8px;text-align:left;">Campanha</th><th style="padding:6px 8px;">Investimento</th><th style="padding:6px 8px;">Leads</th><th style="padding:6px 8px;">Qualif.</th><th style="padding:6px 8px;">CPL</th></tr></thead><tbody>${campaignRows}</tbody></table>`
          + (report.hiddenCampaigns ? `<p style="font-size:12px;color:#6b7280;">… e mais ${report.hiddenCampaigns} campanha(s).</p>` : "")) : "")
      + (report.attention.length ? section("Atenção", list(report.attention.map((a) => `<b>${escapeHtml(a.name)}</b> gastou ${escapeHtml(brl(a.spend))} e não gerou nenhum lead.`))) : "")
      + (report.ruleEvents.length ? section("Regras automáticas disparadas", list(report.ruleEvents.map((e) => escapeHtml(e.message)))) : "");

  const link = appUrl && /^https?:\/\//.test(appUrl) ? `<p style="margin-top:24px;"><a href="${escapeHtml(appUrl.replace(/\/$/, ""))}/paid-traffic" style="background:#2563eb;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none;font-size:14px;">Abrir no be2bdr</a></p>` : "";

  const html = `<!doctype html><html lang="pt-BR"><body style="margin:0;background:#f8fafc;font-family:Arial,Helvetica,sans-serif;color:#111827;">
  <div style="max-width:640px;margin:0 auto;padding:24px;background:#ffffff;">
    <p style="font-size:12px;color:#6b7280;margin:0;">RELATÓRIO SEMANAL DE TRÁFEGO PAGO${org ? ` · ${escapeHtml(org.toUpperCase())}` : ""}</p>
    <h1 style="font-size:20px;margin:4px 0 2px;">${escapeHtml(pt(w.since))} a ${escapeHtml(pt(w.until))}</h1>
    <p style="font-size:12px;color:#6b7280;margin:0 0 16px;">Comparado com ${escapeHtml(pt(report.window.prev.since))} a ${escapeHtml(pt(report.window.prev.until))}. CPL e custos usam os leads do funil de atendimento.</p>
    ${body}${link}
    <p style="font-size:11px;color:#9ca3af;margin-top:28px;border-top:1px solid #e5e7eb;padding-top:12px;">Você recebe este e-mail porque um administrador da empresa cadastrou o seu endereço para o relatório semanal. Para deixar de receber, peça a um administrador para remover o seu e-mail em Configurações.</p>
  </div></body></html>`;

  const lines = [`RELATÓRIO SEMANAL DE TRÁFEGO PAGO${org ? ` — ${org}` : ""}`, `${pt(w.since)} a ${pt(w.until)}`, ""];
  if (report.empty) lines.push("Não houve investimento nem leads nesta semana.");
  else {
    lines.push(`Investimento: ${brl(c.spend)}`, `Leads: ${int(c.leads)}`, `CPL: ${brl(c.cpl)}`, `Qualificados: ${int(c.qualified)}`, `Enviados ao CRM: ${int(c.crm)}`);
    if (report.campaigns.length) { lines.push("", "Campanhas:"); for (const r of report.campaigns) lines.push(`- ${r.name}: ${brl(r.spend)} | ${int(r.leads)} leads | CPL ${brl(r.cpl)}`); }
    if (report.attention.length) { lines.push("", "Atenção:"); for (const a of report.attention) lines.push(`- ${a.name} gastou ${brl(a.spend)} e não gerou leads.`); }
    if (report.ruleEvents.length) { lines.push("", "Regras disparadas:"); for (const e of report.ruleEvents) lines.push(`- ${e.message}`); }
  }
  return { subject, html, text: lines.join("\n") };
}

// ---------------------------------------------------------------------------
// Agendamento e validação
// ---------------------------------------------------------------------------
export const MAX_RECIPIENTS = 5;
export const MAX_ATTEMPTS_PER_DAY = 3;
const EMAIL_RE = /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]{2,}$/;

export function validateScheduleInput(input) {
  const errors = [];
  const value = {};
  if ("recipients" in input) {
    const raw = Array.isArray(input.recipients) ? input.recipients : [];
    const list = [...new Set(raw.map((e) => String(e ?? "").trim().toLowerCase()).filter(Boolean))];
    const bad = list.filter((e) => e.length > 254 || !EMAIL_RE.test(e));
    if (bad.length) errors.push(`E-mail inválido: ${bad[0]}`);
    else if (list.length > MAX_RECIPIENTS) errors.push(`No máximo ${MAX_RECIPIENTS} destinatários.`);
    else value.recipients = list;
  }
  if ("weekday" in input) {
    const n = Number(input.weekday);
    if (!Number.isInteger(n) || n < 1 || n > 7) errors.push("Dia da semana inválido (1 = segunda … 7 = domingo).");
    else value.weekday = n;
  }
  if ("hour" in input) {
    const n = Number(input.hour);
    if (!Number.isInteger(n) || n < 0 || n > 23) errors.push("Hora inválida (0 a 23).");
    else value.hour = n;
  }
  if ("is_active" in input) {
    if (typeof input.is_active !== "boolean") errors.push("is_active deve ser verdadeiro/falso.");
    else value.is_active = input.is_active;
  }
  if ("org_name" in input) value.org_name = String(input.org_name ?? "").replace(/[\r\n]+/g, " ").trim().slice(0, 120) || null;
  return errors.length ? { ok: false, errors } : { ok: true, value };
}

/**
 * Está na hora de enviar? Dia/hora locais já alcançados, ainda não enviado hoje e sem estourar
 * as tentativas do dia (uma falha é repetida a cada execução, no máximo MAX_ATTEMPTS_PER_DAY vezes).
 */
export function isDue(schedule, now = new Date()) {
  if (!schedule.is_active || !(schedule.recipients?.length > 0)) return false;
  const tz = schedule.timezone || "America/Sao_Paulo";
  const here = localParts(now, tz);
  if (here.weekday !== schedule.weekday || here.hour < schedule.hour) return false;
  if (schedule.last_sent_at && localParts(new Date(schedule.last_sent_at), tz).day === here.day) return false;
  if (schedule.attempts_day === here.day && schedule.attempts >= MAX_ATTEMPTS_PER_DAY) return false;
  return true;
}
