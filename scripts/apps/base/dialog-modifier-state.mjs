/**
 * Normalize a signed integer modifier from dialog form data.
 *
 * @param {unknown} value Submitted value.
 * @param {number} [fallback=0] Fallback value.
 * @returns {number}
 */
export function normalizeDialogModifier(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

/**
 * Normalize a free-text modifier reason.
 *
 * @param {unknown} value Submitted value.
 * @returns {string}
 */
export function normalizeModifierReason(value) {
  return String(value ?? "").trim();
}

/**
 * Build a compact custom modifier payload shared by combat dialogs.
 *
 * @param {object} data Submitted form data.
 * @param {string} [valueKey="customAugment"] Numeric field name.
 * @param {string} [reasonKey="customAugmentReason"] Reason field name.
 * @returns {{value: number, reason: string}}
 */
export function customModifierState(data = {}, valueKey = "customAugment", reasonKey = "customAugmentReason") {
  return {
    value: normalizeDialogModifier(data?.[valueKey], 0),
    reason: normalizeModifierReason(data?.[reasonKey])
  };
}
