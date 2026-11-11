/**
 * Alcance estimado do público na Meta (Fase 5 do assistente de campanha).
 *
 * Recebe o público descrito no assistente (país, estado, cidade, raio, idade, gênero e interesses em TEXTO),
 * traduz para o que a Meta entende (chave da cidade, ids de interesses) e pergunta à Graph API quantas
 * pessoas ele alcança. Só LÊ: nada é criado na Meta.
 *
 * Este arquivo é PURO (sem banco): a rota fica em metaReach.js. Passos: valida a entrada → resolve país/cidade/interesses (busca na Meta) → monta o `targeting_spec` →
 * `reachestimate` (e, se falhar por motivo que não seja de acesso, `delivery_estimate`).
 * Resultados ficam em cache por 10 min e há limite de consultas por empresa, para poupar a cota da Meta.
 */
import { MetaGraphError, graphRequest } from "./metaGraph.js";

export const RADIUS_MIN_KM = 17; // limites do raio de cidade na Meta (10–50 milhas)
export const RADIUS_MAX_KM = 80;
export const MAX_INTERESTS = 8;
export const AGE_MIN = 13;
export const AGE_MAX = 65;

export class ReachError extends Error {
  constructor(message, httpStatus = 422, details = null) {
    super(message);
    this.name = "ReachError";
    this.httpStatus = httpStatus;
    this.details = details;
  }
}

const clip = (v, max) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);
/** minúsculas, sem acento e sem espaços repetidos: "São Paulo" e "sao  paulo" são iguais */
export const norm = (s) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();

export const BR_STATES = {
  AC: "Acre", AL: "Alagoas", AP: "Amapá", AM: "Amazonas", BA: "Bahia", CE: "Ceará", DF: "Distrito Federal", ES: "Espírito Santo",
  GO: "Goiás", MA: "Maranhão", MT: "Mato Grosso", MS: "Mato Grosso do Sul", MG: "Minas Gerais", PA: "Pará", PB: "Paraíba", PR: "Paraná",
  PE: "Pernambuco", PI: "Piauí", RJ: "Rio de Janeiro", RN: "Rio Grande do Norte", RS: "Rio Grande do Sul", RO: "Rondônia", RR: "Roraima",
  SC: "Santa Catarina", SP: "São Paulo", SE: "Sergipe", TO: "Tocantins",
};

const COUNTRY_CODES = {
  brasil: "BR", brazil: "BR", br: "BR", portugal: "PT", pt: "PT", argentina: "AR", ar: "AR", paraguai: "PY", paraguay: "PY", py: "PY",
  uruguai: "UY", uruguay: "UY", uy: "UY", chile: "CL", cl: "CL", colombia: "CO", co: "CO", peru: "PE", mexico: "MX", mx: "MX",
  "estados unidos": "US", "estados unidos da america": "US", eua: "US", usa: "US", us: "US",
};

