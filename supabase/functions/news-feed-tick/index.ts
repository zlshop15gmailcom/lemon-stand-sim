// Supabase Edge Function, invoked on its own cron (every 2 real minutes).
// Generates news_items from whatever new rows have appeared in fed_meetings,
// economic_releases, and company_events since the last run, plus a small
// trickle of pure-noise headlines unrelated to any specific event (per
// CLAUDE.md: "not every headline moves the market"). Reacts to events created
// by macro-tick and company-events-tick -- does not generate any price
// movement itself.

import { createClient } from 'jsr:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_SIM_DAYS_FOR_NOISE = 60;
const DAILY_NOISE_HEADLINE_RATE = 0.6;

// Sectors most affected by Fed/rate moves -- mirrors market-tick's
// SECTOR_SENSITIVITY map (kept as a smaller local copy since only the
// high-rate-sensitivity sectors matter for tagging headlines).
const RATE_SENSITIVE_SECTORS = ['financials', 'real_estate', 'utilities'];

const NOISE_HEADLINES = [
  'Trading volumes stay light as investors await fresh catalysts.',
  'Analysts describe the session as directionless amid mixed signals.',
  'Market breadth narrows as participants stay on the sidelines.',
  'Strategists see little conviction in either direction this week.',
  'Quiet trading session leaves major sectors little changed.',
  'Investors digest recent moves without a clear new theme emerging.',
];

interface Company {
  id: string;
  ticker: string;
  name: string;
  sector: string;
}

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

