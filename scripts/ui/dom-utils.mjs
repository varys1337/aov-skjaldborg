import { MODULE_ID } from "../constants.mjs";

/**
 * Escape text before inserting module-generated strings into HTML snippets.
 *
 * @param {unknown} value Candidate text.
 * @returns {string}
 */
export function htmlEscape(value) {
  const div = document.createElement("div");
  div.textContent = String(value ?? "");
  return div.innerHTML;
}

/**
 * Resolve the shared action-interface theme class.
 *
 * @returns {"skj-theme-aov"|"skj-theme-classic"}
 */
export function actionThemeClass() {
  try {
    return game.settings.get(MODULE_ID, "actionUiTheme") === "classic"
      ? "skj-theme-classic"
      : "skj-theme-aov";
  } catch (_exception) {
    return "skj-theme-aov";
  }
}

/**
 * Detect whether a texture or portrait source should be rendered as video.
 *
 * @param {unknown} source Media source path.
 * @returns {boolean}
 */
export function isVideoSource(source) {
  return /\.(?:webm|mp4|m4v|ogv|ogg)(?:$|[?#])/i.test(String(source ?? ""));
}

/**
 * Resolve a portrait source for combat dialogs.
 *
 * Actor art is the module's display standard for dialog previews. Token art is
 * only used as a fallback when the Actor has no portrait configured.
 *
 * @param {Actor|object|null|undefined} actor Actor document or plain object.
 * @param {Token|TokenDocument|object|null|undefined} [token=null] Token placeable or document fallback.
 * @returns {string}
 */
export function actorPortraitSource(actor, token = null) {
  const actorImg = String(actor?.img ?? "").trim();
  if (actorImg) return actorImg;
  return String(
    token?.document?.texture?.src
    ?? token?.texture?.src
    ?? token?.img
    ?? token?.object?.document?.texture?.src
    ?? token?.object?.texture?.src
    ?? ""
  ).trim();
}

/**
 * Convert an unknown value to a finite number.
 *
 * @param {unknown} value Candidate number.
 * @param {number|null} [fallback=null] Fallback value.
 * @returns {number|null}
 */
export function finiteNumber(value, fallback = null) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

/**
 * Localize a key while retaining a readable fallback if the key is missing.
 *
 * @param {string} key Localization key.
 * @param {string} fallback Fallback label.
 * @returns {string}
 */
export function localizeOrFallback(key, fallback) {
  const localized = game.i18n.localize(key);
  return localized === key ? fallback : localized;
}

/**
 * Apply the standard Enter/Escape commit interaction for inline numeric inputs.
 *
 * @param {KeyboardEvent} event Input key event.
 * @returns {boolean} Whether the event was handled.
 */
export function handleCommitInputKeydown(event) {
  const input = event.target;
  if (!(input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement)) return false;
  if (event.key === "Enter") {
    event.preventDefault();
    input.blur();
    return true;
  }
  if (event.key === "Escape") {
    event.preventDefault();
    input.value = input.dataset.originalValue ?? input.defaultValue;
    input.blur();
    return true;
  }
  return false;
}
