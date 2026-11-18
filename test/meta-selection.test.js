import { test } from "node:test";
import assert from "node:assert/strict";
import { createSelectionHandlers, normalizeAdAccountId, normalizeOptions, pickDefaults, restrictToGranted, validateSelection } from "../src/metaSelection.js";

const FEAX = { id: "1553288294853534", name: "Feax Informática" };
const BE2B = { id: "1610491439097515", name: "Be2B Tecnologia" };
const raw = {
  businesses: { data: [BE2B, FEAX] },
  adAccounts: { data: [
    { id: "act_3639337402278", name: "Marcio Mendes", account_status: 1 },                                  // conta pessoal (sem empresa)
    { id: "act_111111111", name: "Be2B teste", account_status: 1, business: BE2B },
    { id: "act_222222222", name: "Feax antiga", account_status: 2, business: FEAX },                        // desativada
    { id: "act_333333333", name: "Feax", account_status: 1, business: FEAX }
  ] },
  pages: { data: [{ id: "369472939791937", name: "Feax Informática e Tecnologia Ltda", instagram_business_account: { id: "1784", username: "feaxinformatica" } }] }
};
const opts = () => normalizeOptions(raw);

test("normalizeAdAccountId aceita só número (com ou sem act_)", () => {
  assert.equal(normalizeAdAccountId("act_123456"), "act_123456"); assert.equal(normalizeAdAccountId("123456"), "act_123456"); assert.equal(normalizeAdAccountId(" 123456 "), "act_123456");
  for (const bad of ["", null, undefined, "act_", "act_12", "abc", "act_12a456", "1".repeat(30), {}, []]) assert.equal(normalizeAdAccountId(bad), null, String(bad));
});

test("normalizeOptions: lista simples, status em português, conta pessoal sem empresa, sem duplicados", () => {
  const o = normalizeOptions({ ...raw, adAccounts: { data: [...raw.adAccounts.data, { id: "act_333333333", name: "repetida", account_status: 1 }] } });
  assert.equal(o.ad_accounts.length, 4); assert.deepEqual(o.businesses.map((b) => b.id), [BE2B.id, FEAX.id]);
  const byId = Object.fromEntries(o.ad_accounts.map((a) => [a.id, a]));
  assert.equal(byId.act_3639337402278.business, null); assert.equal(byId.act_222222222.status_label, "Desativada"); assert.equal(byId.act_222222222.active, false); assert.equal(byId.act_333333333.active, true); assert.equal(byId.act_333333333.name, "Feax");
  assert.deepEqual(o.pages[0], { id: "369472939791937", name: "Feax Informática e Tecnologia Ltda", instagram: { id: "1784", username: "feaxinformatica" } });
});

test("normalizeOptions tolera respostas vazias, nulas ou com lixo", () => {
  for (const input of [undefined, null, {}, { businesses: null, adAccounts: null, pages: null }, { adAccounts: { data: [null, {}, { id: "x" }, 5] } }]) assert.deepEqual(normalizeOptions(input), { businesses: [], ad_accounts: [], pages: [] });
  assert.equal(normalizeOptions({ adAccounts: { data: [{ id: "act_999999", account_status: 55 }] } }).ad_accounts[0].status_label, "Situação desconhecida");
});

test("pickDefaults: primeira conta ATIVA da primeira empresa; nunca a conta de outra empresa se houver uma da empresa", () => {
  const feaxOnly = normalizeOptions({ ...raw, businesses: { data: [FEAX] } });
  const d = pickDefaults(feaxOnly); assert.equal(d.business.id, FEAX.id); assert.equal(d.adAccount.id, "act_333333333"); assert.equal(d.page.id, "369472939791937");
});

test("pickDefaults: sem conta ativa da empresa usa a primeira dela; sem empresa usa a primeira ativa; vazio devolve nulos", () => {
  const onlyDisabled = normalizeOptions({ businesses: { data: [FEAX] }, adAccounts: { data: [{ id: "act_222222222", name: "x", account_status: 2, business: FEAX }, { id: "act_777777777", name: "pessoal", account_status: 1 }] } });
  assert.equal(pickDefaults(onlyDisabled).adAccount.id, "act_222222222");
  const noBusiness = normalizeOptions({ adAccounts: { data: [{ id: "act_5555555", name: "p1", account_status: 2 }, { id: "act_6666666", name: "p2", account_status: 1 }] } });
  const d = pickDefaults(noBusiness); assert.equal(d.adAccount.id, "act_6666666"); assert.equal(d.business, null);
  assert.deepEqual(pickDefaults(normalizeOptions({})), { business: null, adAccount: null, page: null });
});

