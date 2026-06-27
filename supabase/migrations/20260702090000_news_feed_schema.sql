-- Phase 5: news feed, generated from macro and company events.

create table news_items (
  id uuid primary key default gen_random_uuid(),
  headline text not null,
  body text not null default '',
  -- Per CLAUDE.md: not every headline moves the market.
  category text not null check (category in ('market_moving', 'noise')),
  asset_class text not null default 'equity',
  sectors text[] not null default '{}',
  tickers text[] not null default '{}',
  source_event_type text not null,
  simulated_date timestamptz not null,
  created_at timestamptz not null default now(),
  search_vector tsvector generated always as (
    to_tsvector('english', coalesce(headline, '') || ' ' || coalesce(body, ''))
  ) stored
);

create index news_items_search_idx on news_items using gin (search_vector);
create index news_items_simulated_date_idx on news_items (simulated_date desc);
create index news_items_tickers_idx on news_items using gin (tickers);
create index news_items_sectors_idx on news_items using gin (sectors);

-- Tracks how far news-feed-tick has scanned the underlying event tables
-- (fed_meetings, economic_releases, company_events), plus a separate cursor
-- for pacing pure-noise headlines that aren't tied to any specific event.
create table news_feed_state (
  id smallint primary key default 1 check (id = 1),
  last_processed_at timestamptz not null,
  last_noise_at timestamptz not null
);

insert into news_feed_state (id, last_processed_at, last_noise_at)
select 1, ms.simulated_time, ms.simulated_time
from market_state ms
where ms.id = 1;

alter table news_items enable row level security;
alter table news_feed_state enable row level security;

create policy "news_items are publicly readable" on news_items for select using (true);
create policy "news_feed_state is publicly readable" on news_feed_state for select using (true);
