-- Fase 4 (correção): a automação de atendimento escolhida no assistente passa a ser gravada na campanha.
-- Sem FK: a tabela `automations` vive no Supabase (Lovable Cloud), não neste banco. Idempotente.
alter table public.paid_traffic_campaigns
  add column if not exists automation_id uuid null;

create index if not exists paid_traffic_campaigns_automation_idx
  on public.paid_traffic_campaigns (automation_id)
  where automation_id is not null;
