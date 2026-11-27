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

-- ---------------------------------------------------------------------------------------------------------------
-- The hedged-vault job (written 2026-11-26; applied 2026-11-27 with the deploy of hedge-keeper).
-- Its state is in keeper_state under "hedge". The job runs every minute and writes a row only when it did or
-- noticed something, and once an hour otherwise.
create table public.hedge_runs (
  id bigint generated always as identity primary key,
  ran_at timestamptz not null default now(),
  ok boolean, mode text, status text, reason text, keeper text, gas_hype numeric,
  vault jsonb, actions jsonb, warnings jsonb, error text
);
alter table public.hedge_runs enable row level security;
create index hedge_runs_ran_at_idx on public.hedge_runs (ran_at desc);
-- Every minute. Same net.http_post call as the others, to /functions/v1/hedge-keeper.
-- select cron.schedule('hedge-keeper', '* * * * *', $$ ... $$);
-- select cron.schedule('hedge-runs-cleanup', '47 3 * * *', $$ delete from public.hedge_runs where ran_at < now() - interval '30 days' $$);

-- ---------------------------------------------------------------------------------------------------------------
-- History for the hedged vault's page (applied 2026-11-27 as migration "hedged_history").
-- Public chain data only: what the keeper bot read from HyperEVM on its runs. The bot's run log (hedge_runs) is
-- cleared after 30 days; this table is kept. A trigger copies one reading per clock hour and one for every run in
-- which the bot acted. Read by the function "hedged-history" (hedged-history-index.ts).
create table public.hedged_states (
  vault text not null,                              -- the vault's address, lower case
  ts timestamptz not null,
  value numeric not null check (value >= 0),        -- the vault's worth at Hyperliquid's price, USDC units (6 decimals)
  supply numeric not null check (supply > 0),       -- shares in issue (6 decimals)
  hype_px numeric not null check (hype_px > 0),     -- Hyperliquid's oracle price of HYPE, dollars
  primary key (vault, ts)
);
alter table public.hedged_states enable row level security;

create or replace function public.hedged_states_from_run() returns trigger
language plpgsql set search_path to '' as $$
declare
  v_vault constant text := '0x269ecaeae9dbc37b9d2cb643deec89394d9e07dd';
  v_value numeric; v_supply numeric; v_px numeric;
begin
  if new.vault is null then return new; end if;
  v_value := round((new.vault->>'valueUsdc')::numeric * 1000000);
  v_supply := round((new.vault->>'shares')::numeric * 1000000);
  v_px := (new.vault->>'hypePrice')::numeric;
  if v_value is null or v_supply is null or v_px is null or v_supply <= 0 or v_px <= 0 then return new; end if;
  if new.status = 'acted' or not exists (
    select 1 from public.hedged_states s
    where s.vault = v_vault and s.ts >= date_trunc('hour', new.ran_at) and s.ts < date_trunc('hour', new.ran_at) + interval '1 hour'
  ) then
    insert into public.hedged_states (vault, ts, value, supply, hype_px) values (v_vault, new.ran_at, v_value, v_supply, v_px) on conflict do nothing;
  end if;
  return new;
exception when others then
  return new; -- the history must never stop the bot's own log
end $$;
create trigger hedged_states_from_run after insert on public.hedge_runs for each row execute function public.hedged_states_from_run();

-- The last reading in each stretch of p_bucket seconds.
create or replace function public.hedged_series(p_vault text, p_from timestamptz, p_bucket integer)
returns table (ts timestamptz, value numeric, supply numeric, hype_px numeric)
language sql stable set search_path to '' as $$
  select distinct on (floor(extract(epoch from s.ts) / p_bucket)) s.ts, s.value, s.supply, s.hype_px
  from public.hedged_states s
  where s.vault = p_vault and s.ts >= p_from
  order by floor(extract(epoch from s.ts) / p_bucket), s.ts desc
$$;

