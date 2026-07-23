import { ACTION_CATEGORIES, INTENT_STATUS } from "../constants.mjs";
import { AoVAdapter } from "../adapter/aov-adapter.mjs";
import { getCombatState, getCombatantState } from "../combat/state.mjs";
import { prepareIntentActions } from "../ui/action-catalog.mjs";
import { getCombatOptions } from "../combat/weapon-state.mjs";
import { performanceDiagnostics } from "../performance/performance-monitor.mjs";
import { RenderCoordinator } from "../ui/render-coordinator.mjs";
import { collectionArray } from "../utils/document-data.mjs";

const INDICATOR_LAYER_ID = "skj-token-intent-layer";
const DISPLAYABLE_STATUSES = new Set([INTENT_STATUS.COMMITTED, INTENT_STATUS.HELD]);
const USE_TRANSFORM_POSITIONING = false;

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
const movingTokenIds = new Set();

let hooksRegistered = false;
let rebuildFrame = 0;
let positionFrame = 0;
let activeTicker = null;
let lastViewportSignature = "";

/**
 * Resolve or create the fixed viewport layer used by token intent indicators.
 *
 * Foundry v14 exposes Canvas#clientCoordinatesFromCanvas for converting a
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
  if (USE_TRANSFORM_POSITIONING) {
    const transform = `translate3d(${clientX}px, ${clientY}px, 0)`;
    if (force || element.style.transform !== transform) {
      element.style.transform = transform;
      performanceDiagnostics.count("intentIndicators.domWrites");
    }
  } else {
    if (force || entry.clientX !== clientX) {
      element.style.left = `${clientX}px`;
      performanceDiagnostics.count("intentIndicators.domWrites");
    }
    if (force || entry.clientY !== clientY) {
      element.style.top = `${clientY}px`;
      performanceDiagnostics.count("intentIndicators.domWrites");
    }
  }

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
function updateTokenIntentIndicatorPositions({ movingOnly = false } = {}) {
  performanceDiagnostics.count("intentIndicators.positionChecks");
  const signature = viewportSignature();
  const viewportChanged = signature !== lastViewportSignature;
  lastViewportSignature = signature;
  const entries = movingOnly && !viewportChanged
    ? Array.from(indicators.values()).filter(entry => movingTokenIds.has(entry.token?.id))
    : indicators.values();
  for (const entry of entries) positionIndicator(entry, viewportChanged);
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

function invalidateTokenIntentIndicators(detail = {}) {
  if (detail.positionOnly === true) positionTokenIntentIndicators();
  else refreshTokenIntentIndicators(detail);
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
  if (!indicators.size || !movingTokenIds.size || !canvas?.ready) {
    detachIndicatorTicker();
    return;
  }
  updateTokenIntentIndicatorPositions({ movingOnly: true });
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
  movingTokenIds.clear();
  document.getElementById(INDICATOR_LAYER_ID)?.remove();
}

/**
 * Build an exact lookup of action categories to the icons and labels already
 * used by the Combat Action HUD.
 *
 * @returns {Map<string, {icon: string, name: string}>}
 */
function intentActionLookup() {
  return new Map(prepareIntentActions({ includeWait: true, includeUtility: false }).map(action => [action.id, {
    icon: action.icon,
    name: action.name
  }]));
}

function createMarker({ combatant, token, className, category, icon, tooltip }) {
  const marker = document.createElement("div");
  marker.className = className;
  marker.dataset.combatantId = combatant.id;
  marker.dataset.tokenId = token.id;
  marker.dataset.actionCategory = category;
  marker.setAttribute("data-tooltip", tooltip);
  marker.setAttribute("aria-label", tooltip);
  marker.setAttribute("role", "img");
  marker.innerHTML = `<i class="${icon}" inert></i>`;
  return marker;
}

function shieldCoverMarkerData(actor) {
  const cover = getCombatOptions(actor).shieldCover;
  const shieldId = String(cover?.shieldId ?? "");
  const locationIds = Array.from(new Set((cover?.locationIds ?? []).map(String).filter(Boolean)));
  if (!shieldId || !locationIds.length) return null;
  const shield = actor?.items?.get?.(shieldId) ?? null;
  if (!shield) return null;
  const locations = locationIds
    .map(id => actor?.items?.get?.(id)?.name ?? "")
    .filter(Boolean);
  const locationText = locations.length
    ? locations.join(", ")
    : game.i18n.localize("AOV_SKJALDBORG.MissileDialog.ShieldCoverUnknownLocations");
  return {
    shield,
    tooltip: game.i18n.format("AOV_SKJALDBORG.MissileDialog.ShieldCoverMarkerTooltip", {
      shield: shield.name ?? "",
      locations: locationText
    })
  };
}

function indicatorMatchesTargets(key, entry, combatantIds, tokenIds) {
  const combatantId = key.split(":")[0];
  return combatantIds.has(combatantId) || tokenIds.has(entry?.token?.id);
}

