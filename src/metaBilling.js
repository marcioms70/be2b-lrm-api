/**
 * Meta Ads: situação de PAGAMENTO da conta de anúncios da empresa (somente leitura).
 *
 * A Meta não permite cadastrar forma de pagamento por API (e a plataforma não deve receber dados de cartão): o cliente cadastra na própria tela
 * de cobrança da Meta. Aqui só LEMOS se já existe forma de pagamento e se a conta está ativa, para o Be2B mostrar "cadastrado / pendente"
 * e avisar antes de a campanha precisar veicular. Regras puras (sem rede e sem banco); a chamada à Graph entra por injeção.
 */
import { ACCOUNT_STATUS, normalizeAdAccountId } from "./metaSelection.js";

/** Campos lidos da conta de anúncios. Nada de saldo, gasto ou dados do cartão além do texto que a Meta já mostra ("Visa *1234"). */
export const BILLING_FIELDS = "account_status,currency,funding_source,funding_source_details{id,type,display_string}";

const str = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);
const safeLabel = (v) => { const s = str(v); return s ? s.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) : null; };

/**
 * Resposta da Graph (conta de anúncios) → situação simples.
 *  - has_funding_source: a conta tem uma forma de pagamento ligada (funding_source ou funding_source_details.id);
 *  - funding_label: o texto que a própria Meta mostra (ex.: "Visa *4242"), sem inventar nada; null se não vier.
 */
export function normalizeBilling(account) {
  const a = account && typeof account === "object" ? account : {};
  const code = Number(a.account_status);
  const st = ACCOUNT_STATUS[code] || { label: "Situação desconhecida", active: false };
  const details = a.funding_source_details && typeof a.funding_source_details === "object" ? a.funding_source_details : {};
  const has = Boolean(str(String(a.funding_source ?? "")) || str(String(details.id ?? "")));
  return {
    account_status: Number.isFinite(code) ? code : null,
    account_status_label: st.label,
    account_active: st.active,
    currency: str(a.currency),
    has_funding_source: has,
    funding_label: has ? safeLabel(details.display_string) : null
  };
}

/** Rota GET /api/meta-ads/connection/billing: qualquer membro da empresa lê; nunca devolve token. */
export function createBillingHandler(deps) {
  const { getOrganizationId, getConnection, decryptToken, loadAccount, ok, fail } = deps;
  async function handle(req, res) {
    try {
      const organizationId = getOrganizationId(req);
      if (!organizationId) return fail(res, 400, "organization_id é obrigatório.");
      const connection = await getConnection(organizationId);
      if (!connection) return fail(res, 404, "Conexão Meta Ads não encontrada. Conecte a conta Meta primeiro.");
      if (!connection.access_token_encrypted) return fail(res, 400, "Conexão Meta Ads sem access_token. Reconecte a conta Meta.");
      const adAccountId = normalizeAdAccountId(connection.ad_account_id);
      if (!adAccountId) return fail(res, 400, "Escolha a conta de anúncios antes de consultar o pagamento.");
      const token = decryptToken(connection.access_token_encrypted);
      let account;
      try { account = await loadAccount(token, adAccountId); }
      catch (error) { return fail(res, 502, "Não foi possível consultar a conta de anúncios na Meta. Tente de novo ou reconecte a conta Meta.", String(error?.message ?? "").split(token).join("[token]")); }
      return ok(res, { data: { ad_account_id: adAccountId, ...normalizeBilling(account) } });
    } catch (error) {
      return fail(res, 500, "Não foi possível consultar o pagamento da conta de anúncios.", error.message);
    }
  }
  return { handle };
}
