import { useState } from 'react';
import './App.css';
import { SimulatedClock } from './components/SimulatedClock';
import { TimeControlBar } from './components/TimeControlBar';
import { CompanyList } from './components/CompanyList';

// Placeholder sections for later phases. Markets is the only one with real
// content this phase -- the rest exist so the nav shape doesn't need to
// change as those phases get built.
const NAV_SECTIONS = ['Markets', 'Portfolio', 'Learn'];

function App() {
  const [activeSection, setActiveSection] = useState('Markets');

  return (
    <div className="app-shell">
      <header className="app-shell__header">
        <div className="app-shell__brand">Lemon Stand Sim</div>
        <nav className="app-shell__nav">
          {NAV_SECTIONS.map((section) => (
            <button
              key={section}
              type="button"
              className={activeSection === section ? 'is-active' : ''}
              onClick={() => setActiveSection(section)}
            >
              {section}
            </button>
          ))}
        </nav>
        <SimulatedClock />
      </header>

      <TimeControlBar />

      <main className="app-shell__main">
        {activeSection === 'Markets' && <CompanyList />}
        {activeSection === 'Portfolio' && (
          <div className="app-shell__placeholder">Portfolio tools arrive in a later phase.</div>
        )}
        {activeSection === 'Learn' && (
          <div className="app-shell__placeholder">The Learning Center arrives in a later phase.</div>
        )}
      </main>
    </div>
  );
}

export default App;
