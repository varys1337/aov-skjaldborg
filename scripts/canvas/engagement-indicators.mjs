import {
  ENGAGEMENT_STATUS,
  ENGAGEMENT_VISUAL_MODE_DEFAULT,
  ENGAGEMENT_VISUAL_MODES,
  MODULE_ID,
  MOVEMENT_DEBUG_CATEGORIES,
  MOVEMENT_DEBUG_LEVELS
} from "../constants.mjs";
import { colorForToken } from "./overlay-colors.mjs";
import { gridSizePixels, tokenCenterPoint, tokenVisibleToUser } from "./overlay-geometry.mjs";
import { CanvasOverlayManager } from "./overlay-manager.mjs";
import { getCombatantState } from "../combat/state.mjs";
import { movementDebug } from "../combat/movement-debugger.mjs";
import { performanceDiagnostics } from "../performance/performance-monitor.mjs";
import { runtimeSettings } from "../runtime-settings.mjs";
import { combatantValues, tokenDocumentForCombatant } from "../combat/combatant-token-resolution.mjs";

const OVERLAY_NAME = "aov-skjaldborg-engagement-indicator-overlay";
const PAIR_MARKER_SCALE = 1.15;
const PAIR_MARKER_RADIUS = 13 * PAIR_MARKER_SCALE;
const PAIR_MARKER_INNER_RADIUS = 8 * PAIR_MARKER_SCALE;
const PAIR_MARKER_COLLISION_DISTANCE = 28 * PAIR_MARKER_SCALE;
const PAIR_MARKER_OFFSET = 12 * PAIR_MARKER_SCALE;
const PAIR_MIXED_DISPOSITION_COLOR = 0xf0c04a;
const PAIR_INNER_COLOR = 0xf4eee8;

let hooksRegistered = false;
const pairEntries = new Map();

export function engagementVisualMode() {
  const value = runtimeSettings.engagementVisualMode ?? ENGAGEMENT_VISUAL_MODE_DEFAULT;
  return Object.values(ENGAGEMENT_VISUAL_MODES).includes(value) ? value : ENGAGEMENT_VISUAL_MODE_DEFAULT;
}

export function usesEngagementOverlay(mode = engagementVisualMode()) {
  return mode === ENGAGEMENT_VISUAL_MODES.OVERLAY || mode === ENGAGEMENT_VISUAL_MODES.BOTH;
}

function tokenId(tokenOrDocument) {
  return String(tokenOrDocument?.id ?? tokenOrDocument?._id ?? tokenOrDocument?.document?.id ?? "").trim();
}

function tokenForCombatant(combatant) {
  const object = combatant?.token?.object;
  if (object?.document) return object;
  const document = tokenDocumentForCombatant(combatant);
  const id = document?.id ?? document?._id ?? combatant?.tokenId ?? combatant?.token?.id ?? combatant?.token?.document?.id;
  return id ? canvas?.tokens?.get?.(id) ?? document ?? combatant?.token ?? null : document ?? combatant?.token ?? null;
}

function combatantHasEngagement(combatant) {
  const engagement = getCombatantState(combatant).engagement;
  return engagement?.status === ENGAGEMENT_STATUS.ENGAGED
    && engagement?.engaged === true
    && (engagement.partnerIds ?? []).length > 0;
}

function combatantByIdMap(combatants) {
  return new Map(combatants.map(combatant => [String(combatant?.id ?? ""), combatant]).filter(([id]) => id));
}

function pairKey(firstId, secondId) {
  return [String(firstId ?? ""), String(secondId ?? "")].sort().join(":");
}

function midpoint(first, second) {
  return {
    x: (Number(first.x) + Number(second.x)) / 2,
    y: (Number(first.y) + Number(second.y)) / 2
  };
}

function pairColor(firstToken, secondToken) {
  const firstColor = colorForToken(firstToken);
  const secondColor = colorForToken(secondToken);
  return firstColor === secondColor ? firstColor : PAIR_MIXED_DISPOSITION_COLOR;
}

