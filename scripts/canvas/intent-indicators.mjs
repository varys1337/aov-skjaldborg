import { ACTION_CATEGORIES, INTENT_STATUS } from "../constants.mjs";
import { AoVAdapter } from "../adapter/aov-adapter.mjs";
import { getCombatantState } from "../combat/state.mjs";
import { prepareIntentActions } from "../ui/action-catalog.mjs";

const INDICATOR_LAYER_ID = "skj-token-intent-layer";
const DISPLAYABLE_STATUSES = new Set([INTENT_STATUS.COMMITTED, INTENT_STATUS.HELD]);

/**
 * @typedef {object} IntentIndicatorEntry
 * @property {HTMLElement} element Marker element.
 * @property {Token} token Current Token placeable.
 * @property {number|null} canvasX Last observed scene-local horizontal coordinate.
 * @property {number|null} canvasY Last observed scene-local vertical coordinate.
 * @property {number|null} clientX Last applied client horizontal coordinate.
 * @property {number|null} clientY Last applied client vertical coordinate.
 * @property {boolean|null} visible Last applied visibility state.
 */

/** @type {Map<string, IntentIndicatorEntry>} */
const indicators = new Map();

let hooksRegistered = false;
let rebuildFrame = 0;
let positionFrame = 0;
let activeTicker = null;
let lastViewportSignature = "";

/**
 * Resolve or create the fixed viewport layer used by token intent indicators.
 *
 * Foundry v13 exposes Canvas#clientCoordinatesFromCanvas for converting a
 * scene-local point to viewport coordinates. Keeping the markers in a fixed
 * DOM layer lets them reuse the Action HUD's Font Awesome classes and Foundry
 * tooltip service without coupling them to movement automation.
 *
 * @returns {HTMLElement|null}
 */
function ensureIndicatorLayer() {
  if (!canvas?.ready) return null;
  let layer = document.getElementById(INDICATOR_LAYER_ID);
  if (layer instanceof HTMLElement) return layer;

  layer = document.createElement("div");
  layer.id = INDICATOR_LAYER_ID;
  layer.className = "skj-token-intent-layer";
  document.body.append(layer);
  return layer;
}

/**
 * Read a compact signature for all viewport transforms that affect conversion
 * from scene coordinates to client coordinates.
 *
 * @returns {string}
 */
function viewportSignature() {
  const transform = canvas?.stage?.worldTransform;
  const viewRect = canvas?.app?.view?.getBoundingClientRect?.();
  return [
    Number(transform?.a ?? 0),
    Number(transform?.b ?? 0),
    Number(transform?.c ?? 0),
    Number(transform?.d ?? 0),
    Number(transform?.tx ?? 0),
    Number(transform?.ty ?? 0),
    Number(viewRect?.left ?? 0),
    Number(viewRect?.top ?? 0),
    Number(viewRect?.width ?? 0),
    Number(viewRect?.height ?? 0)
  ].join(":");
}

/**
 * Resolve the rendered top-center of a Token in scene-local canvas pixels.
 *
 * Token.position is preferred over document coordinates because it follows a
 * live PIXI movement animation. Token width is already expressed in canvas
 * pixels and remains independent of viewport pan and zoom.
 *
 * @param {Token} token Token placeable.
 * @returns {{x: number, y: number}|null}
 */
function tokenTopCenterCanvasPoint(token) {
  const positionX = Number(token?.position?.x);
  const positionY = Number(token?.position?.y);
  const documentX = Number(token?.document?.x);
  const documentY = Number(token?.document?.y);
  const width = Number(token?.w);
  const centerX = Number(token?.center?.x);

  const x = Number.isFinite(positionX) ? positionX : documentX;
  const y = Number.isFinite(positionY) ? positionY : documentY;
  const topCenterX = Number.isFinite(width) && Number.isFinite(x)
    ? x + (width / 2)
    : centerX;

  if (!Number.isFinite(topCenterX) || !Number.isFinite(y)) return null;
  return { x: topCenterX, y };
}

/**
 * Resolve the active canvas Token represented by a Combatant.
 *
 * @param {Combatant} combatant Combatant whose Token should receive a marker.
 * @returns {Token|null}
 */
function resolveCombatantToken(combatant) {
  const object = combatant?.token?.object;
  if (object?.document) return object;
  const tokenId = combatant?.tokenId ?? combatant?.token?.id;
  return tokenId ? canvas?.tokens?.get?.(tokenId) ?? null : null;
}

