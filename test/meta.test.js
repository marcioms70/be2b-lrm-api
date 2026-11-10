import { test } from "node:test";
import assert from "node:assert/strict";
import { MetaGraphError, graphRequest } from "../src/metaGraph.js";
import { buildWindow, mapInsightRow, metaStatusFor, pickLeadCount } from "../src/metaInsightsMap.js";

const res = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const noSleep = async () => {};

test("pickLeadCount usa UM tipo (não soma tipos sobrepostos)", () => {
  assert.equal(pickLeadCount([
    { action_type: "link_click", value: "50" },
    { action_type: "lead", value: "4" },
    { action_type: "onsite_conversion.lead_grouped", value: "4" },
    { action_type: "onsite_conversion.messaging_conversation_started_7d", value: "9" }
  ]), 4);
  assert.equal(pickLeadCount([{ action_type: "onsite_conversion.messaging_conversation_started_7d", value: "9" }]), 9);
  assert.equal(pickLeadCount([{ action_type: "link_click", value: "50" }]), 0);
  assert.equal(pickLeadCount(undefined), 0);
});

test("mapInsightRow calcula taxas a partir dos totais do dia", () => {
  const m = mapInsightRow({ date_start: "2026-11-09", spend: "120.50", impressions: "10000", clicks: "300", inline_link_clicks: "200", actions: [{ action_type: "lead", value: "5" }] });
  assert.equal(m.report_date, "2026-11-09");
  assert.equal(m.amount_spent, 120.5);
  assert.equal(m.clicks, 200); // clique no link tem prioridade
  assert.equal(m.leads, 5);
  assert.equal(m.cpl, 24.1);
  assert.equal(m.ctr, 2);
  assert.equal(m.cpc, 0.6025);
});

test("mapInsightRow sem dados não divide por zero", () => {
  const m = mapInsightRow({ date_start: "2026-11-09", spend: "0", impressions: "0" });
  assert.deepEqual([m.cpl, m.ctr, m.cpc, m.leads], [null, null, null, 0]);
  assert.equal(mapInsightRow({ date_start: "x", spend: "1", impressions: "10", clicks: "4" }).clicks, 4); // sem link clicks usa clicks
});

test("buildWindow: últimos N dias, limitado a 90", () => {
  const today = new Date(Date.UTC(2026, 10, 10));
  assert.deepEqual(buildWindow(7, today), { since: "2026-11-04", until: "2026-11-10", days: 7 });
  assert.equal(buildWindow(500, today).days, 90);
  assert.equal(buildWindow("abc", today).days, 7);
  assert.equal(buildWindow(0, today).days, 1);
});

test("metaStatusFor: finalizar/arquivar só pausa (ARCHIVED é irreversível)", () => {
  assert.equal(metaStatusFor("ativa"), "ACTIVE");
  assert.equal(metaStatusFor("pausada"), "PAUSED");
  assert.equal(metaStatusFor("finalizada"), "PAUSED");
  assert.equal(metaStatusFor("arquivada"), "PAUSED");
  assert.equal(metaStatusFor("rascunho"), null);
  assert.equal(metaStatusFor("aguardando_aprovacao"), null);
});

test("graphRequest: envia token no header (não na URL) e devolve o JSON", async () => {
  let seen;
  const out = await graphRequest({ path: "/123/insights", token: "TKN", params: { fields: "spend" }, baseUrl: "https://g.test/v1", sleep: noSleep,
    fetchImpl: async (url, init) => { seen = { url: String(url), init }; return res(200, { data: [] }); } });
  assert.deepEqual(out, { data: [] });
  assert.equal(seen.init.headers.Authorization, "Bearer TKN");
  assert.ok(!seen.url.includes("TKN"));
  assert.ok(seen.url.includes("fields=spend"));
});

test("graphRequest: repete GET em erro transitório e depois funciona", async () => {
  let n = 0;
  const out = await graphRequest({ path: "/x", token: "t", baseUrl: "https://g.test", sleep: noSleep, random: () => 0,
    fetchImpl: async () => (++n < 3 ? res(503, { error: { message: "down", code: 2 } }) : res(200, { ok: true })) });
  assert.equal(n, 3);
  assert.deepEqual(out, { ok: true });
});

test("graphRequest: rate limit (código 17) é repetido e depois falha com classificação", async () => {
  let n = 0;
  await assert.rejects(
    graphRequest({ path: "/x", token: "t", baseUrl: "https://g.test", sleep: noSleep, maxRetries: 2, random: () => 0,
      fetchImpl: async () => { n++; return res(400, { error: { message: "limite", code: 17 } }); } }),
    (e) => e instanceof MetaGraphError && e.isRateLimit && e.code === 17
  );
  assert.equal(n, 3);
});

test("graphRequest: token expirado (190) NÃO é repetido e é sinalizado", async () => {
  let n = 0;
  await assert.rejects(
    graphRequest({ path: "/x", token: "t", baseUrl: "https://g.test", sleep: noSleep,
      fetchImpl: async () => { n++; return res(401, { error: { message: "expirou", code: 190, error_subcode: 463 } }); } }),
    (e) => e.isTokenExpired === true && e.subcode === 463
  );
  assert.equal(n, 1);
});

test("graphRequest: POST de criação não é repetido em 5xx (evita objetos duplicados)", async () => {
  let n = 0;
  await assert.rejects(
    graphRequest({ method: "POST", path: "/act_1/campaigns", token: "t", params: { name: "x" }, baseUrl: "https://g.test", sleep: noSleep,
      fetchImpl: async () => { n++; return res(500, { error: { message: "boom", code: 2 } }); } }),
    MetaGraphError
  );
  assert.equal(n, 1);
});

test("graphRequest: falha de rede vira MetaGraphError após as tentativas", async () => {
  let n = 0;
  await assert.rejects(
    graphRequest({ path: "/x", token: "t", baseUrl: "https://g.test", sleep: noSleep, maxRetries: 1, random: () => 0,
      fetchImpl: async () => { n++; throw new Error("ECONNRESET"); } }),
    /Falha de rede/
  );
  assert.equal(n, 2);
});
