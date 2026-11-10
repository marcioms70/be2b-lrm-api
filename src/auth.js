/**
 * Autenticação e autorização da API.
 *
 * - Usuário: o front envia `Authorization: Bearer <JWT do Supabase>`. Validamos o
 *   token no Supabase (`/auth/v1/user`) e conferimos se o usuário pertence à
 *   empresa (`organization_id`) consultando `organization_users` COM o token do
 *   próprio usuário (a RLS do Supabase decide o que ele enxerga).
 * - Webhooks de entrada (n8n/WhatsApp): protegidos por segredo compartilhado
 *   opcional (`INBOUND_WEBHOOK_SECRET`, header `x-webhook-secret`).
 * - Rotas públicas: health, arquivos de mídia (a Meta precisa baixá-los),
 *   redirecionador de rastreamento e callback OAuth da Meta (state assinado).
 *
 * Variáveis:
 *   SUPABASE_URL, SUPABASE_ANON_KEY  → habilitam a validação
 *   API_AUTH_MODE = enforce (padrão) | log (só registra) | off
 *   INBOUND_WEBHOOK_SECRET           → opcional
 *
 * Sem SUPABASE_URL/SUPABASE_ANON_KEY a API continua ABERTA (compatibilidade) e
 * registra um aviso alto no start. Configure antes de expor em produção.
 */
import crypto from "crypto";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const POSITIVE_TTL_MS = 60_000;
const NEGATIVE_TTL_MS = 10_000;

