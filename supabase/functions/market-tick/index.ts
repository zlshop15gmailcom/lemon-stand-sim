// Supabase Edge Function, invoked on a fixed wall-clock cron (e.g. every 30-60s).
// It advances the simulated market clock by however many simulated minutes are
// owed given the user-controlled time_multiplier, and runs one price step per
// simulated minute for every company.
//
// Phase 1 scope: equities only, core price model (GBM + mean reversion +
// momentum + sector/market correlated shocks + archetype-driven idiosyncratic
// events). Other asset classes and news generation are later phases.
//
// Phase 2 addition: reads macro_state (set by the separate macro-tick
// function) once per invocation and applies a small sector-sensitivity tilt
// on top of the existing per-company math -- the cycle phase and Fed funds
// rate nudge each company's return, scaled by its sector's sensitivity and
// its own beta, the same way the market-wide shock already uses beta.

import { createClient } from 'jsr:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

// Bounds how much work a single invocation does. If the user fast-forwards to a
// huge multiplier, we process this many simulated minutes now and pick up the
// remainder on the next cron firing rather than blocking on one giant batch.
const MAX_TICKS_PER_RUN = 100;

const SECTORS = [
  'technology', 'healthcare', 'energy', 'financials',
  'consumer_discretionary', 'consumer_staples', 'industrials',
  'utilities', 'real_estate', 'materials', 'communication_services',
] as const;

// Small per-tick bias applied market-wide depending on the macro cycle phase,
// before being scaled by each sector's cyclical sensitivity and the
// company's own beta. Magnitudes are deliberately small relative to a
// company's own volatility-driven shock -- this is a lean, not an override.
const CYCLE_PHASE_BIAS: Record<string, number> = {
  expansion: 0.0003,
  peak: 0.0001,
  recession: -0.0004,
  trough: -0.0002,
};

// Treated as the "neutral" Fed funds rate for rate-tilt purposes -- above
// this, rate-sensitive sectors lean negative; below it, they lean positive.
const NEUTRAL_FED_RATE = 2.5;

// How strongly each sector amplifies/dampens the cycle-phase tilt and the
// Fed-rate tilt. Cyclical sectors swing more with the economy; rate-sensitive
// sectors (financials, real estate, utilities) react more to rate changes.
// This is a simplification -- in reality financials can benefit from higher
// rates via net interest margin, but treating all rate-sensitive sectors
// uniformly is a reasonable v1 approximation.
const SECTOR_SENSITIVITY: Record<string, { cyclical: number; rate: number }> = {
  technology: { cyclical: 1.0, rate: 0.4 },
  healthcare: { cyclical: 0.3, rate: 0.2 },
  energy: { cyclical: 0.8, rate: 0.2 },
  financials: { cyclical: 0.9, rate: 1.0 },
  consumer_discretionary: { cyclical: 1.1, rate: 0.6 },
  consumer_staples: { cyclical: 0.2, rate: 0.2 },
  industrials: { cyclical: 1.0, rate: 0.5 },
  utilities: { cyclical: 0.2, rate: 0.9 },
  real_estate: { cyclical: 0.7, rate: 1.0 },
  materials: { cyclical: 0.9, rate: 0.4 },
  communication_services: { cyclical: 0.6, rate: 0.3 },
};

interface Company {
  id: string;
  sector: string;
  archetype: string;
  current_price: number;
  drift: number;
  volatility: number;
  event_probability: number;
  mean_reversion_strength: number;
  momentum_strength: number;
  beta: number;
  anchor_price: number;
  last_return: number;
}

