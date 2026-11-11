import { test } from "node:test";
import assert from "node:assert/strict";
import { MetaGraphError, graphBaseUrl } from "../src/metaGraph.js";
import {
  AGE_MAX, AGE_MIN, BR_STATES, MAX_INTERESTS, RADIUS_MAX_KM, RADIUS_MIN_KM, ReachError, buildTargetingSpec, clampRadius, createReachGuard, estimateReach,
  norm, parseReachInput, parseReachResponse, pickCity, pickInterest, reachCacheKey,
} from "../src/metaReachCore.js";

// ---------------------------------------------------------------------------
test("norm ignora acento, maiúsculas e espaços repetidos", () => {
  assert.equal(norm("  São   PAULO "), "sao paulo");
  assert.equal(norm(null), "");
});

test("parseReachInput: padrões (Brasil, 18–65, todos os gêneros, sem cidade nem raio)", () => {
  const r = parseReachInput({});
  assert.equal(r.ok, true);
  assert.deepEqual(r.value, { country: "Brasil", state: "", city: "", radius_km: null, min_age: 18, max_age: 65, gender: "all", interests: [], interests_truncated: false });
  assert.equal(parseReachInput(undefined).ok, true);
  assert.equal(parseReachInput("lixo").ok, true);
  assert.equal(parseReachInput([1]).ok, true);
});

test("parseReachInput: idade fora de 13–65 ou invertida é recusada, com mensagem", () => {
  for (const t of [{ min_age: 10 }, { max_age: 70 }, { min_age: 40, max_age: 30 }]) {
    const r = parseReachInput(t);
    assert.equal(r.ok, false);
    assert.match(r.message, new RegExp(`${AGE_MIN} e ${AGE_MAX}`));
  }
  assert.equal(parseReachInput({ min_age: "25", max_age: "55" }).value.min_age, 25);
  assert.equal(parseReachInput({ min_age: 13, max_age: 65 }).ok, true);
});

test("parseReachInput: gênero inválido é recusado; aceita all, male e female", () => {
  assert.equal(parseReachInput({ gender: "outro" }).ok, false);
  for (const g of ["all", "male", "female", "MALE"]) assert.equal(parseReachInput({ gender: g }).ok, true);
});

test("parseReachInput: raio só vale com cidade; interesses sem repetição (ignorando acento), com limite", () => {
  assert.equal(parseReachInput({ radius_km: 20 }).value.radius_km, null);
  assert.equal(parseReachInput({ city: "Campo Grande", radius_km: "20" }).value.radius_km, 20);
  assert.equal(parseReachInput({ city: "Campo Grande", radius_km: -5 }).value.radius_km, null);
  const csv = parseReachInput({ interests: "Oficina, auto peças,  AUTO PEÇAS , , mecânica" }).value;
  assert.deepEqual(csv.interests, ["Oficina", "auto peças", "mecânica"]);
  const many = parseReachInput({ interests: Array.from({ length: 12 }, (_, i) => `tema ${i}`) }).value;
  assert.equal(many.interests.length, MAX_INTERESTS);
  assert.equal(many.interests_truncated, true);
});

test("parseReachInput: limita tamanhos de texto", () => {
  const v = parseReachInput({ city: "c".repeat(300), country: "p".repeat(300), state: "s".repeat(300), interests: ["i".repeat(300)] }).value;
  assert.equal(v.city.length, 80); assert.equal(v.country.length, 60); assert.equal(v.state.length, 40); assert.equal(v.interests[0].length, 60);
});

// ---------------------------------------------------------------------------
const cities = [
  { key: "1", name: "Campo Grande", type: "city", region: "Mato Grosso do Sul", country_code: "BR" },
  { key: "2", name: "Campo Grande", type: "city", region: "Rio de Janeiro", country_code: "BR" },
  { key: "3", name: "Campo Grande do Sul", type: "city", region: "Mato Grosso do Sul" },
  { key: "9", name: "Campo Grande", type: "region", region: "x" },
];

test("pickCity: nome IGUAL (sem acento/maiúsculas); nunca aproxima", () => {
  assert.equal(pickCity([{ key: "7", name: "São Paulo", type: "city", region: "São Paulo" }], { city: "sao paulo" }).match.key, "7");
  assert.equal(pickCity(cities, { city: "Campo Gran" }), null);
  assert.equal(pickCity([], { city: "X" }), null);
  assert.equal(pickCity(null, { city: "X" }), null);
});

