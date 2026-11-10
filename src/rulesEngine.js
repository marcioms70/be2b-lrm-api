/**
 * Motor de regras do Tráfego Pago — funções puras (sem banco, sem rede).
 *
 * Métricas por campanha numa janela de N dias:
 *   spend, leads (funil LRM), cpl = spend ÷ leads, cost_per_qualified, ctr, cpc,
 *   days_without_leads, balance.
 *
 * Convenção para custo sem resultado: se há gasto ≥ min_spend e ZERO leads, o CPL é
 * "infinito" — uma regra `cpl > X` dispara (queimando orçamento sem retorno), enquanto
 * `cpl < X` não.
 */

export const RULE_METRICS = ["cpl", "cost_per_qualified", "spend", "leads", "ctr", "cpc", "days_without_leads", "balance"];
export const RULE_OPERATORS = [">", ">=", "<", "<="];
export const RULE_ACTIONS = ["notify", "pause"];

const QUALIFIED = new Set(["qualificado", "quente", "enviado_crm"]);

const num = (v) => {
  if (v === null || v === undefined || v === "") return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** Datas yyyy-MM-dd no fuso dado. */
export function dayInTimezone(date, timeZone = "America/Sao_Paulo") {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

export function shiftDay(day, delta) {
  const [y, m, d] = day.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + delta));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
}

export function daysBetween(fromDay, toDay) {
  const [y1, m1, d1] = fromDay.split("-").map(Number);
  const [y2, m2, d2] = toDay.split("-").map(Number);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86400000);
}

/** Dias com linha da Meta ignoram o lançamento manual do mesmo dia (evita gasto em dobro). */
export function dedupeMetricRows(rows) {
  const metaDays = new Set(rows.filter((r) => r.source === "meta_api").map((r) => `${r.campaign_id}|${r.report_date}`));
  if (metaDays.size === 0) return rows;
  return rows.filter((r) => r.source === "meta_api" || !metaDays.has(`${r.campaign_id}|${r.report_date}`));
}

/**
 * @param {{ campaign: object, metricRows: object[], leadRows: {created_day:string,status:string}[],
 *           today: string, windowDays: number }} input
 *   metricRows: { report_date:'yyyy-MM-dd', amount_spent, impressions, clicks, remaining_balance, source }
 *   leadRows: leads da campanha (qualquer data) com o dia de criação já no fuso certo
 */
export function computeSnapshot({ campaign, metricRows, leadRows, today, windowDays }) {
  const since = shiftDay(today, -(windowDays - 1));
  const rows = dedupeMetricRows(metricRows).filter((r) => r.report_date >= since && r.report_date <= today);

  let spend = 0, impressions = 0, clicks = 0;
  for (const r of rows) { spend += num(r.amount_spent); impressions += num(r.impressions); clicks += num(r.clicks); }

  const inWindow = leadRows.filter((l) => l.created_day >= since && l.created_day <= today);
  const leads = inWindow.length;
  const qualified = inWindow.filter((l) => QUALIFIED.has(l.status)).length;

  // Dias sem lead: desde o último lead; sem nenhum lead, desde o início/criação da campanha.
  const lastLeadDay = leadRows.reduce((max, l) => (l.created_day > max ? l.created_day : max), "");
  const startDay = (campaign.start_date ? String(campaign.start_date).slice(0, 10) : campaign.created_day) || today;
  const ref = lastLeadDay && lastLeadDay >= startDay ? lastLeadDay : startDay;
  const daysWithoutLeads = Math.max(0, daysBetween(ref, today));

  // Saldo: última métrica manual com saldo; senão o saldo cadastrado na campanha.
  const withBalance = metricRows
    .filter((r) => r.remaining_balance !== null && r.remaining_balance !== undefined && r.remaining_balance !== "")
    .sort((a, b) => (a.report_date < b.report_date ? 1 : -1));
  const balance = withBalance.length ? num(withBalance[0].remaining_balance)
    : campaign.current_balance !== null && campaign.current_balance !== undefined ? num(campaign.current_balance) : null;

  return {
    window: { since, until: today },
    spend, impressions, clicks, leads, qualified,
    hasMetrics: rows.length > 0,
    cpl: leads > 0 ? spend / leads : null,
    costPerQualified: qualified > 0 ? spend / qualified : null,
    ctr: impressions > 0 ? (clicks / impressions) * 100 : null,
    cpc: clicks > 0 ? spend / clicks : null,
    daysWithoutLeads,
    balance
  };
}

export function compareValue(value, operator, threshold) {
  switch (operator) {
    case ">": return value > threshold;
    case ">=": return value >= threshold;
    case "<": return value < threshold;
    case "<=": return value <= threshold;
    default: return false;
  }
}

/**
 * @returns {{ evaluable: boolean, triggered: boolean, value: number|null, reason?: string }}
 */
export function evaluateRule(rule, snap) {
  const minSpend = num(rule.min_spend);
  // "leads" também exige evidência: "0 leads" só significa algo se houve gasto (senão a campanha
  // recém-ativada, sem investimento, dispararia a regra — e uma regra de pausa a pararia).
  const needsSpendEvidence = ["cpl", "cost_per_qualified", "ctr", "cpc", "leads"].includes(rule.metric);

  if (needsSpendEvidence && snap.spend < minSpend) {
    return { evaluable: false, triggered: false, value: null, reason: `gasto na janela (${snap.spend.toFixed(2)}) abaixo do mínimo (${minSpend})` };
  }

  let value;
  switch (rule.metric) {
    case "spend": value = snap.spend; break;
    case "leads": value = snap.leads; break;
    case "days_without_leads": value = snap.daysWithoutLeads; break;
    case "balance": value = snap.balance; break;
    case "ctr": value = snap.ctr; break;
    case "cpc": value = snap.cpc; break;
    case "cpl":
      value = snap.cpl !== null ? snap.cpl : snap.spend > 0 ? Infinity : null; break;
    case "cost_per_qualified":
      value = snap.costPerQualified !== null ? snap.costPerQualified : snap.spend > 0 ? Infinity : null; break;
    default: return { evaluable: false, triggered: false, value: null, reason: "métrica desconhecida" };
  }

  if (value === null || value === undefined) return { evaluable: false, triggered: false, value: null, reason: "sem dados para a métrica" };
  return { evaluable: true, triggered: compareValue(value, rule.operator, num(rule.threshold)), value };
}

