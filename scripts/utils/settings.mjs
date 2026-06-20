/**
 * Coerce a numeric settings value to its supported range and step.
 *
 * @param {unknown} value Submitted value.
 * @param {number} fallback Default value.
 * @param {{min: number, max: number, step: number}} limits Numeric constraints.
 * @returns {number}
 */
export function normalizeNumberSetting(value, fallback, limits) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  const clamped = Math.min(limits.max, Math.max(limits.min, numeric));
  const stepped = limits.min + Math.round((clamped - limits.min) / limits.step) * limits.step;
  const decimals = String(limits.step).split(".")[1]?.length ?? 0;
  return Number(stepped.toFixed(decimals));
}