test("pickCity: estado em sigla ou por extenso escolhe a cidade certa; estado errado → null", () => {
  assert.equal(pickCity(cities, { city: "Campo Grande", state: "MS" }).match.key, "1");
  assert.equal(pickCity(cities, { city: "Campo Grande", state: "mato grosso do sul" }).match.key, "1");
  assert.equal(pickCity(cities, { city: "Campo Grande", state: "RJ" }).match.key, "2");
  assert.equal(pickCity(cities, { city: "Campo Grande", state: "SP" }), null, "existe a cidade, mas não neste estado");
});

test("pickCity: sem estado e com homônimas → pega a primeira e marca ambígua", () => {
  const r = pickCity(cities, { city: "Campo Grande" });
  assert.equal(r.match.key, "1"); assert.equal(r.ambiguous, true);
  assert.equal(pickCity([cities[0]], { city: "Campo Grande" }).ambiguous, false);
});

test("pickCity: ignora resultado que não é cidade ou não tem chave", () => {
  assert.equal(pickCity([{ name: "Campo Grande", type: "region", key: "9" }, { name: "Campo Grande", type: "city" }], { city: "Campo Grande" }), null);
});

test("pickInterest: nome igual se houver; senão o primeiro; sem resultado → null", () => {
  const list = [{ id: "1", name: "Oficina mecânica" }, { id: "2", name: "Oficina" }, { name: "sem id" }];
  assert.deepEqual(pickInterest(list, "oficina"), { match: list[1], exact: true });
  assert.deepEqual(pickInterest(list, "carro"), { match: list[0], exact: false });
  assert.equal(pickInterest([], "x"), null);
  assert.equal(pickInterest(undefined, "x"), null);
});

test("clampRadius respeita os limites da Meta (17–80 km) e avisa quando ajusta", () => {
  assert.deepEqual(clampRadius(null), { radius: null, adjusted: false });
  assert.deepEqual(clampRadius(5), { radius: RADIUS_MIN_KM, adjusted: true });
  assert.deepEqual(clampRadius(200), { radius: RADIUS_MAX_KM, adjusted: true });
  assert.deepEqual(clampRadius(30), { radius: 30, adjusted: false });
});

test("buildTargetingSpec: país OU cidade (com raio em km), idade, gênero e interesses (OU entre si)", () => {
  assert.deepEqual(buildTargetingSpec({ countryCode: "BR", min_age: 18, max_age: 65 }), { geo_locations: { countries: ["BR"] }, age_min: 18, age_max: 65 });
  const full = buildTargetingSpec({ countryCode: "BR", city: { key: "1" }, radiusKm: 20, min_age: 25, max_age: 55, gender: "female", interests: [{ id: "6", name: "Oficina" }] });
  assert.deepEqual(full, {
    geo_locations: { cities: [{ key: "1", radius: 20, distance_unit: "kilometer" }] }, age_min: 25, age_max: 55, genders: [2],
    flexible_spec: [{ interests: [{ id: "6", name: "Oficina" }] }],
  });
  assert.deepEqual(buildTargetingSpec({ countryCode: "BR", city: { key: "1" }, min_age: 18, max_age: 65 }).geo_locations, { cities: [{ key: "1" }] }); // sem raio
  assert.deepEqual(buildTargetingSpec({ countryCode: "BR", min_age: 18, max_age: 65, gender: "male" }).genders, [1]);
  assert.equal("genders" in buildTargetingSpec({ countryCode: "BR", min_age: 18, max_age: 65, gender: "all" }), false);
});

// ---------------------------------------------------------------------------
test("parseReachResponse: reachestimate (objeto ou lista), delivery_estimate e valores em texto", () => {
  assert.deepEqual(parseReachResponse({ data: { users_lower_bound: 1000, users_upper_bound: 1500, estimate_ready: true } }), { lower: 1000, upper: 1500, ready: true });
  assert.deepEqual(parseReachResponse({ data: [{ users_lower_bound: "2000", users_upper_bound: "3000" }] }), { lower: 2000, upper: 3000, ready: true });
  assert.deepEqual(parseReachResponse({ data: [{ estimate_mau_lower_bound: 500, estimate_mau_upper_bound: 800, estimate_dau: 40 }] }), { lower: 500, upper: 800, ready: true });
  assert.deepEqual(parseReachResponse({ data: [{ estimate_mau: 12345 }] }), { lower: 12345, upper: 12345, ready: true });
  assert.deepEqual(parseReachResponse({ users_lower_bound: 10, users_upper_bound: 20 }), { lower: 10, upper: 20, ready: true }); // sem "data"
});

