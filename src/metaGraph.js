/**
 * Cliente mínimo da Graph API da Meta, com retry e classificação de erros.
 * Sem dependência de banco: testável isoladamente.
 */

export const RATE_LIMIT_CODES = [4, 17, 32, 613];
const RETRYABLE_STATUS = [429, 500, 502, 503, 504];
const PERMISSION_CODES = [10, 200];

export class MetaGraphError extends Error {
  constructor(message, { status, code, subcode, type, path } = {}) {
    super(message);
    this.name = "MetaGraphError";
    this.status = status ?? null;
    this.code = code ?? null;
    this.subcode = subcode ?? null;
    this.type = type ?? null;
    this.path = path ?? null;
    /** token expirado/revogado → precisa reconectar a conta */
    this.isTokenExpired = code === 190;
    this.isRateLimit = RATE_LIMIT_CODES.includes(code) || status === 429;
    this.isPermission = PERMISSION_CODES.includes(code) || (code >= 200 && code <= 299);
  }
}

export function graphBaseUrl(env = process.env) {
  // META_GRAPH_BASE_URL (com a versão) existe para testes e proxies; em produção fica vazio.
  if (env.META_GRAPH_BASE_URL) return String(env.META_GRAPH_BASE_URL).replace(/\/+$/, "");
  return `https://graph.facebook.com/${env.META_GRAPH_API_VERSION || "v21.0"}`;
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {{ method?: "GET"|"POST", path: string, token: string, params?: object,
 *           fetchImpl?: typeof fetch, sleep?: (ms:number)=>Promise<void>, maxRetries?: number,
 *           baseUrl?: string, random?: () => number }} opts
 */
export async function graphRequest(opts) {
  const {
    method = "GET", path, token, params = {}, fetchImpl = fetch, sleep = defaultSleep,
    maxRetries = 3, baseUrl = graphBaseUrl(), random = Math.random
  } = opts;

  const url = new URL(`${baseUrl}${path}`);
  const headers = { Authorization: `Bearer ${token}`, Accept: "application/json" };
  let body;

  if (method === "GET") {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, typeof v === "object" ? JSON.stringify(v) : String(v));
    }
  } else {
    const form = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== "") form.set(k, typeof v === "object" ? JSON.stringify(v) : String(v));
    }
    body = form;
    headers["Content-Type"] = "application/x-www-form-urlencoded";
  }

  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let res;
    try {
      res = await fetchImpl(url, { method, headers, body });
    } catch (err) {
      lastError = new MetaGraphError(`Falha de rede ao contatar a Meta: ${err.message}`, { path });
      if (attempt < maxRetries) { await sleep(1000 * 2 ** attempt + random() * 300); continue; }
      throw lastError;
    }

    const json = await res.json().catch(() => ({}));
    if (res.ok && !json?.error) return json;

    const e = json?.error || {};
    lastError = new MetaGraphError(e.message || `Erro da Meta Graph API: HTTP ${res.status}`, {
      status: res.status, code: e.code, subcode: e.error_subcode, type: e.type, path
    });

    // Só repete erros transitórios. Token inválido/permissão/validação não adiantam repetir.
    // POST (criação) não é repetido em 5xx para não duplicar objetos.
    const transient = lastError.isRateLimit || RETRYABLE_STATUS.includes(res.status);
    const canRetry = transient && (method === "GET" || lastError.isRateLimit);
    if (canRetry && attempt < maxRetries) {
      await sleep(1000 * 2 ** attempt + random() * 300);
      continue;
    }
    throw lastError;
  }
  throw lastError;
}