// ---------------------------------------------------------------------------
// Entrada
// ---------------------------------------------------------------------------
const toInt = (v) => {
  if (v === "" || v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : null;
};

/** @returns {{ ok: true, value: object } | { ok: false, message: string }} */
export function parseReachInput(raw) {
  const t = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const minRaw = toInt(t.min_age), maxRaw = toInt(t.max_age);
  const min_age = minRaw ?? 18, max_age = maxRaw ?? AGE_MAX;
  if (min_age < AGE_MIN || max_age > AGE_MAX || min_age > max_age) {
    return { ok: false, message: `Idade inválida: informe valores entre ${AGE_MIN} e ${AGE_MAX} anos, com a mínima menor ou igual à máxima.` };
  }
  const gender = String(t.gender ?? "all").trim().toLowerCase() || "all";
  if (!["all", "male", "female"].includes(gender)) return { ok: false, message: "Gênero inválido (use todos, masculino ou feminino)." };

  const interestsRaw = Array.isArray(t.interests) ? t.interests : String(t.interests ?? "").split(",");
  const seen = new Set();
  const interests = [];
  for (const it of interestsRaw) {
    const name = clip(it, 60);
    const k = norm(name);
    if (!name || seen.has(k)) continue;
    seen.add(k);
    interests.push(name);
  }

  const city = clip(t.city, 80);
  const radius = toInt(t.radius_km);
  return {
    ok: true,
    value: {
      country: clip(t.country, 60) || "Brasil",
      state: clip(t.state, 40),
      city,
      radius_km: city && radius && radius > 0 ? radius : null, // raio só vale com cidade
      min_age, max_age, gender,
      interests: interests.slice(0, MAX_INTERESTS),
      interests_truncated: interests.length > MAX_INTERESTS,
    },
  };
}

// ---------------------------------------------------------------------------
// Resolução (texto → ids da Meta)
// ---------------------------------------------------------------------------
/** Escolhe a cidade certa entre os resultados da busca. Só aceita nome IGUAL (sem acento/maiúsculas); nunca "parecido". */
export function pickCity(results, { city, state } = {}) {
  const wanted = norm(city);
  const exact = (Array.isArray(results) ? results : []).filter((r) => r && r.type === "city" && r.key && norm(r.name) === wanted);
  if (exact.length === 0) return null;
  const uf = String(state ?? "").trim();
  const stateName = norm(uf.length === 2 ? (BR_STATES[uf.toUpperCase()] ?? uf) : uf);
  if (stateName) {
    const inState = exact.filter((r) => norm(r.region) === stateName);
    if (inState.length > 0) return { match: inState[0], ambiguous: false };
    return null; // existe a cidade, mas não neste estado: melhor avisar do que estimar a errada
  }
  return { match: exact[0], ambiguous: exact.length > 1 };
}

/** Interesse: nome igual se houver; senão o primeiro resultado (a Meta ordena por relevância). */
export function pickInterest(results, name) {
  const list = (Array.isArray(results) ? results : []).filter((r) => r && r.id && r.name);
  if (list.length === 0) return null;
  const exact = list.find((r) => norm(r.name) === norm(name));
  return { match: exact ?? list[0], exact: !!exact };
}

/** Público no formato da Meta. Cidade tem prioridade sobre o país; interesses são alternativos entre si (OU). */
export function buildTargetingSpec({ countryCode, city = null, radiusKm = null, min_age, max_age, gender = "all", interests = [] }) {
  const spec = {
    geo_locations: city
      ? { cities: [{ key: city.key, ...(radiusKm ? { radius: radiusKm, distance_unit: "kilometer" } : {}) }] }
      : { countries: [countryCode] },
    age_min: min_age,
    age_max: max_age,
  };
  if (gender === "male") spec.genders = [1];
  if (gender === "female") spec.genders = [2];
  if (interests.length > 0) spec.flexible_spec = [{ interests: interests.map((i) => ({ id: i.id, name: i.name })) }];
  return spec;
}

export function clampRadius(km) {
  if (!km) return { radius: null, adjusted: false };
  const radius = Math.min(RADIUS_MAX_KM, Math.max(RADIUS_MIN_KM, km));
  return { radius, adjusted: radius !== km };
}

// ---------------------------------------------------------------------------
// Resposta da Meta
// ---------------------------------------------------------------------------
const toCount = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
};

/**
 * Aceita os formatos conhecidos: `reachestimate` (users_lower_bound/users_upper_bound, em objeto ou lista) e
 * `delivery_estimate` (estimate_mau_*, ou só estimate_mau). Devolve null se não houver número utilizável.
 */
export function parseReachResponse(json) {
  const d = Array.isArray(json?.data) ? json.data[0] : (json?.data ?? json);
  if (!d || typeof d !== "object") return null;
  let lower = toCount(d.users_lower_bound), upper = toCount(d.users_upper_bound);
  if (lower === null && upper === null) { lower = toCount(d.estimate_mau_lower_bound); upper = toCount(d.estimate_mau_upper_bound); }
  if (lower === null && upper === null) { const m = toCount(d.estimate_mau ?? d.users); if (m !== null) { lower = m; upper = m; } }
  if (lower === null && upper === null) return null;
  if (lower === null) lower = upper;
  if (upper === null) upper = lower;
  if (lower > upper) [lower, upper] = [upper, lower];
  return { lower, upper, ready: d.estimate_ready !== false };
}

/** Erros em que repetir por outro caminho não adianta (acesso, cota). */
const isFatal = (e) => e instanceof MetaGraphError && (e.isTokenExpired || e.isRateLimit || e.isPermission);

// ---------------------------------------------------------------------------
// Consulta
// ---------------------------------------------------------------------------
async function search(graph, token, params) {
  const r = await graph({ path: "/search", token, params: { limit: 25, locale: "pt_BR", ...params } });
  return Array.isArray(r?.data) ? r.data : [];
}

/**
 * @param {{ token: string, adAccountId: string, input: object, graph?: Function }} args
 */