function removeTargetedIndicators(combatantIds, tokenIds) {
  for (const [key, entry] of Array.from(indicators.entries())) {
    if (!indicatorMatchesTargets(key, entry, combatantIds, tokenIds)) continue;
    entry.element?.remove?.();
    indicators.delete(key);
  }
}

function combatantMarkers(combatant, actionLookup) {
  const state = getCombatantState(combatant);
  const status = state.intent?.status;
  const category = state.intent?.actionCategory;
  const token = resolveCombatantToken(combatant);
  if (!token) return [];

  const markers = [];
  if (DISPLAYABLE_STATUSES.has(status) && Object.values(ACTION_CATEGORIES).includes(category)) {
    const action = actionLookup.get(category);
    if (action) {
      const publicText = category === ACTION_CATEGORIES.OTHER
        ? String(state.intent?.publicText ?? "").trim()
        : "";
      const tooltip = publicText ? `${action.name}: ${publicText}` : action.name;
      markers.push(createMarker({
        combatant,
        token,
        className: `skj-token-intent-indicator ${status}`,
        category,
        icon: action.icon,
        tooltip
      }));
    }
  }

  const shieldCover = shieldCoverMarkerData(combatant.actor);
  if (shieldCover) {
    markers.push(createMarker({
      combatant,
      token,
      className: "skj-token-intent-indicator shield-cover",
      category: "shield-cover",
      icon: "fa-solid fa-shield-halved",
      tooltip: shieldCover.tooltip
    }));
  }

  if (getCombatOptions(combatant.actor).shieldwall.enabled) {
    markers.push(createMarker({
      combatant,
      token,
      className: "skj-token-intent-indicator shieldwall",
      category: "shieldwall",
      icon: "fa-solid fa-shield",
      tooltip: game.i18n.localize("AOV_SKJALDBORG.Utility.ShieldwallEnabled")
    }));
  }

  return markers.map((marker, index) => ({ marker, token, key: `${combatant.id}:${marker.dataset.actionCategory}:${index}` }));
}

function appendCombatantIndicators(layer, combatant, actionLookup) {
  for (const { marker, token, key } of combatantMarkers(combatant, actionLookup)) {
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
    indicators.set(key, entry);
    positionIndicator(entry, true);
  }
}

/**
 * Rebuild the canvas indicators from authoritative persisted Combatant state.
 *
 * Uncommitted combatants are deliberately omitted because their default action
 * category is not a declaration. Committed and held declarations remain visible
 * through all phases until round state resets them.
 *
 * @param {{combatantIds?: string[], tokenIds?: string[]}} [detail={}] Optional targeted invalidation detail.
 * @returns {void}
 */
export function refreshTokenIntentIndicators(detail = {}) {
  rebuildFrame = 0;
  performanceDiagnostics.count("intentIndicators.rebuild");
  const layer = ensureIndicatorLayer();
  const combat = game.combat;
  if (
    !layer
    || !AoVAdapter.isAoVWorld()
    || !AoVAdapter.enabledSetting
    || !combat?.started
    || !getCombatState(combat).enabled
  ) {
    clearTokenIntentIndicators();
    return;
  }

  const actionLookup = intentActionLookup();
  const combatants = collectionArray(combat.combatants);
  const targetCombatantIds = new Set((detail.combatantIds ?? []).map(String).filter(Boolean));
  const targetTokenIds = new Set((detail.tokenIds ?? []).map(String).filter(Boolean));
  const targeted = targetCombatantIds.size > 0 || targetTokenIds.size > 0;
  performanceDiagnostics.count(
    targeted ? "intentIndicators.rebuild.targeted" : "intentIndicators.rebuild.full",
    1,
    {
      combatantIds: Array.from(targetCombatantIds),
      tokenIds: Array.from(targetTokenIds),
      reason: detail.reason ?? null
    }
  );

  if (targeted && indicators.size) {
    const selectedCombatants = combatants.filter(combatant =>
      targetCombatantIds.has(String(combatant.id))
      || targetTokenIds.has(String(combatant.tokenId ?? combatant.token?.id ?? ""))
    );
    removeTargetedIndicators(targetCombatantIds, targetTokenIds);
    for (const combatant of selectedCombatants) appendCombatantIndicators(layer, combatant, actionLookup);
    performanceDiagnostics.count("intentIndicators.visible", indicators.size);
    if (indicators.size && movingTokenIds.size) attachIndicatorTicker();
    else detachIndicatorTicker();
    return;
  }

  layer.replaceChildren();
  indicators.clear();
  lastViewportSignature = "";

  for (const combatant of combatants) appendCombatantIndicators(layer, combatant, actionLookup);
  performanceDiagnostics.count("intentIndicators.visible", indicators.size);

  if (indicators.size && movingTokenIds.size) attachIndicatorTicker();
  else detachIndicatorTicker();
}

/**
 * Coalesce document and canvas changes into one indicator rebuild per frame.
 *
 * @returns {void}
 */
