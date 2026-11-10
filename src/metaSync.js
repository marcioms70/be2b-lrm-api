/**
 * Fase 2 — sincronização com a Meta:
 *  - insights diários → paid_traffic_metrics (source = 'meta_api')
 *  - pausar/ativar campanhas publicadas refletindo na Meta
 *  - consulta da publicação e da revisão do anúncio
 */
import { query } from "./db.js";
import { ensureSchema } from "./migrate.js";
import { decryptToken } from "./tokenCrypto.js";
import { MetaGraphError, graphRequest } from "./metaGraph.js";
import { INSIGHT_FIELDS, buildWindow, mapInsightRow, metaStatusFor } from "./metaInsightsMap.js";

export class MetaSyncError extends Error {
  constructor(message, httpStatus = 502, details = null) {
    super(message);
    this.name = "MetaSyncError";
    this.httpStatus = httpStatus;
    this.details = details;
  }
}

// ---------------------------------------------------------------------------
// Conexão / token
// ---------------------------------------------------------------------------
async function getConnectedConnection(organizationId) {
  const r = await query(
    `select * from public.meta_ads_connections where organization_id = $1 and status = 'connected' limit 1`,
    [organizationId]
  );
  return r.rows[0] || null;
}

async function markNeedsReconnect(organizationId, message) {
  await query(
    `update public.meta_ads_connections set status = 'needs_reconnect', last_error = $2, updated_at = now() where organization_id = $1`,
    [organizationId, message]
  ).catch(() => null);
}

/** Traduz erros da Graph API para mensagens úteis e trata token expirado. */
async function translateGraphError(err, organizationId) {
  if (!(err instanceof MetaGraphError)) return err;
  if (err.isTokenExpired) {
    await markNeedsReconnect(organizationId, err.message);
    return new MetaSyncError("O acesso à conta Meta expirou. Reconecte a conta em Configurações → Integrações → Meta Ads.", 409, { code: err.code, subcode: err.subcode });
  }
  if (err.isRateLimit) return new MetaSyncError("A Meta limitou as requisições. Tente novamente em alguns minutos.", 429, { code: err.code });
  if (err.isPermission) return new MetaSyncError(`A Meta negou a permissão: ${err.message}`, 403, { code: err.code });
  return new MetaSyncError(`Erro da Meta: ${err.message}`, 502, { code: err.code, subcode: err.subcode });
}

async function tokenFor(organizationId) {
  const connection = await getConnectedConnection(organizationId);
  if (!connection) throw new MetaSyncError("Conta Meta Ads não conectada (ou precisa ser reconectada).", 409);
  if (!connection.access_token_encrypted) throw new MetaSyncError("Conexão Meta sem token. Reconecte a conta.", 409);
  return { connection, token: decryptToken(connection.access_token_encrypted) };
}

async function getPublication(organizationId, campaignId) {
  const r = await query(
    `select * from public.meta_ads_campaign_publications where organization_id = $1 and campaign_id = $2 limit 1`,
    [organizationId, campaignId]
  );
  return r.rows[0] || null;
}

// ---------------------------------------------------------------------------
// Insights
// ---------------------------------------------------------------------------
async function fetchDailyInsights({ token, metaCampaignId, since, until }) {
  const rows = [];
  let after;
  for (let page = 0; page < 10; page++) {
    const res = await graphRequest({
      path: `/${metaCampaignId}/insights`,
      token,
      params: { fields: INSIGHT_FIELDS, level: "campaign", time_increment: 1, time_range: { since, until }, limit: 500, after }
    });
    rows.push(...(res.data || []));
    after = res.paging?.next ? res.paging?.cursors?.after : null;
    if (!after) break;
  }
  return rows;
}

async function upsertMetric(organizationId, campaignId, m) {
  await query(
    `insert into public.paid_traffic_metrics
       (organization_id, campaign_id, report_date, impressions, clicks, leads, amount_spent, cpl, ctr, cpc, source)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'meta_api')
     on conflict (campaign_id, report_date) where source = 'meta_api'
     do update set impressions = excluded.impressions, clicks = excluded.clicks, leads = excluded.leads,
                   amount_spent = excluded.amount_spent, cpl = excluded.cpl, ctr = excluded.ctr, cpc = excluded.cpc`,
    [organizationId, campaignId, m.report_date, m.impressions, m.clicks, m.leads, m.amount_spent, m.cpl, m.ctr, m.cpc]
  );
}

