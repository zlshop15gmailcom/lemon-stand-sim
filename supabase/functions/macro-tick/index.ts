// Supabase Edge Function, invoked on its own slower wall-clock cron (every 5
// real minutes). Unlike market-tick, this function does not own a tick loop --
// it reacts to wherever market_state.simulated_time already is (the price
// engine owns the clock) and processes whatever macro events have come due
// since the last time it ran: phase transitions, Fed meetings, monthly/
// quarterly economic releases, and yield curve refreshes.
//
// Phase 2 scope: macro state only. This does not yet feed into market-tick's
// price math -- wiring sector rotation/macro tilt into the price engine is a
// separate follow-up step.

import { createClient } from 'jsr:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

// Safety caps, same purpose as market-tick's MAX_TICKS_PER_RUN: if simulated
// time has jumped a long way (e.g. the user left a high time multiplier
// running for a while in real time), don't process an unbounded number of
// events in one invocation.
const MAX_PHASE_TRANSITIONS_PER_RUN = 12;
const MAX_FED_MEETINGS_PER_RUN = 12;
const MAX_RELEASES_PER_SERIES_PER_RUN = 12;

const DAY_MS = 24 * 60 * 60 * 1000;

const FED_RATE_FLOOR = 0.25;
const FED_RATE_CEILING = 20;

const PHASE_SEQUENCE = ['expansion', 'peak', 'recession', 'trough'] as const;
type Phase = (typeof PHASE_SEQUENCE)[number];

// Randomized duration ranges, in simulated days, drawn fresh each time a
// phase begins.
const PHASE_DURATION_DAYS: Record<Phase, [number, number]> = {
  expansion: [120, 270],
  peak: [20, 60],
  recession: [60, 150],
  trough: [20, 50],
};

// Rough targets each series drifts toward while in a given phase. Actual
// values are blended gradually toward these, not snapped, so series don't
// look mechanically robotic.
const PHASE_TARGETS: Record<Phase, { inflation: number; pce: number; gdp: number; unemployment: number }> = {
  expansion: { inflation: 2.5, pce: 2.3, gdp: 2.8, unemployment: 4.0 },
  peak: { inflation: 4.0, pce: 3.6, gdp: 1.8, unemployment: 3.8 },
  recession: { inflation: 1.5, pce: 1.3, gdp: -1.5, unemployment: 7.0 },
  trough: { inflation: 1.0, pce: 0.9, gdp: -0.3, unemployment: 7.8 },
};

// Probability of each Fed decision by phase. Remaining probability mass (if
// any) falls to 'hold'.
const FED_DECISION_WEIGHTS: Record<Phase, { hike: number; cut: number }> = {
  expansion: { hike: 0.5, cut: 0.1 },
  peak: { hike: 0.6, cut: 0.1 },
  recession: { hike: 0.1, cut: 0.6 },
  trough: { hike: 0.1, cut: 0.5 },
};

