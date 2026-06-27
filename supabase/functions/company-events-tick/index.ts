// Supabase Edge Function, invoked on its own cron (every 2 real minutes).
// Like macro-tick, this reacts to wherever market_state.simulated_time
// already is rather than owning its own clock.
//
// Two categories of event:
//  1. Scheduled, per-company (earnings, IPOs) -- driven by absolute
//     next_*_at columns on `companies`, same pattern as macro-tick's Fed
//     meetings.
//  2. Probabilistic (analyst ratings, dividends, buybacks, splits, M&A,
//     spinoffs, scandals) -- stepped through one simulated day at a time
//     since company_events_state.last_processed_at, with a daily Bernoulli
//     roll per company per event type, so the *rate* of these events tracks
//     simulated time (and therefore the user's time multiplier) rather than
//     wall-clock cron frequency.
//
// Price impacts are applied directly to companies.current_price (with a
// price_history row inserted for chart continuity) rather than routed through
// market-tick -- these are discrete jumps tied to a specific narrative event,
// not part of the continuous stochastic process market-tick already owns.

import { createClient } from 'jsr:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_SIM_DAYS_PER_RUN = 60;
const MAX_EARNINGS_PER_RUN = 300;
const MAX_IPOS_PER_RUN = 50;

// Daily probability a given listed company experiences each event type.
// Deliberately small -- these are flavor events layered on top of the
// continuous price process, not the dominant source of price movement.
const DAILY_RATES = {
  analystRating: 0.01,
  dividend: 0.002,
  buyback: 0.0015,
  split: 0.0004,
  scandal: 0.0003,
};

// Universe-wide (not per-company) daily probability of one M&A or spinoff
// event happening somewhere in the market.
const DAILY_MERGER_PROBABILITY = 0.05;
const DAILY_SPINOFF_PROBABILITY = 0.02;

const SPECULATIVE_PROFILE = {
  drift: [-0.0002, 0.0006], volatility: [0.03, 0.06], eventProbability: [0.01, 0.03],
  meanReversion: [0, 0.01], momentum: [0.15, 0.3], beta: [1.3, 2.0],
};

