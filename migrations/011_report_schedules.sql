-- Fase 4: relatório semanal por e-mail. Idempotente.
create table if not exists public.paid_traffic_report_schedules (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  org_name text null,
  is_active boolean not null default true,
  recipients text[] not null default '{}',
  weekday integer not null default 1,            -- 1 = segunda … 7 = domingo
  hour integer not null default 8,               -- hora local
  timezone text not null default 'America/Sao_Paulo',
  last_sent_at timestamptz null,
  last_status text null,
  last_error text null,
  attempts_day text null,                        -- dia local da última tentativa (yyyy-MM-dd)
  attempts integer not null default 0,           -- tentativas nesse dia (limita reenvio após falha)
  last_test_at timestamptz null,
  created_by uuid null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint paid_traffic_report_schedules_weekday_check check (weekday between 1 and 7),
  constraint paid_traffic_report_schedules_hour_check check (hour between 0 and 23),
  constraint paid_traffic_report_schedules_recipients_check check (coalesce(array_length(recipients, 1), 0) <= 5)
);

create unique index if not exists paid_traffic_report_schedules_org_uidx
  on public.paid_traffic_report_schedules (organization_id);
