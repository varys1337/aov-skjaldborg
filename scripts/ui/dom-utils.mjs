import { MODULE_ID } from "../constants.mjs";
import { AOV_MONOCHROME_ACTION_IMAGES } from "../adapter/aov-contract.mjs";

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

/** Read the registered core preference without assuming a meaning for "". */
function coreUiConfiguration() {
  try {
    return game.settings.settings.has("core.uiConfig") ? game.settings.get("core", "uiConfig") : null;
  } catch (_exception) {
    return null;
  }
}

/**
 * Resolve Interface and Application palettes independently. The CSS fallback
 * reads Foundry's resolved surface token, never an OS preference or version guess.
 * @param {"interface"|"applications"} surface Surface whose preference to use.
 * @param {HTMLElement|null} [root=null] Existing application frame.
 * @param {object|null} [config=null] Configuration supplied by the setting hook.
 * @returns {"light"|"dark"|null}
 */
function actionColorMode(surface, root = null, config = null) {
  const mode = (config ?? coreUiConfiguration())?.colorScheme?.[surface];
  if (mode === "light" || mode === "dark") return mode;
  const source = surface === "interface"
    ? document.getElementById("interface")
    : root?.isConnected ? root : document.body;
  if (!source) return null;
  const resolved = getComputedStyle(source).getPropertyValue("--color-scheme").trim();
  return resolved === "light" || resolved === "dark" ? resolved : null;
}

/** Initial classes for module-owned frames, including native DialogV2 prompts. */
export function actionThemeClasses(surface = "applications") {
  const mode = actionColorMode(surface);
  return ["skj-themed-surface", actionThemeClass(), ...(mode ? [`skj-color-${mode}`] : [])];
}

/** Apply presentation only; retain all form DOM, values, focus and scroll. */
export function applyActionTheme(root, surface = "applications", config = null) {
  if (!(root instanceof HTMLElement)) return;
  root.classList.add("skj-themed-surface");
  const theme = actionThemeClass();
  for (const element of [root, ...root.querySelectorAll(".skj-theme-aov, .skj-theme-classic")]) {
    element.classList.toggle("skj-theme-aov", theme === "skj-theme-aov");
    element.classList.toggle("skj-theme-classic", theme === "skj-theme-classic");
  }
  const mode = actionColorMode(surface, root, config);
  if (!mode) return; // Retain the existing palette if core cannot resolve one.
  root.classList.toggle("skj-color-light", mode === "light");
  root.classList.toggle("skj-color-dark", mode === "dark");
}

/** Refresh only module-owned frames using the documented AppV2 registry. */
export function refreshActionThemes(config = null) {
  for (const app of foundry.applications.api.ApplicationV2.instances()) {
    if (!app.rendered) continue;
    const root = app.element;
    if (!root?.classList?.contains("skj-themed-surface")) continue;
    const surface = root.matches(".skj-actor-hotbar, .skj-action-ring-app") ? "interface" : "applications";
    applyActionTheme(root, surface, config);
  }
}

let actionThemeHooksRegistered = false;
/** One setting listener, registered through the feature registry. */
export function registerActionThemeHooks(hooks) {
  if (actionThemeHooksRegistered) return;
  actionThemeHooksRegistered = true;
  let refreshFrame = null;
  let pendingConfig = null;
  hooks.on("clientSettingChanged", (key, value) => {
    if (key !== "core.uiConfig") return;
    pendingConfig = value;
    if (refreshFrame !== null) return;
    // Run after the setting's synchronous callbacks, before the next paint.
    refreshFrame = requestAnimationFrame(() => {
      refreshFrame = null;
      const config = pendingConfig;
      pendingConfig = null;
      refreshActionThemes(config);
    });
  });
}

// Verified black/white AoV defaults only. Never infer monochrome from an SVG
// extension or Item type: those can also contain user-provided coloured art.
const MONOCHROME_ACTION_IMAGES = new Set(AOV_MONOCHROME_ACTION_IMAGES);

/** Mark only verified default art for palette-aware image treatment. */
export function isMonochromeActionImage(source) {
  return MONOCHROME_ACTION_IMAGES.has(String(source ?? "").replace(/^\//, "").split(/[?#]/, 1)[0]);
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