function randNormal(): number {
  // Box-Muller transform.
  const u1 = Math.random() || Number.MIN_VALUE;
  const u2 = Math.random();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

Deno.serve(async () => {
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const { data: state, error: stateError } = await supabase
    .from('market_state')
    .select('*')
    .eq('id', 1)
    .single();

  if (stateError || !state) {
    return new Response(JSON.stringify({ error: stateError?.message ?? 'market_state not found' }), { status: 500 });
  }

  if (!state.is_running) {
    return new Response(JSON.stringify({ skipped: true, reason: 'market is paused' }), { status: 200 });
  }

  const now = new Date();
  const lastTickAt = new Date(state.last_tick_at);
  const realElapsedMs = now.getTime() - lastTickAt.getTime();
  const realElapsedMinutes = realElapsedMs / 60_000;
  const simulatedMinutesOwed = realElapsedMinutes * Number(state.time_multiplier);
  const ticksToRun = Math.min(Math.floor(simulatedMinutesOwed), MAX_TICKS_PER_RUN);

  if (ticksToRun <= 0) {
    return new Response(JSON.stringify({ skipped: true, reason: 'no simulated time owed yet' }), { status: 200 });
  }

  const { data: companies, error: companiesError } = await supabase
    .from('companies')
    .select('id, sector, archetype, current_price, drift, volatility, event_probability, mean_reversion_strength, momentum_strength, beta, anchor_price, last_return');

  if (companiesError || !companies) {
    return new Response(JSON.stringify({ error: companiesError?.message ?? 'failed to load companies' }), { status: 500 });
  }

  const { data: macro, error: macroError } = await supabase
    .from('macro_state')
    .select('cycle_phase, fed_funds_rate')
    .eq('id', 1)
    .single();

  if (macroError || !macro) {
    return new Response(JSON.stringify({ error: macroError?.message ?? 'macro_state not found' }), { status: 500 });
  }

  // Computed once per invocation -- macro_state only changes via the
  // separate macro-tick function, never within this run.
  const cyclePhaseBias = CYCLE_PHASE_BIAS[macro.cycle_phase] ?? 0;
  const rateGapFromNeutral = NEUTRAL_FED_RATE - Number(macro.fed_funds_rate);

  const liveCompanies = companies as Company[];
  let simulatedTime = new Date(state.simulated_time);

  const priceHistoryRows: { company_id: string; simulated_timestamp: string; price: number }[] = [];
  const eventRows: { company_id: string; event_type: string; description: string; impact: number; simulated_timestamp: string }[] = [];
  const companyUpdates = new Map<string, { current_price: number; last_return: number }>();

  for (let tick = 0; tick < ticksToRun; tick += 1) {
    simulatedTime = new Date(simulatedTime.getTime() + 60_000);
    const simulatedTimestamp = simulatedTime.toISOString();

    const marketShock = randNormal();
    const sectorShocks = new Map(SECTORS.map((sector) => [sector, randNormal()]));

    for (const company of liveCompanies) {
      const latest = companyUpdates.get(company.id);
      const currentPrice = latest ? latest.current_price : company.current_price;
      const lastReturn = latest ? latest.last_return : company.last_return;

      const idiosyncraticShock = randNormal();
      const sectorShock = sectorShocks.get(company.sector) ?? 0;

      const correlatedShock = company.volatility *
        (0.5 * company.beta * marketShock + 0.3 * sectorShock + 0.2 * idiosyncraticShock);

      const reversionTerm = company.mean_reversion_strength *
        ((company.anchor_price - currentPrice) / company.anchor_price);

      const momentumTerm = company.momentum_strength * lastReturn;

      const sensitivity = SECTOR_SENSITIVITY[company.sector] ?? { cyclical: 0.5, rate: 0.5 };
      const cycleTilt = cyclePhaseBias * sensitivity.cyclical * company.beta;
      const rateTilt = rateGapFromNeutral * 0.0002 * sensitivity.rate * company.beta;

      let stepReturn = company.drift + correlatedShock + reversionTerm + momentumTerm + cycleTilt + rateTilt;

      let eventImpact = 0;
      if (Math.random() < company.event_probability) {
        const direction = Math.random() < 0.5 ? -1 : 1;
        eventImpact = direction * company.volatility * (5 + Math.random() * 5);
        stepReturn += eventImpact;
        eventRows.push({
          company_id: company.id,
          event_type: eventImpact > 0 ? 'positive_shock' : 'negative_shock',
          description: eventImpact > 0
            ? 'Unexpected positive development moves the price sharply higher.'
            : 'Unexpected negative development moves the price sharply lower.',
          impact: eventImpact,
          simulated_timestamp: simulatedTimestamp,
        });
      }

      const newPrice = Math.max(0.01, currentPrice * (1 + stepReturn));

      priceHistoryRows.push({
        company_id: company.id,
        simulated_timestamp: simulatedTimestamp,
        price: Number(newPrice.toFixed(4)),
      });

      companyUpdates.set(company.id, { current_price: newPrice, last_return: stepReturn });
    }
  }

  const { error: insertHistoryError } = await supabase.from('price_history').insert(priceHistoryRows);
  if (insertHistoryError) {
    return new Response(JSON.stringify({ error: insertHistoryError.message }), { status: 500 });
  }

  if (eventRows.length > 0) {
    const { error: insertEventsError } = await supabase.from('market_events').insert(eventRows);
    if (insertEventsError) {
      return new Response(JSON.stringify({ error: insertEventsError.message }), { status: 500 });
    }
  }

  const companyUpdatePromises = Array.from(companyUpdates.entries()).map(([id, update]) =>
    supabase
      .from('companies')
      .update({ current_price: Number(update.current_price.toFixed(4)), last_return: update.last_return })
      .eq('id', id)
  );
  await Promise.all(companyUpdatePromises);

  const realMinutesConsumed = ticksToRun / Number(state.time_multiplier);
  const newLastTickAt = new Date(lastTickAt.getTime() + realMinutesConsumed * 60_000);

  const { error: updateStateError } = await supabase
    .from('market_state')
    .update({
      simulated_time: simulatedTime.toISOString(),
      last_tick_at: newLastTickAt.toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', 1);

  if (updateStateError) {
    return new Response(JSON.stringify({ error: updateStateError.message }), { status: 500 });
  }

  return new Response(
    JSON.stringify({
      ticksRun: ticksToRun,
      companiesUpdated: companyUpdates.size,
      eventsGenerated: eventRows.length,
      simulatedTime: simulatedTime.toISOString(),
    }),
    { status: 200 },
  );
});