export async function estimateReach({ token, adAccountId, input, graph = graphRequest }) {
  const act = String(adAccountId).startsWith("act_") ? String(adAccountId) : `act_${adAccountId}`;

  // país
  let countryCode = COUNTRY_CODES[norm(input.country)] ?? null;
  if (!countryCode) {
    const found = (await search(graph, token, { type: "adgeolocation", q: input.country, location_types: ["country"] }))
      .find((r) => r.type === "country" && (r.country_code || r.key));
    if (!found) throw new ReachError(`Não encontrei o país “${input.country}” na Meta. Confira o nome.`);
    countryCode = String(found.country_code || found.key).toUpperCase();
  }

  // cidade (com raio)
  let city = null, cityInfo = null;
  const { radius, adjusted } = clampRadius(input.radius_km);
  if (input.city) {
    const results = await search(graph, token, { type: "adgeolocation", q: input.city, location_types: ["city"], country_code: countryCode });
    const picked = pickCity(results, { city: input.city, state: input.state });
    if (!picked) {
      throw new ReachError(
        input.state
          ? `Não encontrei a cidade “${input.city}” no estado “${input.state}” na Meta. Confira o nome e o estado.`
          : `Não encontrei a cidade “${input.city}” na Meta. Confira o nome.`,
      );
    }
    city = picked.match;
    cityInfo = { name: city.name, region: city.region ?? null, radius_km: radius, radius_adjusted: adjusted, ambiguous: picked.ambiguous };
  }

  // interesses (em paralelo; um que falha por motivo não fatal só fica sem resolver)
  const resolved = [], unresolved = [];
  const lookups = await Promise.all(input.interests.map(async (name) => {
    try { return { name, results: await search(graph, token, { type: "adinterest", q: name, limit: 5 }) }; }
    catch (e) { if (isFatal(e)) throw e; return { name, results: [] }; }
  }));
  for (const { name, results } of lookups) {
    const p = pickInterest(results, name);
    if (!p) unresolved.push(name);
    else resolved.push({ id: String(p.match.id), name: p.match.name, asked: name, exact: p.exact });
  }

  const spec = buildTargetingSpec({
    countryCode, city, radiusKm: radius, min_age: input.min_age, max_age: input.max_age, gender: input.gender, interests: resolved,
  });

  // estimativa: reachestimate primeiro; se falhar por motivo que não seja de acesso/cota, delivery_estimate
  let estimate = null, source = null, lastErr = null;
  try {
    estimate = parseReachResponse(await graph({ path: `/${act}/reachestimate`, token, params: { targeting_spec: spec } }));
    source = "reachestimate";
  } catch (e) { if (isFatal(e)) throw e; lastErr = e; }
  if (!estimate) {
    try {
      estimate = parseReachResponse(await graph({ path: `/${act}/delivery_estimate`, token, params: { targeting_spec: spec, optimization_goal: "REACH" } }));
      source = "delivery_estimate";
    } catch (e) { if (isFatal(e)) throw e; lastErr = e; }
  }
  if (!estimate) {
    throw lastErr instanceof MetaGraphError ? lastErr : new ReachError("A Meta não devolveu uma estimativa para este público.", 502);
  }

  return {
    lower: estimate.lower, upper: estimate.upper, ready: estimate.ready, source,
    resolved: {
      country: countryCode, city: cityInfo, interests: resolved.map(({ id, name, asked, exact }) => ({ id, name, asked, exact })),
      age_min: input.min_age, age_max: input.max_age, gender: input.gender,
    },
    unresolved_interests: unresolved,
    interests_truncated: !!input.interests_truncated,
  };
}

// ---------------------------------------------------------------------------
// Cache e limite de uso
// ---------------------------------------------------------------------------
export function createReachGuard({ now = Date.now, ttlMs = 10 * 60_000, maxEntries = 500, limit = 20, windowMs = 60_000 } = {}) {
  const cache = new Map();
  const hits = new Map();
  return {
    get(key) {
      const h = cache.get(key);
      if (!h) return null;
      if (h.exp < now()) { cache.delete(key); return null; }
      return h.value;
    },
    set(key, value) {
      if (cache.size >= maxEntries) cache.delete(cache.keys().next().value);
      cache.set(key, { value, exp: now() + ttlMs });
    },
    /** true se a empresa ainda pode consultar a Meta agora (só consultas reais contam, não as do cache) */
    take(orgId) {
      const t = now();
      const recent = (hits.get(orgId) ?? []).filter((x) => x > t - windowMs);
      if (recent.length >= limit) { hits.set(orgId, recent); return false; }
      recent.push(t);
      hits.set(orgId, recent);
      return true;
    },
  };
}

export const reachCacheKey = (orgId, adAccountId, input) => `${orgId}|${adAccountId}|${JSON.stringify(input)}`;