test("validateSelection: só vale conta que o próprio token lista", () => {
  assert.equal(validateSelection(opts(), {}).code, "invalid_ad_account"); assert.equal(validateSelection(opts(), { ad_account_id: "lixo" }).code, "invalid_ad_account");
  const r = validateSelection(opts(), { ad_account_id: "act_999999999" }); assert.equal(r.ok, false); assert.equal(r.code, "ad_account_not_available");
});

test("validateSelection: a empresa é a da conta; empresa diferente é conflito; conta pessoal fica sem empresa", () => {
  const ok = validateSelection(opts(), { ad_account_id: "333333333" }); assert.equal(ok.ok, true); assert.equal(ok.business.id, FEAX.id); assert.equal(ok.adAccount.id, "act_333333333");
  assert.equal(validateSelection(opts(), { ad_account_id: "act_333333333", business_id: FEAX.id }).ok, true);
  assert.equal(validateSelection(opts(), { ad_account_id: "act_333333333", business_id: BE2B.id }).code, "business_mismatch");
  assert.equal(validateSelection(opts(), { ad_account_id: "act_333333333", business_id: "999" }).code, "business_not_available");
  const personal = validateSelection(opts(), { ad_account_id: "act_3639337402278" }); assert.equal(personal.ok, true); assert.equal(personal.business, null);
  assert.equal(validateSelection(opts(), { ad_account_id: "act_3639337402278", business_id: FEAX.id }).business.id, FEAX.id);   // conta pessoal + empresa conhecida da lista
});

test("validateSelection: a Página é opcional, mas se vier precisa estar na lista", () => {
  assert.equal(validateSelection(opts(), { ad_account_id: "act_333333333" }).page, null);
  assert.equal(validateSelection(opts(), { ad_account_id: "act_333333333", page_id: "369472939791937" }).page.instagram.username, "feaxinformatica");
  assert.equal(validateSelection(opts(), { ad_account_id: "act_333333333", page_id: "1" }).code, "page_not_available");
});

// ---- rotas (dependências falsas) ---------------------------------------------------------------------------------------------------------
const mkRes = () => { const r = { status: 200, body: null, code(c) { this.status = c; return this; } }; return r; };
function harness(o = {}) {
  const calls = { saved: [], loaded: [], cleared: [] }; let conn = o.connection === undefined ? { organization_id: "ORG", access_token_encrypted: "enc", page_id: null, business_id: BE2B.id, ad_account_id: "act_111111111", selection_confirmed_at: null } : o.connection;
  const h = createSelectionHandlers({
    getOrganizationId: (req) => req.org ?? "ORG", isOrgAdmin: (req) => req.admin !== false, getConnection: async () => conn,
    decryptToken: (e) => { assert.equal(e, "enc"); return "TOKEN-SECRETO"; },
    loadOptions: async (t) => { calls.loaded.push(t); if (o.loadThrows) throw new Error(`Graph recusou ${t}`); return o.raw || raw; },
    clearSelection: async (org) => { calls.cleared.push(org); conn = { ...conn, business_id: null, business_name: null, ad_account_id: null, ad_account_name: null, page_id: null, page_name: null, selection_confirmed_at: null }; return conn; },
    saveSelection: async (org, data) => { calls.saved.push([org, data]); conn = { ...conn, ...data, selection_confirmed_at: new Date() }; return conn; },
    sanitizeConnection: (c) => ({ business_id: c.business_id, ad_account_id: c.ad_account_id, page_id: c.page_id, selection_confirmed: Boolean(c.selection_confirmed_at), has_access_token: true }),
    ok: (res, b) => { res.body = { success: true, ...b }; return res; }, fail: (res, status, message, details) => { res.status = status; res.body = { success: false, message, details }; return res; }
  });
  return { h, calls };
}

test("GET options: devolve opções e a escolha atual, sem token", async () => {
  const { h, calls } = harness(); const res = mkRes(); await h.handleOptions({}, res);
  assert.equal(res.status, 200); assert.equal(res.body.data.selection_confirmed, false); assert.equal(res.body.data.current.ad_account_id, "act_111111111"); assert.equal(res.body.data.ad_accounts.length, 4); assert.deepEqual(calls.loaded, ["TOKEN-SECRETO"]);
  assert.ok(!JSON.stringify(res.body).includes("TOKEN-SECRETO") && !JSON.stringify(res.body).includes("enc\""));
});