test("parseReachResponse: limites invertidos são corrigidos; só um limite vale para os dois; 'ainda calculando' vira ready=false", () => {
  assert.deepEqual(parseReachResponse({ data: { users_lower_bound: 900, users_upper_bound: 100 } }), { lower: 100, upper: 900, ready: true });
  assert.deepEqual(parseReachResponse({ data: { users_upper_bound: 700 } }), { lower: 700, upper: 700, ready: true });
  assert.equal(parseReachResponse({ data: { users_lower_bound: 0, users_upper_bound: 0, estimate_ready: false } }).ready, false);
});

test("parseReachResponse: sem número utilizável → null", () => {
  for (const j of [null, undefined, {}, { data: [] }, { data: {} }, { data: [{ users_lower_bound: -5 }] }, { data: { users_lower_bound: "abc" } }, "texto"]) {
    assert.equal(parseReachResponse(j), null);
  }
});

// ---------------------------------------------------------------------------
const metaErr = (over = {}) => new MetaGraphError("erro", over);

/** graph falso: registra as chamadas e responde por rota */
function fakeGraph(routes) {
  const calls = [];
  const fn = async ({ path, token, params }) => {
    calls.push({ path, token, params });
    const key = path === "/search" ? `search:${params.type}:${params.q ?? ""}` : path;
    const handler = routes[key] ?? routes[path] ?? routes[`search:${params.type}`];
    if (!handler) throw new Error(`rota não simulada: ${key}`);
    const out = typeof handler === "function" ? handler({ path, token, params }) : handler;
    if (out instanceof Error) throw out;
    return out;
  };
  fn.calls = calls;
  return fn;
}
const input = (over = {}) => parseReachInput({ country: "Brasil", state: "MS", city: "Campo Grande", radius_km: 20, min_age: 25, max_age: 55, gender: "female", interests: ["oficina", "xyz"], ...over }).value;
const okRoutes = (over = {}) => ({
  "search:adgeolocation": { data: cities },
  "search:adinterest:oficina": { data: [{ id: "6003", name: "Oficina", audience_size: 100 }] },
  "search:adinterest:xyz": { data: [] },
  "/act_123/reachestimate": { data: { users_lower_bound: 120000, users_upper_bound: 140000, estimate_ready: true } },
  ...over,
});

test("estimateReach: resolve cidade e interesses, monta o público e devolve a faixa", async () => {
  const graph = fakeGraph(okRoutes());
  const r = await estimateReach({ token: "TOK", adAccountId: "act_123", input: input(), graph });
  assert.equal(r.lower, 120000); assert.equal(r.upper, 140000); assert.equal(r.ready, true); assert.equal(r.source, "reachestimate");
  assert.deepEqual(r.resolved.city, { name: "Campo Grande", region: "Mato Grosso do Sul", radius_km: 20, radius_adjusted: false, ambiguous: false });
  assert.deepEqual(r.resolved.interests, [{ id: "6003", name: "Oficina", asked: "oficina", exact: true }]);
  assert.deepEqual(r.unresolved_interests, ["xyz"]);

  const reach = graph.calls.find((c) => c.path === "/act_123/reachestimate");
  assert.equal(reach.token, "TOK");
  assert.deepEqual(reach.params.targeting_spec, {
    geo_locations: { cities: [{ key: "1", radius: 20, distance_unit: "kilometer" }] }, age_min: 25, age_max: 55, genders: [2],
    flexible_spec: [{ interests: [{ id: "6003", name: "Oficina" }] }],
  });
  const city = graph.calls.find((c) => c.params.type === "adgeolocation");
  assert.deepEqual([city.params.q, city.params.location_types, city.params.country_code, city.params.locale], ["Campo Grande", ["city"], "BR", "pt_BR"]);
});

test("estimateReach: aceita conta com ou sem o prefixo act_", async () => {
  const g1 = fakeGraph(okRoutes());
  await estimateReach({ token: "T", adAccountId: "123", input: input(), graph: g1 });
  assert.ok(g1.calls.some((c) => c.path === "/act_123/reachestimate"));
});

