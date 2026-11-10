-- Fase 3: regras automáticas do Tráfego Pago. Idempotente.

create table if not exists public.paid_traffic_rules (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  campaign_id uuid null,                      -- null = todas as campanhas ativas da empresa
  name text not null,
  metric text not null,
  operator text not null,
  threshold numeric not null,
  window_days integer not null default 3,
  min_spend numeric not null default 0,       -- evidência mínima: não avalia com gasto menor que isso
  action text not null default 'notify',
  cooldown_hours integer not null default 24,
  max_actions_per_day integer not null default 3,
  is_active boolean not null default true,
  created_by uuid null,
  last_run_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint paid_traffic_rules_metric_check check (metric in
    ('cpl','cost_per_qualified','spend','leads','ctr','cpc','days_without_leads','balance')),
  constraint paid_traffic_rules_operator_check check (operator in ('>','>=','<','<=')),
  constraint paid_traffic_rules_action_check check (action in ('notify','pause')),
  constraint paid_traffic_rules_window_check check (window_days between 1 and 30),
  constraint paid_traffic_rules_cooldown_check check (cooldown_hours between 1 and 720),
  constraint paid_traffic_rules_max_check check (max_actions_per_day between 1 and 50),
  constraint paid_traffic_rules_min_spend_check check (min_spend >= 0)
);

create index if not exists paid_traffic_rules_org_idx on public.paid_traffic_rules (organization_id);
create index if not exists paid_traffic_rules_active_idx on public.paid_traffic_rules (is_active) where is_active;

create table if not exists public.paid_traffic_rule_runs (
  id uuid primary key default gen_random_uuid(),
  rule_id uuid not null references public.paid_traffic_rules(id) on delete cascade,
  organization_id uuid not null,
  campaign_id uuid not null,
  status text not null,
  metric_value numeric null,
  threshold numeric null,
  action text not null,
  message text null,
  created_at timestamptz not null default now(),
  constraint paid_traffic_rule_runs_status_check check (status in ('notified','paused','failed'))
);

create index if not exists paid_traffic_rule_runs_org_idx on public.paid_traffic_rule_runs (organization_id, created_at desc);
create index if not exists paid_traffic_rule_runs_rule_campaign_idx on public.paid_traffic_rule_runs (rule_id, campaign_id, created_at desc);
