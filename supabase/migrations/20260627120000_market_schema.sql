-- Phase 1: market engine schema (equities universe only; other asset classes are later phases)

create extension if not exists pgcrypto;

create table companies (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  ticker text not null unique,
  sector text not null check (sector in (
    'technology', 'healthcare', 'energy', 'financials',
    'consumer_discretionary', 'consumer_staples', 'industrials',
    'utilities', 'real_estate', 'materials', 'communication_services'
  )),
  archetype text not null check (archetype in (
    'blue_chip', 'growth', 'speculative', 'penny_stock', 'value', 'cyclical'
  )),
  current_price numeric not null check (current_price > 0),
  drift numeric not null,
  volatility numeric not null check (volatility > 0),
  event_probability numeric not null default 0.01 check (event_probability >= 0 and event_probability <= 1),
  mean_reversion_strength numeric not null default 0,
  momentum_strength numeric not null default 0,
  beta numeric not null default 1.0,
  -- Long-run reversion target for mean-reverting archetypes (blue_chip, value).
  -- Set to the seeded starting price and not updated by ticks.
  anchor_price numeric not null check (anchor_price > 0),
  -- Realized return from the most recent tick, fed back in as the momentum term.
  last_return numeric not null default 0,
  created_at timestamptz not null default now()
);

create index companies_sector_idx on companies (sector);
create index companies_archetype_idx on companies (archetype);

-- Append-only tick log. At 500+ companies ticking every simulated minute (and faster
-- at high time multipliers), this table grows unbounded. Before this goes to
-- production scale we need a retention/downsampling strategy -- e.g. roll old
-- intraday rows up into coarser OHLC bars (hourly/daily) and drop the raw ticks
-- past some age, or move cold history to a separate partition/table.
create table price_history (
  id bigint generated always as identity primary key,
  company_id uuid not null references companies (id) on delete cascade,
  simulated_timestamp timestamptz not null,
  price numeric not null check (price > 0),
  created_at timestamptz not null default now()
);

create index price_history_company_time_idx on price_history (company_id, simulated_timestamp desc);

create table market_events (
  id uuid primary key default gen_random_uuid(),
  company_id uuid references companies (id) on delete cascade,
  event_type text not null,
  description text not null,
  impact numeric not null default 0,
  simulated_timestamp timestamptz not null,
  created_at timestamptz not null default now()
);

create index market_events_company_time_idx on market_events (company_id, simulated_timestamp desc);

-- Singleton row holding global engine state/config.
create table market_state (
  id smallint primary key default 1 check (id = 1),
  time_multiplier numeric not null default 1 check (time_multiplier >= 0),
  is_running boolean not null default true,
  simulated_time timestamptz not null,
  last_tick_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into market_state (id, time_multiplier, is_running, simulated_time, last_tick_at)
values (1, 1, true, now(), now());

alter table companies enable row level security;
alter table price_history enable row level security;
alter table market_events enable row level security;
alter table market_state enable row level security;

create policy "companies are publicly readable" on companies for select using (true);
create policy "price_history is publicly readable" on price_history for select using (true);
create policy "market_events are publicly readable" on market_events for select using (true);
create policy "market_state is publicly readable" on market_state for select using (true);
