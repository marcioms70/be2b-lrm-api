import { test } from "node:test";
import assert from "node:assert/strict";
import { BILLING_FIELDS, createBillingHandler, normalizeBilling } from "../src/metaBilling.js";

test("normalizeBilling: conta ativa com cartão → cadastrado, com o texto que a Meta mostra", () => {
  const r = normalizeBilling({ account_status: 1, currency: "BRL", funding_source: "123456", funding_source_details: { id: "123456", type: 1, display_string: "Visa *4242" } });
  assert.deepEqual(r, { account_status: 1, account_status_label: "Ativa", account_active: true, currency: "BRL", has_funding_source: true, funding_label: "Visa *4242" });
});

test("normalizeBilling: sem forma de pagamento → pendente; conta com pendência de pagamento não é ativa", () => {
  const r = normalizeBilling({ account_status: 3, currency: "BRL" });
  assert.equal(r.has_funding_source, false); assert.equal(r.funding_label, null); assert.equal(r.account_active, false); assert.equal(r.account_status_label, "Com pendência de pagamento");
  assert.equal(normalizeBilling({ account_status: 1, funding_source: null }).has_funding_source, false);
  assert.equal(normalizeBilling({ account_status: 1, funding_source: "" }).has_funding_source, false);
});

test("normalizeBilling: só o id dentro de funding_source_details também conta; sem texto, o rótulo fica nulo (nada inventado)", () => {
  const r = normalizeBilling({ account_status: 1, funding_source_details: { id: "9" } });
  assert.equal(r.has_funding_source, true); assert.equal(r.funding_label, null);
});

test("normalizeBilling: rótulo é limpo (controle, espaços) e limitado; entrada estranha não quebra", () => {
  const r = normalizeBilling({ account_status: 1, funding_source: "1", funding_source_details: { display_string: "  Visa\n\t *1234  " + "x".repeat(200) } });
  assert.ok(r.funding_label.startsWith("Visa *1234")); assert.ok(r.funding_label.length <= 80); assert.ok(!/[\n\t]/.test(r.funding_label));
  for (const bad of [null, undefined, 5, "x", [], { account_status: "abc" }]) { const o = normalizeBilling(bad); assert.equal(o.has_funding_source, false); assert.equal(o.account_status_label, "Situação desconhecida"); }
});

test("BILLING_FIELDS não pede saldo, gasto nem dados de cartão além do texto exibido", () => {
  assert.equal(/balance|amount_spent|spend_cap|account_number|card/i.test(BILLING_FIELDS), false);
  assert.ok(BILLING_FIELDS.includes("funding_source") && BILLING_FIELDS.includes("account_status"));
});

const mkRes = () => ({ status: 200, body: null, code(c) { this.status = c; return this; } });
function harness(o = {}) {
  const calls = { loaded: [] };
  const conn = o.connection === undefined ? { organization_id: "ORG", access_token_encrypted: "enc", ad_account_id: "act_1163549722874788" } : o.connection;
  const h = createBillingHandler({
    getOrganizationId: (req) => req.org ?? "ORG", getConnection: async () => { if (o.dbThrows) throw new Error("banco caiu"); return conn; },
    decryptToken: (e) => { assert.equal(e, "enc"); return "TOKEN-SECRETO"; },
    loadAccount: async (t, id) => { calls.loaded.push([t, id]); if (o.graphThrows) throw new Error(`Graph recusou ${t}`); return o.account || { account_status: 1, currency: "BRL", funding_source: "1", funding_source_details: { id: "1", display_string: "Visa *4242" } }; },
    ok: (res, b) => { res.body = { success: true, ...b }; return res; }, fail: (res, status, message, details) => { res.status = status; res.body = { success: false, message, details }; return res; }
  });
  return { h, calls };
}

test("rota: devolve a situação da conta DA empresa (id normalizado) e nunca o token", async () => {
  const { h, calls } = harness(); const res = mkRes(); await h.handle({}, res);
  assert.equal(res.status, 200); assert.equal(res.body.data.ad_account_id, "act_1163549722874788"); assert.equal(res.body.data.has_funding_source, true); assert.equal(res.body.data.funding_label, "Visa *4242");
  assert.deepEqual(calls.loaded, [["TOKEN-SECRETO", "act_1163549722874788"]]);
  assert.ok(!JSON.stringify(res.body).includes("TOKEN-SECRETO") && !JSON.stringify(res.body).includes("enc\""));
});

test("rota: sem empresa, sem conexão, sem token e sem conta de anúncios → erros claros e nenhuma chamada à Meta", async () => {
  let { h, calls } = harness(); let res = mkRes(); await h.handle({ org: "" }, res); assert.equal(res.status, 400);
  ({ h, calls } = harness({ connection: null })); res = mkRes(); await h.handle({}, res); assert.equal(res.status, 404);
  ({ h, calls } = harness({ connection: { organization_id: "ORG", access_token_encrypted: null, ad_account_id: "act_1163549722874788" } })); res = mkRes(); await h.handle({}, res); assert.equal(res.status, 400); assert.match(res.body.message, /Reconecte/);
  ({ h, calls } = harness({ connection: { organization_id: "ORG", access_token_encrypted: "enc", ad_account_id: null } })); res = mkRes(); await h.handle({}, res); assert.equal(res.status, 400); assert.match(res.body.message, /Escolha a conta/);
  ({ h, calls } = harness({ connection: { organization_id: "ORG", access_token_encrypted: "enc", ad_account_id: "lixo" } })); res = mkRes(); await h.handle({}, res); assert.equal(res.status, 400);
  assert.deepEqual(calls.loaded, []);
});

test("rota: Meta recusa (token vencido) → 502 com orientação; banco fora → 500; nenhum dos dois vaza o token", async () => {
  let { h } = harness({ graphThrows: true }); let res = mkRes(); await h.handle({}, res);
  assert.equal(res.status, 502); assert.match(res.body.message, /reconecte/i);
  assert.ok(!JSON.stringify(res.body).includes("TOKEN-SECRETO")); assert.ok(String(res.body.details).includes("[token]"));   // a Meta ecoou o token na mensagem: sai mascarado
  ({ h } = harness({ dbThrows: true })); res = mkRes(); await h.handle({}, res); assert.equal(res.status, 500); assert.ok(!JSON.stringify(res.body).includes("TOKEN-SECRETO"));
});

test("rota: conta sem pagamento volta como pendente (has_funding_source=false), com a situação da conta", async () => {
  const { h } = harness({ account: { account_status: 3, currency: "BRL" } }); const res = mkRes(); await h.handle({}, res);
  assert.equal(res.status, 200); assert.equal(res.body.data.has_funding_source, false); assert.equal(res.body.data.account_active, false);
});
