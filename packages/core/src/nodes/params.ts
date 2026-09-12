/**
 * Coercion for parameters the runtime cannot take at face value.
 *
 * Everything here exists because a number field is a text input underneath: it
 * hands back an empty string when someone clears it, and `Number('')` is 0.
 */

/**
 * A timeout in milliseconds, or the fallback when the value is missing, blank
 * or nonsense.
 *
 * Zero is the dangerous case rather than an obvious one: `setTimeout(fn, 0)`
 * and `AbortSignal.timeout(0)` both fire on the next tick, so a cleared timeout
 * field would abort every request before it left the process.
 */
export function resolveTimeout(value: unknown, fallback: number, max: number): number {
  if (value === undefined || value === null || value === '') return fallback;

  const ms = Number(value);
  if (!Number.isFinite(ms) || ms <= 0) return fallback;

  return Math.min(Math.round(ms), max);
}
