import { useEffect, useRef, useState } from 'react';

/**
 * Debounced search input.
 *
 * Searching is done by the API, not by filtering rows already on screen, so a
 * match on page 9 is still found. That means every keystroke would otherwise be
 * a request — hence the delay, and the minimum length, since v4 rejects a
 * campaign name filter shorter than 3 characters.
 */
export default function SearchBox({
  value,
  onSearch,
  placeholder = 'Search…',
  hint = null,
  minLength = 3,
  delay = 400,
  width = 300,
}) {
  const [text, setText] = useState(value || '');
  const timer = useRef(null);
  const latest = useRef(onSearch);
  latest.current = onSearch;

  // Reset when the caller clears it (e.g. switching tabs).
  useEffect(() => { setText(value || ''); }, [value]);

  useEffect(() => {
    const trimmed = text.trim();
    // An empty box means "no filter" and must fire immediately, otherwise
    // clearing it leaves the previous results on screen.
    const tooShort = trimmed.length > 0 && trimmed.length < minLength;
    if (tooShort) return undefined;

    clearTimeout(timer.current);
    timer.current = setTimeout(() => latest.current(trimmed), trimmed ? delay : 0);
    return () => clearTimeout(timer.current);
  }, [text, minLength, delay]);

  const trimmed = text.trim();
  const tooShort = trimmed.length > 0 && trimmed.length < minLength;

  return (
    <div style={{ position: 'relative', width }}>
      <input
        type="text"
        value={text}
        placeholder={placeholder}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setText('');
          if (e.key === 'Enter') { clearTimeout(timer.current); latest.current(trimmed); }
        }}
        style={{ paddingRight: text ? 28 : 11 }}
      />
      {text && (
        <button
          type="button"
          aria-label="Clear search"
          onClick={() => setText('')}
          style={{
            position: 'absolute', right: 6, top: 7, border: 'none', background: 'none',
            cursor: 'pointer', color: 'var(--ink-soft)', fontSize: 15, lineHeight: 1, padding: 2,
          }}
        >
          ×
        </button>
      )}
      {(tooShort || hint) && (
        <p className="hint" style={{ margin: '4px 0 0', fontSize: 11 }}>
          {tooShort ? `Type at least ${minLength} characters` : hint}
        </p>
      )}
    </div>
  );
}
