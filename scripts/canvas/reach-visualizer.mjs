import {
  MODULE_ID,
  REACH_VISUALIZER_SHAPE,
  REACH_VISUALIZER_VISIBILITY
} from "../constants.mjs";
import { AoVAdapter } from "../adapter/aov-adapter.mjs";
import {
  getReachVisualizerSettings,
  normalizeReachVisualizerSettings,
  setReachVisualizerSettings
} from "./reach-visualizer-config.mjs";
import { circleReachRadius, isSquareGridType, squareReachOutline } from "./reach-visualizer-geometry.mjs";
import { drawSolidCircle, drawSolidGridSegments } from "./reach-visualizer-render.mjs";
import { reachUnitsForActor, reachUnitsForCombatant } from "../combat/movement-controller.mjs";

const OVERLAY_NAME = "aov-skjaldborg-reach-visualizer-overlay";
const CONTROL_TOOL_NAME = "aov-skjaldborg-reach-visualizer";
const DEFAULT_GRID_SIZE = 100;
const DISPOSITION_COLORS = Object.freeze({
  friendly: 0x42d392,
  neutral: 0xf0c04a,
  hostile: 0xff5c5c,
  fallback: 0x7cc7ff
});

let hooksRegistered = false;
let settings = normalizeReachVisualizerSettings({});
let enabled = false;
let overlayContainer = null;
let hoveredTokenId = null;
let pendingRedraw = false;
const tokenOverlays = new Map();

function pixi() {
  return globalThis.PIXI ?? null;
}

function gridSize() {
  return Number(canvas?.scene?.grid?.size ?? canvas?.grid?.size) || DEFAULT_GRID_SIZE;
}

function sceneGridDistance() {
  return Number(canvas?.scene?.grid?.distance) || 1;
}

function isCanvasReady() {
  return Boolean(canvas?.ready !== false && canvas?.scene && canvas?.tokens && typeof canvas.tokens.addChild === "function");
}

function isVisibleToken(token) {
  if (!token?.actor || !token?.document) return false;
  if (token.document.hidden && !game.user?.isGM) return false;
  if (token.visible === false || token.isVisible === false) return false;
  return true;
}

function tokenId(token) {
  return String(token?.id ?? token?.document?.id ?? "").trim();
}

