import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyRoute, createAuthMiddleware, extractBearer, readAuthConfig, resolveOrganizationId } from "../src/auth.js";

const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const ENV = { SUPABASE_URL: "https://x.supabase.co", SUPABASE_ANON_KEY: "anon" };
const silent = { warn() {}, error() {}, log() {} };

function jsonRes(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

/** fetch simulado do Supabase: tokens válidos e vínculos configuráveis. */
function fakeSupabase({ tokens = { good: { id: "u1", email: "a@b.c" } }, memberships = {}, visibleOrgs = [] } = {}) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push(url);
    const token = init.headers.Authorization.replace("Bearer ", "");
    if (url.endsWith("/auth/v1/user")) {
      return tokens[token] ? jsonRes(200, tokens[token]) : jsonRes(401, {});
    }
    if (url.includes("/rest/v1/organization_users")) {
      const org = /organization_id=eq\.([^&]+)/.exec(url)[1];
      return jsonRes(200, memberships[org] || []);
    }
    if (url.includes("/rest/v1/organizations")) {
      const org = /id=eq\.([^&]+)/.exec(url)[1];
      return jsonRes(200, visibleOrgs.includes(org) ? [{ id: org }] : []);
    }
    return jsonRes(404, {});
  };
  impl.calls = calls;
  return impl;
}

function run(mw, { method = "GET", path = "/api/paid-traffic/campaigns", headers = {}, query = {}, body } = {}) {
  return new Promise((resolve) => {
    const req = { method, path, headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])), query, body };
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      json(b) { resolve({ status: this.statusCode, body: b, req, passed: false }); },
    };
    mw(req, res, () => resolve({ status: 200, passed: true, req }));
  });
}

test("classifyRoute separa públicas, webhooks e rotas de usuário", () => {
  assert.equal(classifyRoute("GET", "/health"), "public");
  assert.equal(classifyRoute("GET", "/uploads/campaigns/a/b.png"), "public");
  assert.equal(classifyRoute("GET", "/r/TP-20260101-ABCD"), "public");
  assert.equal(classifyRoute("GET", "/api/meta-ads/oauth/callback"), "public");
  assert.equal(classifyRoute("POST", "/api/paid-traffic/inbound-lead"), "webhook");
  assert.equal(classifyRoute("POST", "/api/paid-traffic/instagram/whatsapp-message"), "webhook");
  assert.equal(classifyRoute("GET", "/api/paid-traffic/campaigns"), "user");
  assert.equal(classifyRoute("POST", "/api/meta-ads/publish-campaign-live"), "user");
  // mesmo caminho com outro método não vira público
  assert.equal(classifyRoute("POST", "/health"), "user");
  assert.equal(classifyRoute("GET", "/api/paid-traffic/inbound-lead"), "user");
});

test("extractBearer", () => {
  assert.equal(extractBearer("Bearer abc.def"), "abc.def");
  assert.equal(extractBearer("bearer abc"), "abc");
  assert.equal(extractBearer("Basic abc"), null);
  assert.equal(extractBearer(undefined), null);
});

test("resolveOrganizationId detecta conflito entre header, query e corpo", () => {
  assert.deepEqual(resolveOrganizationId({ headers: { "x-organization-id": ORG }, query: {}, body: { organization_id: ORG } }), { organizationId: ORG, conflict: false });
  assert.equal(resolveOrganizationId({ headers: { "x-organization-id": ORG }, query: { organization_id: OTHER } }).conflict, true);
  assert.deepEqual(resolveOrganizationId({ headers: {}, query: {} }), { organizationId: null, conflict: false });
});

test("sem Supabase configurado a API fica aberta (compatibilidade)", async () => {
  const mw = createAuthMiddleware({ env: {}, fetchImpl: fakeSupabase(), logger: silent });
  assert.equal(mw.config.mode, "off");
  assert.equal((await run(mw)).passed, true);
});

test("rota de usuário sem token → 401", async () => {
  const mw = createAuthMiddleware({ env: ENV, fetchImpl: fakeSupabase(), logger: silent });
  const r = await run(mw, { headers: { "x-organization-id": ORG } });
  assert.equal(r.status, 401);
});

test("token inválido → 401", async () => {
  const mw = createAuthMiddleware({ env: ENV, fetchImpl: fakeSupabase(), logger: silent });
  const r = await run(mw, { headers: { authorization: "Bearer bad", "x-organization-id": ORG } });
  assert.equal(r.status, 401);
});

test("membro ativo passa e req.auth é preenchido", async () => {
  const mw = createAuthMiddleware({ env: ENV, logger: silent, fetchImpl: fakeSupabase({ memberships: { [ORG]: [{ status: "active", is_blocked: false, role: "admin" }] } }) });
  const r = await run(mw, { headers: { authorization: "Bearer good", "x-organization-id": ORG } });
  assert.equal(r.passed, true);
  assert.deepEqual(r.req.auth, { userId: "u1", email: "a@b.c", organizationId: ORG });
});

