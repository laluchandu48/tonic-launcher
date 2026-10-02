import { useState } from 'react';

/**
 * Charts are hand-drawn SVG rather than a charting dependency: two forms, one
 * series each, no need for 200KB of library.
 *
 * Deliberately NOT a combined uniques-and-revenue plot. Two measures on two
 * y-scales in one frame invent a correlation the data does not contain — the
 * alignment of the scales is arbitrary. They are drawn as small multiples
 * instead: separate plots, shared x axis, each on its own honest scale.
 */

const BLUE = '#2a78d6';
const GRID = '#e6ecef';
const AXIS_INK = '#5c7280';

/**
 * Pick an axis scale whose ticks land on round numbers AND whose ceiling sits
 * just above the data. Stepping only by powers of ten does one or the other
 * badly: a 54k maximum gets a 100k axis (bars use half the height), and
 * quartering an axis puts ticks on 1250 / 3750, which round to a gap-toothed
 * "$1k, $3k, $4k".
 *
 * So: try each nice step, keep the one giving 4-6 intervals, prefer 5.
 */
function niceScale(value) {
  if (!(value > 0)) return { max: 1, ticks: [0, 1] };

  const magnitude = 10 ** Math.floor(Math.log10(value));
  const candidates = [];
  for (const mult of [0.1, 0.2, 0.25, 0.5, 1, 2, 2.5, 5, 10]) {
    const step = mult * magnitude;
    const intervals = Math.ceil(value / step);
    if (intervals >= 3 && intervals <= 7) candidates.push({ step, intervals });
  }

  const best = candidates.sort(
    (a, b) => Math.abs(a.intervals - 5) - Math.abs(b.intervals - 5) || a.intervals - b.intervals
  )[0] || { step: value, intervals: 1 };

  const max = best.step * best.intervals;
  const ticks = [];
  for (let i = 0; i <= best.intervals; i += 1) ticks.push(best.step * i);
  return { max, ticks };
}

/** A column with its top corners rounded and its base square on the axis. */
function columnPath(x, y, w, h, r = 4) {
  const radius = Math.min(r, w / 2, Math.max(h, 0));
  if (h <= 0) return '';
  return `M${x},${y + h} L${x},${y + radius} Q${x},${y} ${x + radius},${y}`
       + ` L${x + w - radius},${y} Q${x + w},${y} ${x + w},${y + radius}`
       + ` L${x + w},${y + h} Z`;
}

/** Vertical columns for one series over time. */
export function ColumnChart({ title, data, valueKey, labelKey, format, height = 190 }) {
  const [hover, setHover] = useState(null);

  if (!data?.length) {
    return (
      <figure style={{ margin: 0 }}>
        <figcaption style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>{title}</figcaption>
        <div className="empty" style={{ padding: 28 }}>No data in this range.</div>
      </figure>
    );
  }

  const padL = 54;
  const padR = 8;
  const padT = 8;
  const padB = 26;
  const width = 560;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;

  const { max, ticks } = niceScale(Math.max(...data.map((d) => Number(d[valueKey]) || 0)));
  const slot = plotW / data.length;
  const barW = Math.max(6, Math.min(38, slot - 8)); // 8px keeps a gap between bars

  return (
    <figure style={{ margin: 0, position: 'relative' }}>
      <figcaption style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>{title}</figcaption>

      <svg viewBox={`0 0 ${width} ${height}`} width="100%" height={height} role="img"
           aria-label={`${title} by day`} style={{ overflow: 'visible' }}>
        {ticks.map((t) => {
          const y = padT + plotH - (t / max) * plotH;
          return (
            <g key={t}>
              <line x1={padL} x2={width - padR} y1={y} y2={y} stroke={GRID} strokeWidth="1" />
              <text x={padL - 8} y={y + 4} textAnchor="end" fontSize="10" fill={AXIS_INK}>
                {format ? format(t, true) : Math.round(t).toLocaleString()}
              </text>
            </g>
          );
        })}

        {data.map((d, i) => {
          const value = Number(d[valueKey]) || 0;
          const h = max > 0 ? (value / max) * plotH : 0;
          const x = padL + i * slot + (slot - barW) / 2;
          const y = padT + plotH - h;
          const active = hover?.i === i;
          return (
            <g key={d[labelKey] ?? i}>
              {/* Full-height hit area: easier to hover than a short bar. */}
              <rect
                x={padL + i * slot} y={padT} width={slot} height={plotH} fill="transparent"
                onMouseEnter={() => setHover({ i, x: x + barW / 2, y })}
                onMouseLeave={() => setHover(null)}
              />
              <path
                d={columnPath(x, y, barW, Math.max(h, value > 0 ? 2 : 0))}
                fill={BLUE}
                opacity={hover && !active ? 0.55 : 1}
                pointerEvents="none"
              />
              <text x={x + barW / 2} y={height - 8} textAnchor="middle" fontSize="10" fill={AXIS_INK}
                    pointerEvents="none">
                {String(d[labelKey]).slice(5)}
              </text>
            </g>
          );
        })}

        <line x1={padL} x2={width - padR} y1={padT + plotH} y2={padT + plotH} stroke="#c9d5da" strokeWidth="1" />
      </svg>

      {hover && (
        <div
          style={{
            position: 'absolute',
            // Clamped horizontally so the tooltip cannot escape the card, and
            // flipped below the bar top when the bar is tall enough that a
            // tooltip above it would cover the chart's own title.
            left: `${Math.min(92, Math.max(8, (hover.x / width) * 100))}%`,
            top: hover.y,
            transform: hover.y < 34 ? 'translate(-50%, 6px)' : 'translate(-50%, -115%)',
            background: '#0c3547', color: '#fff', padding: '5px 9px', borderRadius: 5,
            fontSize: 12, whiteSpace: 'nowrap', pointerEvents: 'none', zIndex: 5,
          }}
        >
          {data[hover.i][labelKey]} — {format
            ? format(Number(data[hover.i][valueKey]) || 0)
            : (Number(data[hover.i][valueKey]) || 0).toLocaleString()}
        </div>
      )}
    </figure>
  );
}

/**
 * Ranked horizontal bars for part-to-whole.
 *
 * A pie was the obvious mirror of the Tonic dashboard, but offer names are long
 * and several shares sit close together — exactly where slices stop being
 * readable. Bars keep the ordering explicit and the labels legible.
 */
export function RankedBars({ data, labelKey, valueKey, shareKey, format }) {
  if (!data?.length) return <div className="empty" style={{ padding: 28 }}>No revenue in this range.</div>;

  const max = Math.max(...data.map((d) => Number(d[valueKey]) || 0), 1);

  return (
    <div>
      {data.map((d) => {
        const value = Number(d[valueKey]) || 0;
        const pct = (value / max) * 100;
        return (
          <div key={d[labelKey]} style={{ marginBottom: 13 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, marginBottom: 4 }}>
              <span style={{ fontSize: 13 }}>{d[labelKey]}</span>
              <span style={{ fontSize: 13, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
                {format ? format(value) : value}
                {shareKey != null && <span className="muted"> · {d[shareKey]}%</span>}
              </span>
            </div>
            <div style={{ background: GRID, borderRadius: 4, height: 9 }}>
              <div style={{ width: `${pct}%`, background: BLUE, borderRadius: 4, height: '100%' }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}