function offsetNearbyPairPoints(pairs) {
  const occupied = [];
  return pairs.map((pair, index) => {
    let offsetIndex = 0;
    for (const placed of occupied) {
      if (Math.hypot(pair.point.x - placed.x, pair.point.y - placed.y) < PAIR_MARKER_COLLISION_DISTANCE) offsetIndex += 1;
    }
    const angle = ((index + offsetIndex) % 8) * (Math.PI / 4);
    const distance = offsetIndex > 0 ? PAIR_MARKER_OFFSET * Math.ceil(offsetIndex / 2) : 0;
    const point = {
      x: pair.point.x + (Math.cos(angle) * distance),
      y: pair.point.y + (Math.sin(angle) * distance)
    };
    occupied.push(point);
    return {
      ...pair,
      point,
      offsetIndex
    };
  });
}

function visibleEngagementPairs(combat = game.combat) {
  if (!usesEngagementOverlay() || !combat) return [];
  const combatants = combatantValues(combat);
  const byId = combatantByIdMap(combatants);
  const seen = new Set();
  const pairs = [];
  for (const combatant of combatants) {
    if (!combatantHasEngagement(combatant)) continue;
    const firstToken = tokenForCombatant(combatant);
    if (!firstToken || !tokenVisibleToUser(firstToken, game.user)) continue;
    const firstCenter = tokenCenterPoint(firstToken, gridSizePixels());
    if (!firstCenter) continue;
    const engagement = getCombatantState(combatant).engagement;
    const partnerIds = Array.isArray(engagement.partnerIds) ? engagement.partnerIds : [];
    for (const partnerId of partnerIds) {
      const partner = byId.get(String(partnerId ?? ""));
      if (!partner || partner.id === combatant.id) continue;
      const key = pairKey(combatant.id, partner.id);
      if (seen.has(key)) continue;
      const secondToken = tokenForCombatant(partner);
      if (!secondToken || !tokenVisibleToUser(secondToken, game.user)) continue;
      const secondCenter = tokenCenterPoint(secondToken, gridSizePixels());
      if (!secondCenter) continue;
      seen.add(key);
      pairs.push({
        key,
        combatant,
        partner,
        firstToken,
        secondToken,
        point: midpoint(firstCenter, secondCenter),
        color: pairColor(firstToken, secondToken),
        partnerIds: [combatant.id, partner.id],
        reason: engagement.reason ?? ""
      });
    }
  }
  return offsetNearbyPairPoints(pairs.sort((left, right) => left.key.localeCompare(right.key)));
}

function destroyDisplayObject(displayObject) {
  try {
    displayObject?.destroy?.({ children: true });
  } catch (_exception) {
    displayObject?.destroy?.();
  }
}

function ensurePairEntry(id, parent = overlayManager.container) {
  if (!id) return null;
  const existing = pairEntries.get(id);
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
  pairEntries.set(id, entry);
  return entry;
}

function destroyPairEntry(id) {
  const entry = pairEntries.get(String(id ?? ""));
  if (!entry) return;
  try {
    entry.container?.parent?.removeChild?.(entry.container);
  } catch (_exception) {
    // Canvas teardown may already have removed the parent container.
  }
  destroyDisplayObject(entry.container);
  pairEntries.delete(String(id ?? ""));
}

function clearAllPairEntries() {
  for (const id of Array.from(pairEntries.keys())) destroyPairEntry(id);
}

function drawPairMarker(entry, pair) {
  if (!entry || !pair?.point) return;
  const key = [
    pair.key,
    Number(pair.point.x).toFixed(2),
    Number(pair.point.y).toFixed(2),
    pair.color,
    pair.partnerIds.join(","),
    pair.reason,
    pair.offsetIndex ?? 0
  ].join("|");
  entry.container.visible = true;
  entry.container.position?.set?.(pair.point.x, pair.point.y);
  if (entry.lastKey === key) return;
  entry.lastKey = key;
  entry.graphics.clear?.();
  if (typeof entry.graphics.lineStyle === "function") entry.graphics.lineStyle(3, pair.color, 0.82);
  if (typeof entry.graphics.beginFill === "function") entry.graphics.beginFill(pair.color, 0.16);
  entry.graphics.drawCircle?.(0, 0, PAIR_MARKER_RADIUS);
  entry.graphics.endFill?.();
  if (typeof entry.graphics.lineStyle === "function") entry.graphics.lineStyle(1.5, PAIR_INNER_COLOR, 0.72);
  entry.graphics.drawCircle?.(0, 0, PAIR_MARKER_INNER_RADIUS);
}