async function syncOnePublication({ organizationId, publication, token, since, until }) {
  const summary = { campaign_id: publication.campaign_id, rows: 0, error: null };
  try {
    const raw = await fetchDailyInsights({ token, metaCampaignId: publication.meta_campaign_id, since, until });
    for (const row of raw) {
      if (!row.date_start) continue;
      await upsertMetric(organizationId, publication.campaign_id, mapInsightRow(row));
      summary.rows += 1;
    }
    await query(
      `update public.meta_ads_campaign_publications set last_insights_sync_at = now(), last_insights_error = null where id = $1`,
      [publication.id]
    );
  } catch (err) {
    const translated = await translateGraphError(err, organizationId);
    summary.error = translated.message;
    await query(
      `update public.meta_ads_campaign_publications set last_insights_error = $2 where id = $1`,
      [publication.id, translated.message]
    ).catch(() => null);
    if (translated instanceof MetaSyncError && translated.httpStatus === 409) summary.fatal = true; // token: não adianta seguir
  }
  return summary;
}

/** Sincroniza uma campanha ou todas as publicadas da empresa. */
export async function syncOrganizationInsights({ organizationId, campaignId = null, days = 7 }) {
  await ensureSchema();
  const { token } = await tokenFor(organizationId);
  const { since, until, days: usedDays } = buildWindow(days);

  const pubs = await query(
    `select * from public.meta_ads_campaign_publications
      where organization_id = $1 and meta_campaign_id is not null and status in ('published','paused')
        and ($2::uuid is null or campaign_id = $2::uuid)`,
    [organizationId, campaignId]
  );
  if (campaignId && pubs.rows.length === 0) {
    throw new MetaSyncError("Esta campanha ainda não foi publicada na Meta.", 404);
  }

  const results = [];
  for (const publication of pubs.rows) {
    const r = await syncOnePublication({ organizationId, publication, token, since, until });
    results.push(r);
    if (r.fatal) break;
  }
  return {
    since, until, days: usedDays,
    campaigns: results.map(({ campaign_id, rows, error }) => ({ campaign_id, rows, error })),
    synced_rows: results.reduce((s, r) => s + r.rows, 0),
    errors: results.filter((r) => r.error).length
  };
}

let autoSyncRunning = false;
export async function runAutoSync(days = 7) {
  if (autoSyncRunning) return null;
  autoSyncRunning = true;
  try {
    await ensureSchema();
    const orgs = await query(`select distinct organization_id from public.meta_ads_connections where status = 'connected'`);
    let rows = 0, errors = 0;
    for (const { organization_id } of orgs.rows) {
      try {
        const r = await syncOrganizationInsights({ organizationId: organization_id, days });
        rows += r.synced_rows; errors += r.errors;
      } catch (err) {
        errors += 1;
        console.error(`[meta-sync] empresa ${organization_id}:`, err.message);
      }
    }
    console.log(`[meta-sync] ${orgs.rows.length} empresa(s), ${rows} linha(s), ${errors} erro(s).`);
    return { organizations: orgs.rows.length, rows, errors };
  } finally {
    autoSyncRunning = false;
  }
}

/** Agenda a sincronização automática. META_INSIGHTS_AUTO_SYNC_HOURS=0 desliga (padrão: 6). */
export function startInsightsAutoSync(env = process.env) {
  const hours = env.META_INSIGHTS_AUTO_SYNC_HOURS === undefined ? 6 : Number(env.META_INSIGHTS_AUTO_SYNC_HOURS);
  if (!Number.isFinite(hours) || hours <= 0) {
    console.log("[meta-sync] sincronização automática desligada.");
    return null;
  }
  const tick = () => runAutoSync().catch((e) => console.error("[meta-sync] falha:", e.message));
  const first = setTimeout(tick, 60_000);
  const timer = setInterval(tick, hours * 3600_000);
  first.unref?.(); timer.unref?.();
  console.log(`[meta-sync] sincronização automática a cada ${hours}h.`);
  return timer;
}

// ---------------------------------------------------------------------------
// Status (pausar / ativar na Meta)
// ---------------------------------------------------------------------------
/**
 * Reflete o status do be2bdr na Meta quando a campanha foi publicada.
 * Lança MetaSyncError se a Meta recusar — o chamador NÃO deve gravar o novo
 * status local nesse caso (senão o be2bdr mostraria "pausada" com gasto rodando).
 */
