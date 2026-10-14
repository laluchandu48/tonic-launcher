import { useEffect, useMemo, useRef, useState } from 'react';

/**
 * A select you can type into.
 *
 * The GEO list runs to roughly two hundred entries and the offer list grows
 * with the account, so a plain <select> means scrolling for the one you want.
 * This keeps the same shape — one value, chosen from a list — and adds a
 * filter box, which is the only thing a native select cannot do.
 *
 * Options are [{ value, label, hint }]; `hint` is shown greyed beside the
 * label and is searched along with it, so an offer can be found by its
 * vertical and a country by either its code or its name.
 */
export default function Picker({
  id,
  value,
  onChange,
  options,
  placeholder = 'Select…',
  searchPlaceholder = 'Type to filter…',
  invalid = false,
  disabled = false,
  emptyText = 'Nothing matches that.',
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const boxRef = useRef(null);
  const inputRef = useRef(null);
  const listRef = useRef(null);

  const selected = options.find((o) => o.value === value) || null;

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) => `${o.label} ${o.hint || ''} ${o.value}`.toLowerCase().includes(q));
  }, [options, query]);

  // Opening starts from a clean filter on whatever is currently chosen.
  useEffect(() => {
    if (!open) return undefined;
    setQuery('');
    setActive(Math.max(0, options.findIndex((o) => o.value === value)));
    const t = setTimeout(() => inputRef.current?.focus(), 0);
    return () => clearTimeout(t);
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  // Keep the highlighted row in view when arrowing through a long list.
  useEffect(() => {
    if (!open) return;
    listRef.current?.querySelector('.picker-option.active')?.scrollIntoView({ block: 'nearest' });
  }, [active, open]);

  const choose = (option) => {
    if (!option) return;
    onChange(option.value);
    setOpen(false);
  };

  const onKeyDown = (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => {
        if (matches.length === 0) return 0;
        const step = e.key === 'ArrowDown' ? 1 : -1;
        return (i + step + matches.length) % matches.length;
      });
    } else if (e.key === 'Enter') {
      e.preventDefault();
      choose(matches[active]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setOpen(false);
    }
  };

  return (
    <div className="picker" ref={boxRef}>
      <button
        type="button"
        id={id}
        className={`picker-control ${invalid ? 'invalid' : ''}`}
        onClick={() => setOpen((o) => !o)}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className={selected ? '' : 'muted'}>
          {selected ? selected.label : placeholder}
          {selected?.hint && <span className="muted"> — {selected.hint}</span>}
        </span>
        <span className="picker-caret" aria-hidden="true">▾</span>
      </button>

      {open && (
        <div className="picker-panel">
          <input
            ref={inputRef}
            type="text"
            className="picker-search"
            value={query}
            placeholder={searchPlaceholder}
            onChange={(e) => { setQuery(e.target.value); setActive(0); }}
            onKeyDown={onKeyDown}
            aria-label={searchPlaceholder}
          />
          <div className="picker-list" ref={listRef} role="listbox">
            {matches.length === 0 ? (
              <p className="picker-empty">{emptyText}</p>
            ) : matches.map((o, i) => (
              <button
                type="button"
                key={o.value}
                role="option"
                aria-selected={o.value === value}
                className={`picker-option ${i === active ? 'active' : ''} ${o.value === value ? 'chosen' : ''}`}
                onMouseEnter={() => setActive(i)}
                onClick={() => choose(o)}
              >
                <span>{o.label}</span>
                {o.hint && <span className="muted">{o.hint}</span>}
              </button>
            ))}
          </div>
          {matches.length > 0 && (
            <p className="picker-count">
              {matches.length} of {options.length}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
