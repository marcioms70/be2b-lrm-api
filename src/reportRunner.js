/**
 * Relatório semanal por e-mail: persistência do agendamento, geração, envio e rotas.
 *
 * Segurança:
 *  - só administradores da empresa (owner/admin/superadmin) leem/alteram o agendamento;
 *  - até 5 destinatários, e-mail validado; "enviar teste" só para os destinatários JÁ salvos,
 *    no máximo 1 por minuto;
 *  - envio agendado reivindicado de forma atômica no banco (duas instâncias não enviam em duplicidade)
 *    e com limite de tentativas por dia.
 */
import { query } from "./db.js";
import { ensureSchema } from "./migrate.js";
import { isOrgAdmin } from "./auth.js";
import { emailConfig, sendEmail, EmailError } from "./emailSender.js";
import { MAX_ATTEMPTS_PER_DAY, buildWeeklyReport, isDue, localParts, renderReportEmail, reportWindow, validateScheduleInput } from "./weeklyReport.js";
import { isUuid } from "./rulesEngine.js";

const DEFAULT_TZ = "America/Sao_Paulo";

// ---------------------------------------------------------------------------
// Persistência
// ---------------------------------------------------------------------------
export async function getSchedule(organizationId) {
  await ensureSchema();
  const r = await query(`select * from public.paid_traffic_report_schedules where organization_id = $1`, [organizationId]);
  return r.rows[0] || null;
}

export async function saveSchedule(organizationId, input, userId = null) {
  await ensureSchema();
  const v = validateScheduleInput(input);
  if (!v.ok) return { ok: false, errors: v.errors };
  const cols = Object.keys(v.value);
  if (cols.length === 0) return { ok: false, errors: ["Nada para atualizar."] };
  // upsert: cria com os padrões da tabela e aplica só o que veio
  const insertCols = ["organization_id", "created_by", ...cols];
  const params = [organizationId, userId, ...cols.map((c) => v.value[c])];
  const r = await query(
    `insert into public.paid_traffic_report_schedules (${insertCols.join(", ")})
     values (${insertCols.map((_, i) => `$${i + 1}`).join(", ")})
     on conflict (organization_id) do update set ${cols.map((c) => `${c} = excluded.${c}`).join(", ")}, updated_at = now()
     returning *`,
    params
  );
  return { ok: true, schedule: r.rows[0] };
}

// ---------------------------------------------------------------------------
// Geração
// ---------------------------------------------------------------------------
async function loadReport(organizationId, tz, now) {
  const window = reportWindow(now, tz);
  const since = window.prev.since, until = window.cur.until;
  const campaigns = await query(`select id, name, status from public.paid_traffic_campaigns where organization_id = $1`, [organizationId]);
  const metrics = await query(
    `select campaign_id, report_date::text as report_date, amount_spent, impressions, clicks, source
       from public.paid_traffic_metrics where organization_id = $1 and report_date between $2::date and $3::date`,
    [organizationId, since, until]
  );
  const leads = await query(
    `select campaign_id, status, sent_to_crm_at is not null as sent_to_crm, to_char(created_at at time zone $4, 'YYYY-MM-DD') as created_day
       from public.paid_traffic_leads where organization_id = $1
        and created_at >= ($2::date)::timestamp at time zone $4 and created_at < (($3::date) + 1)::timestamp at time zone $4`,
    [organizationId, since, until, tz]
  );
  const events = await query(
    `select message, to_char(created_at at time zone $4, 'YYYY-MM-DD') as created_day
       from public.paid_traffic_rule_runs where organization_id = $1 and status in ('notified','paused','failed')
        and created_at >= ($2::date)::timestamp at time zone $4 and created_at < (($3::date) + 1)::timestamp at time zone $4
      order by created_at desc limit 20`,
    [organizationId, since, until, tz]
  ).catch(() => ({ rows: [] })); // tabela de regras pode ainda não existir em bancos antigos
  return buildWeeklyReport({ campaigns: campaigns.rows, metricRows: metrics.rows, leadRows: leads.rows, ruleEvents: events.rows, window });
}

