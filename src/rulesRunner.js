/**
 * Regras automáticas do Tráfego Pago: persistência, execução e rotas.
 *
 * Segurança operacional:
 *  - ação padrão é NOTIFICAR (registra no histórico da campanha e no log de execuções);
 *  - PAUSAR é opt-in por regra e pode ser desligado no servidor (RULES_ALLOW_PAUSE=false);
 *  - cooldown por regra+campanha e limite diário por regra (falhas também contam,
 *    para não ficar tentando pausar na Meta a cada execução);
 *  - `dry_run` mostra o que aconteceria, sem agir;
 *  - só avalia campanhas com status "ativa".
 *
 * Rode UMA instância do agendador (mesma premissa da sincronização de insights).
 */
import { query } from "./db.js";
import { ensureSchema } from "./migrate.js";
import { MetaSyncError, syncMetaCampaignStatus } from "./metaSync.js";
import {
  RULE_METRICS, canAct, computeSnapshot, dayInTimezone, describeTrigger, evaluateRule, isUuid, validateRuleInput
} from "./rulesEngine.js";

const TZ = () => process.env.RULES_TIMEZONE || "America/Sao_Paulo";

const RULE_COLUMNS = ["campaign_id", "name", "metric", "operator", "threshold", "window_days", "min_spend", "action", "cooldown_hours", "max_actions_per_day", "is_active"];

// ---------------------------------------------------------------------------
// Persistência
// ---------------------------------------------------------------------------
export async function listRules(organizationId) {
  await ensureSchema();
  const r = await query(
    `select r.*, c.name as campaign_name
       from public.paid_traffic_rules r
       left join public.paid_traffic_campaigns c on c.id = r.campaign_id
      where r.organization_id = $1
      order by r.created_at desc`,
    [organizationId]
  );
  return r.rows;
}

export async function createRule(organizationId, input, createdBy = null) {
  await ensureSchema();
  const v = validateRuleInput(input);
  if (!v.ok) return { ok: false, errors: v.errors };
  if (v.value.campaign_id) {
    const c = await query(`select 1 from public.paid_traffic_campaigns where id = $1 and organization_id = $2`, [v.value.campaign_id, organizationId]);
    if (c.rowCount === 0) return { ok: false, errors: ["Campanha não encontrada nesta empresa."] };
  }
  const cols = RULE_COLUMNS.filter((c) => c in v.value);
  const r = await query(
    `insert into public.paid_traffic_rules (organization_id, created_by, ${cols.join(", ")})
     values ($1, $2, ${cols.map((_, i) => `$${i + 3}`).join(", ")}) returning *`,
    [organizationId, createdBy, ...cols.map((c) => v.value[c])]
  );
  return { ok: true, rule: r.rows[0] };
}

export async function updateRule(organizationId, id, input) {
  await ensureSchema();
  const v = validateRuleInput(input, { partial: true });
  if (!v.ok) return { ok: false, errors: v.errors };
  const cols = RULE_COLUMNS.filter((c) => c in v.value);
  if (cols.length === 0) return { ok: false, errors: ["Nada para atualizar."] };
  if (v.value.campaign_id) {
    const c = await query(`select 1 from public.paid_traffic_campaigns where id = $1 and organization_id = $2`, [v.value.campaign_id, organizationId]);
    if (c.rowCount === 0) return { ok: false, errors: ["Campanha não encontrada nesta empresa."] };
  }
  const r = await query(
    `update public.paid_traffic_rules set ${cols.map((c, i) => `${c} = $${i + 3}`).join(", ")}, updated_at = now()
      where id = $1 and organization_id = $2 returning *`,
    [id, organizationId, ...cols.map((c) => v.value[c])]
  );
  return r.rowCount === 0 ? { ok: false, notFound: true, errors: ["Regra não encontrada."] } : { ok: true, rule: r.rows[0] };
}

export async function deleteRule(organizationId, id) {
  await ensureSchema();
  const r = await query(`delete from public.paid_traffic_rules where id = $1 and organization_id = $2`, [id, organizationId]);
  return r.rowCount > 0;
}

