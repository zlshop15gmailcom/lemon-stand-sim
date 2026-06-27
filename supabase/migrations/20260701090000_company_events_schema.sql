-- Phase 4: company-level events (earnings, analyst ratings, dividends/splits/
-- buybacks, M&A/spinoffs, IPOs, scandals). All scheduling columns/timestamps
-- here are SIMULATED time, same convention as Phase 1/2.

alter table companies
  add column is_listed boolean not null default true,
  add column listed_at timestamptz,
  add column next_earnings_at timestamptz,
  add column last_eps numeric,
  add column last_revenue numeric;

-- Backfill existing companies as already listed at the engine's start, with a
-- randomized first earnings date within the next simulated quarter so they
-- don't all report on the same day, and rough placeholder financials derived
-- from price (fake P/E ~10-30x, fake revenue scaled off price) so earnings
-- surprises have something plausible to move from.
update companies c
set
  listed_at = ms.simulated_time,
  next_earnings_at = ms.simulated_time + (random() * 90 || ' days')::interval,
  last_eps = round((c.current_price / (10 + random() * 20))::numeric, 2),
  last_revenue = round((c.current_price * (50 + random() * 200) * 1000000)::numeric, 0)
from market_state ms
where ms.id = 1;

create table company_events (
  id uuid primary key default gen_random_uuid(),
  event_type text not null check (event_type in (
    'earnings', 'analyst_rating', 'dividend', 'split', 'buyback',
    'merger', 'spinoff', 'ipo', 'scandal'
  )),
  company_id uuid not null references companies (id) on delete cascade,
  -- For 'merger': the acquirer is company_id, the target is related_company_id.
  -- For 'spinoff': the parent is company_id, the newly created spinoff is
  -- related_company_id.
  related_company_id uuid references companies (id) on delete set null,
  simulated_date timestamptz not null,
  price_impact numeric not null default 0,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index company_events_company_date_idx on company_events (company_id, simulated_date desc);
create index company_events_type_date_idx on company_events (event_type, simulated_date desc);

-- Tracks how far the probabilistic (non-scheduled) event types have been
-- processed, in simulated time, so company-events-tick can step through
-- elapsed simulated days consistently regardless of cron wall-clock timing or
-- the user's time multiplier -- same purpose as market_state.last_tick_at.
create table company_events_state (
  id smallint primary key default 1 check (id = 1),
  last_processed_at timestamptz not null
);

insert into company_events_state (id, last_processed_at)
select 1, ms.simulated_time
from market_state ms
where ms.id = 1;

alter table company_events enable row level security;
alter table company_events_state enable row level security;

create policy "company_events are publicly readable" on company_events for select using (true);
create policy "company_events_state is publicly readable" on company_events_state for select using (true);
