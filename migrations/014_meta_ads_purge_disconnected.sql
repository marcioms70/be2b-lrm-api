-- Conexões "desconectadas" antes da correção do botão Desconectar ficaram com token e conta gravados.
-- Desconectar passou a apagar tudo; isto limpa o que sobrou. Idempotente: só toca em linhas com status 'disconnected'.
update public.meta_ads_connections
set access_token_encrypted = null, token_type = null, token_expires_at = null, scopes = null, meta_user_id = null,
    business_id = null, business_name = null, ad_account_id = null, ad_account_name = null,
    page_id = null, page_name = null, instagram_actor_id = null, instagram_username = null,
    selection_confirmed_at = null, connected_at = null, updated_at = now()
where status = 'disconnected'
  and (access_token_encrypted is not null or ad_account_id is not null or business_id is not null
       or page_id is not null or instagram_actor_id is not null or meta_user_id is not null);