export async function listRuns(organizationId, limit = 50) {
  await ensureSchema();
  const n = Math.max(1, Math.min(Number(limit) || 50, 200));
  const r = await query(
    `select run.*, r.name as rule_name, c.name as campaign_name
       from public.paid_traffic_rule_runs run
       join public.paid_traffic_rules r on r.id = run.rule_id
       left join public.paid_traffic_campaigns c on c.id = run.campaign_id
      where run.organization_id = $1
      order by run.created_at desc limit $2`,
    [organizationId, n]
  );
  return r.rows;
}

// ---------------------------------------------------------------------------
// Execução
// ---------------------------------------------------------------------------
async function addHistory(organizationId, campaignId, eventType, description, metadata) {
  await query(
    `insert into public.paid_traffic_history (campaign_id, organization_id, event_type, description, metadata)
     values ($1, $2, $3, $4, $5::jsonb)`,
    [campaignId, organizationId, eventType, description, JSON.stringify(metadata || {})]
  ).catch((e) => console.error("[rules] histórico:", e.message));
}

async function loadContext(organizationId, tz, today) {
  const campaigns = await query(
    `select id, name, status, start_date::text as start_date, current_balance,
            to_char(created_at at time zone $2, 'YYYY-MM-DD') as created_day
       from public.paid_traffic_campaigns
      where organization_id = $1 and status = 'ativa'`,
    [organizationId, tz]
  );
  const ids = campaigns.rows.map((c) => c.id);
  if (ids.length === 0) return { campaigns: [], metrics: [], leads: [], runs: [] };

  const metrics = await query(
    `select campaign_id, report_date::text as report_date, amount_spent, impressions, clicks, remaining_balance, source
       from public.paid_traffic_metrics
      where organization_id = $1 and campaign_id = any($2::uuid[])
        and report_date >= ($3::date - 60)`,
    [organizationId, ids, today]
  );
  const leads = await query(
    `select campaign_id, status, to_char(created_at at time zone $3, 'YYYY-MM-DD') as created_day
       from public.paid_traffic_leads
      where organization_id = $1 and campaign_id = any($2::uuid[])
        and created_at >= now() - interval '180 days'`,
    [organizationId, ids, tz]
  );
  const runs = await query(
    `select rule_id, campaign_id, created_at from public.paid_traffic_rule_runs
      where organization_id = $1 and created_at >= now() - interval '30 days'`,
    [organizationId]
  );
  return { campaigns: campaigns.rows, metrics: metrics.rows, leads: leads.rows, runs: runs.rows };
}

function pauseAllowed() {
  return String(process.env.RULES_ALLOW_PAUSE ?? "true").toLowerCase() !== "false";
}

/**
 * @param {{ organizationId: string, dryRun?: boolean, now?: Date }} opts
 */
export async function runRulesForOrganization({ organizationId, dryRun = false, now = new Date() }) {
  await ensureSchema();
  const tz = TZ();
  const today = dayInTimezone(now, tz);
  const rulesRes = await query(`select * from public.paid_traffic_rules where organization_id = $1 and is_active`, [organizationId]);
  const rules = rulesRes.rows;
  const summary = { dry_run: dryRun, evaluated: 0, not_evaluable: 0, results: [] };
  if (rules.length === 0) return summary;

  const ctx = await loadContext(organizationId, tz, today);
  const snapshots = new Map(); // `${campaignId}|${windowDays}`

  const snapshotOf = (campaign, windowDays) => {
    const key = `${campaign.id}|${windowDays}`;
    if (!snapshots.has(key)) {
      snapshots.set(key, computeSnapshot({
        campaign,
        metricRows: ctx.metrics.filter((m) => m.campaign_id === campaign.id),
        leadRows: ctx.leads.filter((l) => l.campaign_id === campaign.id),
        today, windowDays
      }));
    }
    return snapshots.get(key);
  };

  // Ações já tomadas (cooldown/limite). Atualizado em memória durante a execução.
  const runs = ctx.runs.map((r) => ({ rule_id: r.rule_id, campaign_id: r.campaign_id, created_at: new Date(r.created_at) }));

  for (const rule of rules) {
    const targets = ctx.campaigns.filter((c) => !rule.campaign_id || c.id === rule.campaign_id);
    for (const campaign of targets) {
      const snap = snapshotOf(campaign, rule.window_days);
      const ev = evaluateRule(rule, snap);
      if (!ev.evaluable) { summary.not_evaluable += 1; continue; }
      summary.evaluated += 1;
      if (!ev.triggered) continue;

      const mine = runs.filter((r) => r.rule_id === rule.id);
      const lastActionAt = runs.filter((r) => r.rule_id === rule.id && r.campaign_id === campaign.id)
        .reduce((max, r) => (!max || r.created_at > max ? r.created_at : max), null);
      const actionsLast24h = mine.filter((r) => now.getTime() - r.created_at.getTime() < 24 * 3600 * 1000).length;
      const gate = canAct(rule, { lastActionAt, actionsLast24h, now });

      const message = describeTrigger(rule, ev.value, campaign.name, rule.window_days);
      const base = {
        rule_id: rule.id, rule_name: rule.name, campaign_id: campaign.id, campaign_name: campaign.name,
        value: ev.value === Infinity ? null : ev.value, infinite: ev.value === Infinity, threshold: Number(rule.threshold),
        action: rule.action, message
      };

      if (!gate.ok) { summary.results.push({ ...base, outcome: gate.reason === "em cooldown" ? "skipped_cooldown" : "skipped_limit" }); continue; }
      if (dryRun) { summary.results.push({ ...base, outcome: "would_act" }); continue; }

      const outcome = await executeAction({ organizationId, rule, campaign, message, value: ev.value });
      runs.push({ rule_id: rule.id, campaign_id: campaign.id, created_at: now });
      summary.results.push({ ...base, ...outcome });
    }
    if (!dryRun) await query(`update public.paid_traffic_rules set last_run_at = now() where id = $1`, [rule.id]).catch(() => null);
  }
  return summary;
}