test("estimateReach: país conhecido não consulta a Meta; país desconhecido é buscado; não achado → erro", async () => {
  const g = fakeGraph(okRoutes());
  await estimateReach({ token: "T", adAccountId: "act_123", input: input({ city: "" }), graph: g });
  assert.equal(g.calls.some((c) => c.params?.location_types?.includes("country")), false);

  const g2 = fakeGraph({ "search:adgeolocation": { data: [{ type: "country", key: "JP", country_code: "JP", name: "Japão" }] }, "/act_123/reachestimate": { data: { users_lower_bound: 5, users_upper_bound: 6 } } });
  const r = await estimateReach({ token: "T", adAccountId: "act_123", input: input({ country: "Japão", city: "", interests: [] }), graph: g2 });
  assert.equal(r.resolved.country, "JP");
  assert.deepEqual(g2.calls[0].params.location_types, ["country"]);

  const g3 = fakeGraph({ "search:adgeolocation": { data: [] } });
  await assert.rejects(estimateReach({ token: "T", adAccountId: "act_123", input: input({ country: "Narnia", city: "" }), graph: g3 }), (e) => e instanceof ReachError && /Narnia/.test(e.message) && e.httpStatus === 422);
});

test("estimateReach: cidade não encontrada (ou no estado errado) → ReachError 422 com o nome e o estado", async () => {
  const g = fakeGraph(okRoutes());
  await assert.rejects(estimateReach({ token: "T", adAccountId: "act_123", input: input({ city: "Atlântida" }), graph: g }), (e) => e instanceof ReachError && e.httpStatus === 422 && /Atlântida/.test(e.message) && /MS/.test(e.message));
  await assert.rejects(estimateReach({ token: "T", adAccountId: "act_123", input: input({ state: "SP" }), graph: g }), (e) => /Campo Grande/.test(e.message) && /SP/.test(e.message));
  assert.equal(g.calls.some((c) => c.path.includes("reachestimate")), false, "não estima com a cidade errada");
});

test("estimateReach: raio fora de 17–80 km é ajustado e avisado", async () => {
  const g = fakeGraph(okRoutes());
  const r = await estimateReach({ token: "T", adAccountId: "act_123", input: input({ radius_km: 5 }), graph: g });
  assert.deepEqual([r.resolved.city.radius_km, r.resolved.city.radius_adjusted], [RADIUS_MIN_KM, true]);
  assert.equal(g.calls.find((c) => c.path.includes("reachestimate")).params.targeting_spec.geo_locations.cities[0].radius, RADIUS_MIN_KM);
});

test("estimateReach: cidade homônima sem estado é marcada como ambígua", async () => {
  const r = await estimateReach({ token: "T", adAccountId: "act_123", input: input({ state: "" }), graph: fakeGraph(okRoutes()) });
  assert.equal(r.resolved.city.ambiguous, true);
});

test("estimateReach: reachestimate recusado (erro comum) → usa delivery_estimate com optimization_goal REACH", async () => {
  const g = fakeGraph(okRoutes({
    "/act_123/reachestimate": metaErr({ status: 400, code: 100 }),
    "/act_123/delivery_estimate": { data: [{ estimate_mau_lower_bound: 800, estimate_mau_upper_bound: 900, estimate_ready: true }] },
  }));
  const r = await estimateReach({ token: "T", adAccountId: "act_123", input: input(), graph: g });
  assert.deepEqual([r.lower, r.upper, r.source], [800, 900, "delivery_estimate"]);
  assert.equal(g.calls.find((c) => c.path.endsWith("delivery_estimate")).params.optimization_goal, "REACH");
});

test("estimateReach: reachestimate sem número também cai no delivery_estimate", async () => {
  const g = fakeGraph(okRoutes({ "/act_123/reachestimate": { data: [] }, "/act_123/delivery_estimate": { data: [{ estimate_mau: 777 }] } }));
  const r = await estimateReach({ token: "T", adAccountId: "act_123", input: input(), graph: g });
  assert.deepEqual([r.lower, r.upper, r.source], [777, 777, "delivery_estimate"]);
});

test("estimateReach: token expirado, falta de permissão ou limite da Meta NÃO tentam o outro caminho", async () => {
  for (const e of [metaErr({ status: 400, code: 190 }), metaErr({ status: 403, code: 200 }), metaErr({ status: 400, code: 17 })]) {
    const g = fakeGraph(okRoutes({ "/act_123/reachestimate": e }));
    await assert.rejects(estimateReach({ token: "T", adAccountId: "act_123", input: input(), graph: g }), (err) => err === e);
    assert.equal(g.calls.some((c) => c.path.endsWith("delivery_estimate")), false);
  }
});