Deno.serve(async () => {
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const { data: marketState, error: marketStateError } = await supabase
    .from('market_state')
    .select('simulated_time')
    .eq('id', 1)
    .single();
  if (marketStateError || !marketState) {
    return new Response(JSON.stringify({ error: marketStateError?.message ?? 'market_state not found' }), { status: 500 });
  }
  const simulatedNow = new Date(marketState.simulated_time);

  const { data: feedState, error: feedStateError } = await supabase
    .from('news_feed_state')
    .select('last_processed_at, last_noise_at')
    .eq('id', 1)
    .single();
  if (feedStateError || !feedState) {
    return new Response(JSON.stringify({ error: feedStateError?.message ?? 'news_feed_state not found' }), { status: 500 });
  }

  const { data: companiesRaw, error: companiesError } = await supabase
    .from('companies')
    .select('id, ticker, name, sector');
  if (companiesError || !companiesRaw) {
    return new Response(JSON.stringify({ error: companiesError?.message ?? 'failed to load companies' }), { status: 500 });
  }
  const companyById = new Map((companiesRaw as Company[]).map((c) => [c.id, c]));

  const lastProcessedAt = new Date(feedState.last_processed_at);
  const newsRows: { headline: string; body: string; category: string; asset_class: string; sectors: string[]; tickers: string[]; source_event_type: string; simulated_date: string }[] = [];
  let latestSeenAt = lastProcessedAt;

  function noteSeen(date: string) {
    const d = new Date(date);
    if (d.getTime() > latestSeenAt.getTime()) latestSeenAt = d;
  }

  // --- Fed meetings ---
  const { data: fedMeetings, error: fedError } = await supabase
    .from('fed_meetings')
    .select('simulated_date, decision, basis_points, rate_before, rate_after, rationale')
    .gt('simulated_date', lastProcessedAt.toISOString())
    .order('simulated_date', { ascending: true })
    .limit(50);
  if (fedError) return new Response(JSON.stringify({ error: fedError.message }), { status: 500 });

  for (const meeting of fedMeetings ?? []) {
    noteSeen(meeting.simulated_date);
    const isHold = meeting.decision === 'hold';
    const headline = isHold
      ? `Fed holds rates steady at ${Number(meeting.rate_after).toFixed(2)}%`
      : `Fed ${meeting.decision === 'hike' ? 'hikes' : 'cuts'} rates ${meeting.basis_points}bps to ${Number(meeting.rate_after).toFixed(2)}%`;

    newsRows.push({
      headline,
      body: meeting.rationale ?? '',
      category: isHold ? 'noise' : 'market_moving',
      asset_class: 'macro',
      sectors: RATE_SENSITIVE_SECTORS,
      tickers: [],
      source_event_type: 'fed_meeting',
      simulated_date: meeting.simulated_date,
    });
  }

  // --- Economic releases (CPI, PCE, GDP, unemployment) ---
  const { data: releases, error: releasesError } = await supabase
    .from('economic_releases')
    .select('release_type, simulated_date, value, prior_value')
    .gt('simulated_date', lastProcessedAt.toISOString())
    .order('simulated_date', { ascending: true })
    .limit(50);
  if (releasesError) return new Response(JSON.stringify({ error: releasesError.message }), { status: 500 });

  const RELEASE_LABELS: Record<string, string> = { cpi: 'CPI inflation', pce: 'PCE inflation', gdp: 'GDP growth', unemployment: 'Unemployment' };
  for (const release of releases ?? []) {
    noteSeen(release.simulated_date);
    const label = RELEASE_LABELS[release.release_type] ?? release.release_type;
    const delta = release.prior_value != null ? Number(release.value) - Number(release.prior_value) : 0;
    const direction = delta > 0.05 ? 'rises' : delta < -0.05 ? 'falls' : 'holds steady';
    const isSignificant = Math.abs(delta) >= 0.3;

    newsRows.push({
      headline: `${label} ${direction} to ${Number(release.value).toFixed(1)}%`,
      body: release.prior_value != null ? `Prior reading was ${Number(release.prior_value).toFixed(1)}%.` : '',
      category: isSignificant ? 'market_moving' : 'noise',
      asset_class: 'macro',
      sectors: release.release_type === 'unemployment' || release.release_type === 'gdp' ? ['consumer_discretionary', 'industrials', 'financials'] : [],
      tickers: [],
      source_event_type: 'economic_release',
      simulated_date: release.simulated_date,
    });
  }

  // --- Company events ---
  const { data: companyEvents, error: companyEventsError } = await supabase
    .from('company_events')
    .select('event_type, company_id, related_company_id, simulated_date, price_impact, details')
    .gt('simulated_date', lastProcessedAt.toISOString())
    .order('simulated_date', { ascending: true })
    .limit(200);
  if (companyEventsError) return new Response(JSON.stringify({ error: companyEventsError.message }), { status: 500 });

  for (const event of companyEvents ?? []) {
    noteSeen(event.simulated_date);
    const company = companyById.get(event.company_id);
    if (!company) continue;
    const related = event.related_company_id ? companyById.get(event.related_company_id) : null;
    const impact = Number(event.price_impact ?? 0);
    const details = (event.details ?? {}) as Record<string, unknown>;

    let headline = '';
    let body = '';
    let category: 'market_moving' | 'noise' = Math.abs(impact) >= 0.03 ? 'market_moving' : 'noise';
    const tickers = [company.ticker];

    switch (event.event_type) {
      case 'earnings': {
        const surprise = Number(details.surprise_pct ?? 0);
        const verb = surprise > 1 ? 'tops' : surprise < -1 ? 'misses' : 'meets';
        headline = `${company.ticker} ${verb} earnings estimates, guidance ${details.guidance ?? 'maintained'}`;
        body = `EPS of ${details.eps_actual} vs. estimate of ${details.eps_estimate}.`;
        break;
      }
      case 'analyst_rating': {
        headline = `Analyst ${details.action === 'upgrade' ? 'upgrades' : 'downgrades'} ${company.ticker} to ${details.rating}, price target $${details.price_target}`;
        break;
      }
      case 'dividend': {
        headline = `${company.ticker} declares dividend of $${details.amount_per_share} per share`;
        category = 'noise';
        break;
      }
      case 'buyback': {
        headline = `${company.ticker} announces new share buyback program`;
        category = 'noise';
        break;
      }
      case 'split': {
        headline = `${company.ticker} announces ${details.ratio} stock split`;
        category = 'noise';
        break;
      }
      case 'merger': {
        headline = `${company.ticker} to acquire ${related?.ticker ?? 'target'} at ${details.premium_pct}% premium`;
        tickers.push(related?.ticker ?? '');
        category = 'market_moving';
        break;
      }
      case 'spinoff': {
        headline = `${company.ticker} announces spinoff of ${details.spinoff_ticker}`;
        if (related) tickers.push(related.ticker);
        category = 'market_moving';
        break;
      }
      case 'ipo': {
        headline = `${company.ticker} debuts on the market at $${details.offer_price}`;
        category = 'market_moving';
        break;
      }
      case 'scandal': {
        headline = `${company.ticker} shares crater amid corporate scandal`;
        body = String(details.note ?? '');
        category = 'market_moving';
        break;
      }
      default:
        continue;
    }

    newsRows.push({
      headline,
      body,
      category,
      asset_class: 'equity',
      sectors: [company.sector],
      tickers: tickers.filter(Boolean),
      source_event_type: event.event_type,
      simulated_date: event.simulated_date,
    });
  }

  // --- Pure noise headlines, paced by elapsed simulated days ---
  const lastNoiseAt = new Date(feedState.last_noise_at);
  const elapsedNoiseDays = Math.min(Math.floor((simulatedNow.getTime() - lastNoiseAt.getTime()) / DAY_MS), MAX_SIM_DAYS_FOR_NOISE);
  let noiseGenerated = 0;
  for (let day = 0; day < elapsedNoiseDays; day += 1) {
    if (Math.random() < DAILY_NOISE_HEADLINE_RATE) {
      const dayTimestamp = new Date(lastNoiseAt.getTime() + (day + 1) * DAY_MS);
      newsRows.push({
        headline: pick(NOISE_HEADLINES),
        body: '',
        category: 'noise',
        asset_class: 'macro',
        sectors: [],
        tickers: [],
        source_event_type: 'noise',
        simulated_date: dayTimestamp.toISOString(),
      });
      noiseGenerated += 1;
    }
  }
  const newLastNoiseAt = new Date(lastNoiseAt.getTime() + elapsedNoiseDays * DAY_MS);

  if (newsRows.length > 0) {
    const { error: insertError } = await supabase.from('news_items').insert(newsRows);
    if (insertError) return new Response(JSON.stringify({ error: insertError.message }), { status: 500 });
  }

  const { error: stateUpdateError } = await supabase
    .from('news_feed_state')
    .update({ last_processed_at: latestSeenAt.toISOString(), last_noise_at: newLastNoiseAt.toISOString() })
    .eq('id', 1);
  if (stateUpdateError) {
    return new Response(JSON.stringify({ error: stateUpdateError.message }), { status: 500 });
  }

  return new Response(
    JSON.stringify({
      fedHeadlines: (fedMeetings ?? []).length,
      releaseHeadlines: (releases ?? []).length,
      companyEventHeadlines: (companyEvents ?? []).length,
      noiseGenerated,
      totalHeadlinesCreated: newsRows.length,
    }),
    { status: 200 },
  );
});
