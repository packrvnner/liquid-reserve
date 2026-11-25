-- Supabase setup for the hosted vault keeper (project "liquid-reserve-keeper").
-- Applied 2026-11-14. Kept here as the record of what exists.

-- 1. Run history. RLS is on with no policies, so only the function's service role can touch it.
create table public.keeper_runs (
  id bigint generated always as identity primary key,
  ran_at timestamptz not null default now(),
  ok boolean not null,
  mode text,
  keeper text,
  block bigint,
  gas_hype numeric,
  vaults jsonb not null default '[]'::jsonb,
  warnings jsonb not null default '[]'::jsonb,
  error text
);
create index keeper_runs_ran_at_idx on public.keeper_runs (ran_at desc);
alter table public.keeper_runs enable row level security;

-- 2. Scheduler and outbound HTTP.
create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

-- 3. Where the scheduler finds the function, and the project's publishable anon key.
--    (Run once in the SQL editor with the real values; both live in Supabase Vault.)
-- select vault.create_secret('https://<project-ref>.supabase.co', 'project_url');
-- select vault.create_secret('<anon key>', 'anon_key');

-- 4. Every 10 minutes.
select cron.schedule(
  'vault-keeper',
  '*/10 * * * *',
  $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url') || '/functions/v1/vault-keeper',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'anon_key')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  );
  $$
);

-- 5. Keep 30 days of history.
select cron.schedule('keeper-runs-cleanup', '17 3 * * *', $$ delete from public.keeper_runs where ran_at < now() - interval '30 days' $$);

-- 6. The reserve job (added 2026-11-15): its own run history and schedule.
create table public.reserve_runs (
  id bigint generated always as identity primary key,
  ran_at timestamptz not null default now(),
  ok boolean not null,
  mode text,
  status text,
  reason text,
  keeper text,
  block bigint,
  gas_hype numeric,
  waiting_usd numeric,
  needed_usd numeric,
  actions jsonb not null default '[]'::jsonb,
  warnings jsonb not null default '[]'::jsonb,
  holdings jsonb,
  error text
);
create index reserve_runs_ran_at_idx on public.reserve_runs (ran_at desc);
alter table public.reserve_runs enable row level security;

-- Every 10 minutes, 5 minutes after the vault keeper (they share one wallet).
select cron.schedule(
  'reserve-keeper',
  '5-59/10 * * * *',
  $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url') || '/functions/v1/reserve-keeper',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'anon_key')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  );
  $$
);
select cron.schedule('reserve-runs-cleanup', '23 3 * * *', $$ delete from public.reserve_runs where ran_at < now() - interval '30 days' $$);

-- 7. The HyperEVM job (added 2026-11-15): saved state, run history, schedule.
create table public.keeper_state (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);
alter table public.keeper_state enable row level security;
create table public.hyperevm_runs (
  id bigint generated always as identity primary key,
  ran_at timestamptz not null default now(),
  ok boolean not null,
  mode text,
  status text,
  reason text,
  keeper text,
  gas_hype numeric,
  batches jsonb not null default '[]'::jsonb,
  actions jsonb not null default '[]'::jsonb,
  warnings jsonb not null default '[]'::jsonb,
  holdings jsonb,
  error text
);
create index hyperevm_runs_ran_at_idx on public.hyperevm_runs (ran_at desc);
alter table public.hyperevm_runs enable row level security;
-- Every 30 minutes (minutes 8 and 38). Same net.http_post call as the others, to /functions/v1/hyperevm-keeper.
-- select cron.schedule('hyperevm-keeper', '8,38 * * * *', $$ ... $$);
-- select cron.schedule('hyperevm-runs-cleanup', '29 3 * * *', $$ delete from public.hyperevm_runs where ran_at < now() - interval '30 days' $$);

-- 8. The treasury job (added 2026-11-15): run history. State is in keeper_state under "treasury".
create table public.treasury_runs (
  id bigint generated always as identity primary key,
  ran_at timestamptz not null default now(),
  ok boolean not null,
  mode text,
  status text,
  reason text,
  keeper text,
  fuel jsonb,
  actions jsonb not null default '[]'::jsonb,
  warnings jsonb not null default '[]'::jsonb,
  error text
);
create index treasury_runs_ran_at_idx on public.treasury_runs (ran_at desc);
alter table public.treasury_runs enable row level security;
-- select cron.schedule('treasury-keeper', '3,33 * * * *', $$ ... net.http_post to /functions/v1/treasury-keeper ... $$);
-- select cron.schedule('treasury-runs-cleanup', '31 3 * * *', $$ delete from public.treasury_runs where ran_at < now() - interval '30 days' $$);

