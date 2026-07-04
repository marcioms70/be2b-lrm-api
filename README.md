# Be2B LRM API

API intermediária do módulo BDR/LRM de Tráfego Pago da Be2B.

## Meta Ads Integration — Fase 7A

Esta fase prepara o backend para conexão com Meta Ads/Instagram. A publicação real de campanhas na Meta Ads API será implementada na Fase 7B.

### Variáveis de ambiente

```env
META_APP_ID=
META_APP_SECRET=
META_REDIRECT_URI=https://api.be2b.tech/api/meta-ads/oauth/callback
META_GRAPH_API_VERSION=v21.0
META_ENCRYPTION_KEY=
META_SCOPES=ads_management,ads_read,business_management,pages_show_list,pages_read_engagement,instagram_basic
FRONTEND_URL=https://SEU_FRONTEND_LOVABLE
```

`META_ENCRYPTION_KEY` é usada para criptografar tokens antes de salvar no PostgreSQL. Nenhum endpoint retorna access_token em texto puro.

### Tabelas criadas

A migration `migrations/007_meta_ads_integration.sql` cria:

- `public.meta_ads_connections`
- `public.meta_ads_publish_jobs`
- `public.meta_ads_campaign_publications`

As rotas também executam essa migration de forma segura com `CREATE TABLE IF NOT EXISTS` quando necessário.

### Endpoints

#### Status da conexão

```http
GET /api/meta-ads/status?organization_id=...
```

Retorna conexão Meta Ads da organização, sem token.

#### Iniciar OAuth

```http
GET /api/meta-ads/oauth/start?organization_id=...
```

Redireciona para a Meta. Se chamado com `Accept: application/json` ou `?format=json`, retorna a URL de autorização.

#### Callback OAuth

```http
GET /api/meta-ads/oauth/callback
```

Recebe o `code`, valida `state`, troca por token, criptografa e salva a conexão.

#### Conexão manual para testes

```http
POST /api/meta-ads/connect/manual
```

Body exemplo:

```json
{
  "organization_id": "11111111-1111-1111-1111-111111111111",
  "business_id": "123",
  "business_name": "Business Teste",
  "ad_account_id": "act_123",
  "ad_account_name": "Conta de Anúncios Teste",
  "page_id": "456",
  "page_name": "Página Teste",
  "instagram_actor_id": "789",
  "instagram_username": "instagram_teste"
}
```

Pode receber `access_token`, mas ele será criptografado e nunca retornado.

#### Desconectar

```http
POST /api/meta-ads/disconnect
```

Marca a conexão como `disconnected`.

#### Testar conexão

```http
POST /api/meta-ads/test-connection
```

Valida o token salvo chamando a Graph API. Se não houver token, marca como `needs_reconnect`.

#### Preparar publicação

```http
POST /api/meta-ads/publish-campaign
```

Body:

```json
{
  "organization_id": "...",
  "campaign_id": "..."
}
```

Nesta Fase 7A, valida campanha e conexão, cria registros em `meta_ads_publish_jobs` e `meta_ads_campaign_publications`, mas ainda não cria Campaign/Ad Set/Ad Creative/Ad na Meta.

#### Opções para frontend

```http
GET /api/meta-ads/config-options?organization_id=...
```

Retorna IDs conectados, pendências e se a organização está pronta para publicar.

## Testes rápidos

```bash
curl "https://api.be2b.tech/api/meta-ads/status?organization_id=11111111-1111-1111-1111-111111111111"
```

```bash
curl -X POST "https://api.be2b.tech/api/meta-ads/connect/manual" \
  -H "Content-Type: application/json" \
  -d '{
    "organization_id": "11111111-1111-1111-1111-111111111111",
    "business_id": "123",
    "business_name": "Business Teste",
    "ad_account_id": "act_123",
    "ad_account_name": "Conta de Anúncios Teste",
    "page_id": "456",
    "page_name": "Página Teste",
    "instagram_actor_id": "789",
    "instagram_username": "instagram_teste"
  }'
```
