/**
 * Sobe o servidor de verdade (bootstrap.js, com as rotas dos *Patch.js reposicionadas)
 * contra um Supabase falso e confere que a autenticação vale para TODAS as rotas,
 * inclusive as registradas pelos patches. Não precisa de Postgres: as rotas testadas
 * respondem antes de qualquer consulta ao banco.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const CAMPAIGN = "33333333-3333-4333-8333-333333333333";

let supabase, server, base, logs = "";

before(async () => {
  supabase = http.createServer((req, res) => {
    const auth = req.headers.authorization || "";
    res.setHeader("content-type", "application/json");
    if (!auth.includes("good")) { res.statusCode = 401; return res.end("{}"); }
    if (req.url.startsWith("/auth/v1/user")) return res.end(JSON.stringify({ id: "44444444-4444-4444-8444-444444444444", email: "u@x.com" }));
    if (req.url.startsWith("/rest/v1/organization_users")) {
      return res.end(JSON.stringify(req.url.includes(`organization_id=eq.${ORG}`) ? [{ status: "active", is_blocked: false }] : []));
    }
    return res.end("[]"); // organizations: sem visibilidade
  });
  await new Promise((r) => supabase.listen(0, r));

  const port = 4000 + Math.floor(Math.random() * 1000);
  base = `http://127.0.0.1:${port}`;
  const uploads = fs.mkdtempSync(path.join(os.tmpdir(), "lrm-up-"));
  server = spawn("node", ["src/bootstrap.js"], {
    env: {
      ...process.env,
      PORT: String(port), NODE_ENV: "production", UPLOAD_DIR: uploads,
      DATABASE_URL: "postgresql://u:p@127.0.0.1:1/none",
      SUPABASE_URL: `http://127.0.0.1:${supabase.address().port}`, SUPABASE_ANON_KEY: "anon",
      META_INSIGHTS_AUTO_SYNC_HOURS: "0"
    }
  });
  server.stdout.on("data", (d) => (logs += d));
  server.stderr.on("data", (d) => (logs += d));
  for (let i = 0; i < 50; i++) {
    try { await fetch(`${base}/health`); return; } catch { await new Promise((r) => setTimeout(r, 200)); }
  }
  throw new Error("servidor não subiu:\n" + logs);
});

after(() => { server?.kill(); supabase?.close(); });

const call = (p, init = {}) => fetch(`${base}${p}`, init);
const authed = (org = ORG, extra = {}) => ({ headers: { authorization: "Bearer good", "x-organization-id": org, ...extra } });

test("rotas públicas respondem sem token", async () => {
  assert.notEqual((await call("/uploads/nao-existe.png")).status, 401);
  assert.notEqual((await call("/r/TP-X")).status, 401);
});

test("rotas do server.js exigem login", async () => {
  assert.equal((await call("/api/paid-traffic/campaigns")).status, 401);
  assert.equal((await call(`/api/paid-traffic/campaigns?organization_id=${ORG}`)).status, 401);
});

test("rotas registradas pelos *Patch.js também exigem login", async () => {
  for (const [method, p] of [
    ["POST", "/api/media/upload"],
    ["POST", "/api/meta-ads/publish-campaign-live"],
    ["GET", "/api/meta-ads/status"],
    ["POST", "/api/creative/generate"],
    ["GET", "/api/creative/brand-kit"],
    ["POST", "/api/meta-ads/sync-insights"],
    ["GET", `/api/meta-ads/campaigns/${CAMPAIGN}/publication`]
  ]) {
    const r = await call(p, { method });
    assert.equal(r.status, 401, `${method} ${p} deveria exigir login (veio ${r.status})`);
  }
});

test("token válido, mas de outra empresa → 403", async () => {
  const r = await call("/api/paid-traffic/campaigns", authed(OTHER));
  assert.equal(r.status, 403);
});

test("token válido + empresa correta passa pela autenticação (rota nova valida o UUID)", async () => {
  const r = await call("/api/meta-ads/campaigns/nao-e-uuid/publication", authed());
  assert.equal(r.status, 400);
  assert.match((await r.json()).message, /campaign_id inválido/);
});

test("sync-insights com campaign_id inválido → 400 (após autenticar)", async () => {
  const r = await call("/api/meta-ads/sync-insights", { method: "POST", headers: { ...authed().headers, "content-type": "application/json" }, body: JSON.stringify({ campaign_id: "x" }) });
  assert.equal(r.status, 400);
});

test("upload de mídia: empresa do formulário diferente da validada → 403", async () => {
  const form = new FormData();
  form.append("file", new Blob([Buffer.from("89504e470d0a1a0a", "hex")], { type: "image/png" }), "a.png");
  form.append("organization_id", OTHER);
  form.append("campaign_id", CAMPAIGN);
  const r = await call("/api/media/upload", { method: "POST", headers: authed().headers, body: form });
  assert.equal(r.status, 403);
});

test("header ≠ corpo → 400", async () => {
  const r = await call("/api/paid-traffic/leads", { method: "POST", headers: { ...authed().headers, "content-type": "application/json" }, body: JSON.stringify({ organization_id: OTHER }) });
  assert.equal(r.status, 400);
});

test("endpoint inexistente continua sendo 404 JSON (após autenticar)", async () => {
  const r = await call("/api/nao-existe", authed());
  assert.equal(r.status, 404);
});