function drawEngagementMarkers({ container }) {
  const mode = engagementVisualMode();
  if (!usesEngagementOverlay(mode)) {
    clearAllPairEntries();
    if (container) container.visible = false;
    return;
  }
  if (container) container.visible = true;
  const pairs = visibleEngagementPairs(game.combat);
  const wanted = new Set(pairs.map(pair => pair.key).filter(Boolean));
  for (const id of Array.from(pairEntries.keys())) {
    if (!wanted.has(id)) destroyPairEntry(id);
  }
  const parent = overlayManager.container;
  for (const pair of pairs) {
    const entry = ensurePairEntry(pair.key, parent);
    drawPairMarker(entry, pair);
  }
  performanceDiagnostics.count("engagement.overlay.draw", 1, {
    pairCount: pairs.length,
    mode
  });
}

const overlayManager = new CanvasOverlayManager({
  id: OVERLAY_NAME,
  layer: "tokens",
  insert: "above",
  zIndex: 1000,
  draw: drawEngagementMarkers
});

function scheduleRedraw(reason = "engagement-overlay") {
  overlayManager.scheduleRedraw(reason);
}

export function syncEngagementOverlayVisual(combatant, engagement, combat = game.combat) {
  if (!usesEngagementOverlay()) return;
  movementDebug(MOVEMENT_DEBUG_CATEGORIES.STATUS, "sync-engagement-overlay", () => ({
    combatId: combat?.id ?? null,
    combatantId: combatant?.id ?? null,
    tokenId: combatant?.tokenId ?? combatant?.token?.id ?? null,
    engaged: engagement?.engaged === true,
    partnerIds: engagement?.partnerIds ?? []
  }), { combatId: combat?.id ?? null, combatantId: combatant?.id ?? null, level: MOVEMENT_DEBUG_LEVELS.TRACE });
  scheduleRedraw(`combatant-${combatant?.id ?? "unknown"}`);
}

export function clearEngagementOverlayVisualsForCombat(_combat = game.combat, { reason = "combat-ended" } = {}) {
  if (!usesEngagementOverlay()) {
    clearAllPairEntries();
    return;
  }
  movementDebug(MOVEMENT_DEBUG_CATEGORIES.STATUS, "clear-engagement-overlay", () => ({ reason }), { level: MOVEMENT_DEBUG_LEVELS.VERBOSE });
  clearAllPairEntries();
  scheduleRedraw(reason);
}

export function refreshEngagementOverlayVisuals(reason = "api") {
  scheduleRedraw(reason);
}

export function registerEngagementIndicatorHooks() {
  if (hooksRegistered) return;
  hooksRegistered = true;
  overlayManager.registerHooks(Hooks);
  Hooks.on("canvasPan", () => scheduleRedraw("canvas-pan"));
  Hooks.on("updateToken", document => {
    const id = tokenId(document);
    if (id) scheduleRedraw("update-token");
  });
  Hooks.on("deleteToken", document => {
    scheduleRedraw("delete-token");
  });
  Hooks.on("updateCombat", () => scheduleRedraw("update-combat"));
  Hooks.on("updateCombatant", () => scheduleRedraw("update-combatant"));
  Hooks.on("deleteCombat", combat => clearEngagementOverlayVisualsForCombat(combat, { reason: "combat-deleted" }));
  Hooks.on("deleteCombatant", combatant => {
    for (const key of Array.from(pairEntries.keys())) {
      if (key.split(":").includes(String(combatant?.id ?? ""))) destroyPairEntry(key);
    }
    scheduleRedraw("delete-combatant");
  });
}

export const __test = Object.freeze({
  engagementVisualMode,
  usesEngagementOverlay,
  visibleEngagementPairs,
  offsetNearbyPairPoints,
  pairKey,
  PAIR_MARKER_SCALE,
  PAIR_MARKER_RADIUS,
  PAIR_MARKER_INNER_RADIUS,
  overlayManager,
  pairEntries
});
