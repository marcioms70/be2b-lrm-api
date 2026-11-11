/**
 * Rota do alcance estimado da Meta: POST /api/meta-ads/reach-estimate.
 * A lógica (validação, resolução, estimativa, cache) está em metaReachCore.js.
 */
import { graphRequest } from "./metaGraph.js";
import { MetaSyncError, tokenFor, translateGraphError } from "./metaSync.js";
import { ReachError, createReachGuard, estimateReach, parseReachInput, reachCacheKey } from "./metaReachCore.js";

// ---------------------------------------------------------------------------
// Rota
// ---------------------------------------------------------------------------
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ok = (res, data = {}) => res.json({ success: true, ...data });
const fail = (res, status, message, details = null) =>
  res.status(status).json({ success: false, message, details: process.env.NODE_ENV === "production" ? undefined : details });
const orgOf = (req) => req.header("x-organization-id") || req.query.organization_id || req.body?.organization_id || null;

export function registerMetaReachRoutes(app, deps = {}) {
  const guard = deps.guard ?? createReachGuard();
  const graph = deps.graph ?? graphRequest;

  app.post("/api/meta-ads/reach-estimate", async (req, res) => {
    const organizationId = orgOf(req);
    if (!organizationId) return fail(res, 400, "organization_id é obrigatório.");
    if (!UUID_RE.test(String(organizationId))) return fail(res, 400, "organization_id inválido.");
    const parsed = parseReachInput(req.body?.targeting);
    if (!parsed.ok) return fail(res, 400, parsed.message);

    try {
      const { connection, token } = await tokenFor(organizationId);
      if (!connection.ad_account_id) {
        throw new MetaSyncError("A conexão Meta não tem uma conta de anúncios. Reconecte a conta em Configurações → Integrações → Meta Ads.", 409);
      }
      const key = reachCacheKey(organizationId, connection.ad_account_id, parsed.value);
      const cached = guard.get(key);
      if (cached) return ok(res, { data: { ...cached, cached: true } });
      if (!guard.take(organizationId)) return fail(res, 429, "Muitas consultas de alcance em pouco tempo. Aguarde um minuto e tente de novo.");

      const data = await estimateReach({ token, adAccountId: connection.ad_account_id, input: parsed.value, graph });
      if (data.ready) guard.set(key, data); // estimativa "ainda calculando" não vai para o cache
      return ok(res, { data });
    } catch (err) {
      if (err instanceof ReachError) return fail(res, err.httpStatus, err.message, err.details);
      const e = await translateGraphError(err, organizationId);
      if (e instanceof MetaSyncError) return fail(res, e.httpStatus, e.message, e.details);
      console.error("[meta-reach] falha:", e?.message);
      return fail(res, 500, "Não foi possível estimar o alcance na Meta.", e?.message);
    }
  });
}
