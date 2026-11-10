-- Fase 2: métricas sincronizadas da Meta convivendo com lançamentos manuais.
-- Idempotente (pode rodar várias vezes).

alter table public.paid_traffic_metrics
  add column if not exists source text not null default 'manual';

-- Uma linha por campanha/dia vinda da Meta (a sincronização faz upsert nela).
-- Lançamentos manuais continuam livres; o front ignora o manual do dia quando há linha da Meta.
create unique index if not exists paid_traffic_metrics_meta_daily_uidx
  on public.paid_traffic_metrics (campaign_id, report_date)
  where source = 'meta_api';

alter table public.meta_ads_campaign_publications
  add column if not exists last_insights_sync_at timestamptz null,
  add column if not exists last_insights_error text null;
