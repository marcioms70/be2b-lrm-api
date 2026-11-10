/**
 * Conversão de linhas de insights da Meta para linhas de paid_traffic_metrics.
 * Funções puras.
 */

/**
 * A Meta devolve o mesmo evento sob vários action_types sobrepostos. Somar todos
 * inflaria a contagem, então usamos UM tipo, na ordem de prioridade abaixo.
 */
export const LEAD_ACTION_PRIORITY = [
  "lead",
  "onsite_conversion.lead_grouped",
  "onsite_conversion.messaging_conversation_started_7d"
];

function toNum(v) {
  if (v === undefined || v === null || v === "") return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export function pickLeadCount(actions) {
  if (!Array.isArray(actions)) return 0;
  for (const type of LEAD_ACTION_PRIORITY) {
    const found = actions.find((a) => a.action_type === type);
    if (found) return Math.round(toNum(found.value));
  }
  return 0;
}

/** Linha do /insights (time_increment=1) → linha de métrica diária. */
export function mapInsightRow(row) {
  const spend = toNum(row.spend);
  const impressions = Math.round(toNum(row.impressions));
  // Para campanhas de tráfego o que importa é o clique no link; cai para clicks totais.
  const clicks = Math.round(toNum(row.inline_link_clicks) || toNum(row.clicks));
  const leads = pickLeadCount(row.actions);
  return {
    report_date: row.date_start,
    amount_spent: spend,
    impressions,
    clicks,
    leads,
    cpl: leads > 0 ? spend / leads : null,
    ctr: impressions > 0 ? (clicks / impressions) * 100 : null,
    cpc: clicks > 0 ? spend / clicks : null
  };
}

export const INSIGHT_FIELDS = "date_start,date_stop,spend,impressions,clicks,inline_link_clicks,actions";

export const MAX_SYNC_DAYS = 90;

function fmt(d) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

/** Janela [since, until] (UTC, inclusiva) dos últimos N dias, limitada a 90. */
export function buildWindow(days = 7, today = new Date()) {
  const n = Math.max(1, Math.min(Number.isFinite(Number(days)) ? Math.floor(Number(days)) : 7, MAX_SYNC_DAYS));
  const until = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  const since = new Date(until);
  since.setUTCDate(since.getUTCDate() - (n - 1));
  return { since: fmt(since), until: fmt(until), days: n };
}

/** pausa/ativa na Meta conforme o status do be2bdr; `null` = não mexer na Meta. */
export function metaStatusFor(status) {
  switch (status) {
    case "ativa": return "ACTIVE";
    // ARCHIVED na Meta é irreversível: finalizar/arquivar apenas PAUSA.
    case "pausada":
    case "finalizada":
    case "arquivada": return "PAUSED";
    default: return null;
  }
}