function tokenCenter(token) {
  const center = token?.center;
  if (Number.isFinite(Number(center?.x)) && Number.isFinite(Number(center?.y))) return center;
  const document = token?.document ?? token;
  const size = gridSize();
  const x = Number(token?.position?.x ?? document?.x ?? document?._source?.x);
  const y = Number(token?.position?.y ?? document?.y ?? document?._source?.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const width = Math.max(1, Number(document?.width ?? document?._source?.width) || 1);
  const height = Math.max(1, Number(document?.height ?? document?._source?.height) || 1);
  return {
    x: x + ((width * size) / 2),
    y: y + ((height * size) / 2)
  };
}

function tokenDispositionColor(token) {
  const disposition = Number(token?.document?.disposition);
  const friendly = globalThis.CONST?.TOKEN_DISPOSITIONS?.FRIENDLY ?? 1;
  const hostile = globalThis.CONST?.TOKEN_DISPOSITIONS?.HOSTILE ?? -1;
  if (disposition === friendly) return DISPOSITION_COLORS.friendly;
  if (disposition === hostile) return DISPOSITION_COLORS.hostile;
  if (disposition === 0) return DISPOSITION_COLORS.neutral;
  return DISPOSITION_COLORS.fallback;
}

function resolveCombatantForToken(token, combat = game.combat) {
  if (!token || !combat?.started) return null;
  const byAdapter = AoVAdapter.getCombatantForToken?.(combat, token);
  if (byAdapter) return byAdapter;
  const id = tokenId(token);
  return id
    ? Array.from(combat.combatants ?? []).find(combatant => (combatant.tokenId ?? combatant.token?.id) === id) ?? null
    : null;
}

function reachUnitsForToken(token) {
  const combatant = resolveCombatantForToken(token);
  if (combatant) return reachUnitsForCombatant(combatant);
  return reachUnitsForActor(token?.actor);
}

function isSquareGrid() {
  return isSquareGridType(canvas?.scene?.grid?.type);
}

function ensureOverlayContainer() {
  if (!isCanvasReady()) return null;
  if (overlayContainer && !overlayContainer.destroyed) return overlayContainer;
  const PIXI = pixi();
  if (!PIXI?.Container) return null;
  overlayContainer = new PIXI.Container();
  overlayContainer.name = OVERLAY_NAME;
  overlayContainer.sortableChildren = true;
  overlayContainer.zIndex = -1000;
  overlayContainer.interactiveChildren = false;
  try {
    overlayContainer.eventMode = "none";
  } catch (_exception) {
    // Older PIXI builds ignore eventMode.
  }
  try {
    if (typeof canvas.tokens.addChildAt === "function") canvas.tokens.addChildAt(overlayContainer, 0);
    else canvas.tokens.addChild(overlayContainer);
  } catch (_exception) {
    overlayContainer = null;
  }
  return overlayContainer;
}

function destroyChild(child) {
  try {
    child?.destroy?.({ children: true });
  } catch (_exception) {
    child?.destroy?.();
  }
}

function destroyOverlayContainer() {
  if (overlayContainer && !overlayContainer.destroyed) {
    try {
      overlayContainer.parent?.removeChild?.(overlayContainer);
    } catch (_exception) {
      // no-op
    }
    destroyChild(overlayContainer);
  }
  overlayContainer = null;
  tokenOverlays.clear();
}

function ensureOverlayEntry(token) {
  const id = tokenId(token);
  if (!id) return null;
  const existing = tokenOverlays.get(id);
  if (existing?.container && !existing.container.destroyed) return existing;
  const parent = ensureOverlayContainer();
  const PIXI = pixi();
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
  for (const token of tokens) ensureOverlayEntry(token);
}

function redrawReachOverlays() {
  pendingRedraw = false;
  if (!enabled || !settings.enabled) {
    syncOverlayEntries([]);
    return;
  }
  const overlay = ensureOverlayContainer();
  if (!overlay) return;
  overlay.visible = true;
  const display = displayTokens(candidateTokens());
  syncOverlayEntries(display);
  for (const token of display) drawTokenOverlay(token);
}

function scheduleRedraw() {
  if (pendingRedraw) return;
  pendingRedraw = true;
  const requestFrame = globalThis.requestAnimationFrame ?? (callback => globalThis.setTimeout(callback, 16));
  requestFrame(redrawReachOverlays);
}

function setEnabled(value) {
  enabled = Boolean(value);
  const overlay = ensureOverlayContainer();
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
  scheduleRedraw();
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
  scheduleRedraw();
}

function registerControlsHook() {
  Hooks.on("getSceneControlButtons", controls => {
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
export function registerReachVisualizerHooks() {
  if (!hooksRegistered) {
    hooksRegistered = true;
    registerControlsHook();
    Hooks.on("canvasReady", () => {
      applyReachVisualizerSettings();
    });
    Hooks.on("canvasTearDown", () => {
      destroyOverlayContainer();
      pendingRedraw = false;
    });
    Hooks.on("hoverToken", (token, hovered) => {
      const id = tokenId(token);
      hoveredTokenId = hovered ? id : hoveredTokenId === id ? null : hoveredTokenId;
      if (settings.visibility === REACH_VISUALIZER_VISIBILITY.HOVER) scheduleRedraw();
      else refreshTokenIds([id]);
    });
    Hooks.on("controlToken", token => refreshTokenIds([tokenId(token)]));
    Hooks.on("refreshToken", token => refreshTokenIds([tokenId(token)]));
    Hooks.on("updateToken", document => refreshTokenIds([String(document?.id ?? document?._id ?? "")]));
    Hooks.on("createToken", scheduleRedraw);
    Hooks.on("deleteToken", document => {
      destroyOverlayEntry(String(document?.id ?? document?._id ?? ""));
      scheduleRedraw();
    });
    Hooks.on("updateCombatant", combatant => refreshTokenIds([String(combatant?.tokenId ?? combatant?.token?.id ?? "")]));
    Hooks.on("updateCombat", scheduleRedraw);
    Hooks.on("updateActor", (actor, changed) => {
      const relevant = foundry.utils.hasProperty(changed ?? {}, `flags.${MODULE_ID}.readiedWeapons`)
        || foundry.utils.hasProperty(changed ?? {}, `flags.${MODULE_ID}.readiedWeaponId`);
      if (relevant) refreshTokenIds(tokenIdsForActor(actor));
    });
    Hooks.on("updateItem", (item, changed) => {
      if (item?.type !== "weapon" || !item.parent) return;
      const relevant = foundry.utils.hasProperty(changed ?? {}, "system.length")
        || foundry.utils.hasProperty(changed ?? {}, "system.equipStatus")
        || foundry.utils.hasProperty(changed ?? {}, "system.weaponType");
      if (relevant) refreshTokenIds(tokenIdsForActor(item.parent));
    });
    Hooks.on("deleteItem", item => {
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
      scheduleRedraw();
    },
    isEnabled: isReachVisualizerEnabled
  };
}

export const __test = Object.freeze({
  candidateTokens,
  displayTokens,
  reachUnitsForToken,
  tokenDispositionColor
});
