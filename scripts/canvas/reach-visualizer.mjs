import {
  MODULE_ID,
  REACH_VISUALIZER_SHAPE,
  REACH_VISUALIZER_VISIBILITY
} from "../constants.mjs";
import {
  getReachVisualizerSettings,
  normalizeReachVisualizerSettings,
  setReachVisualizerSettings
} from "./reach-visualizer-config.mjs";
import { colorForToken } from "./overlay-colors.mjs";
import {
  gridSizePixels,
  isSquareGrid as sceneIsSquareGrid,
  sceneGridDistance as sceneDistance,
  tokenCenterPoint,
  tokenVisibleToUser
} from "./overlay-geometry.mjs";
import { CanvasOverlayManager } from "./overlay-manager.mjs";
import { circleReachRadius, squareReachOutline } from "./reach-visualizer-geometry.mjs";
import { drawSolidCircle, drawSolidGridSegments } from "./reach-visualizer-render.mjs";
import { reachUnitsForActor, reachUnitsForCombatant } from "../combat/movement-controller.mjs";
import { combatantForTokenDocument } from "../combat/combatant-token-resolution.mjs";

const OVERLAY_NAME = "aov-skjaldborg-reach-visualizer-overlay";
const CONTROL_TOOL_NAME = "aov-skjaldborg-reach-visualizer";

let hooksRegistered = false;
let settings = normalizeReachVisualizerSettings({});
let enabled = false;
let hoveredTokenId = null;
const tokenOverlays = new Map();

function gridSize() {
  return gridSizePixels();
}

function sceneGridDistance() {
  return sceneDistance();
}

function isVisibleToken(token) {
  return tokenVisibleToUser(token, game.user);
}

function tokenId(token) {
  return String(token?.id ?? token?.document?.id ?? "").trim();
}

function tokenCenter(token) {
  return tokenCenterPoint(token, gridSize());
}

function tokenDispositionColor(token) {
  return colorForToken(token);
}

function reachUnitsForToken(token) {
  const combat = game.combat;
  const combatant = token && combat?.started
    ? combatantForTokenDocument(combat, token?.document ?? token)
    : null;
  if (combatant) return reachUnitsForCombatant(combatant);
  return reachUnitsForActor(token?.actor);
}

function isSquareGrid() {
  return sceneIsSquareGrid(canvas?.scene?.grid);
}

function destroyChild(child) {
  try {
    child?.destroy?.({ children: true });
  } catch (_exception) {
    child?.destroy?.();
  }
}

function ensureOverlayEntry(token, parent = overlayManager.container) {
  const id = tokenId(token);
  if (!id) return null;
  const existing = tokenOverlays.get(id);
  if (existing?.container && !existing.container.destroyed) return existing;
  const PIXI = globalThis.PIXI ?? null;
  if (!parent || !PIXI?.Container || !PIXI?.Graphics) return null;
  const container = new PIXI.Container();
  container.name = `${OVERLAY_NAME}-${id}`;
  container.interactiveChildren = false;
  try {
    container.eventMode = "none";
  } catch (_exception) {
    // Older PIXI builds ignore eventMode.
  }
  const graphics = new PIXI.Graphics();
  container.addChild(graphics);
  parent.addChild(container);
  const entry = { container, graphics, lastKey: "" };
  tokenOverlays.set(id, entry);
  return entry;
}

function destroyOverlayEntry(id) {
  const entry = tokenOverlays.get(id);
  if (!entry) return;
  try {
    entry.container?.parent?.removeChild?.(entry.container);
  } catch (_exception) {
    // no-op
  }
  destroyChild(entry.container);
  tokenOverlays.delete(id);
}

function candidateTokens() {
  if (!enabled || !settings.enabled) return [];
  return Array.from(canvas?.tokens?.placeables ?? []).filter(isVisibleToken);
}

function displayTokens(candidates) {
  if (settings.visibility === REACH_VISUALIZER_VISIBILITY.HOVER) {
    return hoveredTokenId
      ? candidates.filter(token => tokenId(token) === hoveredTokenId)
      : [];
  }
  return candidates;
}

function alphaForToken(token) {
  if (settings.visibility !== REACH_VISUALIZER_VISIBILITY.DYNAMIC) return settings.opacity;
  const id = tokenId(token);
  const controlled = canvas?.tokens?.controlled ?? [];
  const active = id && (hoveredTokenId === id || controlled.some(controlledToken => tokenId(controlledToken) === id));
  return active ? settings.activeOpacity : settings.passiveOpacity;
}

