/**
 * Meta Ads: escolha da empresa (Business Manager) e da conta de anúncios de CADA empresa da plataforma (multi-tenant).
 *
 * Antes, o callback do OAuth gravava o PRIMEIRO item de /me/businesses e de /me/adaccounts, sem considerar o que o usuário
 * quis: quem administra várias empresas (ou tem conta de anúncios pessoal) acabava conectado à conta errada.
 * Aqui ficam as regras PURAS (sem rede e sem banco): normalizar o que a Meta devolve, sugerir um padrão melhor e VALIDAR a escolha.
 * A escolha só vale se a conta estiver entre as que o próprio token consegue listar: não dá para gravar um ID qualquer.
 */

/** Códigos de account_status da Meta → texto em português e se a conta pode veicular anúncios. */
export const ACCOUNT_STATUS = {
  1: { label: "Ativa", active: true },
  2: { label: "Desativada", active: false },
  3: { label: "Com pendência de pagamento", active: false },
  7: { label: "Em análise de risco", active: false },
  8: { label: "Pagamento pendente de liquidação", active: false },
  9: { label: "Em período de carência", active: false },
  100: { label: "Encerramento pendente", active: false },
  101: { label: "Encerrada", active: false },
  201: { label: "Ativa", active: true },
  202: { label: "Encerrada", active: false }
};

const str = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);
const list = (r) => (Array.isArray(r?.data) ? r.data : Array.isArray(r) ? r : []);

/** "123" / "act_123" → "act_123"; qualquer outra coisa → null. */
export function normalizeAdAccountId(value) {
  const m = /^(?:act_)?(\d{5,25})$/.exec(String(value ?? "").trim());
  return m ? `act_${m[1]}` : null;
}

/**
 * Isolamento entre empresas: quem autoriza (ex.: a agência) pode enxergar contas de VÁRIOS clientes. Só vale o que a pessoa
 * MARCOU na tela de permissões da Meta, que vem em `granular_scopes[].target_ids` do /debug_token.
 *  - contas de anúncios: alvos de ads_management/ads_read; Páginas: alvos de qualquer permissão pages_*;
 *  - sem alvo listado (ou sem granular_scopes) = nada: nunca "tudo que o usuário enxerga";
 *  - as empresas são derivadas das contas permitidas (o Business dono de cada uma).
 */
export function restrictToGranted(raw, debugData) {
  const input = raw && typeof raw === "object" ? raw : {};
  const granular = Array.isArray(debugData?.granular_scopes) ? debugData.granular_scopes : [];
  const targets = (match) => new Set(granular.filter((g) => match(String(g?.scope || ""))).flatMap((g) => list(g?.target_ids)).map((t) => String(t).replace(/^act_/, "")));
  const adIds = targets((s) => s === "ads_management" || s === "ads_read");
  const pageIds = targets((s) => s.startsWith("pages_"));
  const adAccounts = list(input.adAccounts).filter((a) => adIds.has(String(a?.id ?? a?.account_id ?? "").replace(/^act_/, "")));
  const businesses = [];
  for (const a of adAccounts) if (a?.business?.id && !businesses.some((b) => b.id === a.business.id)) businesses.push({ id: a.business.id, name: a.business.name });
  const pages = list(input.pages).filter((p) => pageIds.has(String(p?.id ?? "")));
  return { businesses, adAccounts, pages };
}

/** Converte o que a Meta devolve (businesses, adaccounts, accounts) em listas simples, sem campos desconhecidos nem duplicados. */
export function normalizeOptions(input) {
  const { businesses, adAccounts, pages } = input && typeof input === "object" ? input : {};
  const seenB = new Set(); const seenA = new Set(); const seenP = new Set();
  const biz = [];
  for (const b of list(businesses)) { const id = str(b?.id); if (!id || seenB.has(id)) continue; seenB.add(id); biz.push({ id, name: str(b?.name) || id }); }
  const accounts = [];
  for (const a of list(adAccounts)) {
    const id = normalizeAdAccountId(a?.id ?? a?.account_id); if (!id || seenA.has(id)) continue; seenA.add(id);
    const code = Number(a?.account_status); const st = ACCOUNT_STATUS[code] || { label: "Situação desconhecida", active: false };
    const bid = str(a?.business?.id);
    accounts.push({ id, name: str(a?.name) || id, status: Number.isFinite(code) ? code : null, status_label: st.label, active: st.active, business: bid ? { id: bid, name: str(a?.business?.name) || bid } : null });
  }
  const pgs = [];
  for (const p of list(pages)) {
    const id = str(p?.id); if (!id || seenP.has(id)) continue; seenP.add(id);
    const igId = str(p?.instagram_business_account?.id);
    pgs.push({ id, name: str(p?.name) || id, instagram: igId ? { id: igId, username: str(p?.instagram_business_account?.username) } : null });
  }
  return { businesses: biz, ad_accounts: accounts, pages: pgs };
}

/**
 * Padrão sugerido (o usuário pode trocar): a empresa vem primeiro; a conta de anúncios é a PRIMEIRA ATIVA que pertence a essa empresa
 * (senão, a primeira dela; senão, a primeira ativa; senão, a primeira). Assim, quem autorizou só a empresa certa já cai na conta certa.
 */
export function pickDefaults(opts) {
  const business = opts.businesses[0] || null;
  const mine = business ? opts.ad_accounts.filter((a) => a.business?.id === business.id) : [];
  const adAccount = mine.find((a) => a.active) || mine[0] || opts.ad_accounts.find((a) => a.active) || opts.ad_accounts[0] || null;
  const effectiveBusiness = adAccount?.business || business;
  const page = opts.pages[0] || null;
  return { business: effectiveBusiness, adAccount, page };
}

