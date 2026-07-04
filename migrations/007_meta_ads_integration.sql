create extension if not exists pgcrypto;

create table if not exists public.meta_ads_connections (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  meta_user_id text null,
  business_id text null,
  business_name text null,
  ad_account_id text null,
  ad_account_name text null,
  page_id text null,
  page_name text null,
  instagram_actor_id text null,
  instagram_username text null,
  access_token_encrypted text null,
  token_type text null,
  token_expires_at timestamptz null,
  scopes text[] null,
  status text not null default 'pending',
  last_error text null,
  connected_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint meta_ads_connections_status_check check (
    status in ('pending', 'connected', 'disconnected', 'error', 'needs_reconnect')
  )
);

create unique index if not exists meta_ads_connections_org_unique
  on public.meta_ads_connections (organization_id);

create index if not exists meta_ads_connections_organization_id_idx
  on public.meta_ads_connections (organization_id);

create index if not exists meta_ads_connections_status_idx
  on public.meta_ads_connections (status);

create index if not exists meta_ads_connections_ad_account_id_idx
  on public.meta_ads_connections (ad_account_id);

create table if not exists public.meta_ads_publish_jobs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  campaign_id uuid not null,
  connection_id uuid null,
  status text not null default 'pending',
  request_payload jsonb null,
  response_payload jsonb null,
  error_message text null,
  started_at timestamptz null,
  finished_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint meta_ads_publish_jobs_status_check check (
    status in ('pending', 'running', 'success', 'error')
  )
);

create index if not exists meta_ads_publish_jobs_organization_id_idx
  on public.meta_ads_publish_jobs (organization_id);

create index if not exists meta_ads_publish_jobs_campaign_id_idx
  on public.meta_ads_publish_jobs (campaign_id);

create index if not exists meta_ads_publish_jobs_status_idx
  on public.meta_ads_publish_jobs (status);

create table if not exists public.meta_ads_campaign_publications (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  campaign_id uuid not null,
  connection_id uuid null,
  publish_job_id uuid null,
  meta_campaign_id text null,
  meta_adset_id text null,
  meta_creative_id text null,
  meta_ad_id text null,
  status text not null default 'draft',
  published_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  raw_response jsonb null,
  last_error text null,
  constraint meta_ads_campaign_publications_status_check check (
    status in ('draft', 'publishing', 'published', 'failed', 'paused', 'archived')
  )
);

create unique index if not exists meta_ads_campaign_publications_org_campaign_unique
  on public.meta_ads_campaign_publications (organization_id, campaign_id);

create index if not exists meta_ads_campaign_publications_organization_id_idx
  on public.meta_ads_campaign_publications (organization_id);

create index if not exists meta_ads_campaign_publications_campaign_id_idx
  on public.meta_ads_campaign_publications (campaign_id);

create index if not exists meta_ads_campaign_publications_status_idx
  on public.meta_ads_campaign_publications (status);
