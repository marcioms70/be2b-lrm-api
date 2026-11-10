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
- Cliques = `inline_link_clicks` (cai para `clicks`). Frequência diária (`frequency`, migração 010) alimenta a detecção de fadiga. Leads da plataforma = UM `action_type`
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

## Fase 3 — Regras automáticas (`migrations/009_paid_traffic_rules.sql`)

Regras avaliadas sobre campanhas **ativas**, com métricas dos últimos N dias (1–30):
`cpl`, `cost_per_qualified`, `spend`, `leads`, `ctr`, `cpc`, `days_without_leads`, `balance`.
Operadores `>`, `>=`, `<`, `<=`. O CPL usa os leads do funil LRM (`paid_traffic_leads`); com gasto ≥ gasto
mínimo e **zero leads** o CPL é tratado como infinito (uma regra `cpl > X` dispara). Nos dias em que há
linha da Meta, o lançamento manual do mesmo dia não é somado.

- `GET/POST /api/paid-traffic/rules`, `PATCH/DELETE /api/paid-traffic/rules/:id`
- `GET /api/paid-traffic/rules/runs` — log de execuções
- `POST /api/paid-traffic/rules/run` `{ dry_run?: true }` — avalia agora; com `dry_run` só mostra o que aconteceria

**Segurança operacional**

- Ação padrão: **notificar** (log + evento no histórico da campanha). **Pausar** é opt-in por regra.
- Pausar passa pela mesma rota de status: pausa **na Meta primeiro**; se a Meta recusar, a campanha continua
  ativa e a falha é registrada. `RULES_ALLOW_PAUSE=false` desliga a pausa no servidor (vira notificação).
- Cooldown por regra+campanha (padrão 24 h) e limite diário por regra (padrão 3). Falhas também contam,
  para não insistir na Meta a cada execução.
- `min_spend`: sem evidência mínima de gasto, as métricas de custo/CTR/CPC não são avaliadas.
- Agendador: `RULES_EVAL_INTERVAL_MINUTES` (padrão 60; `0` desliga). Rode **uma** instância do servidor,
  senão o agendador (e a sincronização de insights) executa em duplicidade. `RULES_TIMEZONE` (padrão
  `America/Sao_Paulo`) define o "dia" das janelas.

### Testes com Postgres real

```sh
TEST_DATABASE_URL=postgresql://usuario@host:5432/banco_de_teste npm test
```
Sem `TEST_DATABASE_URL` os testes de banco são ignorados. Use um banco **descartável**: o teste cria
tabelas-base se faltarem e apaga os dados das empresas de teste.

## Fase 4 — Relatório semanal por e-mail (`migrations/011_report_schedules.sql`)

Resumo dos **7 últimos dias completos** (até ontem) comparado aos 7 anteriores: investimento, leads, CPL,
qualificados, custo por qualificado, enviados ao CRM, campanhas da semana, campanhas que gastaram sem gerar
leads e regras automáticas disparadas. Dias com linha da Meta não somam o lançamento manual do mesmo dia.

- `GET/PUT /api/paid-traffic/report-schedule` — destinatários (até 5), dia da semana (1 = segunda … 7 = domingo),
  hora local (padrão segunda 08h, `America/Sao_Paulo`), ativo e nome da empresa.
- `POST /api/paid-traffic/report-schedule/preview` — devolve o assunto e o HTML sem enviar.
- `POST /api/paid-traffic/report-schedule/send-test` — envia agora **só para os destinatários salvos**
  (no máximo 1 por minuto).
- **Somente administradores da empresa** (owner/admin/superadmin) acessam essas rotas. Isso depende da
  autenticação estar ligada (`SUPABASE_URL`/`SUPABASE_ANON_KEY`); com a API aberta (modo `off`) não há como
  saber o papel e a checagem é ignorada.
- Envio pelo Resend (`RESEND_API_KEY`, `REPORT_FROM_EMAIL`, remetente verificado). Sem elas nada é enviado e a
  tela avisa. Todo texto dinâmico (nome de campanha/empresa) é escapado no HTML; o assunto não aceita quebra de linha.
- O envio agendado é reivindicado de forma atômica no banco (duas instâncias não duplicam), acontece uma vez por
  dia/agendamento e, se falhar, é repetido até 3 vezes no mesmo dia. O resultado fica em `last_status`/`last_error`.

### Automação de atendimento na campanha (`migrations/012_campaign_automation.sql`)

`paid_traffic_campaigns.automation_id` (uuid, sem FK — a tabela `automations` vive no Supabase). O assistente do
be2bdr já exigia escolher a automação, mas o valor era descartado. Agora é gravado em `POST/PATCH
/api/paid-traffic/campaigns` (vazio vira `null`; texto que não é UUID → 400) e vem na linha da campanha
devolvida por `GET /api/paid-traffic/instagram/campaign/:trackingCode`.

Atenção: por enquanto o campo só é **gravado e exibido**. Nenhum fluxo do n8n conhecido (BDR, SDR, cadências,
memória do chat) lê essa rota nem usa o `automation_id` da campanha; o `automation_id` que o fluxo BDR recebe
vem das Automações do Be2B. Para a campanha acionar a automação escolhida, o ponto que recebe o lead do anúncio
(por exemplo `POST /api/paid-traffic/inbound-lead`) ainda precisa ser ligado a ela.

Ordem de deploy: o servidor aplica a migração sozinho no start. Se não conseguir (usuário sem DDL), as rotas de
campanha ignoram colunas que o banco ainda não tem, em vez de falhar — então backend e banco podem subir em
qualquer ordem. Aplique a migração manualmente nesse caso.
