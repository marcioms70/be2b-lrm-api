/**
 * Sobe o servidor REAL contra um Postgres REAL e confere que a automação de atendimento escolhida
 * no assistente é gravada na campanha (antes era descartada em silêncio). Só roda com TEST_DATABASE_URL;
 * cria e apaga um banco próprio (`<banco>_auto`) para poder remover a coluna sem afetar outros testes.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import pg from "pg";

const BASE = process.env.TEST_DATABASE_URL;
const skip = !BASE;
const ORG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const AUTO = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const AUTO2 = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

let adminUrl, testUrl, dbName, proc, base, logs = "";

const DDL = `
create extension if not exists pgcrypto;
create table public.paid_traffic_campaigns (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null, name text not null, product_service text, objective text, platform text,
  status text not null default 'rascunho', start_date date, end_date date, budget_type text, daily_budget numeric(12,2), total_budget numeric(12,2),
  current_balance numeric(12,2), min_balance_alert numeric(12,2), budget_notes text, target_audience text, min_age int, max_age int, gender text,
  interests text[], segment text, job_role text, company_type text, intent_level text, country text, state text, city text, radius_km int,
  included_regions text[], excluded_regions text[], ad_title text, ad_primary_text text, ad_short_call text, cta text, creative_notes text,
  agent_id uuid, whatsapp_instance_id uuid, whatsapp_destination text, initial_bdr_message text, initial_lead_temperature text,
  send_to_crm_when_qualified boolean, tracking_code text, whatsapp_prefilled_message text, whatsapp_tracking_url text, landing_page_url text,
  utm_source text, utm_medium text, utm_campaign text, utm_content text, utm_term text, created_by uuid, created_at timestamptz not null default now(), updated_at timestamptz not null default now());
create unique index paid_traffic_campaigns_tracking_code_uniq on public.paid_traffic_campaigns (tracking_code) where tracking_code is not null;
create table public.paid_traffic_history (id uuid primary key default gen_random_uuid(), campaign_id uuid not null references public.paid_traffic_campaigns(id) on delete cascade,
  organization_id uuid not null, event_type text not null, description text, metadata jsonb, created_by uuid, created_at timestamptz not null default now());
create table public.paid_traffic_metrics (id uuid primary key default gen_random_uuid(), campaign_id uuid not null, organization_id uuid not null, report_date date not null,
  impressions int default 0, clicks int default 0, leads int default 0, amount_spent numeric(12,2) default 0, remaining_balance numeric(12,2), cpl numeric(12,2), ctr numeric(8,4), cpc numeric(12,2), notes text, recommendation text, created_by uuid, created_at timestamptz not null default now());
create table public.paid_traffic_leads (id uuid primary key default gen_random_uuid(), organization_id uuid not null, campaign_id uuid not null, status text not null default 'novo', temperature text not null default 'morno', created_at timestamptz not null default now(), sent_to_crm_at timestamptz);
`;

async function startServer(db) {
  const port = 5000 + Math.floor(Math.random() * 1000);
  base = `http://127.0.0.1:${port}`;
  logs = "";
  proc = spawn("node", ["src/bootstrap.js"], {
    env: { ...process.env, PORT: String(port), NODE_ENV: "production", DATABASE_URL: db, UPLOAD_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "lrm-a-")),
      SUPABASE_URL: "", SUPABASE_ANON_KEY: "", META_INSIGHTS_AUTO_SYNC_HOURS: "0", RULES_EVAL_INTERVAL_MINUTES: "0", REPORT_EVAL_INTERVAL_MINUTES: "0", META_ENCRYPTION_KEY: "k" },
  });
  proc.stdout.on("data", (d) => (logs += d)); proc.stderr.on("data", (d) => (logs += d));
  for (let i = 0; i < 60; i++) { try { await fetch(`${base}/health`); return; } catch { await new Promise((r) => setTimeout(r, 200)); } }
  throw new Error("servidor não subiu:\n" + logs);
}
const stopServer = async () => { if (proc) { proc.kill(); await new Promise((r) => proc.once("exit", r)); proc = null; } };
const api = (p, init = {}) => fetch(`${base}${p}`, { ...init, headers: { "content-type": "application/json", "x-organization-id": ORG, ...(init.headers || {}) } });
const create = (body) => api("/api/paid-traffic/campaigns", { method: "POST", body: JSON.stringify({ organization_id: ORG, name: "Camp", objective: "leads_whatsapp", platform: "meta", ...body }) });

before(async () => {
  if (skip) return;
  const u = new URL(BASE);
  dbName = `${u.pathname.slice(1)}_auto`;
  adminUrl = new URL(BASE); adminUrl.pathname = "/postgres"; adminUrl = adminUrl.toString();
  testUrl = new URL(BASE); testUrl.pathname = `/${dbName}`; testUrl = testUrl.toString();
  const admin = new pg.Client({ connectionString: adminUrl }); await admin.connect();
  await admin.query(`drop database if exists ${dbName}`); await admin.query(`create database ${dbName}`); await admin.end();
  const c = new pg.Client({ connectionString: testUrl }); await c.connect(); await c.query(DDL); await c.end();
});

after(async () => {
  if (skip) return;
  await stopServer();
  const admin = new pg.Client({ connectionString: adminUrl }); await admin.connect();
  await admin.query(`drop database if exists ${dbName} with (force)`); await admin.end();
});

test("a automação escolhida é gravada, devolvida e visível para quem resolve a campanha pelo código", { skip }, async () => {
  await startServer(testUrl);
  const r = await create({ automation_id: AUTO, ad_title: "Título" });
  assert.equal(r.status, 200);
  const { data } = await r.json();
  assert.equal(data.automation_id, AUTO);

  // o n8n resolve a campanha pelo código de rastreamento (rota pública) e agora enxerga a automação
  const resolved = await (await fetch(`${base}/api/paid-traffic/instagram/campaign/${data.tracking_code}`)).json();
  assert.equal(resolved.data.campaign.automation_id, AUTO);

  const list = await (await api("/api/paid-traffic/campaigns")).json();
  assert.equal(list.data.find((c) => c.id === data.id).automation_id, AUTO);
});

test("editar troca a automação; '' limpa (null); campo ausente não mexe", { skip }, async () => {
  const { data } = await (await create({ automation_id: AUTO })).json();
  const patch = (body) => api(`/api/paid-traffic/campaigns/${data.id}`, { method: "PATCH", body: JSON.stringify(body) });

  assert.equal((await (await patch({ automation_id: AUTO2 })).json()).data.automation_id, AUTO2);
  assert.equal((await (await patch({ name: "Só o nome" })).json()).data.automation_id, AUTO2, "não enviar o campo preserva o valor");
  assert.equal((await (await patch({ automation_id: "" })).json()).data.automation_id, null);
});

test("automation_id que não é UUID → 400 (e não 500 do banco), na criação e na edição", { skip }, async () => {
  const bad = await create({ automation_id: "nao-e-uuid" });
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).message, /automation_id inválido/);

  const { data } = await (await create({})).json();
  const p = await api(`/api/paid-traffic/campaigns/${data.id}`, { method: "PATCH", body: JSON.stringify({ automation_id: "1; drop table x" }) });
  assert.equal(p.status, 400);
});

test("duplicar mantém a automação; campanha sem automação continua funcionando", { skip }, async () => {
  const { data } = await (await create({ automation_id: AUTO })).json();
  const dup = await (await api(`/api/paid-traffic/campaigns/${data.id}/duplicate`, { method: "POST", body: "{}" })).json();
  assert.equal(dup.data.automation_id, AUTO);
  assert.notEqual(dup.data.tracking_code, data.tracking_code);

  const without = await (await create({})).json();
  assert.equal(without.data.automation_id, null);
});

test("banco SEM a coluna (migração pendente): criar e editar continuam funcionando e o campo é ignorado", { skip }, async () => {
  // 1) o servidor aplica a migração 012 sozinho no start (coluna volta a existir)
  await stopServer();
  const c = new pg.Client({ connectionString: testUrl }); await c.connect();
  await c.query(`drop index if exists paid_traffic_campaigns_automation_idx`);
  await c.query(`alter table public.paid_traffic_campaigns drop column automation_id`);
  await startServer(testUrl);
  await new Promise((r) => setTimeout(r, 800));
  const readded = await c.query(`select 1 from information_schema.columns where table_name = 'paid_traffic_campaigns' and column_name = 'automation_id'`);
  assert.equal(readded.rowCount, 1, "o servidor aplica a migração 012 sozinho no start");

  // 2) servidor que NÃO consegue migrar (usuário sem permissão de DDL) e banco sem a coluna
  await stopServer();
  await c.query(`drop index if exists paid_traffic_campaigns_automation_idx`);
  await c.query(`alter table public.paid_traffic_campaigns drop column automation_id`);
  await c.query(`create role sem_ddl login password 'x'`).catch(() => null);
  await c.query(`grant all on all tables in schema public to sem_ddl`);
  await c.query(`grant usage on schema public to sem_ddl`);
  const limited = new URL(testUrl); limited.username = "sem_ddl"; limited.password = "x";
  await startServer(limited.toString());
  const r = await create({ automation_id: AUTO, name: "Sem coluna" });
  assert.equal(r.status, 200, "criar não pode falhar por causa da coluna ausente");
  const { data } = await r.json();
  assert.equal("automation_id" in data, false);
  const p = await api(`/api/paid-traffic/campaigns/${data.id}`, { method: "PATCH", body: JSON.stringify({ automation_id: AUTO, name: "Editada" }) });
  assert.equal(p.status, 200);
  assert.equal((await p.json()).data.name, "Editada");
  assert.match(logs, /não foi possível aplicar as migrações no start/);
  await c.end();
});
