-- Phase 2: macro engine schema (Fed, inflation/GDP/unemployment, yield curve,
-- recession/expansion cycle). All scheduling columns below ("*_at", "started_at",
-- "ends_at", "simulated_date") are SIMULATED time, taken from market_state's
-- own simulated_time clock -- never wall-clock time. Only created_at/updated_at
-- are real wall-clock timestamps, used purely for our own debugging/bookkeeping
-- and never read by simulation logic.

create table macro_state (
  id smallint primary key default 1 check (id = 1),

  cycle_phase text not null check (cycle_phase in ('expansion', 'peak', 'recession', 'trough')),
  -- Simulated time the current phase began / is scheduled to end. Phase
  -- transitions are deterministic once phase_ends_at is reached -- there is
  -- no threshold-crossing logic, this is a fixed-duration state machine.
  phase_started_at timestamptz not null,
  phase_ends_at timestamptz not null,

  -- Secondary flavor noise layered on top of the phase for the derived
  -- indicators below (inflation/GDP/unemployment). Does NOT drive phase
  -- transitions -- it just keeps those series from looking robotic.
  momentum numeric not null default 0,

  fed_funds_rate numeric not null,
  last_fed_meeting_at timestamptz,
  next_fed_meeting_at timestamptz not null,

  inflation_rate numeric not null,
  pce_rate numeric not null,
  gdp_growth numeric not null,
  unemployment_rate numeric not null,

  next_cpi_release_at timestamptz not null,
  next_gdp_release_at timestamptz not null,
  next_unemployment_release_at timestamptz not null,

  updated_at timestamptz not null default now()
);

create table fed_meetings (
  id uuid primary key default gen_random_uuid(),
  simulated_date timestamptz not null,
  rate_before numeric not null,
  rate_after numeric not null,
  decision text not null check (decision in ('hike', 'cut', 'hold')),
  basis_points numeric not null default 0,
  rationale text,
  created_at timestamptz not null default now()
);

create index fed_meetings_simulated_date_idx on fed_meetings (simulated_date desc);

create table economic_releases (
  id uuid primary key default gen_random_uuid(),
  release_type text not null check (release_type in ('cpi', 'pce', 'gdp', 'unemployment')),
  simulated_date timestamptz not null,
  value numeric not null,
  prior_value numeric,
  created_at timestamptz not null default now()
);

create index economic_releases_type_date_idx on economic_releases (release_type, simulated_date desc);

create table yield_curve_snapshots (
  id bigint generated always as identity primary key,
  simulated_date timestamptz not null,
  tenor text not null check (tenor in ('3m', '2y', '10y', '30y')),
  yield numeric not null,
  created_at timestamptz not null default now()
);

create index yield_curve_snapshots_date_tenor_idx on yield_curve_snapshots (simulated_date desc, tenor);

create table macro_phase_history (
  id uuid primary key default gen_random_uuid(),
  phase text not null check (phase in ('expansion', 'peak', 'recession', 'trough')),
  started_at timestamptz not null,
  ended_at timestamptz,
  created_at timestamptz not null default now()
);

create index macro_phase_history_started_at_idx on macro_phase_history (started_at desc);

-- Seed the singleton row off the price engine's existing simulated clock, so
-- the macro engine starts in lockstep with market_state rather than wall-clock "now".
insert into macro_state (
  id, cycle_phase, phase_started_at, phase_ends_at, momentum,
  fed_funds_rate, next_fed_meeting_at,
  inflation_rate, pce_rate, gdp_growth, unemployment_rate,
  next_cpi_release_at, next_gdp_release_at, next_unemployment_release_at
)
select
  1,
  'expansion',
  ms.simulated_time,
  ms.simulated_time + interval '180 days',
  0,
  4.5,
  ms.simulated_time + interval '42 days',
  2.5,
  2.3,
  2.0,
  4.0,
  ms.simulated_time + interval '30 days',
  ms.simulated_time + interval '90 days',
  ms.simulated_time + interval '30 days'
from market_state ms
where ms.id = 1;

insert into macro_phase_history (phase, started_at, ended_at)
select 'expansion', ms.simulated_time, null
from market_state ms
where ms.id = 1;

alter table macro_state enable row level security;
alter table fed_meetings enable row level security;
alter table economic_releases enable row level security;
alter table yield_curve_snapshots enable row level security;
alter table macro_phase_history enable row level security;

create policy "macro_state is publicly readable" on macro_state for select using (true);
create policy "fed_meetings are publicly readable" on fed_meetings for select using (true);
create policy "economic_releases are publicly readable" on economic_releases for select using (true);
create policy "yield_curve_snapshots are publicly readable" on yield_curve_snapshots for select using (true);
create policy "macro_phase_history is publicly readable" on macro_phase_history for select using (true);
