import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabaseClient';

const POLL_INTERVAL_MS = 5000;

export function SimulatedClock() {
  const [simulatedTime, setSimulatedTime] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;

    async function fetchSimulatedTime() {
      const { data, error: fetchError } = await supabase
        .from('market_state')
        .select('simulated_time')
        .eq('id', 1)
        .single();

      if (cancelled) return;

      if (fetchError) {
        setError(fetchError.message);
        return;
      }

      setError(null);
      setSimulatedTime(data.simulated_time);
    }

    fetchSimulatedTime();
    const interval = setInterval(fetchSimulatedTime, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  if (error) {
    return <div className="simulated-clock simulated-clock--error">Clock unavailable: {error}</div>;
  }

  if (!simulatedTime) {
    return <div className="simulated-clock">Loading simulated time...</div>;
  }

  const formatted = new Date(simulatedTime).toLocaleString(undefined, {
    weekday: 'short',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

  return (
    <div className="simulated-clock">
      <span className="simulated-clock__label">Simulated time</span>
      <span className="simulated-clock__value">{formatted}</span>
    </div>
  );
}