function randNormal(): number {
  const u1 = Math.random() || Number.MIN_VALUE;
  const u2 = Math.random();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

function randIn(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function nextPhase(current: Phase): Phase {
  const idx = PHASE_SEQUENCE.indexOf(current);
  return PHASE_SEQUENCE[(idx + 1) % PHASE_SEQUENCE.length];
}

function clampRate(rate: number): number {
  return Math.min(FED_RATE_CEILING, Math.max(FED_RATE_FLOOR, rate));
}

interface MacroState {
  cycle_phase: Phase;
  phase_started_at: string;
  phase_ends_at: string;
  momentum: number;
  fed_funds_rate: number;
  last_fed_meeting_at: string | null;
  next_fed_meeting_at: string;
  inflation_rate: number;
  pce_rate: number;
  gdp_growth: number;
  unemployment_rate: number;
  next_cpi_release_at: string;
  next_gdp_release_at: string;
  next_unemployment_release_at: string;
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

  const { data: macro, error: macroError } = await supabase
    .from('macro_state')
    .select('*')
    .eq('id', 1)
    .single();

  if (macroError || !macro) {
    return new Response(JSON.stringify({ error: macroError?.message ?? 'macro_state not found' }), { status: 500 });
  }

  const state = macro as MacroState;
  const simulatedNow = new Date(marketState.simulated_time);

  const phaseHistoryInserts: { phase: Phase; started_at: string; ended_at: string | null }[] = [];
  const phaseHistoryCloses: { started_at: string; ended_at: string }[] = [];
  const fedMeetingInserts: { simulated_date: string; rate_before: number; rate_after: number; decision: string; basis_points: number; rationale: string }[] = [];
  const releaseInserts: { release_type: string; simulated_date: string; value: number; prior_value: number }[] = [];

  let cyclePhase = state.cycle_phase;
  let phaseStartedAt = new Date(state.phase_started_at);
  let phaseEndsAt = new Date(state.phase_ends_at);

  // 1. Phase transitions -- repeat in case simulated time jumped past more
  // than one phase boundary since the last run.
  let phaseTransitions = 0;
  while (phaseEndsAt.getTime() <= simulatedNow.getTime() && phaseTransitions < MAX_PHASE_TRANSITIONS_PER_RUN) {
    phaseHistoryCloses.push({ started_at: phaseStartedAt.toISOString(), ended_at: phaseEndsAt.toISOString() });

    cyclePhase = nextPhase(cyclePhase);
    phaseStartedAt = phaseEndsAt;
    const [minDays, maxDays] = PHASE_DURATION_DAYS[cyclePhase];
    phaseEndsAt = new Date(phaseStartedAt.getTime() + randIn(minDays, maxDays) * DAY_MS);

    phaseHistoryInserts.push({ phase: cyclePhase, started_at: phaseStartedAt.toISOString(), ended_at: null });
    phaseTransitions += 1;
  }

  // 2. Fed meetings -- biased by current phase and current inflation, capped
  // by hard floor/ceiling regardless of what the phase logic would otherwise do.
  let fedFundsRate = Number(state.fed_funds_rate);
  let lastFedMeetingAt = state.last_fed_meeting_at ? new Date(state.last_fed_meeting_at) : null;
  let nextFedMeetingAt = new Date(state.next_fed_meeting_at);
  let fedMeetings = 0;

  while (nextFedMeetingAt.getTime() <= simulatedNow.getTime() && fedMeetings < MAX_FED_MEETINGS_PER_RUN) {
    const weights = FED_DECISION_WEIGHTS[cyclePhase];
    const roll = Math.random();
    const decision = roll < weights.hike ? 'hike' : roll < weights.hike + weights.cut ? 'cut' : 'hold';
    const basisPoints = decision === 'hold' ? 0 : (Math.random() < 0.7 ? 25 : 50);

    const rateBefore = fedFundsRate;
    const rawRateAfter = decision === 'hike'
      ? rateBefore + basisPoints / 100
      : decision === 'cut'
      ? rateBefore - basisPoints / 100
      : rateBefore;
    const rateAfter = clampRate(rawRateAfter);

    fedMeetingInserts.push({
      simulated_date: nextFedMeetingAt.toISOString(),
      rate_before: Number(rateBefore.toFixed(2)),
      rate_after: Number(rateAfter.toFixed(2)),
      decision,
      basis_points: decision === 'hold' ? 0 : basisPoints,
      rationale: decision === 'hike'
        ? `Inflation and a ${cyclePhase} economy support tighter policy.`
        : decision === 'cut'
        ? `Weakening conditions in a ${cyclePhase} economy support easier policy.`
        : 'Current conditions support holding rates steady.',
    });

    fedFundsRate = rateAfter;
    lastFedMeetingAt = nextFedMeetingAt;
    nextFedMeetingAt = new Date(nextFedMeetingAt.getTime() + 42 * DAY_MS);
    fedMeetings += 1;
  }

  // 3. Monthly/quarterly releases -- each series drifts gradually toward its
  // current phase's target rather than snapping to it.
  function blendToward(current: number, target: number, weight: number, noiseScale: number): number {
    return current + (target - current) * weight + randNormal() * noiseScale;
  }

  let inflationRate = Number(state.inflation_rate);
  let pceRate = Number(state.pce_rate);
  let nextCpiReleaseAt = new Date(state.next_cpi_release_at);
  let cpiReleases = 0;
  while (nextCpiReleaseAt.getTime() <= simulatedNow.getTime() && cpiReleases < MAX_RELEASES_PER_SERIES_PER_RUN) {
    const target = PHASE_TARGETS[cyclePhase];
    const priorInflation = inflationRate;
    const priorPce = pceRate;
    inflationRate = Math.max(-2, blendToward(inflationRate, target.inflation, 0.35, 0.15));
    pceRate = Math.max(-2, blendToward(pceRate, target.pce, 0.35, 0.15));

    releaseInserts.push({ release_type: 'cpi', simulated_date: nextCpiReleaseAt.toISOString(), value: Number(inflationRate.toFixed(2)), prior_value: Number(priorInflation.toFixed(2)) });
    releaseInserts.push({ release_type: 'pce', simulated_date: nextCpiReleaseAt.toISOString(), value: Number(pceRate.toFixed(2)), prior_value: Number(priorPce.toFixed(2)) });

    nextCpiReleaseAt = new Date(nextCpiReleaseAt.getTime() + 30 * DAY_MS);
    cpiReleases += 1;
  }

  let unemploymentRate = Number(state.unemployment_rate);
  let nextUnemploymentReleaseAt = new Date(state.next_unemployment_release_at);
  let unemploymentReleases = 0;
  while (nextUnemploymentReleaseAt.getTime() <= simulatedNow.getTime() && unemploymentReleases < MAX_RELEASES_PER_SERIES_PER_RUN) {
    const target = PHASE_TARGETS[cyclePhase];
    const prior = unemploymentRate;
    // Unemployment is sticky -- moves toward its target more slowly than
    // inflation/GDP do.
    unemploymentRate = Math.max(1, blendToward(unemploymentRate, target.unemployment, 0.15, 0.1));

    releaseInserts.push({ release_type: 'unemployment', simulated_date: nextUnemploymentReleaseAt.toISOString(), value: Number(unemploymentRate.toFixed(2)), prior_value: Number(prior.toFixed(2)) });

    nextUnemploymentReleaseAt = new Date(nextUnemploymentReleaseAt.getTime() + 30 * DAY_MS);
    unemploymentReleases += 1;
  }

  let gdpGrowth = Number(state.gdp_growth);
  let nextGdpReleaseAt = new Date(state.next_gdp_release_at);
  let gdpReleases = 0;
  while (nextGdpReleaseAt.getTime() <= simulatedNow.getTime() && gdpReleases < MAX_RELEASES_PER_SERIES_PER_RUN) {
    const target = PHASE_TARGETS[cyclePhase];
    const prior = gdpGrowth;
    gdpGrowth = blendToward(gdpGrowth, target.gdp, 0.4, 0.3);

    releaseInserts.push({ release_type: 'gdp', simulated_date: nextGdpReleaseAt.toISOString(), value: Number(gdpGrowth.toFixed(2)), prior_value: Number(prior.toFixed(2)) });

    nextGdpReleaseAt = new Date(nextGdpReleaseAt.getTime() + 90 * DAY_MS);
    gdpReleases += 1;
  }

  // 4. Yield curve refresh -- at most once per simulated day.
  const { data: latestSnapshot } = await supabase
    .from('yield_curve_snapshots')
    .select('simulated_date')
    .order('simulated_date', { ascending: false })
    .limit(1)
    .maybeSingle();

  const yieldCurveInserts: { simulated_date: string; tenor: string; yield: number }[] = [];
  const lastSnapshotAt = latestSnapshot ? new Date(latestSnapshot.simulated_date) : null;
  if (!lastSnapshotAt || simulatedNow.getTime() - lastSnapshotAt.getTime() >= DAY_MS) {
    const inflationGap = inflationRate - 2;
    const recessionTilt = cyclePhase === 'recession' || cyclePhase === 'trough' ? -0.5 : 0;
    const peakInversion = cyclePhase === 'peak' ? -0.8 : 0;

    const threeMonth = fedFundsRate + randNormal() * 0.05;
    const twoYear = fedFundsRate + inflationGap * 0.2 + recessionTilt + randNormal() * 0.1;
    const tenYear = fedFundsRate * 0.6 + inflationRate * 0.4 + 1.0 + peakInversion + randNormal() * 0.1;
    const thirtyYear = tenYear + 0.3 + randNormal() * 0.1;

    for (const [tenor, value] of [['3m', threeMonth], ['2y', twoYear], ['10y', tenYear], ['30y', thirtyYear]] as const) {
      yieldCurveInserts.push({ simulated_date: simulatedNow.toISOString(), tenor, yield: Number(value.toFixed(2)) });
    }
  }

  // 5. Momentum -- small mean-reverting wobble, not a phase driver.
  const newMomentum = Math.max(-1, Math.min(1, state.momentum * 0.9 + randNormal() * 0.05));

  // Write everything out.
  for (const close of phaseHistoryCloses) {
    const { error } = await supabase
      .from('macro_phase_history')
      .update({ ended_at: close.ended_at })
      .eq('started_at', close.started_at)
      .is('ended_at', null);
    if (error) {
      return new Response(JSON.stringify({ error: error.message }), { status: 500 });
    }
  }

  if (phaseHistoryInserts.length > 0) {
    const { error } = await supabase.from('macro_phase_history').insert(phaseHistoryInserts);
    if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  }

  if (fedMeetingInserts.length > 0) {
    const { error } = await supabase.from('fed_meetings').insert(fedMeetingInserts);
    if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  }

  if (releaseInserts.length > 0) {
    const { error } = await supabase.from('economic_releases').insert(releaseInserts);
    if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  }

  if (yieldCurveInserts.length > 0) {
    const { error } = await supabase.from('yield_curve_snapshots').insert(yieldCurveInserts);
    if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  }

  const { error: updateError } = await supabase
    .from('macro_state')
    .update({
      cycle_phase: cyclePhase,
      phase_started_at: phaseStartedAt.toISOString(),
      phase_ends_at: phaseEndsAt.toISOString(),
      momentum: newMomentum,
      fed_funds_rate: Number(fedFundsRate.toFixed(2)),
      last_fed_meeting_at: lastFedMeetingAt ? lastFedMeetingAt.toISOString() : null,
      next_fed_meeting_at: nextFedMeetingAt.toISOString(),
      inflation_rate: Number(inflationRate.toFixed(2)),
      pce_rate: Number(pceRate.toFixed(2)),
      gdp_growth: Number(gdpGrowth.toFixed(2)),
      unemployment_rate: Number(unemploymentRate.toFixed(2)),
      next_cpi_release_at: nextCpiReleaseAt.toISOString(),
      next_gdp_release_at: nextGdpReleaseAt.toISOString(),
      next_unemployment_release_at: nextUnemploymentReleaseAt.toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', 1);

  if (updateError) {
    return new Response(JSON.stringify({ error: updateError.message }), { status: 500 });
  }

  return new Response(
    JSON.stringify({
      phaseTransitions,
      fedMeetingsRun: fedMeetings,
      cpiReleases,
      unemploymentReleases,
      gdpReleases,
      yieldCurveRefreshed: yieldCurveInserts.length > 0,
      cyclePhase,
      fedFundsRate: Number(fedFundsRate.toFixed(2)),
    }),
    { status: 200 },
  );
});