test("estimateReach: se os dois caminhos falham, devolve o último erro da Meta; sem erro, ReachError 502", async () => {
  const last = metaErr({ status: 400, code: 100 });
  const g = fakeGraph(okRoutes({ "/act_123/reachestimate": metaErr({ status: 400, code: 100 }), "/act_123/delivery_estimate": last }));
  await assert.rejects(estimateReach({ token: "T", adAccountId: "act_123", input: input(), graph: g }), (e) => e === last);
  const g2 = fakeGraph(okRoutes({ "/act_123/reachestimate": { data: [] }, "/act_123/delivery_estimate": { data: [] } }));
  await assert.rejects(estimateReach({ token: "T", adAccountId: "act_123", input: input(), graph: g2 }), (e) => e instanceof ReachError && e.httpStatus === 502);
});

test("estimateReach: interesse com falha comum só fica sem resolver; falha de acesso derruba tudo", async () => {
  const g = fakeGraph(okRoutes({ "search:adinterest:oficina": metaErr({ status: 500 }) }));
  const r = await estimateReach({ token: "T", adAccountId: "act_123", input: input(), graph: g });
  assert.deepEqual(r.unresolved_interests.sort(), ["oficina", "xyz"]);
  const bad = metaErr({ status: 400, code: 190 });
  const g2 = fakeGraph(okRoutes({ "search:adinterest:oficina": bad }));
  await assert.rejects(estimateReach({ token: "T", adAccountId: "act_123", input: input(), graph: g2 }), (e) => e === bad);
});

test("estimateReach: 'ainda calculando' volta com ready=false; interesses cortados são avisados", async () => {
  const g = fakeGraph(okRoutes({ "/act_123/reachestimate": { data: { users_lower_bound: 0, users_upper_bound: 0, estimate_ready: false } } }));
  assert.equal((await estimateReach({ token: "T", adAccountId: "act_123", input: input(), graph: g })).ready, false);
  const many = input({ interests: Array.from({ length: 12 }, (_, i) => `t${i}`) });
  const g2 = fakeGraph(okRoutes({ "search:adinterest": { data: [] } }));
  assert.equal((await estimateReach({ token: "T", adAccountId: "act_123", input: many, graph: g2 })).interests_truncated, true);
});

// ---------------------------------------------------------------------------
test("guarda: cache vale por 10 minutos e expira", () => {
  let t = 1_000_000;
  const guard = createReachGuard({ now: () => t });
  assert.equal(guard.get("k"), null);
  guard.set("k", { a: 1 });
  assert.deepEqual(guard.get("k"), { a: 1 });
  t += 9 * 60_000; assert.deepEqual(guard.get("k"), { a: 1 });
  t += 2 * 60_000; assert.equal(guard.get("k"), null);
});

test("guarda: o cache tem tamanho máximo (descarta o mais antigo)", () => {
  const guard = createReachGuard({ maxEntries: 3 });
  for (const k of ["a", "b", "c", "d"]) guard.set(k, k);
  assert.equal(guard.get("a"), null); assert.equal(guard.get("d"), "d");
});

test("guarda: limite por empresa em 1 minuto; outras empresas e o minuto seguinte liberam", () => {
  let t = 0;
  const guard = createReachGuard({ now: () => t, limit: 3, windowMs: 60_000 });
  assert.deepEqual([1, 2, 3, 4].map(() => guard.take("A")), [true, true, true, false]);
  assert.equal(guard.take("B"), true, "outra empresa não é afetada");
  t += 61_000;
  assert.equal(guard.take("A"), true, "passou a janela");
});

test("a chave do cache separa empresa, conta e público", () => {
  const i = input();
  assert.notEqual(reachCacheKey("o1", "a", i), reachCacheKey("o2", "a", i));
  assert.notEqual(reachCacheKey("o1", "a", i), reachCacheKey("o1", "b", i));
  assert.notEqual(reachCacheKey("o1", "a", i), reachCacheKey("o1", "a", input({ min_age: 30 })));
  assert.equal(reachCacheKey("o1", "a", i), reachCacheKey("o1", "a", input()));
});

test("graphBaseUrl: padrão é a Meta com a versão; META_GRAPH_BASE_URL só para testes/proxy", () => {
  assert.equal(graphBaseUrl({}), "https://graph.facebook.com/v21.0");
  assert.equal(graphBaseUrl({ META_GRAPH_API_VERSION: "v22.0" }), "https://graph.facebook.com/v22.0");
  assert.equal(graphBaseUrl({ META_GRAPH_BASE_URL: "http://127.0.0.1:9/v21.0/" }), "http://127.0.0.1:9/v21.0");
});

test("todos os estados do Brasil estão na tabela", () => {
  assert.equal(Object.keys(BR_STATES).length, 27);
});
