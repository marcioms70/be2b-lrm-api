/**
 * Sobe o servidor REAL (bootstrap.js) contra um Postgres REAL e uma Graph API FALSA por HTTP, e confere a rota
 * POST /api/meta-ads/reach-estimate de ponta a ponta: token da empresa descriptografado e enviado à Meta, parâmetros
 * (location_types, targeting_spec) como a Graph API recebe, cache, limite de uso, isolamento entre empresas e erros.
 * Só roda com TEST_DATABASE_URL; cria e apaga um banco próprio (`<banco>_reach`).
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import pg from "pg";

const BASE = process.env.TEST_DATABASE_URL;
const skip = !BASE;
process.env.META_ENCRYPTION_KEY = "chave-de-teste";
const { encryptToken } = await import("../src/tokenCrypto.js");

const ORG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ORG_RATE = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const TOKEN = "TOKEN-DA-EMPRESA-A";

let adminUrl, testUrl, dbName, proc, base, logs = "", fakeServer, fakeUrl;
const seen = []; // o que a Graph falsa recebeu
let graphMode = "ok";

const cities = [
  { key: "3001", name: "Campo Grande", type: "city", region: "Mato Grosso do Sul", country_code: "BR" },
  { key: "3002", name: "Campo Grande", type: "city", region: "Rio de Janeiro", country_code: "BR" },
];

function startFakeGraph() {
  return new Promise((resolve) => {
    fakeServer = http.createServer((req, res) => {
      const url = new URL(req.url, "http://x");
      const q = Object.fromEntries(url.searchParams);
      seen.push({ path: url.pathname, query: q, auth: req.headers.authorization });
      const send = (status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
      if (url.pathname === "/v21.0/search") {
        if (q.type === "adgeolocation") return send(200, { data: q.q === "Atlântida" ? [] : cities });
        if (q.type === "adinterest") return send(200, { data: q.q === "oficina" ? [{ id: "6003", name: "Oficina", audience_size: 1000 }] : [] });
      }
      if (url.pathname.endsWith("/reachestimate")) {
        if (graphMode === "expired") return send(400, { error: { message: "Error validating access token", type: "OAuthException", code: 190 } });
        return send(200, { data: { users_lower_bound: 120000, users_upper_bound: 140000, estimate_ready: true } });
      }
      return send(404, { error: { message: "rota não simulada " + url.pathname, code: 100 } });
    });
    fakeServer.listen(0, "127.0.0.1", () => { fakeUrl = `http://127.0.0.1:${fakeServer.address().port}/v21.0`; resolve(); });
  });
}

async function startServer(db) {
  const port = 6000 + Math.floor(Math.random() * 1000);
  base = `http://127.0.0.1:${port}`;
  proc = spawn("node", ["src/bootstrap.js"], {
    env: { ...process.env, PORT: String(port), NODE_ENV: "production", DATABASE_URL: db, UPLOAD_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "lrm-r-")),
      SUPABASE_URL: "", SUPABASE_ANON_KEY: "", META_INSIGHTS_AUTO_SYNC_HOURS: "0", RULES_EVAL_INTERVAL_MINUTES: "0", REPORT_EVAL_INTERVAL_MINUTES: "0",
      META_ENCRYPTION_KEY: "chave-de-teste", META_GRAPH_BASE_URL: fakeUrl },
  });
  proc.stdout.on("data", (d) => (logs += d)); proc.stderr.on("data", (d) => (logs += d));
  for (let i = 0; i < 60; i++) { try { await fetch(`${base}/health`); return; } catch { await new Promise((r) => setTimeout(r, 200)); } }
  throw new Error("servidor não subiu:\n" + logs);
}

const estimate = (targeting, org = ORG, extra = {}) =>
  fetch(`${base}/api/meta-ads/reach-estimate`, { method: "POST", headers: { "content-type": "application/json", "x-organization-id": org, ...extra }, body: JSON.stringify({ targeting }) });
const target = (over = {}) => ({ country: "Brasil", state: "MS", city: "Campo Grande", radius_km: 20, min_age: 25, max_age: 55, gender: "female", interests: "oficina, xyz", ...over });
const connect = (db, org, over = {}) => db.query(
  `insert into public.meta_ads_connections (organization_id, ad_account_id, access_token_encrypted, status) values ($1, $2, $3, $4)
   on conflict do nothing`, [org, over.account ?? "act_123", encryptToken(over.token ?? TOKEN), over.status ?? "connected"]);

before(async () => {
  if (skip) return;
  await startFakeGraph();
  const u = new URL(BASE);
  dbName = `${u.pathname.slice(1)}_reach`;
  adminUrl = new URL(BASE); adminUrl.pathname = "/postgres"; adminUrl = adminUrl.toString();
  testUrl = new URL(BASE); testUrl.pathname = `/${dbName}`; testUrl = testUrl.toString();
  const admin = new pg.Client({ connectionString: adminUrl }); await admin.connect();
  await admin.query(`drop database if exists ${dbName} with (force)`); await admin.query(`create database ${dbName}`); await admin.end();
  const c = new pg.Client({ connectionString: testUrl }); await c.connect();
  await c.query(fs.readFileSync(new URL("../migrations/007_meta_ads_integration.sql", import.meta.url), "utf8"));
  await c.end();
  await startServer(testUrl);
});

after(async () => {
  if (skip) return;
  if (proc) { proc.kill(); await new Promise((r) => proc.once("exit", r)); }
  fakeServer?.close();
  const admin = new pg.Client({ connectionString: adminUrl }); await admin.connect();
  await admin.query(`drop database if exists ${dbName} with (force)`); await admin.end();
});

test("sem conta Meta conectada → 409 claro, sem falar com a Meta", { skip }, async () => {
  seen.length = 0;
  const r = await estimate(target());
  assert.equal(r.status, 409);
  assert.match((await r.json()).message, /não conectada/);
  assert.equal(seen.length, 0);
});

test("organization_id ausente ou inválido → 400; público inválido → 400 sem falar com a Meta", { skip }, async () => {
  seen.length = 0;
  const noOrg = await fetch(`${base}/api/meta-ads/reach-estimate`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ targeting: target() }) });
  assert.equal(noOrg.status, 400);
  assert.equal((await estimate(target(), "nao-e-uuid")).status, 400);
  const bad = await estimate(target({ min_age: 40, max_age: 30 }));
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).message, /Idade inválida/);
  assert.equal(seen.length, 0);
});

test("estimativa de ponta a ponta: token descriptografado, parâmetros certos e faixa devolvida", { skip }, async () => {
  const c = new pg.Client({ connectionString: testUrl }); await c.connect(); await connect(c, ORG); await c.end();
  seen.length = 0; graphMode = "ok";
  const r = await estimate(target());
  assert.equal(r.status, 200, logs.slice(-400));
  const { data } = await r.json();
  assert.deepEqual([data.lower, data.upper, data.ready, data.source], [120000, 140000, true, "reachestimate"]);
  assert.deepEqual(data.resolved.city, { name: "Campo Grande", region: "Mato Grosso do Sul", radius_km: 20, radius_adjusted: false, ambiguous: false });
  assert.deepEqual(data.resolved.interests.map((i) => i.id), ["6003"]);
  assert.deepEqual(data.unresolved_interests, ["xyz"]);

  // o que a Meta (falsa) realmente recebeu pela rede
  assert.ok(seen.length >= 4);
  assert.ok(seen.every((s) => s.auth === `Bearer ${TOKEN}`), "o token da empresa vai no cabeçalho Authorization");
  const geo = seen.find((s) => s.query.type === "adgeolocation");
  assert.equal(geo.query.q, "Campo Grande");
  assert.equal(geo.query.location_types, '["city"]'); // a Graph API espera lista JSON
  assert.equal(geo.query.country_code, "BR"); assert.equal(geo.query.locale, "pt_BR");
  const reach = seen.find((s) => s.path === "/v21.0/act_123/reachestimate");
  assert.deepEqual(JSON.parse(reach.query.targeting_spec), {
    geo_locations: { cities: [{ key: "3001", radius: 20, distance_unit: "kilometer" }] }, age_min: 25, age_max: 55, genders: [2],
    flexible_spec: [{ interests: [{ id: "6003", name: "Oficina" }] }],
  });
});

test("segunda consulta idêntica vem do cache e não chama a Meta", { skip }, async () => {
  seen.length = 0;
  const r = await estimate(target());
  assert.equal(r.status, 200);
  const { data } = await r.json();
  assert.equal(data.cached, true);
  assert.equal(data.lower, 120000);
  assert.equal(seen.length, 0);
});

test("outro público (idade diferente) não usa o cache", { skip }, async () => {
  seen.length = 0;
  const r = await estimate(target({ min_age: 30 }));
  assert.equal(r.status, 200);
  assert.equal((await r.json()).data.cached, undefined);
  assert.ok(seen.length > 0);
});

test("cidade que a Meta não conhece → 422 com o nome, sem estimar", { skip }, async () => {
  seen.length = 0;
  const r = await estimate(target({ city: "Atlântida" }));
  assert.equal(r.status, 422);
  assert.match((await r.json()).message, /Atlântida/);
  assert.equal(seen.some((s) => s.path.endsWith("reachestimate")), false);
});

test("cidade no estado errado → 422 (não estima a cidade homônima de outro estado)", { skip }, async () => {
  const r = await estimate(target({ state: "SP" }));
  assert.equal(r.status, 422);
  assert.match((await r.json()).message, /SP/);
});

test("uma empresa nunca usa a conexão de outra (isolamento)", { skip }, async () => {
  seen.length = 0;
  const r = await estimate(target({ min_age: 21 }), ORG_B); // ORG_B não tem conexão
  assert.equal(r.status, 409);
  assert.equal(seen.length, 0);
});

test("conta com status diferente de 'connected' não é usada", { skip }, async () => {
  const c = new pg.Client({ connectionString: testUrl }); await c.connect();
  await connect(c, ORG_B, { status: "needs_reconnect", token: "TOKEN-B" }); await c.end();
  const r = await estimate(target({ min_age: 22 }), ORG_B);
  assert.equal(r.status, 409);
});

test("token expirado na Meta → 409 pedindo para reconectar e a conexão é marcada", { skip }, async () => {
  const c = new pg.Client({ connectionString: testUrl }); await c.connect();
  await connect(c, "dddddddd-dddd-4ddd-8ddd-dddddddddddd", { token: "TOKEN-VELHO" });
  graphMode = "expired";
  const r = await estimate(target({ min_age: 19 }), "dddddddd-dddd-4ddd-8ddd-dddddddddddd");
  assert.equal(r.status, 409);
  assert.match((await r.json()).message, /expirou.*Reconecte/);
  const row = await c.query(`select status from public.meta_ads_connections where organization_id = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'`);
  assert.equal(row.rows[0].status, "needs_reconnect");
  await c.end(); graphMode = "ok";
});

test("limite de consultas por minuto → 429 (cache não conta)", { skip }, async () => {
  const c = new pg.Client({ connectionString: testUrl }); await c.connect(); await connect(c, ORG_RATE); await c.end();
  let last;
  const statuses = [];
  for (let age = 18; age <= 40; age++) { last = await estimate(target({ min_age: age, max_age: 65, city: "", interests: "" }), ORG_RATE); statuses.push(last.status); }
  assert.equal(statuses.filter((s) => s === 200).length, 20, "20 consultas reais por minuto");
  assert.ok(statuses.slice(20).every((s) => s === 429));
  assert.match((await last.json()).message, /Muitas consultas/);
  // repetir uma já feita volta do cache, mesmo com o limite estourado
  const cached = await estimate(target({ min_age: 18, max_age: 65, city: "", interests: "" }), ORG_RATE);
  assert.equal(cached.status, 200);
  assert.equal((await cached.json()).data.cached, true);
});