const LABELS = {
  cpl: "CPL", cost_per_qualified: "Custo por qualificado", spend: "Investimento", leads: "Leads",
  ctr: "CTR", cpc: "CPC", days_without_leads: "Dias sem leads", balance: "Saldo"
};
const MONEY = new Set(["cpl", "cost_per_qualified", "spend", "cpc", "balance"]);

export function formatMetricValue(metric, value) {
  if (value === Infinity) return "sem leads (∞)";
  if (value === null || value === undefined) return "—";
  if (MONEY.has(metric)) return `R$ ${Number(value).toFixed(2).replace(".", ",")}`;
  if (metric === "ctr") return `${Number(value).toFixed(2).replace(".", ",")}%`;
  return String(Math.round(value * 100) / 100);
}

export function describeTrigger(rule, value, campaignName, windowDays) {
  const label = LABELS[rule.metric] || rule.metric;
  const scope = ["days_without_leads", "balance"].includes(rule.metric) ? "" : ` nos últimos ${windowDays} dia(s)`;
  return `Regra “${rule.name}”: ${label}${scope} = ${formatMetricValue(rule.metric, value)} (${rule.operator} ${formatMetricValue(rule.metric, num(rule.threshold))}) em “${campaignName}”.`;
}

/**
 * Pode agir agora? Respeita cooldown (por regra+campanha) e o limite diário (por regra).
 * @param {{ lastActionAt: Date|string|null, actionsLast24h: number, now?: Date }} s
 */
export function canAct(rule, s) {
  const now = s.now || new Date();
  if (s.actionsLast24h >= num(rule.max_actions_per_day)) return { ok: false, reason: "limite diário da regra atingido" };
  if (s.lastActionAt) {
    const elapsedH = (now.getTime() - new Date(s.lastActionAt).getTime()) / 3600000;
    if (elapsedH < num(rule.cooldown_hours)) return { ok: false, reason: "em cooldown" };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Validação de entrada (criação/edição)
// ---------------------------------------------------------------------------
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v) => typeof v === "string" && UUID_RE.test(v);

/** @returns {{ ok: true, value: object } | { ok: false, errors: string[] }} */
export function validateRuleInput(input, { partial = false } = {}) {
  const errors = [];
  const v = {};
  const has = (k) => Object.prototype.hasOwnProperty.call(input, k);

  if (!partial || has("name")) {
    const name = String(input.name ?? "").trim();
    if (!name) errors.push("Nome é obrigatório.");
    else if (name.length > 120) errors.push("Nome deve ter até 120 caracteres.");
    else v.name = name;
  }
  if (!partial || has("metric")) {
    if (!RULE_METRICS.includes(input.metric)) errors.push("Métrica inválida.");
    else v.metric = input.metric;
  }
  if (!partial || has("operator")) {
    if (!RULE_OPERATORS.includes(input.operator)) errors.push("Operador inválido.");
    else v.operator = input.operator;
  }
  if (!partial || has("threshold")) {
    const t = Number(input.threshold);
    if (input.threshold === "" || input.threshold === null || input.threshold === undefined || !Number.isFinite(t)) errors.push("Valor-limite inválido.");
    else v.threshold = t;
  }
  const intField = (key, label, min, max, def) => {
    if (partial && !has(key)) return;
    const raw = input[key] === undefined || input[key] === null || input[key] === "" ? def : Number(input[key]);
    if (!Number.isInteger(raw) || raw < min || raw > max) errors.push(`${label} deve ser um inteiro entre ${min} e ${max}.`);
    else v[key] = raw;
  };
  intField("window_days", "Janela (dias)", 1, 30, 3);
  intField("cooldown_hours", "Cooldown (horas)", 1, 720, 24);
  intField("max_actions_per_day", "Máximo de ações por dia", 1, 50, 3);

  if (!partial || has("min_spend")) {
    const raw = input.min_spend === undefined || input.min_spend === null || input.min_spend === "" ? 0 : Number(input.min_spend);
    if (!Number.isFinite(raw) || raw < 0) errors.push("Gasto mínimo inválido.");
    else v.min_spend = raw;
  }
  if (!partial || has("action")) {
    const action = input.action === undefined || input.action === null || input.action === "" ? "notify" : input.action;
    if (!RULE_ACTIONS.includes(action)) errors.push("Ação inválida.");
    else v.action = action;
  }
  if (!partial || has("campaign_id")) {
    if (input.campaign_id === undefined || input.campaign_id === null || input.campaign_id === "") v.campaign_id = null;
    else if (!isUuid(input.campaign_id)) errors.push("campaign_id inválido.");
    else v.campaign_id = input.campaign_id;
  }
  if (has("is_active")) {
    if (typeof input.is_active !== "boolean") errors.push("is_active deve ser verdadeiro/falso.");
    else v.is_active = input.is_active;
  }

  return errors.length ? { ok: false, errors } : { ok: true, value: v };
}