function renderKeyForToken(token, reachUnits, alpha, shape) {
  const document = token?.document ?? token;
  return [
    shape,
    reachUnits,
    alpha,
    settings.lineWidth,
    tokenDispositionColor(token),
    Number(token?.position?.x ?? document?.x ?? document?._source?.x ?? 0),
    Number(token?.position?.y ?? document?.y ?? document?._source?.y ?? 0),
    Number(document?.width ?? document?._source?.width ?? 1),
    Number(document?.height ?? document?._source?.height ?? 1),
    gridSize(),
    sceneGridDistance(),
    String(canvas?.scene?.grid?.type ?? "")
  ].join("|");
}

function drawTokenOverlay(token) {
  const entry = ensureOverlayEntry(token);
  const center = tokenCenter(token);
  if (!entry || !center) return;
  const reachUnits = Math.max(1, Math.round(Number(reachUnitsForToken(token)) || 1));
  const alpha = alphaForToken(token);
  const useGrid = settings.shape === REACH_VISUALIZER_SHAPE.GRID && isSquareGrid();
  const shape = useGrid ? REACH_VISUALIZER_SHAPE.GRID : REACH_VISUALIZER_SHAPE.CIRCLE;
  const key = renderKeyForToken(token, reachUnits, alpha, shape);
  entry.container.alpha = alpha;
  entry.container.position.set(0, 0);
  entry.graphics.position?.set?.(0, 0);
  if (entry.lastKey === key) return;
  entry.lastKey = key;
  entry.graphics.clear?.();
  const color = tokenDispositionColor(token);
  const lineWidth = settings.lineWidth;
  if (useGrid) {
    const outline = squareReachOutline(token, reachUnits, gridSize());
    drawSolidGridSegments(entry.graphics, outline.segments, lineWidth, color);
  } else {
    const radius = circleReachRadius(token, reachUnits, gridSize());
    entry.graphics.position?.set?.(center.x, center.y);
    drawSolidCircle(entry.graphics, radius, lineWidth, color);
  }
}

function syncOverlayEntries(tokens) {
  const wanted = new Set(tokens.map(token => tokenId(token)).filter(Boolean));
  for (const id of Array.from(tokenOverlays.keys())) {
    if (!wanted.has(id)) destroyOverlayEntry(id);
  }
  const parent = overlayManager.container;
  for (const token of tokens) ensureOverlayEntry(token, parent);
}

function drawReachOverlays({ container }) {
  if (!enabled || !settings.enabled) {
    syncOverlayEntries([]);
    if (container) container.visible = false;
    return;
  }
  container.visible = true;
  const display = displayTokens(candidateTokens());
  syncOverlayEntries(display);
  for (const token of display) drawTokenOverlay(token);
}

const overlayManager = new CanvasOverlayManager({
  id: OVERLAY_NAME,
  layer: "tokens",
  zIndex: -1000,
  draw: drawReachOverlays
});

function scheduleRedraw(reason = "reach-visualizer") {
  overlayManager.scheduleRedraw(reason);
}

function setEnabled(value) {
  enabled = Boolean(value);
  const overlay = overlayManager.container;
  if (overlay) overlay.visible = enabled;
  if (!enabled) syncOverlayEntries([]);
}

/**
 * Toggle the client-side reach visualizer.
 *
 * @param {boolean} value Enabled state.
 * @returns {Promise<void>}
 */
export async function toggleReachVisualizer(value) {
  const next = await setReachVisualizerSettings({ enabled: Boolean(value) });
  applyReachVisualizerSettings(next);
  ui.controls?.render?.({ reset: true });
}

/**
 * Apply current or supplied reach visualizer settings.
 *
 * @param {object|null} [value=null] Optional normalized settings.
 * @returns {void}
 */
export function applyReachVisualizerSettings(value = null) {
  settings = normalizeReachVisualizerSettings(value ?? getReachVisualizerSettings());
  setEnabled(settings.enabled);
  scheduleRedraw("settings");
}

/**
 * Return whether the reach visualizer is currently enabled.
 *
 * @returns {boolean}
 */
export function isReachVisualizerEnabled() {
  return enabled && settings.enabled;
}

function tokenIdsForActor(actor) {
  const actorId = String(actor?.id ?? "");
  if (!actorId) return [];
  return Array.from(canvas?.tokens?.placeables ?? [])
    .filter(token => String(token?.actor?.id ?? "") === actorId)
    .map(tokenId)
    .filter(Boolean);
}