-- 9. The Ascend job (added 2026-11-15): run history. State is in keeper_state under "ascend".
create table public.ascend_runs (
  id bigint generated always as identity primary key,
  ran_at timestamptz not null default now(),
  ok boolean not null,
  mode text,
  status text,
  reason text,
  keeper text,
  coins jsonb not null default '[]'::jsonb,
  actions jsonb not null default '[]'::jsonb,
  warnings jsonb not null default '[]'::jsonb,
  error text
);
create index ascend_runs_ran_at_idx on public.ascend_runs (ran_at desc);
alter table public.ascend_runs enable row level security;
-- select cron.schedule('ascend-keeper', '8-59/10 * * * *', $$ ... net.http_post to /functions/v1/ascend-keeper ... $$);
-- select cron.schedule('ascend-runs-cleanup', '37 3 * * *', $$ delete from public.ascend_runs where ran_at < now() - interval '30 days' $$);

-- 10. The creator-cut job (added 2026-11-15): run history.
create table public.creator_runs (
  id bigint generated always as identity primary key,
  ran_at timestamptz not null default now(),
  ok boolean not null,
  mode text,
  status text,
  reason text,
  keeper text,
  waiting jsonb,
  actions jsonb not null default '[]'::jsonb,
  warnings jsonb not null default '[]'::jsonb,
  error text
);
create index creator_runs_ran_at_idx on public.creator_runs (ran_at desc);
alter table public.creator_runs enable row level security;
-- select cron.schedule('creator-keeper', '2-59/10 * * * *', $$ ... net.http_post to /functions/v1/creator-keeper ... $$);
-- select cron.schedule('creator-runs-cleanup', '41 3 * * *', $$ delete from public.creator_runs where ran_at < now() - interval '30 days' $$);

-- ---------------------------------------------------------------------------------------------------------------
-- History for the Stake page (liquidHYPE), added 2026-11-20 (migration "staking_history"). Public chain data only;
-- written by "history-recorder", read by "stake-history".

-- Kinetiq's kHYPE rate over time: StakingAccountant.kHYPEToHYPE(1e18) on HyperEVM, in wei (1e18 = 1 HYPE per kHYPE).
create table public.khype_rate (
  ts timestamptz primary key,
  block bigint not null,
  rate numeric not null
);
alter table public.khype_rate enable row level security;

-- The staking vault every 5 minutes: kHYPE held for stakers, liquidHYPE in issue, the rate the vault values kHYPE at,
-- and the fee waiting inside it. All in wei.
create table public.stake_states (
  vault text not null,
  ts timestamptz not null,
  assets numeric not null,
  supply numeric not null,
  rate numeric not null,
  fees numeric not null default 0,
  primary key (vault, ts)
);
alter table public.stake_states enable row level security;

-- The last reading in each stretch of p_bucket seconds.
create or replace function public.khype_rate_series(p_from timestamptz, p_bucket integer)
returns table (ts timestamptz, rate numeric)
language sql stable set search_path to '' as $$
  select distinct on (floor(extract(epoch from k.ts) / p_bucket)) k.ts, k.rate
  from public.khype_rate k
  where k.ts >= p_from
  order by floor(extract(epoch from k.ts) / p_bucket), k.ts desc
$$;

create or replace function public.stake_series(p_vault text, p_from timestamptz, p_bucket integer)
returns table (ts timestamptz, assets numeric, supply numeric, rate numeric, fees numeric)
language sql stable set search_path to '' as $$
  select distinct on (floor(extract(epoch from s.ts) / p_bucket)) s.ts, s.assets, s.supply, s.rate, s.fees
  from public.stake_states s
  where s.vault = p_vault and s.ts >= p_from
  order by floor(extract(epoch from s.ts) / p_bucket), s.ts desc
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- The KNTQ staking job (applied 2026-11-21 as migration "kntq_runs", when KNTQ staking launched).
-- Its state is in keeper_state under "kntq".
create table public.kntq_runs (
  id bigint generated always as identity primary key,
  ran_at timestamptz not null default now(),
  ok boolean, mode text, status text, reason text, keeper text, gas_hype jsonb,
  batches jsonb, actions jsonb, warnings jsonb, holdings jsonb, error text
);
alter table public.kntq_runs enable row level security;
create index kntq_runs_ran_at_idx on public.kntq_runs (ran_at desc);
-- Every 10 minutes (minutes 6,16,...,56). Same net.http_post call as the others, to /functions/v1/kntq-keeper.
-- select cron.schedule('kntq-keeper', '6-59/10 * * * *', $$ ... $$);
-- select cron.schedule('kntq-runs-cleanup', '43 3 * * *', $$ delete from public.kntq_runs where ran_at < now() - interval '30 days' $$);
