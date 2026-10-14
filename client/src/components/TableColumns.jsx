import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/**
 * Column behaviour shared by the Final Data and Campaigns tables: sorting,
 * which columns show, and how wide each one is.
 *
 * It lives in one place because the two tables are read the same way, and a
 * sort that reverses on Final Data but not on Campaigns is the kind of
 * inconsistency nobody reports and everybody notices.
 *
 * A column is described by { key, label, numeric?, title?, pinned?, value? }.
 * `value` pulls the sort key out of a row when it is not simply row[key];
 * `pinned` marks a column that cannot be hidden (the selection checkbox, the
 * on/off switch) because hiding it would take away the row's controls.
 */

/** Below this a column is unreadable, so a drag cannot shrink one past it. */
const MIN_WIDTH = 56;

const read = (key) => {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    // Private windows and blocked site data both throw here. Preferences are a
    // convenience, so the table opens with its defaults rather than failing.
    return null;
  }
};

const write = (key, value) => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch { /* see above */ }
};

export function useColumnPrefs(storageKey, columns) {
  const [prefs, setPrefs] = useState(() => {
    const saved = read(storageKey);
    return {
      hidden: Array.isArray(saved?.hidden) ? saved.hidden : [],
      widths: saved?.widths && typeof saved.widths === 'object' ? saved.widths : {},
    };
  });

  useEffect(() => { write(storageKey, prefs); }, [storageKey, prefs]);

  /**
   * Saved preferences are reconciled against the columns that actually exist.
   * A key left over from an older version of the table must not hide anything,
   * and a pinned column stays visible however old the stored list is.
   */
  const hidden = useMemo(() => {
    const hideable = new Set(columns.filter((c) => !c.pinned).map((c) => c.key));
    return new Set(prefs.hidden.filter((k) => hideable.has(k)));
  }, [prefs.hidden, columns]);

  const visible = useMemo(
    () => columns.filter((c) => !hidden.has(c.key)),
    [columns, hidden]
  );

  const toggle = useCallback((key) => setPrefs((p) => {
    const next = new Set(p.hidden);
    if (next.has(key)) next.delete(key); else next.add(key);
    return { ...p, hidden: [...next] };
  }), []);

  const setWidth = useCallback((key, px) => setPrefs((p) => ({
    ...p,
    widths: { ...p.widths, [key]: Math.round(px) },
  })), []);

  const reset = useCallback(() => setPrefs({ hidden: [], widths: {} }), []);

  const customised = hidden.size > 0 || Object.keys(prefs.widths).length > 0;

  return { hidden, visible, widths: prefs.widths, toggle, setWidth, reset, customised };
}

/**
 * The table's own minimum width, so hiding columns actually buys space on a
 * phone instead of leaving the same wide scroll with bigger gaps.
 */
export const tableMinWidth = (visible, widths) =>
  `${Math.max(
    420,
    visible.reduce((n, c) => n + (widths[c.key] || c.width || 96), 0)
  )}px`;

/** First click sorts the way the column is usually read; the second reverses. */
export const nextSort = (sort, col) => (
  sort.key === col.key
    ? { key: col.key, dir: sort.dir === 'asc' ? 'desc' : 'asc' }
    : { key: col.key, dir: col.numeric ? 'desc' : 'asc' }
);

/**
 * Sort rows by the current column.
 *
 * A missing value is not a small one — an adset with no CPL has not got the
 * cheapest leads — so blanks sink to the bottom in both directions rather than
 * crowding whichever end the sign points at.
 */
export function sortRows(list, columns, sort) {
  if (!sort?.key) return list;
  const col = columns.find((c) => c.key === sort.key);
  const sign = sort.dir === 'asc' ? 1 : -1;
  const valueOf = col?.value || ((row) => row[sort.key]);

  return [...list].sort((a, b) => {
    const x = valueOf(a);
    const y = valueOf(b);
    const xMissing = x == null || x === '';
    const yMissing = y == null || y === '';
    if (xMissing || yMissing) return xMissing && yMissing ? 0 : xMissing ? 1 : -1;
    if (col?.numeric) return (Number(x) - Number(y)) * sign;
    return String(x).localeCompare(String(y), undefined, { sensitivity: 'base' }) * sign;
  });
}

/** The "Columns" button and its checklist. */
export function ColumnsMenu({ columns, hidden, toggle, reset, customised }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const hideable = columns.filter((c) => !c.pinned);

  return (
    <div className="col-menu" ref={ref}>
      <button
        type="button"
        className={`chip ${hidden.size ? 'on' : ''}`}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="true"
        title="Choose which columns to show"
      >
        Columns{hidden.size ? ` · ${hidden.size} hidden` : ''}
      </button>
      {open && (
        <div className="col-menu-panel">
          {hideable.map((c) => (
            <label className="col-menu-item" key={c.key}>
              <input
                type="checkbox"
                checked={!hidden.has(c.key)}
                onChange={() => toggle(c.key)}
              />
              <span>{c.label}</span>
            </label>
          ))}
          <button
            type="button"
            className="btn btn-ghost col-menu-reset"
            onClick={reset}
            disabled={!customised}
          >
            Reset columns and widths
          </button>
        </div>
      )}
    </div>
  );
}

/** One header cell: the sort control, plus the grip that resizes the column. */
function HeaderCell({ col, width, setWidth, sort, onSort }) {
  const ref = useRef(null);
  const sortable = col.sortable !== false && typeof onSort === 'function';
  const active = sort?.key === col.key;

  const startResize = (e) => {
    // Without this the pointer-down also counts as a click on the sort button
    // underneath, so every resize would re-sort the table.
    e.preventDefault();
    e.stopPropagation();

    // Measure the rendered width rather than assuming a default, so the first
    // drag continues from where the column actually is instead of jumping.
    const startX = e.clientX;
    const startWidth = ref.current?.getBoundingClientRect().width || col.width || 120;

    const move = (ev) => setWidth(col.key, Math.max(MIN_WIDTH, startWidth + (ev.clientX - startX)));
    const stop = () => {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', stop);
      document.body.classList.remove('col-resizing');
    };

    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', stop);
    document.body.classList.add('col-resizing');
  };

  const w = width || col.width;
  const className = [col.numeric ? 'num' : '', col.sticky || ''].filter(Boolean).join(' ');

  return (
    <th
      ref={ref}
      className={className || undefined}
      title={col.title}
      style={w ? { width: w, minWidth: w, maxWidth: w } : undefined}
      aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      {sortable ? (
        <button type="button" className="th-sort" onClick={() => onSort(col)}>
          {col.label}
          <span className={`sort-arrow ${active ? 'on' : ''}`}>
            {active ? (sort.dir === 'asc' ? '↑' : '↓') : '↕'}
          </span>
        </button>
      ) : col.label}

      {col.resizable !== false && (
        <span
          className="col-grip"
          onPointerDown={startResize}
          onDoubleClick={() => setWidth(col.key, col.width || 120)}
          title={`Drag to resize ${col.label}`}
        />
      )}
    </th>
  );
}

/**
 * `leading` is for a cell that is part of the row but not part of the column
 * system — the select-all checkbox on Campaigns, which is neither sortable,
 * hideable nor resizable.
 */
export function HeaderRow({ columns, widths, setWidth, sort, onSort, leading = null }) {
  return (
    <tr>
      {leading}
      {columns.map((col) => (
        <HeaderCell
          key={col.key}
          col={col}
          width={widths[col.key]}
          setWidth={setWidth}
          sort={sort}
          onSort={onSort}
        />
      ))}
    </tr>
  );
}
