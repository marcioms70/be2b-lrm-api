/**
 * Monta a URL do diálogo de login da Meta.
 *
 * - Login do Facebook clássico: as permissões vão na URL (`scope`).
 * - Login do Facebook para Empresas: a URL NÃO aceita `scope`; as permissões vêm de uma
 *   "configuração" criada no painel da Meta e identificada por `config_id`. Sem ele a Meta
 *   mostra "esse app precisa de pelo menos uma permissão compatível".
 *   Para receber `code` (e não um token direto) é preciso `override_default_response_type=true`.
 *
 * Com `configId` definido usamos o modo Empresas; sem ele, o modo clássico (comportamento anterior).
 */
export function buildAuthorizationUrl({ version, appId, redirectUri, state, scopes = [], configId = "" }) {
  const url = new URL(`https://www.facebook.com/${version}/dialog/oauth`);
  url.searchParams.set("client_id", appId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);
  url.searchParams.set("response_type", "code");

  const config = String(configId || "").trim();
  if (config) {
    url.searchParams.set("config_id", config);
    url.searchParams.set("override_default_response_type", "true");
  } else {
    url.searchParams.set("scope", scopes.join(","));
  }
  return url;
}