export function scheduleTokenIntentIndicatorRefresh(detail = {}) {
  RenderCoordinator.invalidate("intentIndicators", {
    ...detail,
    reason: detail.reason ?? "indicator-refresh"
  });
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

function tokenIdFromDocument(document) {
  return document?.id ?? document?._id ?? null;
}

function tokenIdFromCombatant(combatant) {
  return combatant?.tokenId ?? combatant?.token?.id ?? combatant?.token?.document?.id ?? null;
}

function actorCombatantIndicatorDetail(actor, reason) {
  const actorId = actor?.id ?? null;
  if (!actorId) return { reason };
  const combatants = collectionArray(game.combat?.combatants);
  const selected = combatants.filter(combatant =>
    combatant.actor?.id === actorId || combatant.token?.actor?.id === actorId
  );
  return {
    combatantIds: selected.map(combatant => combatant.id).filter(Boolean),
    tokenIds: selected.map(tokenIdFromCombatant).filter(Boolean),
    reason
  };
}

function markTokenMoving(document) {
  const tokenId = tokenIdFromDocument(document);
  if (!tokenId) return;
  movingTokenIds.add(tokenId);
  if (indicators.size) attachIndicatorTicker();
  RenderCoordinator.invalidate("intentIndicators", {
    positionOnly: true,
    tokenIds: [tokenId],
    reason: "token-moving"
  });
}

function markTokenStatic(document) {
  const tokenId = tokenIdFromDocument(document);
  if (!tokenId) return;
  movingTokenIds.delete(tokenId);
  RenderCoordinator.invalidate("intentIndicators", {
    positionOnly: true,
    tokenIds: [tokenId],
    reason: "token-static"
  });
  if (!movingTokenIds.size) detachIndicatorTicker();
}

/**
 * Register Foundry v14 canvas and document hooks for visual intent markers.
 *
 * @returns {void}
 */
export function registerTokenIntentIndicatorHooks(hooks = globalThis.Hooks) {
  if (hooksRegistered) return;
  hooksRegistered = true;

  RenderCoordinator.register("intentIndicators", invalidateTokenIntentIndicators);

  hooks.on("canvasReady", () => scheduleTokenIntentIndicatorRefresh({ reason: "canvas-ready" }));
  hooks.on("canvasPan", () => RenderCoordinator.invalidate("intentIndicators", { positionOnly: true, reason: "canvas-pan" }));
  hooks.on("canvasTearDown", clearTokenIntentIndicators);
  hooks.on("drawToken", token => scheduleTokenIntentIndicatorRefresh({
    tokenIds: [tokenIdFromDocument(token?.document ?? token)].filter(Boolean),
    reason: "token-draw"
  }));
  hooks.on("refreshToken", updateIndicatorTokenReference);
  hooks.on("destroyToken", token => scheduleTokenIntentIndicatorRefresh({
    tokenIds: [tokenIdFromDocument(token?.document ?? token)].filter(Boolean),
    reason: "token-destroy"
  }));
  hooks.on("updateToken", (document, changes) => {
    const tokenId = tokenIdFromDocument(document);
    if (changes?.x !== undefined || changes?.y !== undefined || changes?.elevation !== undefined) {
      RenderCoordinator.invalidate("intentIndicators", {
        positionOnly: true,
        tokenIds: [tokenId].filter(Boolean),
        reason: "token-update-position"
      });
    }
  });
  hooks.on("preMoveToken", markTokenMoving);
  hooks.on("moveToken", markTokenMoving);
  hooks.on("pauseToken", markTokenStatic);
  hooks.on("stopToken", markTokenStatic);
  hooks.on("createCombatant", combatant => scheduleTokenIntentIndicatorRefresh({
    combatantIds: [combatant?.id].filter(Boolean),
    tokenIds: [tokenIdFromCombatant(combatant)].filter(Boolean),
    reason: "combatant-create"
  }));
  hooks.on("updateCombatant", combatant => scheduleTokenIntentIndicatorRefresh({
    combatantIds: [combatant?.id].filter(Boolean),
    tokenIds: [tokenIdFromCombatant(combatant)].filter(Boolean),
    reason: "combatant-update"
  }));
  hooks.on("deleteCombatant", combatant => scheduleTokenIntentIndicatorRefresh({
    combatantIds: [combatant?.id].filter(Boolean),
    tokenIds: [tokenIdFromCombatant(combatant)].filter(Boolean),
    reason: "combatant-delete"
  }));
  hooks.on("updateActor", (actor, changes) => {
    if (changes?.flags?.["aov-skjaldborg"]?.combatOptions !== undefined) {
      scheduleTokenIntentIndicatorRefresh(actorCombatantIndicatorDetail(actor, "actor-combat-options"));
    }
  });
  hooks.on("updateCombat", () => scheduleTokenIntentIndicatorRefresh({ reason: "combat-update" }));
  hooks.on("deleteCombat", clearTokenIntentIndicators);

  window.addEventListener("resize", () => RenderCoordinator.invalidate("intentIndicators", { positionOnly: true, reason: "resize" }));
  scheduleTokenIntentIndicatorRefresh();
}
