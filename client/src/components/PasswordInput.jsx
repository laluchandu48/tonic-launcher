import { useState } from 'react';

/**
 * A password field with a show/hide toggle.
 *
 * The toggle is a button rather than a checkbox so it can live inside the
 * field, and it carries aria-pressed so a screen reader announces the state —
 * the icon alone says nothing out loud. Revealed text is never persisted:
 * the field reverts to hidden on every mount.
 */
export default function PasswordInput({ id, value, onChange, autoComplete, autoFocus, className, placeholder, onKeyDown }) {
  const [shown, setShown] = useState(false);

  return (
    <div className="pw-wrap">
      <input
        id={id}
        type={shown ? 'text' : 'password'}
        className={className}
        value={value}
        autoComplete={autoComplete}
        autoFocus={autoFocus}
        placeholder={placeholder}
        onChange={onChange}
        onKeyDown={onKeyDown}
      />
      <button
        type="button"
        className="pw-toggle"
        onClick={() => setShown((v) => !v)}
        aria-pressed={shown}
        aria-label={shown ? 'Hide password' : 'Show password'}
        title={shown ? 'Hide password' : 'Show password'}
        // Keeps a click from submitting the form it sits in.
        tabIndex={-1}
      >
        {shown ? (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
            <path d="M3 3l18 18" />
            <path d="M10.6 10.6a2 2 0 002.8 2.8" />
            <path d="M9.4 5.2A9.5 9.5 0 0112 5c5 0 9 4.5 9 7a11 11 0 01-2.4 3.3" />
            <path d="M6.3 6.8A11.6 11.6 0 003 12c0 2.5 4 7 9 7a9.3 9.3 0 003.9-.8" />
          </svg>
        ) : (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
            <path d="M3 12s3.5-7 9-7 9 7 9 7-3.5 7-9 7-9-7-9-7z" />
            <circle cx="12" cy="12" r="2.6" />
          </svg>
        )}
      </button>
    </div>
  );
}
