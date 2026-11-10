-- Fase 3: frequência diária (usada na detecção de fadiga criativa). Idempotente.
alter table public.paid_traffic_metrics
  add column if not exists frequency numeric(8,2) null;