/**
 * Position one indicator above its Token.
 *
 * DOM writes are skipped unless the Token point, viewport transform, client
 * point, or visibility actually changed. This makes the ticker-based safety
 * net inexpensive while still following animated movement and camera motion.
 *
 * @param {IntentIndicatorEntry} entry Indicator cache entry.
 * @param {boolean} force Force client-coordinate recomputation.
 * @returns {void}
 */
function positionIndicator(entry, force = false) {
  const { element, token } = entry;
  const canvasPoint = tokenTopCenterCanvasPoint(token);
  const visible = token?.visible !== false && token?.isVisible !== false && !!canvasPoint;

  if (entry.visible !== visible) {
    element.hidden = !visible;
    entry.visible = visible;
  }
  if (!visible) return;

  const canvasChanged = entry.canvasX !== canvasPoint.x || entry.canvasY !== canvasPoint.y;
  if (!force && !canvasChanged) return;

  const clientPoint = canvas.clientCoordinatesFromCanvas(canvasPoint);
  if (!Number.isFinite(clientPoint?.x) || !Number.isFinite(clientPoint?.y)) {
    element.hidden = true;
    entry.visible = false;
    return;
  }

  const clientX = Math.round(clientPoint.x);
  const clientY = Math.round(clientPoint.y);
  if (force || entry.clientX !== clientX) element.style.left = `${clientX}px`;
  if (force || entry.clientY !== clientY) element.style.top = `${clientY}px`;

  entry.canvasX = canvasPoint.x;
  entry.canvasY = canvasPoint.y;
  entry.clientX = clientX;
  entry.clientY = clientY;
}

/**
 * Reposition all markers after camera, viewport, or Token transform changes.
 *
 * @returns {void}
 */
function updateTokenIntentIndicatorPositions() {
  const signature = viewportSignature();
  const viewportChanged = signature !== lastViewportSignature;
  lastViewportSignature = signature;
  for (const entry of indicators.values()) positionIndicator(entry, viewportChanged);
}

/**
 * Reposition all markers after camera, viewport, or Token transform changes.
 *
 * @returns {void}
 */
export function positionTokenIntentIndicators() {
  positionFrame = 0;
  updateTokenIntentIndicatorPositions();
}

/**
 * Coalesce camera and document notifications into one post-render position
 * update. Running on the next animation frame is important because canvasPan
 * may be dispatched before the final PIXI stage transform is painted.
 *
 * @returns {void}
 */
export function scheduleTokenIntentIndicatorPosition() {
  if (positionFrame) return;
  positionFrame = requestAnimationFrame(positionTokenIntentIndicators);
}

/**
 * Lightweight PIXI ticker callback used as a reliability safety net.
 *
 * Most frames perform only numeric comparisons. DOM writes occur only while a
 * Token is animating or the canvas transform has changed.
 *
 * @returns {void}
 */
function tickTokenIntentIndicators() {
  if (!indicators.size || !canvas?.ready) return;
  updateTokenIntentIndicatorPositions();
}

/**
 * Attach the marker position safety net to the current Canvas ticker.
 *
 * @returns {void}
 */
function attachIndicatorTicker() {
  const ticker = canvas?.app?.ticker;
  if (!ticker || activeTicker === ticker) return;
  if (activeTicker) activeTicker.remove(tickTokenIntentIndicators);
  ticker.add(tickTokenIntentIndicators);
  activeTicker = ticker;
}

/**
 * Release the Canvas ticker callback.
 *
 * @returns {void}
 */
function detachIndicatorTicker() {
  if (activeTicker) activeTicker.remove(tickTokenIntentIndicators);
  activeTicker = null;
}

/**
 * Remove the complete token intent overlay and release cached references.
 *
 * @returns {void}
 */
export function clearTokenIntentIndicators() {
  if (rebuildFrame) cancelAnimationFrame(rebuildFrame);
  if (positionFrame) cancelAnimationFrame(positionFrame);
  rebuildFrame = 0;
  positionFrame = 0;
  lastViewportSignature = "";
  detachIndicatorTicker();
  indicators.clear();
  document.getElementById(INDICATOR_LAYER_ID)?.remove();
}