/**
 * Valida a escolha contra as opções reais do token. Devolve { ok:true, business, adAccount, page } ou { ok:false, code, message }.
 *  - a conta de anúncios é obrigatória e precisa estar na lista;
 *  - a empresa é a da própria conta; se vier outra, é conflito; conta pessoal (sem empresa) fica sem empresa;
 *  - a Página é opcional e, se vier, precisa estar na lista (o Instagram acompanha a Página).
 */
export function validateSelection(opts, body = {}) {
  const wanted = normalizeAdAccountId(body.ad_account_id);
  if (!wanted) return { ok: false, code: "invalid_ad_account", message: "Escolha uma conta de anúncios." };
  const adAccount = opts.ad_accounts.find((a) => a.id === wanted);
  if (!adAccount) return { ok: false, code: "ad_account_not_available", message: "Essa conta de anúncios não está entre as disponíveis para esta conexão. Atualize a lista e escolha de novo." };
  let business = adAccount.business;
  const bid = str(body.business_id);
  if (bid) {
    const known = opts.businesses.find((b) => b.id === bid) || (adAccount.business?.id === bid ? adAccount.business : null);
    if (!known) return { ok: false, code: "business_not_available", message: "Essa empresa não está entre as disponíveis para esta conexão." };
    if (adAccount.business && adAccount.business.id !== bid) return { ok: false, code: "business_mismatch", message: "A conta de anúncios escolhida pertence a outra empresa. Escolha de novo." };
    if (!adAccount.business) business = known;
  }
  let page = null;
  const pid = str(body.page_id);
  if (pid) {
    page = opts.pages.find((p) => p.id === pid) || null;
    if (!page) return { ok: false, code: "page_not_available", message: "Essa Página não está entre as disponíveis para esta conexão." };
  }
  return { ok: true, business: business || null, adAccount, page };
}

/**
 * Rotas "listar opções" e "gravar a escolha", com as dependências injetadas (testáveis sem banco e sem rede).
 * Só administradores da empresa. O token nunca sai daqui: a resposta traz só IDs e nomes.
 */
export function createSelectionHandlers(deps) {
  const { getOrganizationId, isOrgAdmin, getConnection, saveSelection, clearSelection, decryptToken, loadOptions, sanitizeConnection, ok, fail } = deps;

  async function prepare(req, res) {
    const organizationId = getOrganizationId(req);
    if (!organizationId) { fail(res, 400, "organization_id é obrigatório."); return null; }
    if (!isOrgAdmin(req)) { fail(res, 403, "Apenas administradores da empresa escolhem a conta de anúncios."); return null; }
    const connection = await getConnection(organizationId);
    if (!connection) { fail(res, 404, "Conexão Meta Ads não encontrada. Conecte a conta Meta primeiro."); return null; }
    if (!connection.access_token_encrypted) { fail(res, 400, "Conexão Meta Ads sem access_token. Reconecte a conta Meta."); return null; }
    let opts;
    try { opts = normalizeOptions(await loadOptions(decryptToken(connection.access_token_encrypted))); }
    catch (error) { fail(res, 502, "Não foi possível listar as contas na Meta. Reconecte a conta Meta e tente de novo.", error.message); return null; }
    return { organizationId, connection, opts };
  }

  async function handleOptions(req, res) {
    try {
      const ctx = await prepare(req, res); if (!ctx) return;
      let c = ctx.connection;
      // Conta gravada que NÃO está entre as autorizadas (ex.: escolha automática antiga, de outro cliente): remove. Só chega aqui se a Meta respondeu.
      let cleared = false;
      const stored = normalizeAdAccountId(c.ad_account_id);
      if (stored && clearSelection && !ctx.opts.ad_accounts.some((a) => a.id === stored)) {
        c = (await clearSelection(ctx.organizationId)) || { ...c, business_id: null, business_name: null, ad_account_id: null, ad_account_name: null, page_id: null, page_name: null, selection_confirmed_at: null };
        cleared = true;
      }
      return ok(res, {
        data: {
          cleared,
          selection_confirmed: Boolean(c.selection_confirmed_at),
          current: { business_id: c.business_id, business_name: c.business_name, ad_account_id: c.ad_account_id, ad_account_name: c.ad_account_name, page_id: c.page_id, page_name: c.page_name },
          ...ctx.opts
        }
      });
    } catch (error) {
      return fail(res, 500, "Não foi possível consultar as contas disponíveis.", error.message);
    }
  }

  async function handleSelect(req, res) {
    try {
      const ctx = await prepare(req, res); if (!ctx) return;
      const v = validateSelection(ctx.opts, req.body || {});
      if (!v.ok) return fail(res, 400, v.message, v.code);
      // Página: a escolhida; senão, a que já estava gravada SE ainda estiver disponível; senão, nenhuma (nunca fica uma Página de outra empresa).
      const kept = ctx.connection.page_id ? ctx.opts.pages.find((p) => p.id === ctx.connection.page_id) || null : null;
      const page = v.page || kept;
      const saved = await saveSelection(ctx.organizationId, {
        business_id: v.business?.id || null, business_name: v.business?.name || null,
        ad_account_id: v.adAccount.id, ad_account_name: v.adAccount.name,
        page_id: page?.id || null, page_name: page?.name || null,
        instagram_actor_id: page?.instagram?.id || null, instagram_username: page?.instagram?.username || null
      });
      return ok(res, { data: { connection: sanitizeConnection(saved), warning: v.adAccount.active ? null : `A conta escolhida está "${v.adAccount.status_label}": a Meta não veicula anúncios nela até regularizar.` } });
    } catch (error) {
      return fail(res, 500, "Não foi possível salvar a escolha.", error.message);
    }
  }

  return { handleOptions, handleSelect };
}