-- what the bot logged before this table existed
insert into public.hedged_states (vault, ts, value, supply, hype_px)
select '0x269ecaeae9dbc37b9d2cb643deec89394d9e07dd', ran_at, round((vault->>'valueUsdc')::numeric * 1000000),
       round((vault->>'shares')::numeric * 1000000), (vault->>'hypePrice')::numeric
from public.hedge_runs where vault is not null and (vault->>'shares')::numeric > 0
on conflict do nothing;

-- ---------------------------------------------------------------------------------------------------------------
-- The hedged vault's own events (applied 2026-11-27 as migration "hedged_events").
-- Every deposit, withdrawal and claim with the wallet it concerns, and every collection of trading fees, copied from
-- HyperEVM by the function "hedged-recorder" (hedged-recorder-index.ts). Public chain data only. The vault's page
-- needs them for a wallet's result, and cannot read them itself (HyperEVM's public RPC answers event queries over
-- 1,000 blocks at most). Read by "hedged-history".
create table public.hedged_events (
  vault text not null,                    -- the vault's address, lower case
  block bigint not null,
  log_index integer not null,
  ts timestamptz not null,                -- the block's time
  tx text not null,
  kind text not null check (kind in ('deposit', 'withdraw', 'claimed', 'fees')),
  account text,                           -- whose it is, lower case: the receiver of a deposit or a claim, the owner of the shares withdrawn; null for fees
  a numeric not null default 0,           -- deposit: USDC in        withdraw: shares given up    claimed: USDC paid    fees: token0 (wrapped HYPE) collected
  b numeric not null default 0,           -- deposit: shares         withdraw: USDC paid at once                         fees: USDC collected
  c numeric not null default 0,           --                         withdraw: wrapped HYPE sent                         fees: token0 of the performance fee
  d numeric not null default 0,           --                         withdraw: USDC owed                                 fees: USDC of the performance fee
  px numeric,                             -- Hyperliquid's price of HYPE in the same transaction, dollars
  primary key (vault, block, log_index)
);
alter table public.hedged_events enable row level security;
create index hedged_events_account_idx on public.hedged_events (vault, account, ts);

-- Everyone's deposits and withdrawals so far, in dollars.
create or replace function public.hedged_flows(p_vault text)
returns table (deposited numeric, paid numeric, owed numeric, asset_usd numeric, deposits bigint, withdrawals bigint)
language sql stable set search_path to '' as $$
  select coalesce(sum(e.a) filter (where e.kind = 'deposit'), 0) / 1000000,
         coalesce(sum(e.b) filter (where e.kind = 'withdraw'), 0) / 1000000,
         coalesce(sum(e.d) filter (where e.kind = 'withdraw'), 0) / 1000000,
         coalesce(sum(e.c / 1000000000000000000 * coalesce(e.px, 0)) filter (where e.kind = 'withdraw'), 0),
         count(*) filter (where e.kind = 'deposit'), count(*) filter (where e.kind = 'withdraw')
  from public.hedged_events e where e.vault = p_vault
$$;
-- Every 5 minutes, at minutes 2, 7, 12 and so on. Same net.http_post call as the others, to /functions/v1/hedged-recorder.
-- One event query a run and no more: see the note at the top of hedged-recorder-index.ts before changing either.
-- select cron.schedule('hedged-recorder', '2-59/5 * * * *', $$ ... $$);

-- ---------------------------------------------------------------------------------------------------------------
-- The hedged vault's range over time (applied 2026-11-27 as migration "hedged_events_filled").
-- One more kind of row in hedged_events: 'filled', from the vault's Filled event, with a = the pool's tick then,
-- b = the range's lower tick, c = its upper tick, d = the liquidity added. The page's chart draws the range from them.
alter table public.hedged_events drop constraint hedged_events_kind_check;
alter table public.hedged_events add constraint hedged_events_kind_check check (kind in ('deposit', 'withdraw', 'claimed', 'fees', 'filled'));