/**
 * Build an exact lookup of action categories to the icons and labels already
 * used by the Combat Action HUD.
 *
 * @returns {Map<string, {icon: string, name: string}>}
 */
function intentActionLookup() {
  return new Map(prepareIntentActions().map(action => [action.id, {
    icon: action.icon,
    name: action.name
  }]));
}

/**
 * Rebuild the canvas indicators from authoritative persisted Combatant state.
 *
 * Uncommitted combatants are deliberately omitted because their default action
 * category is not a declaration. Committed and held declarations remain visible
 * through all phases until round state resets them.
 *
 * @returns {void}
 */
export function refreshTokenIntentIndicators() {
  rebuildFrame = 0;
  const layer = ensureIndicatorLayer();
  const combat = game.combat;
  if (!layer || !AoVAdapter.isAoVWorld() || !AoVAdapter.enabledSetting || !combat) {
    clearTokenIntentIndicators();
    return;
  }

  layer.replaceChildren();
  indicators.clear();
  lastViewportSignature = "";
  const actionLookup = intentActionLookup();

  for (const combatant of combat.combatants ?? []) {
    const state = getCombatantState(combatant);
    const status = state.intent?.status;
    const category = state.intent?.actionCategory;
    if (!DISPLAYABLE_STATUSES.has(status) || !Object.values(ACTION_CATEGORIES).includes(category)) continue;

    const token = resolveCombatantToken(combatant);
    const action = actionLookup.get(category);
    if (!token || !action) continue;

    const marker = document.createElement("div");
    marker.className = `skj-token-intent-indicator ${status}`;
    marker.dataset.combatantId = combatant.id;
    marker.dataset.tokenId = token.id;
    marker.dataset.actionCategory = category;
    marker.setAttribute("data-tooltip", action.name);
    marker.setAttribute("aria-label", action.name);
    marker.setAttribute("role", "img");
    marker.innerHTML = `<i class="${action.icon}" inert></i>`;
    layer.append(marker);

    const entry = {
      element: marker,
      token,
      canvasX: null,
      canvasY: null,
      clientX: null,
      clientY: null,
      visible: null
    };
    indicators.set(combatant.id, entry);
    positionIndicator(entry, true);
  }

  if (indicators.size) attachIndicatorTicker();
  else detachIndicatorTicker();
}

/**
 * Coalesce document and canvas changes into one indicator rebuild per frame.
 *
 * @returns {void}
 */
export function scheduleTokenIntentIndicatorRefresh() {
  if (rebuildFrame) return;
  rebuildFrame = requestAnimationFrame(refreshTokenIntentIndicators);
}

/**
 * Refresh the cached placeable reference associated with one Token.
 *
 * @param {Token} token Refreshed Token placeable.
 * @returns {void}
 */
function updateIndicatorTokenReference(token) {
  for (const entry of indicators.values()) {
    if (entry.token?.id !== token?.id) continue;
    entry.token = token;
    entry.canvasX = null;
    entry.canvasY = null;
  }
  scheduleTokenIntentIndicatorPosition();
}

/**
 * Register Foundry v13 canvas and document hooks for visual intent markers.
 *
 * @returns {void}
 */
export function registerTokenIntentIndicatorHooks() {
  if (hooksRegistered) return;
  hooksRegistered = true;

  Hooks.on("canvasReady", scheduleTokenIntentIndicatorRefresh);
  Hooks.on("canvasPan", scheduleTokenIntentIndicatorPosition);
  Hooks.on("canvasTearDown", clearTokenIntentIndicators);
  Hooks.on("drawToken", scheduleTokenIntentIndicatorRefresh);
  Hooks.on("refreshToken", updateIndicatorTokenReference);
  Hooks.on("destroyToken", scheduleTokenIntentIndicatorRefresh);
  Hooks.on("updateToken", scheduleTokenIntentIndicatorPosition);
  Hooks.on("createCombatant", scheduleTokenIntentIndicatorRefresh);
  Hooks.on("updateCombatant", scheduleTokenIntentIndicatorRefresh);
  Hooks.on("deleteCombatant", scheduleTokenIntentIndicatorRefresh);
  Hooks.on("updateCombat", scheduleTokenIntentIndicatorRefresh);
  Hooks.on("deleteCombat", clearTokenIntentIndicators);

  window.addEventListener("resize", scheduleTokenIntentIndicatorPosition);
  scheduleTokenIntentIndicatorRefresh();
}
