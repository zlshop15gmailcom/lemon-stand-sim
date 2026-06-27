import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabaseClient';

const POLL_INTERVAL_MS = 5000;
const PRESET_MULTIPLIERS = [1, 10, 100, 1000];

export function TimeControlBar() {
  const [isRunning, setIsRunning] = useState(null);
  const [timeMultiplier, setTimeMultiplier] = useState(null);
  const [customValue, setCustomValue] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;

    async function fetchState() {
      const { data, error: fetchError } = await supabase
        .from('market_state')
        .select('is_running, time_multiplier')
        .eq('id', 1)
        .single();

      if (cancelled) return;

      if (fetchError) {
        setError(fetchError.message);
        return;
      }

      setError(null);
      setIsRunning(data.is_running);
      setTimeMultiplier(Number(data.time_multiplier));
    }

    fetchState();
    const interval = setInterval(fetchState, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  async function callRpc(name, args) {
    setPending(true);
    setError(null);
    const { error: rpcError } = await supabase.rpc(name, args);
    setPending(false);

    if (rpcError) {
      setError(rpcError.message);
      return false;
    }
    return true;
  }

  async function handlePauseToggle() {
    const nextRunning = !isRunning;
    const ok = await callRpc('set_market_running', { running: nextRunning });
    if (ok) setIsRunning(nextRunning);
  }

  async function handlePresetClick(multiplier) {
    const ok = await callRpc('set_time_multiplier', { new_multiplier: multiplier });
    if (ok) setTimeMultiplier(multiplier);
  }

  async function handleCustomSubmit(event) {
    event.preventDefault();
    const parsed = Number(customValue);
    if (!Number.isFinite(parsed) || parsed < 0) {
      setError('Custom multiplier must be a non-negative number.');
      return;
    }
    const ok = await callRpc('set_time_multiplier', { new_multiplier: parsed });
    if (ok) {
      setTimeMultiplier(parsed);
      setCustomValue('');
    }
  }

  const loaded = isRunning !== null && timeMultiplier !== null;

  return (
    <div className="time-control-bar">
      <button
        type="button"
        className={`time-control-bar__pause ${isRunning === false ? 'is-active' : ''}`}
        onClick={handlePauseToggle}
        disabled={!loaded || pending}
      >
        {isRunning === false ? 'Paused' : 'Pause'}
      </button>

      {PRESET_MULTIPLIERS.map((multiplier) => (
        <button
          key={multiplier}
          type="button"
          className={`time-control-bar__preset ${isRunning && timeMultiplier === multiplier ? 'is-active' : ''}`}
          onClick={() => handlePresetClick(multiplier)}
          disabled={!loaded || pending}
        >
          {multiplier}x
        </button>
      ))}

      <form className="time-control-bar__custom" onSubmit={handleCustomSubmit}>
        <input
          type="number"
          min="0"
          step="any"
          placeholder="Custom"
          value={customValue}
          onChange={(event) => setCustomValue(event.target.value)}
          disabled={!loaded || pending}
        />
        <button type="submit" disabled={!loaded || pending || customValue === ''}>
          Set
        </button>
      </form>

      {loaded && (
        <span className="time-control-bar__current">
          Current: {isRunning === false ? 'paused' : `${timeMultiplier}x`}
        </span>
      )}

      {error && <span className="time-control-bar__error">{error}</span>}
    </div>
  );
}
