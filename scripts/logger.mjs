import { MODULE_ID } from "./constants.mjs";

/**
 * Emit a debug log only when the module debug setting is enabled.
 *
 * @param {...unknown} args Values forwarded to `console.debug`.
 * @returns {void}
 */
export function debug(...args) {
  if (!game.settings?.get(MODULE_ID, "debug")) return;
  console.debug(`${MODULE_ID} |`, ...args);
}

/**
 * Emit a module-prefixed warning.
 *
 * @param {...unknown} args Values forwarded to `console.warn`.
 * @returns {void}
 */
export function warn(...args) {
  console.warn(`${MODULE_ID} |`, ...args);
}

/**
 * Emit a module-prefixed error.
 *
 * @param {...unknown} args Values forwarded to `console.error`.
 * @returns {void}
 */
export function error(...args) {
  console.error(`${MODULE_ID} |`, ...args);
}
