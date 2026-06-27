// Adds a pipeline of not-yet-listed companies that debut on a schedule,
// picked up by company-events-tick's IPO check. Run once: `npm run seed:ipo`.
// Safe to re-run -- upserts on ticker, and ticker generation checks against
// existing tickers already in the database so it won't collide with the
// main equity universe from seed-market.mjs.

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in environment.');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const TOTAL_PIPELINE_COMPANIES = 40;
const DAY_MS = 24 * 60 * 60 * 1000;

const SECTORS = [
  'technology', 'healthcare', 'energy', 'financials',
  'consumer_discretionary', 'consumer_staples', 'industrials',
  'utilities', 'real_estate', 'materials', 'communication_services',
];

// IPOs skew toward growth/speculative archetypes, same as real-world IPO
// cohorts tend to.
const ARCHETYPE_WEIGHTS = { growth: 0.45, speculative: 0.4, cyclical: 0.1, value: 0.05 };

const WORD_BANK = {
  technology: ['Nexsys', 'Quanta', 'Holocode', 'Driftwave', 'Synapse', 'Latticework'],
  healthcare: ['Cellora', 'Genovia', 'Pulseworks', 'Remedia', 'Helixion'],
  energy: ['Voltgrid', 'Solra', 'Brightfuel', 'Greenfield', 'Coreshaft'],
  financials: ['Ledgerly', 'Capital Crest', 'Anchorpoint', 'Wellspring'],
  consumer_discretionary: ['Cratebox', 'Urban Cart', 'Highline', 'Velour'],
  consumer_staples: ['Wholeroot', 'Sunfield', 'Greenpoint Foods'],
  industrials: ['Forgeline', 'Cogwright', 'Dynaforge'],
  utilities: ['Wattbridge', 'Lumen Utility', 'Aquaflow'],
  real_estate: ['Skyline Holdings', 'Brickrow', 'Parklane'],
  materials: ['Alloy Works', 'Quarrystone', 'Ferrum'],
  communication_services: ['Wavelink', 'Signalhouse', 'Broadcast Bay'],
};

const SUFFIXES = ['Corp', 'Holdings', 'Group', 'Inc', 'Co', 'Technologies', 'Labs'];

const ARCHETYPE_PROFILES = {
  value: {
    price: [20, 150], volatility: [0.008, 0.02], drift: [0.0001, 0.0004],
    eventProbability: [0.003, 0.01], meanReversion: [0.04, 0.12], momentum: [0, 0.05], beta: [0.7, 1.0],
  },
  cyclical: {
    price: [15, 120], volatility: [0.015, 0.035], drift: [-0.0001, 0.0005],
    eventProbability: [0.005, 0.015], meanReversion: [0.01, 0.04], momentum: [0.05, 0.15], beta: [1.0, 1.4],
  },
  growth: {
    price: [20, 200], volatility: [0.015, 0.03], drift: [0.0003, 0.0008],
    eventProbability: [0.005, 0.015], meanReversion: [0, 0.02], momentum: [0.1, 0.25], beta: [1.1, 1.5],
  },
  speculative: {
    price: [5, 50], volatility: [0.03, 0.06], drift: [-0.0002, 0.0006],
    eventProbability: [0.01, 0.03], meanReversion: [0, 0.01], momentum: [0.15, 0.3], beta: [1.3, 2.0],
  },
};

function randIn([min, max]) {
  return min + Math.random() * (max - min);
}

function pickWeighted(weights) {
  const r = Math.random();
  let cumulative = 0;
  for (const [key, weight] of Object.entries(weights)) {
    cumulative += weight;
    if (r <= cumulative) return key;
  }
  return Object.keys(weights)[0];
}

function tickerFromName(name, used) {
  const letters = name.replace(/[^A-Za-z]/g, '').toUpperCase();
  let base = letters.slice(0, 4) || 'XXXX';
  let ticker = base;
  let attempt = 0;
  while (used.has(ticker)) {
    attempt += 1;
    ticker = `${base.slice(0, 3)}${attempt}`;
  }
  used.add(ticker);
  return ticker;
}

async function main() {
  const { data: marketState, error: marketStateError } = await supabase
    .from('market_state')
    .select('simulated_time')
    .eq('id', 1)
    .single();

  if (marketStateError || !marketState) {
    console.error('Failed to load market_state:', marketStateError?.message);
    process.exit(1);
  }

  const { data: existing, error: existingError } = await supabase.from('companies').select('ticker');
  if (existingError) {
    console.error('Failed to load existing tickers:', existingError.message);
    process.exit(1);
  }

  const used = new Set(existing.map((c) => c.ticker));
  const simulatedNow = new Date(marketState.simulated_time);
  const pipeline = [];

  for (let i = 0; i < TOTAL_PIPELINE_COMPANIES; i += 1) {
    const sector = SECTORS[i % SECTORS.length];
    const archetype = pickWeighted(ARCHETYPE_WEIGHTS);
    const profile = ARCHETYPE_PROFILES[archetype];

    const words = WORD_BANK[sector];
    const word = words[Math.floor(Math.random() * words.length)];
    const suffix = SUFFIXES[Math.floor(Math.random() * SUFFIXES.length)];
    const name = `${word} ${suffix}`;
    const ticker = tickerFromName(`${word}${suffix}`, used);
    const startingPrice = Number(randIn(profile.price).toFixed(2));

    // Spread debuts over the next ~2 simulated years so IPOs trickle in
    // rather than all landing at once.
    const listedAt = new Date(simulatedNow.getTime() + randIn([10, 730]) * DAY_MS);

    pipeline.push({
      name,
      ticker,
      sector,
      archetype,
      current_price: startingPrice,
      anchor_price: startingPrice,
      last_return: 0,
      drift: randIn(profile.drift),
      volatility: randIn(profile.volatility),
      event_probability: randIn(profile.eventProbability),
      mean_reversion_strength: randIn(profile.meanReversion),
      momentum_strength: randIn(profile.momentum),
      beta: randIn(profile.beta),
      is_listed: false,
      listed_at: listedAt.toISOString(),
      next_earnings_at: new Date(listedAt.getTime() + 90 * DAY_MS).toISOString(),
      last_eps: Number((startingPrice / (10 + Math.random() * 20)).toFixed(2)),
      last_revenue: Math.round(startingPrice * (50 + Math.random() * 200) * 1_000_000),
    });
  }

  const { error } = await supabase.from('companies').upsert(pipeline, { onConflict: 'ticker' });
  if (error) {
    console.error('Failed to seed IPO pipeline:', error.message);
    process.exit(1);
  }

  console.log(`Done. Seeded ${pipeline.length} pending IPO companies.`);
}

main();
