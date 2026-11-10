/**
 * Integração com Postgres REAL (SQL das Fases 2 e 3). Só roda com TEST_DATABASE_URL:
 *   TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:5432/lrm_test npm test
 * Cria as tabelas-base se faltarem (mesmo formato do be2bdr) e limpa os dados da empresa de teste.
 * A Graph API é simulada via globalThis.fetch.
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

const DB_URL = process.env.TEST_DATABASE_URL;
const skip = !DB_URL;

const ORG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_ORG = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CAMP = "c0000000-0000-4000-8000-000000000001";
const CAMP2 = "c0000000-0000-4000-8000-000000000002";

let query, sync, rules, tokenCrypto, realFetch;
const calls = [];

function stubFetch(handler) {
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    const rec = { url: u.pathname + u.search, method: init.method || "GET", auth: init.headers?.Authorization, body: init.body ? String(init.body) : null };
    calls.push(rec);
    const r = await handler(rec);
    return { ok: (r.status ?? 200) < 400, status: r.status ?? 200, json: async () => r.body ?? {} };
  };
}

const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date());
const dayOffset = (n) => { const d = new Date(); d.setUTCDate(d.getUTCDate() - n); return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(d); };

before(async () => {
  if (skip) return;
  process.env.DATABASE_URL = DB_URL;
  process.env.META_ENCRYPTION_KEY = "chave-de-teste";
  process.env.NODE_ENV = "test";
  ({ query } = await import("../src/db.js"));
  tokenCrypto = await import("../src/tokenCrypto.js");
  sync = await import("../src/metaSync.js");
  rules = await import("../src/rulesRunner.js");
  realFetch = globalThis.fetch;

  await query(`create extension if not exists pgcrypto`);
  await query(`create table if not exists public.paid_traffic_campaigns (
    id uuid primary key default gen_random_uuid(), organization_id uuid not null, name text not null, status text not null default 'rascunho',
    start_date date, current_balance numeric(12,2), min_balance_alert numeric(12,2), tracking_code text, created_at timestamptz not null default now())`);
  await query(`create table if not exists public.paid_traffic_metrics (
    id uuid primary key default gen_random_uuid(), campaign_id uuid not null references public.paid_traffic_campaigns(id) on delete cascade,
    organization_id uuid not null, report_date date not null, impressions integer default 0, clicks integer default 0, leads integer default 0,
    amount_spent numeric(12,2) default 0, remaining_balance numeric(12,2), cpl numeric(12,2), ctr numeric(8,4), cpc numeric(12,2),
    notes text, recommendation text, created_by uuid, created_at timestamptz not null default now())`);
  await query(`create table if not exists public.paid_traffic_leads (
    id uuid primary key default gen_random_uuid(), organization_id uuid not null, campaign_id uuid not null references public.paid_traffic_campaigns(id) on delete cascade,
    status text not null default 'novo', created_at timestamptz not null default now(), sent_to_crm_at timestamptz)`);
  await query(`create table if not exists public.paid_traffic_history (
    id uuid primary key default gen_random_uuid(), campaign_id uuid not null references public.paid_traffic_campaigns(id) on delete cascade,
    organization_id uuid not null, event_type text not null, description text, metadata jsonb, created_by uuid, created_at timestamptz not null default now())`);

  // migrações do backend (007–009), as mesmas aplicadas em runtime
  await (await import("../src/migrate.js")).ensureSchema();
});

after(async () => {
  if (skip) return;
  globalThis.fetch = realFetch;
  const { pool } = await import("../src/db.js");
  await pool.end();
});

beforeEach(async () => {
  if (skip) return;
  calls.length = 0;
  globalThis.fetch = realFetch;
  for (const org of [ORG, OTHER_ORG]) {
    await query(`delete from public.paid_traffic_rules where organization_id = $1`, [org]); // cascata em rule_runs
    await query(`delete from public.meta_ads_campaign_publications where organization_id = $1`, [org]).catch(() => null);
    await query(`delete from public.meta_ads_connections where organization_id = $1`, [org]).catch(() => null);
    await query(`delete from public.paid_traffic_campaigns where organization_id = $1`, [org]);
  }
  delete process.env.RULES_ALLOW_PAUSE;
});

async function seedCampaign(id = CAMP, over = {}) {
  const c = { name: "Campanha A", status: "ativa", start_date: dayOffset(30), ...over };
  await query(`insert into public.paid_traffic_campaigns (id, organization_id, name, status, start_date, current_balance) values ($1,$2,$3,$4,$5,$6)`,
    [id, over.org || ORG, c.name, c.status, c.start_date, c.current_balance ?? null]);
}
async function seedConnection(status = "connected") {
  await query(`select 1`); // garante ensureSchema abaixo
  await (await import("../src/migrate.js")).ensureSchema();
  await query(`insert into public.meta_ads_connections (organization_id, ad_account_id, page_id, access_token_encrypted, status) values ($1,'act_1','p1',$2,$3)`,
    [ORG, tokenCrypto.encryptToken("TOKEN-REAL"), status]);
}
async function seedPublication(campaignId = CAMP, status = "paused") {
  await (await import("../src/migrate.js")).ensureSchema();
  await query(`insert into public.meta_ads_campaign_publications (organization_id, campaign_id, meta_campaign_id, meta_adset_id, meta_ad_id, status) values ($1,$2,'M1','M2','M3',$3)`, [ORG, campaignId, status]);
}
const addMetric = (day, spend, extra = {}) => query(
  `insert into public.paid_traffic_metrics (campaign_id, organization_id, report_date, amount_spent, impressions, clicks, source) values ($1,$2,$3,$4,$5,$6,$7)`,
  [extra.campaign || CAMP, ORG, day, spend, extra.impressions ?? 10000, extra.clicks ?? 200, extra.source ?? "manual"]);
const addLeads = async (n, day, status = "novo", campaign = CAMP) => {
  for (let i = 0; i < n; i++) await query(`insert into public.paid_traffic_leads (organization_id, campaign_id, status, created_at) values ($1,$2,$3,$4::timestamptz)`, [ORG, campaign, status, `${day}T15:00:00Z`]);
};
const history = async (campaign = CAMP) => (await query(`select event_type, description from public.paid_traffic_history where campaign_id = $1 order by created_at`, [campaign])).rows;
const runsOf = async () => (await query(`select status, action from public.paid_traffic_rule_runs where organization_id = $1 order by created_at`, [ORG])).rows;
const campaignStatus = async (id = CAMP) => (await query(`select status from public.paid_traffic_campaigns where id = $1`, [id])).rows[0].status;
const mkRule = (over = {}) => rules.createRule(ORG, { name: "CPL alto", metric: "cpl", operator: ">", threshold: 50, window_days: 3, min_spend: 0, ...over });

// ---------------------------------------------------------------------------
// Fase 2 — insights e status
// ---------------------------------------------------------------------------
test("sync de insights: upsert por campanha/dia (sem duplicar) e preserva o lançamento manual", { skip }, async () => {
  await seedCampaign(); await seedConnection(); await seedPublication();
  const d1 = dayOffset(1), d2 = dayOffset(2);
  await addMetric(d1, 55, { source: "manual" });

  let spend = "120.50";
  stubFetch((rec) => rec.url.includes("/M1/insights")
    ? { body: { data: [
        { date_start: d2, spend: "80", impressions: "5000", clicks: "100", inline_link_clicks: "90", actions: [{ action_type: "lead", value: "2" }, { action_type: "onsite_conversion.lead_grouped", value: "2" }] },
        { date_start: d1, spend, impressions: "10000", clicks: "300", inline_link_clicks: "200", actions: [{ action_type: "lead", value: "5" }] },
      ] } }
    : { status: 404, body: { error: { message: "?" } } });

  const r1 = await sync.syncOrganizationInsights({ organizationId: ORG, days: 7 });
  assert.equal(r1.synced_rows, 2);
  assert.equal(r1.errors, 0);
  assert.equal(calls[0].auth, "Bearer TOKEN-REAL");             // token descriptografado, no header
  assert.ok(!calls[0].url.includes("TOKEN-REAL"));              // e nunca na URL

  spend = "130.75";                                             // a Meta revisa o valor do dia
  await sync.syncOrganizationInsights({ organizationId: ORG, days: 7 });

  const rows = (await query(`select report_date::text d, source, amount_spent::float8 spend, clicks, leads, cpl::float8 cpl from public.paid_traffic_metrics where campaign_id = $1 order by report_date, source`, [CAMP])).rows;
  const meta = rows.filter((x) => x.source === "meta_api");
  assert.equal(meta.length, 2, "uma linha da Meta por dia (upsert, sem duplicar)");
  const m1 = meta.find((x) => x.d === d1);
  assert.equal(m1.spend, 130.75);                               // atualizado
  assert.equal(m1.clicks, 200);                                 // clique no link
  assert.equal(m1.leads, 5);
  assert.equal(m1.cpl, 26.15);
  assert.equal(meta.find((x) => x.d === d2).leads, 2);          // um único action_type (não 2+2)
  assert.equal(rows.filter((x) => x.source === "manual").length, 1, "lançamento manual preservado");

  const pub = (await query(`select last_insights_sync_at, last_insights_error from public.meta_ads_campaign_publications where campaign_id = $1`, [CAMP])).rows[0];
  assert.ok(pub.last_insights_sync_at);
  assert.equal(pub.last_insights_error, null);
});

test("sync de insights: token expirado (190) marca a conexão para reconectar", { skip }, async () => {
  await seedCampaign(); await seedConnection(); await seedPublication();
  stubFetch(() => ({ status: 400, body: { error: { message: "Session expired", code: 190, error_subcode: 463 } } }));

  const r = await sync.syncOrganizationInsights({ organizationId: ORG, days: 7 });
  assert.equal(r.errors, 1);
  assert.match(r.campaigns[0].error, /expirou/);
  const conn = (await query(`select status from public.meta_ads_connections where organization_id = $1`, [ORG])).rows[0];
  assert.equal(conn.status, "needs_reconnect");
  assert.equal(calls.length, 1, "token expirado não é repetido");
});

test("sync de insights: campanha não publicada → 404; sem conexão → 409", { skip }, async () => {
  await seedCampaign();
  await assert.rejects(sync.syncOrganizationInsights({ organizationId: ORG, campaignId: CAMP }), (e) => e.httpStatus === 409); // sem conexão
  await seedConnection();
  await assert.rejects(sync.syncOrganizationInsights({ organizationId: ORG, campaignId: CAMP }), (e) => e.httpStatus === 404); // sem publicação
});

test("status na Meta: ativa campanha, conjunto e anúncio; pausa; ignora o que não foi publicado", { skip }, async () => {
  await seedCampaign(); await seedConnection(); await seedPublication();
  stubFetch(() => ({ body: { success: true } }));

  const on = await sync.syncMetaCampaignStatus({ organizationId: ORG, campaignId: CAMP, status: "ativa" });
  assert.deepEqual(on, { synced: true, meta_status: "ACTIVE" });
  assert.deepEqual(calls.map((c) => c.url.split("?")[0]), ["/v21.0/M1", "/v21.0/M2", "/v21.0/M3"]);
  assert.ok(calls.every((c) => c.method === "POST" && c.body === "status=ACTIVE"));
  assert.equal((await query(`select status from public.meta_ads_campaign_publications where campaign_id = $1`, [CAMP])).rows[0].status, "published");

  calls.length = 0;
  await sync.syncMetaCampaignStatus({ organizationId: ORG, campaignId: CAMP, status: "finalizada" });
  assert.ok(calls.every((c) => c.body === "status=PAUSED"), "finalizar só pausa (ARCHIVED é irreversível)");
  assert.equal((await query(`select status from public.meta_ads_campaign_publications where campaign_id = $1`, [CAMP])).rows[0].status, "paused");

  calls.length = 0;
  assert.deepEqual(await sync.syncMetaCampaignStatus({ organizationId: ORG, campaignId: CAMP, status: "rascunho" }), { synced: false, reason: "status_not_synced" });
  assert.deepEqual(await sync.syncMetaCampaignStatus({ organizationId: ORG, campaignId: CAMP2, status: "pausada" }), { synced: false, reason: "not_published" });
  assert.equal(calls.length, 0);
});

test("status na Meta: se a Meta recusa, lança erro e NÃO marca a publicação como alterada", { skip }, async () => {
  await seedCampaign(); await seedConnection(); await seedPublication(CAMP, "published");
  stubFetch(() => ({ status: 400, body: { error: { message: "Permissions error", code: 200 } } }));
  await assert.rejects(sync.syncMetaCampaignStatus({ organizationId: ORG, campaignId: CAMP, status: "pausada" }), (e) => e.httpStatus === 403);
  assert.equal((await query(`select status from public.meta_ads_campaign_publications where campaign_id = $1`, [CAMP])).rows[0].status, "published");
});

// ---------------------------------------------------------------------------
// Fase 3 — regras automáticas
// ---------------------------------------------------------------------------
test("regras: CRUD valida, respeita a empresa e aplica padrões seguros", { skip }, async () => {
  await seedCampaign();
  const bad = await rules.createRule(ORG, { name: "", metric: "x" });
  assert.equal(bad.ok, false);

  const alien = await rules.createRule(ORG, { name: "R", metric: "cpl", operator: ">", threshold: 1, campaign_id: CAMP2 });
  assert.deepEqual(alien.errors, ["Campanha não encontrada nesta empresa."]);

  const ok = await mkRule({ campaign_id: CAMP });
  assert.equal(ok.ok, true);
  assert.equal(ok.rule.action, "notify");            // padrão seguro
  assert.equal(ok.rule.cooldown_hours, 24);
  assert.equal(Number(ok.rule.threshold), 50);

  const upd = await rules.updateRule(ORG, ok.rule.id, { is_active: false, threshold: 80 });
  assert.equal(upd.rule.is_active, false);
  assert.equal(Number(upd.rule.threshold), 80);
  assert.equal((await rules.updateRule(OTHER_ORG, ok.rule.id, { is_active: true })).notFound, true, "outra empresa não altera a regra");
  assert.equal(await rules.deleteRule(OTHER_ORG, ok.rule.id), false);
  assert.equal((await rules.listRules(ORG)).length, 1);
  assert.equal(await rules.deleteRule(ORG, ok.rule.id), true);
});

test("regras: CPL alto dispara em campanha ativa; dry_run não age; notificar grava histórico e log", { skip }, async () => {
  await seedCampaign();
  await addMetric(dayOffset(1), 300); await addLeads(3, dayOffset(1));          // CPL = 100
  await mkRule();                                                                // CPL > 50

  const dry = await rules.runRulesForOrganization({ organizationId: ORG, dryRun: true });
  assert.equal(dry.results.length, 1);
  assert.equal(dry.results[0].outcome, "would_act");
  assert.equal(dry.results[0].value, 100);
  assert.equal((await runsOf()).length, 0, "dry_run não grava nada");
  assert.equal((await history()).length, 0);

  const real = await rules.runRulesForOrganization({ organizationId: ORG });
  assert.equal(real.results[0].outcome, "notified");
  assert.deepEqual(await runsOf(), [{ status: "notified", action: "notify" }]);
  const h = await history();
  assert.equal(h[0].event_type, "rule_triggered");
  assert.match(h[0].description, /CPL nos últimos 3 dia\(s\) = R\$ 100,00/);
  assert.equal(await campaignStatus(), "ativa", "notificar não altera a campanha");
});

test("regras: não avalia campanha pausada, nem com gasto abaixo do mínimo; CPL ok não dispara", { skip }, async () => {
  await seedCampaign(CAMP, { status: "pausada" });
  await addMetric(dayOffset(1), 300); await addLeads(3, dayOffset(1));
  await mkRule();
  assert.equal((await rules.runRulesForOrganization({ organizationId: ORG })).results.length, 0);

  await query(`update public.paid_traffic_campaigns set status = 'ativa'`);
  await query(`update public.paid_traffic_rules set min_spend = 500`);          // gasto 300 < 500
  const low = await rules.runRulesForOrganization({ organizationId: ORG });
  assert.equal(low.results.length, 0);
  assert.equal(low.not_evaluable, 1);

  await query(`update public.paid_traffic_rules set min_spend = 0, threshold = 150`); // CPL 100 não passa de 150
  assert.equal((await rules.runRulesForOrganization({ organizationId: ORG })).results.length, 0);
});

test("regras: gasto sem nenhum lead dispara (CPL infinito) e saldo baixo usa o saldo cadastrado", { skip }, async () => {
  await seedCampaign(CAMP, { current_balance: 40 });
  await addMetric(dayOffset(1), 200);                                            // sem leads
  await mkRule({ min_spend: 100 });
  await mkRule({ name: "Saldo baixo", metric: "balance", operator: "<", threshold: 100 });
  const r = await rules.runRulesForOrganization({ organizationId: ORG });
  assert.deepEqual(r.results.map((x) => x.rule_name).sort(), ["CPL alto", "Saldo baixo"]);
  const cpl = r.results.find((x) => x.rule_name === "CPL alto");
  assert.equal(cpl.infinite, true);
  assert.equal(cpl.value, null);
});

test("regras: cooldown e limite diário impedem repetição", { skip }, async () => {
  await seedCampaign(CAMP); await seedCampaign(CAMP2, { name: "Campanha B" });
  for (const c of [CAMP, CAMP2]) { await addMetric(dayOffset(1), 300, { campaign: c }); await addLeads(3, dayOffset(1), "novo", c); }
  await mkRule({ max_actions_per_day: 1, cooldown_hours: 24 });

  const first = await rules.runRulesForOrganization({ organizationId: ORG });
  const outcomes = first.results.map((x) => x.outcome).sort();
  assert.deepEqual(outcomes, ["notified", "skipped_limit"], "limite de 1 ação/dia na regra");

  const second = await rules.runRulesForOrganization({ organizationId: ORG });
  assert.ok(second.results.every((x) => x.outcome === "skipped_cooldown" || x.outcome === "skipped_limit"));
  assert.equal((await runsOf()).length, 1, "nada novo foi gravado");
});

test("regras: pausar para na Meta e localmente, registra e respeita o histórico", { skip }, async () => {
  await seedCampaign(); await seedConnection(); await seedPublication(CAMP, "published");
  await addMetric(dayOffset(1), 300); await addLeads(3, dayOffset(1));
  await mkRule({ action: "pause" });
  stubFetch(() => ({ body: { success: true } }));

  const r = await rules.runRulesForOrganization({ organizationId: ORG });
  assert.equal(r.results[0].outcome, "paused");
  assert.equal(await campaignStatus(), "pausada");
  assert.equal(calls.filter((c) => c.method === "POST").length, 3, "campanha, conjunto e anúncio pausados na Meta");
  assert.deepEqual(await runsOf(), [{ status: "paused", action: "pause" }]);
  const h = await history();
  assert.equal(h[0].event_type, "status_change");
  assert.match(h[0].description, /PAUSADA automaticamente/);
});

test("regras: se a Meta recusar a pausa, a campanha continua ativa e a falha fica registrada", { skip }, async () => {
  await seedCampaign(); await seedConnection(); await seedPublication(CAMP, "published");
  await addMetric(dayOffset(1), 300); await addLeads(3, dayOffset(1));
  await mkRule({ action: "pause" });
  stubFetch(() => ({ status: 400, body: { error: { message: "Session expired", code: 190 } } }));

  const r = await rules.runRulesForOrganization({ organizationId: ORG });
  assert.equal(r.results[0].outcome, "failed");
  assert.match(r.results[0].message, /Não foi possível pausar/);
  assert.equal(await campaignStatus(), "ativa");
  assert.deepEqual(await runsOf(), [{ status: "failed", action: "pause" }]);
  // falha também conta no cooldown: não insiste a cada execução
  const again = await rules.runRulesForOrganization({ organizationId: ORG });
  assert.equal(again.results[0].outcome, "skipped_cooldown");
  assert.equal(calls.filter((c) => c.method === "POST").length, 1);
});

test("regras: RULES_ALLOW_PAUSE=false transforma pausa em notificação", { skip }, async () => {
  process.env.RULES_ALLOW_PAUSE = "false";
  await seedCampaign();
  await addMetric(dayOffset(1), 300); await addLeads(3, dayOffset(1));
  await mkRule({ action: "pause" });
  stubFetch(() => { throw new Error("não deveria chamar a Meta"); });
  const r = await rules.runRulesForOrganization({ organizationId: ORG });
  assert.equal(r.results[0].outcome, "notified");
  assert.match(r.results[0].message, /pausa automática desativada/);
  assert.equal(await campaignStatus(), "ativa");
});

test("regras: dias sem leads e isolamento entre empresas", { skip }, async () => {
  await seedCampaign(CAMP, { start_date: dayOffset(10) });
  await addLeads(1, dayOffset(6));                                               // último lead há 6 dias
  await mkRule({ name: "Sem leads", metric: "days_without_leads", operator: ">=", threshold: 3 });
  // regra de OUTRA empresa não deve rodar nesta execução
  await query(`insert into public.paid_traffic_campaigns (id, organization_id, name, status) values ($1,$2,'Alheia','ativa')`, [CAMP2, OTHER_ORG]);
  await rules.createRule(OTHER_ORG, { name: "Alheia", metric: "days_without_leads", operator: ">=", threshold: 1 });

  const r = await rules.runRulesForOrganization({ organizationId: ORG });
  assert.equal(r.results.length, 1);
  assert.equal(r.results[0].value, 6);
  assert.equal(r.results[0].campaign_id, CAMP);
  assert.equal((await rules.listRuns(OTHER_ORG)).length, 0);
});
