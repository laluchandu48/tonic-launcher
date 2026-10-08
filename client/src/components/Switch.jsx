/**
 * On/off control for a row.
 *
 * A real checkbox underneath, so it is reachable by keyboard and announced
 * correctly; the visible track and knob are drawn from it. `busy` shows the
 * in-flight state rather than letting someone toggle twice while a request is
 * still travelling to Facebook.
 */
export default function Switch({ checked, onChange, disabled, busy, label }) {
  return (
    <label className={`switch ${busy ? 'busy' : ''}`} title={label}>
      <input
        type="checkbox"
        checked={Boolean(checked)}
        disabled={disabled || busy}
        onChange={(e) => onChange(e.target.checked)}
        aria-label={label}
      />
      <span className="switch-track"><span className="switch-knob" /></span>
    </label>
  );
}