// ---------------------------------------------------------------------------
// Classificação de rotas
// ---------------------------------------------------------------------------
const PUBLIC_ROUTES = [
  { method: "GET", re: /^\/health\/?$/ },
  { method: "GET", re: /^\/uploads\// },
  { method: "GET", re: /^\/r\/[^/]+\/?$/ },
  { method: "GET", re: /^\/api\/paid-traffic\/instagram\/redirect\/[^/]+\/?$/ },
  { method: "GET", re: /^\/api\/paid-traffic\/instagram\/campaign\/[^/]+\/?$/ },
  { method: "GET", re: /^\/api\/meta-ads\/oauth\/callback\/?$/ }
];

const WEBHOOK_ROUTES = [
  { method: "POST", re: /^\/api\/paid-traffic\/inbound-lead\/?$/ },
  { method: "POST", re: /^\/api\/paid-traffic\/instagram\/inbound-lead\/?$/ },
  { method: "POST", re: /^\/api\/paid-traffic\/instagram\/whatsapp-message\/?$/ }
];

/** @returns {"public" | "webhook" | "user"} */
export function classifyRoute(method, path) {
  const m = String(method || "GET").toUpperCase();
  if (PUBLIC_ROUTES.some((r) => r.method === m && r.re.test(path))) return "public";
  if (WEBHOOK_ROUTES.some((r) => r.method === m && r.re.test(path))) return "webhook";
  return "user";
}

export function extractBearer(header) {
  const match = /^Bearer\s+([^\s]+)$/i.exec(String(header || ""));
  return match ? match[1] : null;
}

/**
 * Coleta o organization_id enviado em header, query e body. Se houver valores
 * diferentes entre si, é conflito (evita validar uma empresa e operar em outra).
 */
export function resolveOrganizationId(req) {
  const values = [
    req.headers?.["x-organization-id"],
    req.query?.organization_id,
    req.body?.organization_id
  ]
    .filter((v) => typeof v === "string" && v.trim() !== "")
    .map((v) => v.trim());
  const distinct = [...new Set(values)];
  if (distinct.length > 1) return { organizationId: null, conflict: true };
  return { organizationId: distinct[0] || null, conflict: false };
}

function safeEqual(a, b) {
  const da = crypto.createHash("sha256").update(String(a)).digest();
  const db = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(da, db);
}

// ---------------------------------------------------------------------------
// Configuração
// ---------------------------------------------------------------------------
export function readAuthConfig(env = process.env) {
  const url = (env.SUPABASE_URL || "").replace(/\/+$/, "");
  const anonKey = env.SUPABASE_ANON_KEY || "";
  const configured = Boolean(url && anonKey);
  let mode = String(env.API_AUTH_MODE || "enforce").toLowerCase();
  if (!["enforce", "log", "off"].includes(mode)) mode = "enforce";
  if (!configured) mode = "off";
  return { url, anonKey, configured, mode, webhookSecret: env.INBOUND_WEBHOOK_SECRET || "" };
}

/** Papéis que podem administrar configurações da empresa (destinatários de relatório etc.). */
export const ADMIN_ROLES = ["owner", "admin", "superadmin"];

/**
 * A requisição veio de administrador da empresa? Com a autenticação desligada (modo off) não há
 * como saber o papel, e a API inteira está aberta: devolve true para manter a compatibilidade.
 */
export function isOrgAdmin(req) {
  if (!req.auth) return true;
  return ADMIN_ROLES.includes(req.auth.role);
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------
/**
 * @param {{ env?: object, fetchImpl?: typeof fetch, now?: () => number, logger?: Pick<Console,"warn"|"error"> }} [deps]
 */
export function createAuthMiddleware(deps = {}) {
  const config = readAuthConfig(deps.env);
  const doFetch = deps.fetchImpl || fetch;
  const now = deps.now || Date.now;
  const logger = deps.logger || console;
  const cache = new Map(); // key -> { value, exp }

  const cacheGet = (key) => {
    const hit = cache.get(key);
    if (!hit) return undefined;
    if (hit.exp < now()) { cache.delete(key); return undefined; }
    return hit.value;
  };
  const cacheSet = (key, value, ttl) => {
    if (cache.size > 5000) cache.clear();
    cache.set(key, { value, exp: now() + ttl });
  };

  async function supabaseGet(pathAndQuery, token) {
    const res = await doFetch(`${config.url}${pathAndQuery}`, {
      headers: { apikey: config.anonKey, Authorization: `Bearer ${token}`, Accept: "application/json" }
    });
    return res;
  }

  async function verifyUser(token) {
    const key = `u:${crypto.createHash("sha256").update(token).digest("hex")}`;
    const cached = cacheGet(key);
    if (cached !== undefined) return cached;
    try {
      const res = await supabaseGet("/auth/v1/user", token);
      if (!res.ok) { cacheSet(key, null, NEGATIVE_TTL_MS); return null; }
      const body = await res.json();
      const user = body?.id ? { id: body.id, email: body.email || null } : null;
      cacheSet(key, user, user ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS);
      return user;
    } catch (err) {
      logger.error("[auth] falha ao validar token no Supabase:", err.message);
      return undefined; // indisponibilidade ≠ token inválido
    }
  }

  async function isMember(token, userId, organizationId) {
    const key = `m:${crypto.createHash("sha256").update(token).digest("hex")}:${organizationId}`;
    const cached = cacheGet(key);
    if (cached !== undefined) return cached;
    try {
      const memberships = await supabaseGet(
        `/rest/v1/organization_users?select=status,is_blocked,role&organization_id=eq.${organizationId}&user_id=eq.${userId}`,
        token
      );
      if (!memberships.ok) return undefined;
      const rows = await memberships.json();
      let result;
      if (Array.isArray(rows) && rows.length > 0) {
        const active = rows.find((r) => r.status === "active" && r.is_blocked === false);
        result = { allowed: !!active, role: active?.role || null };
      } else {
        // Sem vínculo: só passa se a RLS deixar o usuário enxergar a empresa (ex.: superadmin).
        const org = await supabaseGet(`/rest/v1/organizations?select=id&id=eq.${organizationId}`, token);
        if (!org.ok) return undefined;
        const orgRows = await org.json();
        const visible = Array.isArray(orgRows) && orgRows.length > 0;
        result = { allowed: visible, role: visible ? "superadmin" : null };
      }
      cacheSet(key, result, result.allowed ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS);
      return result;
    } catch (err) {
      logger.error("[auth] falha ao validar vínculo com a empresa:", err.message);
      return undefined;
    }
  }

  function reject(req, res, next, status, message) {
    if (config.mode === "log") {
      logger.warn(`[auth][log-only] ${req.method} ${req.path} → ${status}: ${message}`);
      return next();
    }
    return res.status(status).json({ success: false, message });
  }

  async function middleware(req, res, next) {
    if (config.mode === "off" || req.method === "OPTIONS") return next();

    const kind = classifyRoute(req.method, req.path);
    if (kind === "public") return next();

    if (kind === "webhook") {
      if (!config.webhookSecret) return next();
      const provided = req.headers["x-webhook-secret"];
      if (typeof provided === "string" && safeEqual(provided, config.webhookSecret)) return next();
      return reject(req, res, next, 401, "Segredo do webhook ausente ou inválido.");
    }

    const token = extractBearer(req.headers.authorization);
    if (!token) return reject(req, res, next, 401, "Autenticação obrigatória.");

    const user = await verifyUser(token);
    if (user === undefined) return reject(req, res, next, 503, "Serviço de autenticação indisponível. Tente novamente.");
    if (!user) return reject(req, res, next, 401, "Sessão inválida ou expirada.");

    const { organizationId, conflict } = resolveOrganizationId(req);
    if (conflict) return reject(req, res, next, 400, "organization_id divergente entre header, query e corpo.");

    let role = null;
    if (organizationId) {
      if (!UUID_RE.test(organizationId)) return reject(req, res, next, 400, "organization_id inválido.");
      const member = await isMember(token, user.id, organizationId);
      if (member === undefined) return reject(req, res, next, 503, "Não foi possível validar o acesso à empresa. Tente novamente.");
      if (!member.allowed) return reject(req, res, next, 403, "Sem acesso a esta empresa.");
      role = member.role;
    }

    req.auth = { userId: user.id, email: user.email, organizationId, role };
    return next();
  }

  middleware.config = config;
  return middleware;
}

export function logAuthStartup(mw, logger = console) {
  const { mode, configured, webhookSecret } = mw.config;
  if (!configured) {
    logger.warn("[auth] ATENÇÃO: SUPABASE_URL/SUPABASE_ANON_KEY ausentes — a API está ABERTA (sem autenticação).");
  } else {
    logger.log(`[auth] modo: ${mode}`);
  }
  if (!webhookSecret) {
    logger.warn("[auth] INBOUND_WEBHOOK_SECRET não definido — endpoints de lead de entrada aceitam qualquer chamador.");
  }
}