test("options/select: só administrador; sem empresa, sem conexão e sem token são recusados com mensagem clara", async () => {
  for (const handler of ["handleOptions", "handleSelect"]) {
    let { h } = harness(); let res = mkRes(); await h[handler]({ admin: false }, res); assert.equal(res.status, 403);
    res = mkRes(); await h[handler]({ org: "" }, res); assert.equal(res.status, 400);
    ({ h } = harness({ connection: null })); res = mkRes(); await h[handler]({}, res); assert.equal(res.status, 404);
    ({ h } = harness({ connection: { organization_id: "ORG", access_token_encrypted: null } })); res = mkRes(); await h[handler]({}, res); assert.equal(res.status, 400); assert.match(res.body.message, /Reconecte/);
  }
});

test("a Meta recusa listar (token vencido): 502 com orientação, sem vazar o token", async () => {
  const { h } = harness({ loadThrows: true }); const res = mkRes(); await h.handleOptions({}, res);
  assert.equal(res.status, 502); assert.match(res.body.message, /Reconecte/);
});

test("POST select grava a escolha validada e a marca como confirmada", async () => {
  const { h, calls } = harness(); const res = mkRes(); await h.handleSelect({ body: { ad_account_id: "act_333333333", page_id: "369472939791937" } }, res);
  assert.equal(res.status, 200); assert.equal(res.body.data.connection.selection_confirmed, true); assert.equal(res.body.data.connection.ad_account_id, "act_333333333"); assert.equal(res.body.data.warning, null);
  assert.deepEqual(calls.saved[0], ["ORG", { business_id: FEAX.id, business_name: FEAX.name, ad_account_id: "act_333333333", ad_account_name: "Feax", page_id: "369472939791937", page_name: "Feax Informática e Tecnologia Ltda", instagram_actor_id: "1784", instagram_username: "feaxinformatica" }]);
});

test("POST select: ID que não está na lista do token NÃO é gravado", async () => {
  const { h, calls } = harness(); const res = mkRes(); await h.handleSelect({ body: { ad_account_id: "act_999999999" } }, res);
  assert.equal(res.status, 400); assert.equal(calls.saved.length, 0); assert.equal(res.body.details, "ad_account_not_available");
});

test("POST select: conta desativada é aceita com aviso; conta pessoal grava sem empresa", async () => {
  let { h, calls } = harness(); let res = mkRes(); await h.handleSelect({ body: { ad_account_id: "act_222222222" } }, res);
  assert.equal(res.status, 200); assert.match(res.body.data.warning, /Desativada/);
  ({ h, calls } = harness()); res = mkRes(); await h.handleSelect({ body: { ad_account_id: "act_3639337402278" } }, res); assert.equal(calls.saved[0][1].business_id, null); assert.equal(calls.saved[0][1].business_name, null);
});

test("POST select: sem escolher Página, mantém a gravada só se ainda disponível (nunca uma Página de outra empresa)", async () => {
  let { h, calls } = harness({ connection: { organization_id: "ORG", access_token_encrypted: "enc", page_id: "369472939791937", selection_confirmed_at: null } }); await h.handleSelect({ body: { ad_account_id: "act_333333333" } }, mkRes());
  assert.equal(calls.saved[0][1].page_id, "369472939791937"); assert.equal(calls.saved[0][1].instagram_username, "feaxinformatica");
  ({ h, calls } = harness({ connection: { organization_id: "ORG", access_token_encrypted: "enc", page_id: "PAGINA-DE-OUTRA-EMPRESA", selection_confirmed_at: null } })); await h.handleSelect({ body: { ad_account_id: "act_333333333" } }, mkRes());
  assert.equal(calls.saved[0][1].page_id, null); assert.equal(calls.saved[0][1].instagram_actor_id, null);
});

test("erro inesperado vira 500 com mensagem fixa (o detalhe técnico não é a mensagem)", async () => {
  const { h } = harness(); const h2 = createSelectionHandlers({ getOrganizationId: () => "ORG", isOrgAdmin: () => true, getConnection: async () => { throw new Error("banco caiu"); }, ok: () => {}, fail: (res, status, message, details) => { res.status = status; res.body = { message, details }; return res; } });
  const res = mkRes(); await h2.handleSelect({ body: {} }, res); assert.equal(res.status, 500); assert.equal(res.body.message, "Não foi possível salvar a escolha."); void h;
});

