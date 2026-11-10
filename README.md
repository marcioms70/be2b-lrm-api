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


## Fase 2 — Autenticação, métricas reais e status na Meta

### Autenticação

O front envia `Authorization: Bearer <JWT do Supabase>` e `x-organization-id`. A API valida o
token no Supabase e confere se o usuário é membro ativo da empresa (consulta `organization_users`
com o token do próprio usuário, então a RLS decide). Defina `SUPABASE_URL` e `SUPABASE_ANON_KEY`.

- **Rollout seguro:** suba com `API_AUTH_MODE=log` (registra o que seria bloqueado, sem bloquear),
  confira os logs `[auth][log-only]`, depois troque para `enforce`.
- **Sem essas variáveis a API continua aberta** e registra um aviso no start.
- **Públicas:** `/health`, `/uploads/*`, `/r/:codigo`, redirecionador/resolução por tracking code e
  `/api/meta-ads/oauth/callback` (state assinado).
- **Webhooks de lead** (`/api/paid-traffic/inbound-lead`, `/instagram/inbound-lead`,
  `/instagram/whatsapp-message`): se `INBOUND_WEBHOOK_SECRET` estiver definido, exigem o header
  `x-webhook-secret`. Atualize os fluxos do n8n antes de definir o segredo.
- `organization_id` divergente entre header, query e corpo → 400.

### Métricas da Meta (`migrations/008_meta_insights_sync.sql`)

- `POST /api/meta-ads/sync-insights` `{ organization_id, campaign_id?, days? (1–90, padrão 7) }`
- Sincronização automática a cada `META_INSIGHTS_AUTO_SYNC_HOURS` horas (padrão 6; `0` desliga).
- Grava em `paid_traffic_metrics` com `source = 'meta_api'`, uma linha por campanha/dia (upsert).
  Lançamentos manuais (`source = 'manual'`) não são alterados.
- Cliques = `inline_link_clicks` (cai para `clicks`). Leads da plataforma = UM `action_type`
  (`lead` → `onsite_conversion.lead_grouped` → `onsite_conversion.messaging_conversation_started_7d`);
  tipos sobrepostos nunca são somados.
- Token expirado (código 190) marca a conexão como `needs_reconnect`.

### Status e publicação

- `POST /api/paid-traffic/campaigns/:id/status` e `/archive`: se a campanha foi publicada na Meta,
  pausa/ativa **campanha, conjunto e anúncio** lá primeiro; se a Meta recusar, o status local **não**
  muda. Finalizar/arquivar apenas PAUSA (ARCHIVED na Meta é irreversível). Escape explícito:
  `skip_meta_sync: true` no corpo.
- `GET /api/meta-ads/campaigns/:campaignId/publication?refresh=1`: situação da publicação e, com
  `refresh=1`, a revisão do anúncio (`effective_status`, `issues_info`, `ad_review_feedback`).
- `POST /api/meta-ads/publish-campaign-live` agora é idempotente (409 se já publicada/em andamento)
  e registra os IDs de objetos criados na Meta quando a publicação falha no meio.

### Testes

```sh
npm test   # node:test, sem dependências extras; inclui subir o servidor contra um Supabase falso
```
