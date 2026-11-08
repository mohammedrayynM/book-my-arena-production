// Money helpers for a multi-currency platform. Calculations are done in INTEGER minor units (paise, cents, fils...) so a
// refund or fee can never be off by a float rounding error, and every amount travels with its currency code.
// The legacy DECIMAL(10,2) columns stay as they are (exact fixed-point, not float); this module is the bridge.

// ISO 4217 minor-unit digits. Anything not listed uses 2.
const DIGITS = { JPY: 0, KRW: 0, VND: 0, KWD: 3, BHD: 3, OMR: 3, JOD: 3, TND: 3 };
const digitsFor = (currency) => (DIGITS[String(currency || '').toUpperCase()] ?? 2);

/** 100.5 + 'INR' -> 10050. Accepts numbers or numeric strings (DECIMAL columns arrive as strings). */
function toMinor(amount, currency = 'INR') {
  const n = Number(amount);
  if (!Number.isFinite(n)) throw new Error(`Invalid amount: ${amount}`);
  const factor = 10 ** digitsFor(currency);
  return Math.round((n + (n >= 0 ? Number.EPSILON : -Number.EPSILON)) * factor);
}
/** 10050 + 'INR' -> 100.5 (a number for display / DECIMAL storage only — never feed it back into arithmetic). */
const fromMinor = (minor, currency = 'INR') => Number(minor) / 10 ** digitsFor(currency);

/** Percentage of an integer minor amount, rounded to the nearest minor unit (half up). */
const percentOf = (minor, percent) => Math.round((Number(minor) * Number(percent)) / 100);

// Display. Symbols come from the countries table at runtime; this fallback only covers formatting on the server (notifications).
const SYMBOLS = { INR: '₹', USD: '$', GBP: '£', EUR: '€', AED: 'AED', SAR: 'SAR', QAR: 'QAR', KWD: 'KWD', OMR: 'OMR', BHD: 'BHD' };
function group(intPart, currency) {
  // India groups as 12,34,567; everything else as 1,234,567
  if (String(currency).toUpperCase() === 'INR') {
    const last3 = intPart.slice(-3); const rest = intPart.slice(0, -3);
    return rest ? `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${last3}` : last3;
  }
  return intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}
/** formatMoney(1000, 'INR') -> '₹1,000' ; formatMoney(100, 'AED') -> 'AED 100' ; formatMoney(50.5, 'GBP') -> '£50.50' */
function formatMoney(amount, currency = 'INR', symbol) {
  const cur = String(currency || 'INR').toUpperCase();
  const d = digitsFor(cur);
  const n = Number(amount);
  const fixed = Math.abs(n).toFixed(d);
  const [i, f] = fixed.split('.');
  const hasFraction = f && Number(f) !== 0;
  const body = `${group(i, cur)}${hasFraction ? `.${f}` : ''}`;
  const sym = symbol || SYMBOLS[cur] || cur;
  const sep = /^[A-Z]{2,}$/.test(sym) ? ' ' : '';
  return `${n < 0 ? '-' : ''}${sym}${sep}${body}`;
}

module.exports = { digitsFor, toMinor, fromMinor, percentOf, formatMoney };
