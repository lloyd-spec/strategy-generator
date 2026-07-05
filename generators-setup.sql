-- ============================================================================
-- PIC PR INSIGHT SUITE - Generators setup
-- Run this once in Supabase (SQL Editor > paste > Run), the same way as
-- suite-setup.sql. Safe to run again - every statement checks before acting.
--
-- Adds the two libraries:
--   strategy_docs   - saved strategy documents from the Strategy Generator
--   monthly_reports - saved reports from the Monthly Report Generator
--
-- Neither table has any public policies: everything moves through each
-- tool's Netlify function using the service key and the team password.
-- ============================================================================

create table if not exists public.strategy_docs (
  id uuid primary key default gen_random_uuid(),
  client text not null,
  html text not null,
  meta jsonb default '{}'::jsonb,
  created_at timestamptz default now()
);
create index if not exists strategy_docs_client_idx
  on public.strategy_docs (client, created_at desc);
alter table public.strategy_docs enable row level security;

create table if not exists public.monthly_reports (
  id uuid primary key default gen_random_uuid(),
  client text not null,
  html text not null,
  meta jsonb default '{}'::jsonb,
  created_at timestamptz default now()
);
create index if not exists monthly_reports_client_idx
  on public.monthly_reports (client, created_at desc);
alter table public.monthly_reports enable row level security;