export async function renderForOrganization(organizationId, { orgName, now = new Date(), timezone = DEFAULT_TZ } = {}) {
  await ensureSchema();
  const report = await loadReport(organizationId, timezone, now);
  return { report, email: renderReportEmail(report, { orgName, appUrl: process.env.FRONTEND_URL }) };
}

// ---------------------------------------------------------------------------
// Envio
// ---------------------------------------------------------------------------
async function deliver(schedule, now) {
  const { email } = await renderForOrganization(schedule.organization_id, { orgName: schedule.org_name, now, timezone: schedule.timezone || DEFAULT_TZ });
  return sendEmail({ to: schedule.recipients, ...email });
}

/** Envia o relatório agora para os destinatários SALVOS (teste manual, no máx. 1 por minuto). */
export async function sendTest(organizationId, now = new Date()) {
  await ensureSchema();
  if (!emailConfig().enabled) return { ok: false, status: 503, message: "O envio de e-mail não está configurado no servidor." };
  const claimed = await query(
    `update public.paid_traffic_report_schedules set last_test_at = now()
      where organization_id = $1 and (last_test_at is null or last_test_at < now() - interval '60 seconds') returning *`,
    [organizationId]
  );
  if (claimed.rowCount === 0) {
    const exists = await getSchedule(organizationId);
    return exists ? { ok: false, status: 429, message: "Aguarde um minuto antes de enviar outro teste." } : { ok: false, status: 400, message: "Salve os destinatários antes de enviar um teste." };
  }
  const schedule = claimed.rows[0];
  if (!schedule.recipients?.length) return { ok: false, status: 400, message: "Cadastre ao menos um destinatário." };
  try {
    await deliver(schedule, now);
    return { ok: true, sent_to: schedule.recipients.length };
  } catch (err) {
    return { ok: false, status: err instanceof EmailError && err.status === 422 ? 422 : 502, message: err.message };
  }
}

let running = false;
/** Envia os relatórios devidos agora. Pode rodar em várias instâncias sem duplicar (claim atômico). */
export async function runDueReports(now = new Date()) {
  if (running) return null;
  running = true;
  const summary = { due: 0, sent: 0, failed: 0 };
  try {
    await ensureSchema();
    if (!emailConfig().enabled) return summary;
    const all = await query(`select * from public.paid_traffic_report_schedules where is_active and coalesce(array_length(recipients, 1), 0) > 0`);
    for (const s of all.rows) {
      if (!isDue(s, now)) continue;
      summary.due += 1;
      const today = localParts(now, s.timezone || DEFAULT_TZ).day;
      // Reivindica: só uma instância consegue, e só dentro do limite de tentativas do dia.
      const claim = await query(
        `update public.paid_traffic_report_schedules
            set attempts_day = $2, attempts = case when attempts_day = $2 then attempts + 1 else 1 end
          where id = $1
            and (attempts_day is distinct from $2 or attempts < $3)
            and (last_sent_at is null or to_char(last_sent_at at time zone timezone, 'YYYY-MM-DD') <> $2)
        returning *`,
        [s.id, today, MAX_ATTEMPTS_PER_DAY]
      );
      if (claim.rowCount === 0) continue;
      try {
        await deliver(claim.rows[0], now);
        // usa o mesmo relógio do isDue (injetável) e não o now() do banco
        await query(`update public.paid_traffic_report_schedules set last_sent_at = $2, last_status = 'sent', last_error = null where id = $1`, [s.id, now]);
        summary.sent += 1;
      } catch (err) {
        await query(`update public.paid_traffic_report_schedules set last_status = 'failed', last_error = $2 where id = $1`, [s.id, String(err.message).slice(0, 500)]);
        summary.failed += 1;
        console.error(`[report] empresa ${s.organization_id}: ${err.message}`);
      }
    }
    if (summary.due) console.log(`[report] ${summary.due} devido(s), ${summary.sent} enviado(s), ${summary.failed} falha(s).`);
    return summary;
  } finally {
    running = false;
  }
}