test("usuário de outra empresa → 403 (não vaza dados entre empresas)", async () => {
  const mw = createAuthMiddleware({ env: ENV, logger: silent, fetchImpl: fakeSupabase({ memberships: { [ORG]: [{ status: "active", is_blocked: false }] } }) });
  const r = await run(mw, { headers: { authorization: "Bearer good" }, query: { organization_id: OTHER } });
  assert.equal(r.status, 403);
});

test("membro bloqueado ou inativo → 403", async () => {
  for (const row of [{ status: "active", is_blocked: true }, { status: "pending", is_blocked: false }]) {
    const mw = createAuthMiddleware({ env: ENV, logger: silent, fetchImpl: fakeSupabase({ memberships: { [ORG]: [row] } }) });
    const r = await run(mw, { headers: { authorization: "Bearer good", "x-organization-id": ORG } });
    assert.equal(r.status, 403);
  }
});

test("sem vínculo mas empresa visível pela RLS (superadmin) → passa", async () => {
  const mw = createAuthMiddleware({ env: ENV, logger: silent, fetchImpl: fakeSupabase({ visibleOrgs: [ORG] }) });
  const r = await run(mw, { headers: { authorization: "Bearer good", "x-organization-id": ORG } });
  assert.equal(r.passed, true);
});

test("header ≠ corpo → 400 (não valida uma empresa e opera em outra)", async () => {
  const mw = createAuthMiddleware({ env: ENV, logger: silent, fetchImpl: fakeSupabase({ memberships: { [ORG]: [{ status: "active", is_blocked: false }] } }) });
  const r = await run(mw, { method: "POST", headers: { authorization: "Bearer good", "x-organization-id": ORG }, body: { organization_id: OTHER } });
  assert.equal(r.status, 400);
});

test("organization_id que não é UUID → 400 (sem injeção na consulta REST)", async () => {
  const f = fakeSupabase();
  const mw = createAuthMiddleware({ env: ENV, logger: silent, fetchImpl: f });
  const r = await run(mw, { headers: { authorization: "Bearer good", "x-organization-id": "x&select=*" } });
  assert.equal(r.status, 400);
  assert.equal(f.calls.some((u) => u.includes("organization_users")), false);
});

test("Supabase fora do ar → 503 (não confunde indisponibilidade com token inválido)", async () => {
  const mw = createAuthMiddleware({ env: ENV, logger: silent, fetchImpl: async () => { throw new Error("ECONNRESET"); } });
  const r = await run(mw, { headers: { authorization: "Bearer good", "x-organization-id": ORG } });
  assert.equal(r.status, 503);
});

test("resultado de autorização é cacheado (poucas chamadas ao Supabase)", async () => {
  const f = fakeSupabase({ memberships: { [ORG]: [{ status: "active", is_blocked: false }] } });
  let t = 1_000;
  const mw = createAuthMiddleware({ env: ENV, logger: silent, fetchImpl: f, now: () => t });
  await run(mw, { headers: { authorization: "Bearer good", "x-organization-id": ORG } });
  const first = f.calls.length;
  await run(mw, { headers: { authorization: "Bearer good", "x-organization-id": ORG } });
  assert.equal(f.calls.length, first);
  t += 61_000; // expira
  await run(mw, { headers: { authorization: "Bearer good", "x-organization-id": ORG } });
  assert.ok(f.calls.length > first);
});

test("modo log registra mas não bloqueia", async () => {
  const warns = [];
  const mw = createAuthMiddleware({ env: { ...ENV, API_AUTH_MODE: "log" }, fetchImpl: fakeSupabase(), logger: { ...silent, warn: (m) => warns.push(m) } });
  const r = await run(mw);
  assert.equal(r.passed, true);
  assert.match(warns[0], /log-only/);
});

test("webhooks: sem segredo configurado aceita; com segredo exige o header", async () => {
  const open = createAuthMiddleware({ env: ENV, fetchImpl: fakeSupabase(), logger: silent });
  assert.equal((await run(open, { method: "POST", path: "/api/paid-traffic/inbound-lead" })).passed, true);

  const locked = createAuthMiddleware({ env: { ...ENV, INBOUND_WEBHOOK_SECRET: "s3" }, fetchImpl: fakeSupabase(), logger: silent });
  assert.equal((await run(locked, { method: "POST", path: "/api/paid-traffic/inbound-lead" })).status, 401);
  assert.equal((await run(locked, { method: "POST", path: "/api/paid-traffic/inbound-lead", headers: { "x-webhook-secret": "errado" } })).status, 401);
  assert.equal((await run(locked, { method: "POST", path: "/api/paid-traffic/inbound-lead", headers: { "x-webhook-secret": "s3" } })).passed, true);
});

test("rotas públicas e OPTIONS não exigem token", async () => {
  const mw = createAuthMiddleware({ env: ENV, fetchImpl: fakeSupabase(), logger: silent });
  assert.equal((await run(mw, { path: "/health" })).passed, true);
  assert.equal((await run(mw, { path: "/r/TP-1" })).passed, true);
  assert.equal((await run(mw, { method: "OPTIONS", path: "/api/paid-traffic/campaigns" })).passed, true);
});

test("readAuthConfig: modo inválido cai em enforce", () => {
  assert.equal(readAuthConfig({ ...ENV, API_AUTH_MODE: "banana" }).mode, "enforce");
});
