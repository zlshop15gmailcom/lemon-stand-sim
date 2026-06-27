// Procedurally generates the fake equity universe and seeds it into Supabase.
// Run once per environment: `npm run seed`. Re-running is safe -- it upserts on ticker.

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in environment.');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const TOTAL_COMPANIES = 520;

const SECTORS = [
  'technology', 'healthcare', 'energy', 'financials',
  'consumer_discretionary', 'consumer_staples', 'industrials',
  'utilities', 'real_estate', 'materials', 'communication_services',
];

// Roughly mirrors a real market: lots of value/blue-chip/cyclical, a meaningful
// speculative/growth tail, and a smaller penny-stock fringe.
const ARCHETYPE_WEIGHTS = {
  blue_chip: 0.15,
  value: 0.18,
  cyclical: 0.17,
  growth: 0.2,
  speculative: 0.2,
  penny_stock: 0.1,
};

const WORD_BANK = {
  technology: ['Vertex', 'Nimbus', 'Quanta', 'Circuit', 'Pixel', 'Cipher', 'Datawave', 'Synapse'],
  healthcare: ['Vitalis', 'Cura', 'Genome', 'Pulse', 'Remedia', 'Helix', 'Sana', 'Meridian'],
  energy: ['Voltaic', 'Crude Peak', 'Solra', 'Fusion Point', 'Greenfield', 'Pioneer Fuel', 'Coreshaft'],
  financials: ['Ledger', 'Sterling Trust', 'Capital Crest', 'Anchor', 'Beacon Hill', 'Wellspring'],
  consumer_discretionary: ['Crate', 'Lemon Stand', 'Urban Cart', 'Highline', 'Bramble', 'Velour'],
  consumer_staples: ['Harvest Co', 'Pantry', 'Wholeroot', 'Sunfield', 'Daily Mill', 'Greenpoint'],
  industrials: ['Ironclad', 'Forge', 'Cogwright', 'Trestle', 'Anvil Works', 'Dynaforge'],
  utilities: ['Gridstone', 'Wattbridge', 'Steady Power', 'Lumen Utility', 'Aquaflow'],
  real_estate: ['Cornerstone', 'Skyline Holdings', 'Brickrow', 'Parklane', 'Summit Realty'],
  materials: ['Granite Point', 'Alloy Works', 'Bedrock', 'Quarrystone', 'Ferrum'],
  communication_services: ['Wavelink', 'Echo Network', 'Pinnacle Media', 'Signalhouse', 'Broadcast Bay'],
};

const SUFFIXES = ['Corp', 'Holdings', 'Group', 'Inc', 'Co', 'Industries', 'Partners'];

// Archetype -> [min, max] ranges for each parameter.
const ARCHETYPE_PROFILES = {
  blue_chip: {
    price: [50, 500], volatility: [0.005, 0.015], drift: [0.0001, 0.0003],
    eventProbability: [0.002, 0.008], meanReversion: [0.05, 0.15], momentum: [0, 0.05], beta: [0.8, 1.1],
  },
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
  penny_stock: {
    price: [0.5, 5], volatility: [0.05, 0.12], drift: [-0.0005, 0.001],
    eventProbability: [0.02, 0.05], meanReversion: [0, 0], momentum: [0.2, 0.4], beta: [1.5, 2.5],
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

function generateCompanies(count) {
  const used = new Set();
  const companies = [];

  for (let i = 0; i < count; i += 1) {
    const sector = SECTORS[i % SECTORS.length];
    const archetype = pickWeighted(ARCHETYPE_WEIGHTS);
    const profile = ARCHETYPE_PROFILES[archetype];

    const words = WORD_BANK[sector];
    const word = words[Math.floor(Math.random() * words.length)];
    const suffix = SUFFIXES[Math.floor(Math.random() * SUFFIXES.length)];
    const name = `${word} ${suffix}`;
    const ticker = tickerFromName(`${word}${suffix}`, used);
    const startingPrice = Number(randIn(profile.price).toFixed(2));

    companies.push({
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
    });
  }

  return companies;
}

async function main() {
  const companies = generateCompanies(TOTAL_COMPANIES);

  const batchSize = 100;
  for (let i = 0; i < companies.length; i += batchSize) {
    const batch = companies.slice(i, i + batchSize);
    const { error } = await supabase.from('companies').upsert(batch, { onConflict: 'ticker' });
    if (error) {
      console.error('Failed to seed batch starting at', i, error);
      process.exit(1);
    }
    console.log(`Seeded companies ${i + 1}-${i + batch.length} of ${companies.length}`);
  }

  console.log(`Done. Seeded ${companies.length} companies.`);
}

main();
