import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabaseClient';

const POLL_INTERVAL_MS = 5000;
const SECTORS = [
  'all', 'technology', 'healthcare', 'energy', 'financials',
  'consumer_discretionary', 'consumer_staples', 'industrials',
  'utilities', 'real_estate', 'materials', 'communication_services',
];

function formatSectorLabel(sector) {
  return sector.replace(/_/g, ' ');
}

export function CompanyList() {
  const [companies, setCompanies] = useState([]);
  const [sectorFilter, setSectorFilter] = useState('all');
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    async function fetchCompanies() {
      let query = supabase
        .from('companies')
        .select('id, name, ticker, sector, archetype, current_price, last_return')
        .order('ticker', { ascending: true });

      if (sectorFilter !== 'all') {
        query = query.eq('sector', sectorFilter);
      }

      const { data, error: fetchError } = await query;

      if (cancelled) return;

      if (fetchError) {
        setError(fetchError.message);
        setLoading(false);
        return;
      }

      setError(null);
      setCompanies(data);
      setLoading(false);
    }

    setLoading(true);
    fetchCompanies();
    const interval = setInterval(fetchCompanies, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [sectorFilter]);

  return (
    <div className="company-list">
      <div className="company-list__controls">
        <label htmlFor="sector-filter">Sector</label>
        <select
          id="sector-filter"
          value={sectorFilter}
          onChange={(event) => setSectorFilter(event.target.value)}
        >
          {SECTORS.map((sector) => (
            <option key={sector} value={sector}>
              {formatSectorLabel(sector)}
            </option>
          ))}
        </select>
        <span className="company-list__count">{companies.length} companies</span>
      </div>

      {error && <div className="company-list__error">Failed to load companies: {error}</div>}

      {loading ? (
        <div className="company-list__loading">Loading companies...</div>
      ) : (
        <table className="company-list__table">
          <thead>
            <tr>
              <th>Ticker</th>
              <th>Name</th>
              <th>Sector</th>
              <th>Archetype</th>
              <th>Price</th>
              <th>Last return</th>
            </tr>
          </thead>
          <tbody>
            {companies.map((company) => {
              const isUp = Number(company.last_return) > 0;
              const isDown = Number(company.last_return) < 0;
              return (
                <tr key={company.id}>
                  <td className="company-list__ticker">{company.ticker}</td>
                  <td>{company.name}</td>
                  <td>{formatSectorLabel(company.sector)}</td>
                  <td>{company.archetype.replace(/_/g, ' ')}</td>
                  <td>${Number(company.current_price).toFixed(2)}</td>
                  <td className={isUp ? 'is-up' : isDown ? 'is-down' : ''}>
                    {(Number(company.last_return) * 100).toFixed(2)}%
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