// ---- isolamento entre empresas (só o que foi marcado na tela da Meta) --------------------------------------------------------------------
const GRAW = {
  adAccounts: { data: [
    { id: "act_111111111", name: "Cliente A", account_status: 1, business: { id: "900", name: "BM A" } },
    { id: "act_222222222", name: "Feax Ads", account_status: 1, business: { id: "1553288294853534", name: "Feax Informática" } },
    { id: "act_333333333", name: "Pessoal", account_status: 1 }
  ] },
  businesses: { data: [{ id: "900", name: "BM A" }, { id: "1553288294853534", name: "Feax Informática" }] },
  pages: { data: [{ id: "p-a", name: "Página A" }, { id: "p-feax", name: "Página Feax" }] }
};
const dbg = (...g) => ({ granular_scopes: g });

test("restrictToGranted: só aparecem as contas marcadas na tela da Meta; as outras do mesmo usuário somem", () => {
  const r = restrictToGranted(GRAW, dbg({ scope: "ads_management", target_ids: ["222222222"] }, { scope: "business_management", target_ids: ["900", "1553288294853534"] }));
  assert.deepEqual(r.adAccounts.map((a) => a.id), ["act_222222222"]);
  assert.deepEqual(r.businesses, [{ id: "1553288294853534", name: "Feax Informática" }]);   // BM A não aparece, mesmo marcado em business_management
  assert.deepEqual(r.pages, []);
  const n = normalizeOptions(r);
  assert.equal(JSON.stringify(n).includes("Cliente A"), false);
  assert.equal(JSON.stringify(n).includes("Pessoal"), false);
});

test("restrictToGranted: ads_read também vale; target_ids com prefixo act_ funcionam; Páginas só as de pages_*", () => {
  const r = restrictToGranted(GRAW, dbg({ scope: "ads_read", target_ids: ["act_111111111"] }, { scope: "pages_show_list", target_ids: ["p-feax"] }));
  assert.deepEqual(r.adAccounts.map((a) => a.id), ["act_111111111"]);
  assert.deepEqual(r.pages.map((p) => p.id), ["p-feax"]);
});

test("restrictToGranted: sem granular_scopes, sem alvos ou sem debug_token = nada (nunca 'tudo que o usuário enxerga')", () => {
  for (const d of [null, undefined, {}, { granular_scopes: [] }, dbg({ scope: "ads_management" }), dbg({ scope: "ads_management", target_ids: [] }), dbg({ scope: "email", target_ids: ["222222222"] })]) {
    const r = restrictToGranted(GRAW, d);
    assert.deepEqual([r.adAccounts, r.businesses, r.pages], [[], [], []]);
  }
  assert.deepEqual(restrictToGranted(null, dbg({ scope: "ads_management", target_ids: ["1"] })), { businesses: [], adAccounts: [], pages: [] });
});

test("restrictToGranted + validateSelection: conta que não foi marcada é recusada, mesmo existindo no usuário", () => {
  const o = normalizeOptions(restrictToGranted(GRAW, dbg({ scope: "ads_management", target_ids: ["222222222"] })));
  assert.equal(validateSelection(o, { ad_account_id: "act_111111111" }).code, "ad_account_not_available");
  assert.equal(validateSelection(o, { ad_account_id: "act_222222222" }).ok, true);
});

test("options: conta gravada que NÃO está entre as autorizadas é removida (nada de Be2B/outro cliente 'conectado')", async () => {
  const stale = { organization_id: "ORG", access_token_encrypted: "enc", business_id: BE2B.id, business_name: "Be2B Tecnologia", ad_account_id: "act_3639337402278", ad_account_name: "Marcio Mendes", page_id: "P", selection_confirmed_at: null };
  const { h, calls } = harness({ connection: stale, raw: { businesses: [], adAccounts: [], pages: [] } }); const res = mkRes(); await h.handleOptions({}, res);
  assert.equal(res.status, 200); assert.deepEqual(calls.cleared, ["ORG"]);
  assert.equal(res.body.data.cleared, true); assert.equal(res.body.data.current.ad_account_id, null); assert.equal(res.body.data.current.business_name, null); assert.equal(res.body.data.current.page_id, null);
});

test("options: conta gravada que continua autorizada NÃO é mexida; falha ao consultar a Meta NÃO apaga nada", async () => {
  let { h, calls } = harness(); let res = mkRes(); await h.handleOptions({}, res);
  assert.deepEqual(calls.cleared, []); assert.equal(res.body.data.cleared, false);
  ({ h, calls } = harness({ loadThrows: true })); res = mkRes(); await h.handleOptions({}, res);
  assert.equal(res.status, 502); assert.deepEqual(calls.cleared, []);
});
