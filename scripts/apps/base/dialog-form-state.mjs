export {
  captureFormValues,
  pickFormValues,
  restoreFormValues,
  validChoiceValue
} from "../target-refresh-helpers.mjs";

/**
 * Read a field value from captured form state.
 *
 * @param {Record<string, string[]>} values Captured values.
 * @param {string} name Field name.
 * @param {string} [fallback=""] Fallback value.
 * @returns {string}
 */
export function capturedValue(values, name, fallback = "") {
  const stored = values?.[name];
  return Array.isArray(stored) ? String(stored.at(-1) ?? fallback) : fallback;
}
