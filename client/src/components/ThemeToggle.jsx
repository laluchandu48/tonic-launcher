import { useEffect, useState } from 'react';

/**
 * Light/dark switch.
 *
 * The chosen theme is written to <html data-theme> and remembered in
 * localStorage. index.html applies the stored value before first paint, so the
 * page never flashes the wrong theme on load. With nothing stored, the system
 * preference wins — the right default is the one the person already chose for
 * their machine.
 */
export function readTheme() {
  try {
    const stored = localStorage.getItem('tl.theme');
    if (stored === 'light' || stored === 'dark') return stored;
  } catch {
    // Private windows and blocked storage both throw; the default still works.
  }
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export default function ThemeToggle() {
  const [theme, setTheme] = useState(readTheme);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem('tl.theme', theme); } catch { /* not worth failing over */ }
  }, [theme]);

  const next = theme === 'dark' ? 'light' : 'dark';

  return (
    <button
      className="icon-btn"
      onClick={() => setTheme(next)}
      title={`Switch to ${next} theme`}
      aria-label={`Switch to ${next} theme`}
    >
      {theme === 'dark' ? (
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4" />
        </svg>
      ) : (
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 12.8A9 9 0 1111.2 3a7 7 0 009.8 9.8z" />
        </svg>
      )}
    </button>
  );
}