export async function syncMetaCampaignStatus({ organizationId, campaignId, status }) {
  const target = metaStatusFor(status);
  if (!target) return { synced: false, reason: "status_not_synced" };

  await ensureSchema();
  const publication = await getPublication(organizationId, campaignId);
  if (!publication?.meta_campaign_id) return { synced: false, reason: "not_published" };

  const { token } = await tokenFor(organizationId);
  const ids = [publication.meta_campaign_id, publication.meta_adset_id, publication.meta_ad_id].filter(Boolean);
  try {
    // campanha → conjunto → anúncio: para ativar, os três precisam estar ACTIVE.
    for (const id of ids) await graphRequest({ method: "POST", path: `/${id}`, token, params: { status: target } });
  } catch (err) {
    throw await translateGraphError(err, organizationId);
  }
  await query(
    `update public.meta_ads_campaign_publications set status = $3, updated_at = now() where organization_id = $1 and campaign_id = $2`,
    [organizationId, campaignId, target === "ACTIVE" ? "published" : "paused"]
  );
  return { synced: true, meta_status: target };
}

// ---------------------------------------------------------------------------
// Publicação + revisão do anúncio
// ---------------------------------------------------------------------------
export async function getPublicationInfo({ organizationId, campaignId, refresh = false }) {
  await ensureSchema();
  const publication = await getPublication(organizationId, campaignId);
  const conn = await query(`select status from public.meta_ads_connections where organization_id = $1 limit 1`, [organizationId]);
  const connectionStatus = conn.rows[0]?.status || "pending";

  const out = {
    connection_status: connectionStatus,
    publication: publication && {
      status: publication.status,
      meta_campaign_id: publication.meta_campaign_id,
      meta_adset_id: publication.meta_adset_id,
      meta_ad_id: publication.meta_ad_id,
      published_at: publication.published_at,
      last_error: publication.last_error,
      last_insights_sync_at: publication.last_insights_sync_at,
      last_insights_error: publication.last_insights_error
    },
    ad_review: null,
    ad_review_error: null
  };

  if (refresh && publication?.meta_ad_id && connectionStatus === "connected") {
    try {
      const { token } = await tokenFor(organizationId);
      const ad = await graphRequest({ path: `/${publication.meta_ad_id}`, token, params: { fields: "effective_status,configured_status,issues_info,ad_review_feedback" } });
      out.ad_review = {
        effective_status: ad.effective_status || null,
        configured_status: ad.configured_status || null,
        issues: ad.issues_info || [],
        feedback: ad.ad_review_feedback || null
      };
    } catch (err) {
      out.ad_review_error = (await translateGraphError(err, organizationId)).message;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Rotas
// ---------------------------------------------------------------------------
function ok(res, data = {}) { return res.json({ success: true, ...data }); }
function fail(res, status, message, details = null) {
  return res.status(status).json({ success: false, message, details: process.env.NODE_ENV === "production" ? undefined : details });
}
function orgOf(req) {
  return req.header("x-organization-id") || req.query.organization_id || req.body?.organization_id || null;
}
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function handleError(res, err, fallbackMessage) {
  if (err instanceof MetaSyncError) return fail(res, err.httpStatus, err.message, err.details);
  console.error(`[meta-sync] ${fallbackMessage}:`, err.message);
  return fail(res, 500, fallbackMessage, err.message);
}

export function registerMetaSyncRoutes(app) {
  app.post("/api/meta-ads/sync-insights", async (req, res) => {
    const organizationId = orgOf(req);
    if (!organizationId) return fail(res, 400, "organization_id é obrigatório.");
    if (req.body?.campaign_id && !UUID_RE.test(String(req.body.campaign_id))) return fail(res, 400, "campaign_id inválido.");
    try {
      const data = await syncOrganizationInsights({ organizationId, campaignId: req.body?.campaign_id || null, days: req.body?.days ?? 7 });
      return ok(res, { message: `${data.synced_rows} linha(s) de métricas sincronizada(s).`, data });
    } catch (err) {
      return handleError(res, err, "Não foi possível sincronizar as métricas da Meta.");
    }
  });

  app.get("/api/meta-ads/campaigns/:campaignId/publication", async (req, res) => {
    const organizationId = orgOf(req);
    if (!organizationId) return fail(res, 400, "organization_id é obrigatório.");
    if (!UUID_RE.test(req.params.campaignId)) return fail(res, 400, "campaign_id inválido.");
    try {
      const data = await getPublicationInfo({ organizationId, campaignId: req.params.campaignId, refresh: req.query.refresh === "1" });
      return ok(res, { data });
    } catch (err) {
      return handleError(res, err, "Não foi possível consultar a publicação da campanha.");
    }
  });
}