async function logRun({ organizationId, rule, campaign, status, value, message }) {
  await query(
    `insert into public.paid_traffic_rule_runs (rule_id, organization_id, campaign_id, status, metric_value, threshold, action, message)
     values ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [rule.id, organizationId, campaign.id, status, Number.isFinite(value) ? value : null, rule.threshold, rule.action, message]
  );
}

async function executeAction({ organizationId, rule, campaign, message, value }) {
  const wantsPause = rule.action === "pause";

  if (wantsPause && pauseAllowed()) {
    try {
      // Pausa na Meta primeiro; se a Meta recusar, o status local não muda.
      await syncMetaCampaignStatus({ organizationId, campaignId: campaign.id, status: "pausada" });
      const upd = await query(
        `update public.paid_traffic_campaigns set status = 'pausada' where id = $1 and organization_id = $2 and status = 'ativa' returning id`,
        [campaign.id, organizationId]
      );
      const done = `${message} Campanha PAUSADA automaticamente.`;
      await logRun({ organizationId, rule, campaign, status: "paused", value, message: done });
      if (upd.rowCount > 0) {
        await addHistory(organizationId, campaign.id, "status_change", done, { rule_id: rule.id, status: "pausada", automatic: true });
      }
      return { outcome: "paused", message: done };
    } catch (err) {
      const reason = err instanceof MetaSyncError ? err.message : `Erro inesperado: ${err.message}`;
      const failed = `${message} Não foi possível pausar: ${reason}`;
      await logRun({ organizationId, rule, campaign, status: "failed", value, message: failed });
      await addHistory(organizationId, campaign.id, "rule_failed", failed, { rule_id: rule.id });
      return { outcome: "failed", message: failed };
    }
  }

  const suffix = wantsPause ? " (pausa automática desativada no servidor — apenas notificado)" : "";
  const text = `${message}${suffix}`;
  await logRun({ organizationId, rule, campaign, status: "notified", value, message: text });
  await addHistory(organizationId, campaign.id, "rule_triggered", text, { rule_id: rule.id, metric: rule.metric });
  return { outcome: "notified", message: text };
}

let schedulerRunning = false;
export async function runAllOrganizations() {
  if (schedulerRunning) return null;
  schedulerRunning = true;
  try {
    await ensureSchema();
    const orgs = await query(`select distinct organization_id from public.paid_traffic_rules where is_active`);
    let triggered = 0, errors = 0;
    for (const { organization_id } of orgs.rows) {
      try {
        const s = await runRulesForOrganization({ organizationId: organization_id });
        triggered += s.results.filter((r) => ["notified", "paused", "failed"].includes(r.outcome)).length;
      } catch (err) {
        errors += 1;
        console.error(`[rules] empresa ${organization_id}:`, err.message);
      }
    }
    console.log(`[rules] ${orgs.rows.length} empresa(s), ${triggered} ação(ões), ${errors} erro(s).`);
    return { organizations: orgs.rows.length, triggered, errors };
  } finally {
    schedulerRunning = false;
  }
}

/** RULES_EVAL_INTERVAL_MINUTES: padrão 60; 0 desliga. */
export function startRulesScheduler(env = process.env) {
  const minutes = env.RULES_EVAL_INTERVAL_MINUTES === undefined ? 60 : Number(env.RULES_EVAL_INTERVAL_MINUTES);
  if (!Number.isFinite(minutes) || minutes <= 0) {
    console.log("[rules] agendador de regras desligado.");
    return null;
  }
  const tick = () => runAllOrganizations().catch((e) => console.error("[rules] falha:", e.message));
  const first = setTimeout(tick, 120_000);
  const timer = setInterval(tick, minutes * 60_000);
  first.unref?.(); timer.unref?.();
  console.log(`[rules] avaliação de regras a cada ${minutes} min.`);
  return timer;
}

// ---------------------------------------------------------------------------
// Rotas
// ---------------------------------------------------------------------------
function ok(res, data = {}) { return res.json({ success: true, ...data }); }
function fail(res, status, message, details = null) {
  return res.status(status).json({ success: false, message, details: process.env.NODE_ENV === "production" ? undefined : details });
}
const orgOf = (req) => req.header("x-organization-id") || req.query.organization_id || req.body?.organization_id || null;

export function registerRulesRoutes(app) {
  app.get("/api/paid-traffic/rules", async (req, res) => {
    const org = orgOf(req);
    if (!org) return fail(res, 400, "organization_id é obrigatório.");
    try {
      return ok(res, { data: { rules: await listRules(org), metrics: RULE_METRICS, pause_enabled: pauseAllowed() } });
    } catch (e) { return fail(res, 500, "Não foi possível listar as regras.", e.message); }
  });

  app.get("/api/paid-traffic/rules/runs", async (req, res) => {
    const org = orgOf(req);
    if (!org) return fail(res, 400, "organization_id é obrigatório.");
    try { return ok(res, { data: await listRuns(org, req.query.limit) }); }
    catch (e) { return fail(res, 500, "Não foi possível listar as execuções.", e.message); }
  });

  app.post("/api/paid-traffic/rules/run", async (req, res) => {
    const org = orgOf(req);
    if (!org) return fail(res, 400, "organization_id é obrigatório.");
    try {
      const data = await runRulesForOrganization({ organizationId: org, dryRun: req.body?.dry_run === true });
      return ok(res, { data });
    } catch (e) { return fail(res, 500, "Não foi possível executar as regras.", e.message); }
  });

  app.post("/api/paid-traffic/rules", async (req, res) => {
    const org = orgOf(req);
    if (!org) return fail(res, 400, "organization_id é obrigatório.");
    try {
      const r = await createRule(org, req.body || {}, req.auth?.userId || null);
      return r.ok ? ok(res, { data: r.rule }) : fail(res, 400, r.errors[0], { errors: r.errors });
    } catch (e) { return fail(res, 500, "Não foi possível criar a regra.", e.message); }
  });

  app.patch("/api/paid-traffic/rules/:id", async (req, res) => {
    const org = orgOf(req);
    if (!org) return fail(res, 400, "organization_id é obrigatório.");
    if (!isUuid(req.params.id)) return fail(res, 400, "id inválido.");
    try {
      const r = await updateRule(org, req.params.id, req.body || {});
      if (r.ok) return ok(res, { data: r.rule });
      return fail(res, r.notFound ? 404 : 400, r.errors[0], { errors: r.errors });
    } catch (e) { return fail(res, 500, "Não foi possível atualizar a regra.", e.message); }
  });

  app.delete("/api/paid-traffic/rules/:id", async (req, res) => {
    const org = orgOf(req);
    if (!org) return fail(res, 400, "organization_id é obrigatório.");
    if (!isUuid(req.params.id)) return fail(res, 400, "id inválido.");
    try {
      return (await deleteRule(org, req.params.id)) ? ok(res) : fail(res, 404, "Regra não encontrada.");
    } catch (e) { return fail(res, 500, "Não foi possível remover a regra.", e.message); }
  });
}
