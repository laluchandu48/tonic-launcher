/**
 * Tonic's domains endpoint returns bare language codes ("de", "zh-hans"), which
 * are not what anyone wants to pick from a list. Intl.DisplayNames is built into
 * the browser and already knows every one of them, so there is no table to keep
 * in sync — it just needs a fallback for codes it cannot resolve.
 */

let displayNames = null;
try {
  displayNames = new Intl.DisplayNames(['en'], { type: 'language' });
} catch {
  // Very old browsers; every lookup then falls through to the code itself.
}

// Codes Intl does not resolve, or resolves less usefully than the industry name.
const OVERRIDES = {
  fil: 'Filipino',
  'zh-hans': 'Chinese (Simplified)',
  'zh-hant': 'Chinese (Traditional)',
  'pt-br': 'Portuguese (Brazil)',
  'es-419': 'Spanish (Latin America)',
  wo: 'Worldwide',
};

export function languageName(code) {
  if (!code) return '';
  const key = String(code).trim().toLowerCase();
  if (OVERRIDES[key]) return OVERRIDES[key];

  try {
    const name = displayNames?.of(key);
    // Intl hands the code straight back when it does not recognise it.
    if (name && name.toLowerCase() !== key) {
      return name.charAt(0).toUpperCase() + name.slice(1);
    }
  } catch {
    // Malformed code — fall through.
  }
  return code;
}

/** Sort a list of codes by the name actually shown, not by the code. */
export function byLanguageName(a, b) {
  return languageName(a).localeCompare(languageName(b));
}