/** REPORT_EVAL_INTERVAL_MINUTES: padrão 15; 0 desliga. */
export function startReportScheduler(env = process.env) {
  const minutes = env.REPORT_EVAL_INTERVAL_MINUTES === undefined ? 15 : Number(env.REPORT_EVAL_INTERVAL_MINUTES);
  if (!Number.isFinite(minutes) || minutes <= 0) { console.log("[report] agendador de relatórios desligado."); return null; }
  if (!emailConfig(env).enabled) console.warn("[report] RESEND_API_KEY/REPORT_FROM_EMAIL ausentes: relatórios por e-mail não serão enviados.");
  const tick = () => runDueReports().catch((e) => console.error("[report] falha:", e.message));
  const first = setTimeout(tick, 150_000);
  const timer = setInterval(tick, minutes * 60_000);
  first.unref?.(); timer.unref?.();
  console.log(`[report] verificação de relatórios a cada ${minutes} min.`);
  return timer;
}

// ---------------------------------------------------------------------------
// Rotas (somente administradores da empresa)
// ---------------------------------------------------------------------------
function ok(res, data = {}) { return res.json({ success: true, ...data }); }
function fail(res, status, message, details = null) {
  return res.status(status).json({ success: false, message, details: process.env.NODE_ENV === "production" ? undefined : details });
}
const orgOf = (req) => req.header("x-organization-id") || req.query.organization_id || req.body?.organization_id || null;

function guard(req, res) {
  const org = orgOf(req);
  if (!org) { fail(res, 400, "organization_id é obrigatório."); return null; }
  if (!isUuid(org)) { fail(res, 400, "organization_id inválido."); return null; }
  if (!isOrgAdmin(req)) { fail(res, 403, "Apenas administradores da empresa podem configurar o relatório semanal."); return null; }
  return org;
}

export function registerReportRoutes(app) {
  app.get("/api/paid-traffic/report-schedule", async (req, res) => {
    const org = guard(req, res); if (!org) return;
    try { return ok(res, { data: { schedule: await getSchedule(org), email_enabled: emailConfig().enabled, max_recipients: 5 } }); }
    catch (e) { return fail(res, 500, "Não foi possível carregar o agendamento.", e.message); }
  });

  app.put("/api/paid-traffic/report-schedule", async (req, res) => {
    const org = guard(req, res); if (!org) return;
    try {
      const r = await saveSchedule(org, req.body || {}, req.auth?.userId || null);
      return r.ok ? ok(res, { data: r.schedule }) : fail(res, 400, r.errors[0], { errors: r.errors });
    } catch (e) { return fail(res, 500, "Não foi possível salvar o agendamento.", e.message); }
  });

  app.post("/api/paid-traffic/report-schedule/preview", async (req, res) => {
    const org = guard(req, res); if (!org) return;
    try {
      const s = await getSchedule(org);
      const { report, email } = await renderForOrganization(org, { orgName: s?.org_name ?? req.body?.org_name, timezone: s?.timezone || DEFAULT_TZ });
      return ok(res, { data: { subject: email.subject, html: email.html, text: email.text, empty: report.empty, window: report.window } });
    } catch (e) { return fail(res, 500, "Não foi possível gerar a prévia.", e.message); }
  });

  app.post("/api/paid-traffic/report-schedule/send-test", async (req, res) => {
    const org = guard(req, res); if (!org) return;
    try {
      const r = await sendTest(org);
      return r.ok ? ok(res, { data: { sent_to: r.sent_to } }) : fail(res, r.status, r.message);
    } catch (e) { return fail(res, 500, "Não foi possível enviar o teste.", e.message); }
  });
}