function refreshTokenIds(ids) {
  for (const id of ids ?? []) {
    const entry = tokenOverlays.get(String(id));
    if (entry) entry.lastKey = "";
  }
  scheduleRedraw("tokens");
}

function registerControlsHook(hooks) {
  hooks.on("getSceneControlButtons", controls => {
    const tokenControl = controls?.tokens;
    if (!tokenControl?.tools) return;
    const existingOrders = Object.values(tokenControl.tools)
      .map(tool => Number(tool?.order))
      .filter(Number.isFinite);
    const order = existingOrders.length ? Math.max(...existingOrders) + 1 : Object.keys(tokenControl.tools).length;
    tokenControl.tools[CONTROL_TOOL_NAME] = {
      name: CONTROL_TOOL_NAME,
      title: settings.enabled
        ? "AOV_SKJALDBORG.Controls.DisableReachVisualizer"
        : "AOV_SKJALDBORG.Controls.EnableReachVisualizer",
      icon: "fa-solid fa-bullseye",
      button: true,
      active: settings.enabled,
      visible: true,
      order,
      onChange: () => toggleReachVisualizer(!settings.enabled)
    };
  });
}

/**
 * Register reach visualizer hooks and return its public API.
 *
 * @returns {{toggle: function(boolean): Promise<void>, applySettings: function(object=): void, redraw: function(): void, isEnabled: function(): boolean}}
 */
export function registerReachVisualizerHooks(hooks = globalThis.Hooks) {
  if (!hooksRegistered) {
    hooksRegistered = true;
    overlayManager.registerHooks(Hooks);
    registerControlsHook(hooks);
    hooks.on("canvasReady", () => {
      applyReachVisualizerSettings();
    });
    hooks.on("canvasTearDown", () => {
      tokenOverlays.clear();
      hoveredTokenId = null;
    });
    hooks.on("hoverToken", (token, hovered) => {
      const id = tokenId(token);
      hoveredTokenId = hovered ? id : hoveredTokenId === id ? null : hoveredTokenId;
      if (settings.visibility === REACH_VISUALIZER_VISIBILITY.HOVER) scheduleRedraw("hover-token");
      else refreshTokenIds([id]);
    });
    hooks.on("controlToken", token => refreshTokenIds([tokenId(token)]));
    hooks.on("refreshToken", token => refreshTokenIds([tokenId(token)]));
    hooks.on("updateToken", document => refreshTokenIds([String(document?.id ?? document?._id ?? "")]));
    hooks.on("createToken", scheduleRedraw);
    hooks.on("deleteToken", document => {
      destroyOverlayEntry(String(document?.id ?? document?._id ?? ""));
      scheduleRedraw("delete-token");
    });
    hooks.on("updateCombatant", combatant => refreshTokenIds([String(combatant?.tokenId ?? combatant?.token?.id ?? "")]));
    hooks.on("updateCombat", scheduleRedraw);
    hooks.on("updateActor", (actor, changed) => {
      const relevant = foundry.utils.hasProperty(changed ?? {}, `flags.${MODULE_ID}.readiedWeapons`)
        || foundry.utils.hasProperty(changed ?? {}, `flags.${MODULE_ID}.readiedWeaponId`);
      if (relevant) refreshTokenIds(tokenIdsForActor(actor));
    });
    hooks.on("updateItem", (item, changed) => {
      if (item?.type !== "weapon" || !item.parent) return;
      const relevant = foundry.utils.hasProperty(changed ?? {}, "system.length")
        || foundry.utils.hasProperty(changed ?? {}, "system.equipStatus")
        || foundry.utils.hasProperty(changed ?? {}, "system.weaponType");
      if (relevant) refreshTokenIds(tokenIdsForActor(item.parent));
    });
    hooks.on("deleteItem", item => {
      if (item?.type === "weapon" && item.parent) refreshTokenIds(tokenIdsForActor(item.parent));
    });
  }
  applyReachVisualizerSettings();
  ui.controls?.render?.({ reset: true });
  return {
    toggle: toggleReachVisualizer,
    applySettings: applyReachVisualizerSettings,
    redraw: () => {
      for (const entry of tokenOverlays.values()) entry.lastKey = "";
      scheduleRedraw("api");
    },
    isEnabled: isReachVisualizerEnabled
  };
}

export const __test = Object.freeze({
  candidateTokens,
  displayTokens,
  overlayManager,
  reachUnitsForToken,
  tokenDispositionColor
});