function randNormal(): number {
  const u1 = Math.random() || Number.MIN_VALUE;
  const u2 = Math.random();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

function randIn([min, max]: [number, number]): number {
  return min + Math.random() * (max - min);
}

interface Company {
  id: string;
  ticker: string;
  name: string;
  sector: string;
  archetype: string;
  current_price: number;
  anchor_price: number;
  volatility: number;
  beta: number;
  drift: number;
  mean_reversion_strength: number;
  momentum_strength: number;
  event_probability: number;
  last_return: number;
  is_listed: boolean;
  listed_at: string | null;
  next_earnings_at: string | null;
  last_eps: number | null;
  last_revenue: number | null;
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

  const { data: eventsState, error: eventsStateError } = await supabase
    .from('company_events_state')
    .select('last_processed_at')
    .eq('id', 1)
    .single();
  if (eventsStateError || !eventsState) {
    return new Response(JSON.stringify({ error: eventsStateError?.message ?? 'company_events_state not found' }), { status: 500 });
  }

  const { data: companiesRaw, error: companiesError } = await supabase
    .from('companies')
    .select('id, ticker, name, sector, archetype, current_price, anchor_price, volatility, beta, drift, mean_reversion_strength, momentum_strength, event_probability, last_return, is_listed, listed_at, next_earnings_at, last_eps, last_revenue');
  if (companiesError || !companiesRaw) {
    return new Response(JSON.stringify({ error: companiesError?.message ?? 'failed to load companies' }), { status: 500 });
  }

  const companies = companiesRaw as Company[];
  const byId = new Map(companies.map((c) => [c.id, c]));

  // Accumulators -- written out in one batch at the end.
  const priceOverrides = new Map<string, number>();
  const earningsUpdates = new Map<string, { last_eps: number; last_revenue: number; next_earnings_at: string }>();
  const delistedIds = new Set<string>();
  const newCompanies: Record<string, unknown>[] = [];
  const eventRows: { event_type: string; company_id: string; related_company_id: string | null; simulated_date: string; price_impact: number; details: Record<string, unknown> }[] = [];
  const priceHistoryRows: { company_id: string; simulated_timestamp: string; price: number }[] = [];

  function currentPrice(id: string): number {
    return priceOverrides.get(id) ?? byId.get(id)!.current_price;
  }

  function applyImpact(id: string, impact: number, at: Date) {
    const newPrice = Math.max(0.01, currentPrice(id) * (1 + impact));
    priceOverrides.set(id, newPrice);
    priceHistoryRows.push({ company_id: id, simulated_timestamp: at.toISOString(), price: Number(newPrice.toFixed(4)) });
  }

  // --- 1. Earnings: scheduled per-company ---
  let earningsProcessed = 0;
  for (const company of companies) {
    if (!company.is_listed || !company.next_earnings_at) continue;
    let nextEarningsAt = new Date(company.next_earnings_at);
    let lastEps = Number(company.last_eps ?? 1);
    let lastRevenue = Number(company.last_revenue ?? 100_000_000);
    let iterations = 0;

    while (nextEarningsAt.getTime() <= simulatedNow.getTime() && earningsProcessed < MAX_EARNINGS_PER_RUN && iterations < 4) {
      const surprisePct = randNormal() * company.volatility * 4;
      const epsEstimate = Number((lastEps * (1 + randIn([0.01, 0.04]))).toFixed(2));
      const epsActual = Number((epsEstimate * (1 + surprisePct)).toFixed(2));
      const revenueEstimate = Math.round(lastRevenue * (1 + randIn([0.005, 0.03])));
      const revenueActual = Math.round(revenueEstimate * (1 + surprisePct * 0.6));
      const priceImpact = Math.max(-0.25, Math.min(0.25, surprisePct * 0.6));
      const guidance = surprisePct > 0.05 ? 'raised' : surprisePct < -0.05 ? 'lowered' : 'maintained';

      applyImpact(company.id, priceImpact, nextEarningsAt);
      eventRows.push({
        event_type: 'earnings',
        company_id: company.id,
        related_company_id: null,
        simulated_date: nextEarningsAt.toISOString(),
        price_impact: priceImpact,
        details: { eps_actual: epsActual, eps_estimate: epsEstimate, revenue_actual: revenueActual, revenue_estimate: revenueEstimate, surprise_pct: Number((surprisePct * 100).toFixed(2)), guidance },
      });

      lastEps = epsActual;
      lastRevenue = revenueActual;
      nextEarningsAt = new Date(nextEarningsAt.getTime() + 90 * DAY_MS);
      earningsProcessed += 1;
      iterations += 1;
    }

    if (iterations > 0) {
      earningsUpdates.set(company.id, { last_eps: lastEps, last_revenue: lastRevenue, next_earnings_at: nextEarningsAt.toISOString() });
    }
  }

  // --- 2. IPOs: scheduled, from the unlisted pipeline ---
  let iposProcessed = 0;
  for (const company of companies) {
    if (company.is_listed || !company.listed_at) continue;
    if (new Date(company.listed_at).getTime() > simulatedNow.getTime()) continue;
    if (iposProcessed >= MAX_IPOS_PER_RUN) break;

    priceOverrides.set(company.id, company.anchor_price);
    priceHistoryRows.push({ company_id: company.id, simulated_timestamp: company.listed_at, price: Number(company.anchor_price.toFixed(4)) });
    eventRows.push({
      event_type: 'ipo',
      company_id: company.id,
      related_company_id: null,
      simulated_date: company.listed_at,
      price_impact: 0,
      details: { offer_price: company.anchor_price, ticker: company.ticker },
    });
    iposProcessed += 1;
  }
  const newlyListedIds = new Set(
    companies.filter((c) => !c.is_listed && c.listed_at && new Date(c.listed_at).getTime() <= simulatedNow.getTime()).slice(0, MAX_IPOS_PER_RUN).map((c) => c.id),
  );

  // --- 3. Probabilistic events: day-stepped since last_processed_at ---
  const lastProcessedAt = new Date(eventsState.last_processed_at);
  const elapsedDays = Math.min(
    Math.floor((simulatedNow.getTime() - lastProcessedAt.getTime()) / DAY_MS),
    MAX_SIM_DAYS_PER_RUN,
  );

  let analystRatingsCount = 0;
  let dividendsCount = 0;
  let buybacksCount = 0;
  let splitsCount = 0;
  let scandalsCount = 0;
  let mergersCount = 0;
  let spinoffsCount = 0;

  for (let day = 0; day < elapsedDays; day += 1) {
    const dayTimestamp = new Date(lastProcessedAt.getTime() + (day + 1) * DAY_MS);

    for (const company of companies) {
      if (!company.is_listed || delistedIds.has(company.id) || newlyListedIds.has(company.id)) continue;

      if (Math.random() < DAILY_RATES.analystRating) {
        const isUpgrade = Math.random() < 0.5;
        const rating = isUpgrade ? (Math.random() < 0.5 ? 'buy' : 'hold') : (Math.random() < 0.5 ? 'hold' : 'sell');
        const targetMove = isUpgrade ? randIn([0.05, 0.25]) : -randIn([0.05, 0.25]);
        const priceTarget = Number((currentPrice(company.id) * (1 + targetMove)).toFixed(2));
        const priceImpact = isUpgrade ? randIn([0.005, 0.02]) : -randIn([0.005, 0.02]);
        applyImpact(company.id, priceImpact, dayTimestamp);
        eventRows.push({
          event_type: 'analyst_rating',
          company_id: company.id,
          related_company_id: null,
          simulated_date: dayTimestamp.toISOString(),
          price_impact: priceImpact,
          details: { action: isUpgrade ? 'upgrade' : 'downgrade', rating, price_target: priceTarget },
        });
        analystRatingsCount += 1;
      }

      const paysDividends = company.archetype === 'blue_chip' || company.archetype === 'value';
      if (paysDividends && Math.random() < DAILY_RATES.dividend) {
        const yieldPct = randIn([0.001, 0.004]);
        const amount = Number((currentPrice(company.id) * yieldPct).toFixed(2));
        applyImpact(company.id, -yieldPct, dayTimestamp);
        eventRows.push({
          event_type: 'dividend',
          company_id: company.id,
          related_company_id: null,
          simulated_date: dayTimestamp.toISOString(),
          price_impact: -yieldPct,
          details: { amount_per_share: amount, yield_pct: Number((yieldPct * 100).toFixed(3)) },
        });
        dividendsCount += 1;
      }

      const doesBuybacks = company.archetype === 'blue_chip' || company.archetype === 'value' || company.archetype === 'growth';
      if (doesBuybacks && Math.random() < DAILY_RATES.buyback) {
        const priceImpact = randIn([0.005, 0.02]);
        applyImpact(company.id, priceImpact, dayTimestamp);
        eventRows.push({
          event_type: 'buyback',
          company_id: company.id,
          related_company_id: null,
          simulated_date: dayTimestamp.toISOString(),
          price_impact: priceImpact,
          details: { note: 'Board authorizes a new share repurchase program.' },
        });
        buybacksCount += 1;
      }

      if (currentPrice(company.id) > 150 && Math.random() < DAILY_RATES.split) {
        const ratio = Math.random() < 0.7 ? 2 : 3;
        const newPrice = currentPrice(company.id) / ratio;
        priceOverrides.set(company.id, newPrice);
        priceHistoryRows.push({ company_id: company.id, simulated_timestamp: dayTimestamp.toISOString(), price: Number(newPrice.toFixed(4)) });
        eventRows.push({
          event_type: 'split',
          company_id: company.id,
          related_company_id: null,
          simulated_date: dayTimestamp.toISOString(),
          price_impact: 0,
          details: { ratio: `${ratio}-for-1` },
        });
        splitsCount += 1;
      }

      if (Math.random() < DAILY_RATES.scandal) {
        const priceImpact = -randIn([0.15, 0.4]);
        applyImpact(company.id, priceImpact, dayTimestamp);
        eventRows.push({
          event_type: 'scandal',
          company_id: company.id,
          related_company_id: null,
          simulated_date: dayTimestamp.toISOString(),
          price_impact: priceImpact,
          details: { note: 'An internal investigation uncovers irregularities, prompting a restatement.' },
        });
        scandalsCount += 1;
      }
    }

    // Universe-wide M&A: one roll per simulated day, not per company.
    if (Math.random() < DAILY_MERGER_PROBABILITY) {
      const candidates = companies.filter((c) => c.is_listed && !delistedIds.has(c.id) && !newlyListedIds.has(c.id));
      if (candidates.length >= 2) {
        const targetPool = candidates.filter((c) => c.archetype === 'speculative' || c.archetype === 'penny_stock' || c.archetype === 'growth');
        const target = (targetPool.length > 0 ? targetPool : candidates)[Math.floor(Math.random() * (targetPool.length > 0 ? targetPool.length : candidates.length))];
        const acquirerPool = candidates.filter((c) => c.id !== target.id);
        const acquirer = acquirerPool[Math.floor(Math.random() * acquirerPool.length)];

        const premium = randIn([0.15, 0.5]);
        applyImpact(target.id, premium, dayTimestamp);
        applyImpact(acquirer.id, randIn([-0.01, 0.03]), dayTimestamp);
        delistedIds.add(target.id);

        eventRows.push({
          event_type: 'merger',
          company_id: acquirer.id,
          related_company_id: target.id,
          simulated_date: dayTimestamp.toISOString(),
          price_impact: premium,
          details: { acquirer_ticker: acquirer.ticker, target_ticker: target.ticker, premium_pct: Number((premium * 100).toFixed(1)) },
        });
        mergersCount += 1;
      }
    }

    // Universe-wide spinoff.
    if (Math.random() < DAILY_SPINOFF_PROBABILITY) {
      const candidates = companies.filter((c) => c.is_listed && !delistedIds.has(c.id) && !newlyListedIds.has(c.id) && (c.archetype === 'blue_chip' || c.archetype === 'cyclical'));
      if (candidates.length > 0) {
        const parent = candidates[Math.floor(Math.random() * candidates.length)];
        const spinoffPrice = Number((currentPrice(parent.id) * randIn([0.1, 0.3])).toFixed(2));
        const newId = crypto.randomUUID();
        const newTicker = `${parent.ticker.slice(0, 3)}${Math.floor(Math.random() * 90 + 10)}`;

        newCompanies.push({
          id: newId,
          name: `${parent.name.split(' ')[0]} Spinoff Holdings`,
          ticker: newTicker,
          sector: parent.sector,
          archetype: 'speculative',
          current_price: spinoffPrice,
          anchor_price: spinoffPrice,
          last_return: 0,
          drift: randIn(SPECULATIVE_PROFILE.drift as [number, number]),
          volatility: randIn(SPECULATIVE_PROFILE.volatility as [number, number]),
          event_probability: randIn(SPECULATIVE_PROFILE.eventProbability as [number, number]),
          mean_reversion_strength: randIn(SPECULATIVE_PROFILE.meanReversion as [number, number]),
          momentum_strength: randIn(SPECULATIVE_PROFILE.momentum as [number, number]),
          beta: randIn(SPECULATIVE_PROFILE.beta as [number, number]),
          is_listed: true,
          listed_at: dayTimestamp.toISOString(),
          next_earnings_at: new Date(dayTimestamp.getTime() + 90 * DAY_MS).toISOString(),
          last_eps: Number((spinoffPrice / 20).toFixed(2)),
          last_revenue: Math.round(spinoffPrice * 60 * 1_000_000),
        });
        priceHistoryRows.push({ company_id: newId, simulated_timestamp: dayTimestamp.toISOString(), price: spinoffPrice });

        applyImpact(parent.id, -randIn([0.02, 0.05]), dayTimestamp);
        eventRows.push({
          event_type: 'spinoff',
          company_id: parent.id,
          related_company_id: newId,
          simulated_date: dayTimestamp.toISOString(),
          price_impact: 0,
          details: { parent_ticker: parent.ticker, spinoff_ticker: newTicker, spinoff_offer_price: spinoffPrice },
        });
        spinoffsCount += 1;
      }
    }
  }

  // --- Write everything out ---
  if (newCompanies.length > 0) {
    const { error } = await supabase.from('companies').insert(newCompanies);
    if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  }

  if (priceHistoryRows.length > 0) {
    const { error } = await supabase.from('price_history').insert(priceHistoryRows);
    if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  }

  if (eventRows.length > 0) {
    const { error } = await supabase.from('company_events').insert(eventRows);
    if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  }

  // Merge all per-company changes into one row per id, then write everything
  // in a single bulk_update_companies call -- separate per-company HTTP
  // requests is exactly what blew market-tick's resource limit at high time
  // multipliers (see migration 20260701100000), so this function never did
  // that in the first place for its own update path either.
  const finalUpdates = new Map<string, Record<string, unknown>>();

  function mergeUpdate(id: string, fields: Record<string, unknown>) {
    finalUpdates.set(id, { ...(finalUpdates.get(id) ?? {}), ...fields });
  }

  for (const [id, price] of priceOverrides.entries()) {
    if (delistedIds.has(id)) continue;
    mergeUpdate(id, { current_price: Number(price.toFixed(4)) });
  }
  for (const id of newlyListedIds) {
    mergeUpdate(id, { is_listed: true, current_price: priceOverrides.get(id) ?? byId.get(id)!.anchor_price });
  }
  for (const id of delistedIds) {
    mergeUpdate(id, { is_listed: false, current_price: priceOverrides.get(id) ?? byId.get(id)!.current_price });
  }
  for (const [id, update] of earningsUpdates.entries()) {
    mergeUpdate(id, update);
  }

  if (finalUpdates.size > 0) {
    const payload = Array.from(finalUpdates.entries()).map(([id, fields]) => ({ id, ...fields }));
    const { error: bulkUpdateError } = await supabase.rpc('bulk_update_companies', { updates: payload });
    if (bulkUpdateError) {
      return new Response(JSON.stringify({ error: bulkUpdateError.message }), { status: 500 });
    }
  }

  const newLastProcessedAt = new Date(lastProcessedAt.getTime() + elapsedDays * DAY_MS);
  const { error: stateUpdateError } = await supabase
    .from('company_events_state')
    .update({ last_processed_at: newLastProcessedAt.toISOString() })
    .eq('id', 1);
  if (stateUpdateError) {
    return new Response(JSON.stringify({ error: stateUpdateError.message }), { status: 500 });
  }

  return new Response(
    JSON.stringify({
      earningsProcessed,
      iposProcessed,
      elapsedSimulatedDays: elapsedDays,
      analystRatingsCount,
      dividendsCount,
      buybacksCount,
      splitsCount,
      scandalsCount,
      mergersCount,
      spinoffsCount,
      newCompaniesCreated: newCompanies.length,
    }),
    { status: 200 },
  );
});
