import { MOVEMENT_PLAN_STATUS } from "../constants.mjs";
import { AoVAdapter } from "../adapter/aov-adapter.mjs";
import { getCombatState, getCombatantState } from "../combat/state.mjs";
import { combatantForTokenDocument } from "../combat/combatant-token-resolution.mjs";
import { canUserViewMovementPlanPreview } from "../permissions.mjs";
import { performanceDiagnostics } from "../performance/performance-monitor.mjs";
import { RenderCoordinator } from "../ui/render-coordinator.mjs";
import { finiteNumber } from "../ui/dom-utils.mjs";
import { warn } from "../logger.mjs";

const LEGACY_DOM_LAYER_ID = "skj-movement-plan-preview-layer";
const LEGACY_PIXI_LAYER_NAME = "skjMovementPlanPreviewLayer";
const PLANNED_STATUSES = new Set([MOVEMENT_PLAN_STATUS.PLANNED]);
const PREVIEW_USER_ID = "aov-skjaldborg-planned-movement-preview";
const RULER_PREVIEW_OPERATION_FLAG = Object.freeze({
  "aov-skjaldborg": Object.freeze({ movementPlanPreview: true })
});
const DEFAULT_GRID_SIZE = 100;
const DEFAULT_GRID_DISTANCE = 1;
const DEFAULT_TOKEN_SHAPE = 4;
const DEFAULT_MOVEMENT_ACTION = "walk";

let hooksRegistered = false;
let activeTokenId = null;
let activeCombatantId = null;
let activeRulerTokenId = null;
let legacyLayersCleaned = false;
let pointerDown = false;
let previewEventToken = null;

function cleanPoint(point) {
  const x = finiteNumber(point?.x);
  const y = finiteNumber(point?.y);
  if (x === null || y === null) return null;
  const elevation = finiteNumber(point?.elevation);
  return elevation === null ? { x: Math.round(x), y: Math.round(y) } : { x: Math.round(x), y: Math.round(y), elevation };
}

function samePoint(a, b) {
  if (!a || !b) return false;
  return Number(a.x) === Number(b.x)
    && Number(a.y) === Number(b.y)
    && (Number(a.elevation) || 0) === (Number(b.elevation) || 0);
}

function appendPoint(route, point) {
  const clean = cleanPoint(point);
  if (!clean || samePoint(clean, route.at(-1))) return;
  route.push(clean);
}

function currentTokenPosition(token) {
  const document = token?.document ?? token;
  const objectX = finiteNumber(token?.position?.x);
  const objectY = finiteNumber(token?.position?.y);
  const documentX = finiteNumber(document?.x);
  const documentY = finiteNumber(document?.y);
  const sourceX = finiteNumber(document?._source?.x);
  const sourceY = finiteNumber(document?._source?.y);
  const x = objectX ?? documentX ?? sourceX;
  const y = objectY ?? documentY ?? sourceY;
  if (x === null || y === null) return null;
  const elevation = finiteNumber(document?.elevation ?? document?._source?.elevation);
  return elevation === null ? { x, y } : { x, y, elevation };
}

function storedMovementRoute(movement) {
  if (Array.isArray(movement?.route) && movement.route.length) return movement.route;
  return Array.isArray(movement?.waypoints) ? movement.waypoints : [];
}

function plannedRouteForToken(token, movement) {
  const origin = cleanPoint(movement?.origin) ?? currentTokenPosition(token);
  const rawRoute = storedMovementRoute(movement);
  const route = [];
  for (const point of rawRoute) appendPoint(route, point);
  const destination = cleanPoint(movement?.destination);
  if (destination) appendPoint(route, destination);
  if (!origin || !route.length) return [];

  const points = [origin];
  for (const point of route) appendPoint(points, point);
  return points.length >= 2 ? points : [];
}

function gridSize() {
  return finiteNumber(canvas?.scene?.grid?.size ?? canvas?.grid?.size, DEFAULT_GRID_SIZE) || DEFAULT_GRID_SIZE;
}

function gridDistance() {
  return finiteNumber(canvas?.scene?.grid?.distance, DEFAULT_GRID_DISTANCE) || DEFAULT_GRID_DISTANCE;
}

function sceneDistanceBetween(a, b) {
  const dx = Number(b?.x) - Number(a?.x);
  const dy = Number(b?.y) - Number(a?.y);
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return 0;
  return (Math.hypot(dx, dy) / gridSize()) * gridDistance();
}

function previewAllowed(combat, combatant) {
  if (!AoVAdapter.isAoVWorld() || !AoVAdapter.enabledSetting) return false;
  if (!combat?.started || !getCombatState(combat).enabled) return false;
  if (!canUserViewMovementPlanPreview(game.user, combatant)) return false;
  const status = getCombatantState(combatant).movement?.planStatus;
  return PLANNED_STATUSES.has(status);
}

function tokenDefaults(document) {
  const source = document?._source ?? {};
  const tokenShape = globalThis.CONST?.TOKEN_SHAPES?.RECTANGLE;
  const action = document?.movementAction
    ?? source.movementAction
    ?? globalThis.CONFIG?.Token?.movement?.defaultAction
    ?? DEFAULT_MOVEMENT_ACTION;
  return {
    elevation: finiteNumber(document?.elevation ?? source.elevation, 0) ?? 0,
    width: Math.max(1, finiteNumber(document?.width ?? source.width, 1) ?? 1),
    height: Math.max(1, finiteNumber(document?.height ?? source.height, 1) ?? 1),
    depth: Math.max(1, finiteNumber(document?.depth ?? source.depth ?? document?.height ?? source.height, 1) ?? 1),
    shape: finiteNumber(document?.shape ?? source.shape ?? tokenShape, DEFAULT_TOKEN_SHAPE) ?? DEFAULT_TOKEN_SHAPE,
    level: String(document?.level ?? source.level ?? ""),
    action: String(action ?? DEFAULT_MOVEMENT_ACTION)
  };
}

function movementWaypoint(document, point, { explicit = false, checkpoint = false, intermediate = false } = {}) {
  const clean = cleanPoint(point);
  if (!clean) return null;
  const defaults = tokenDefaults(document);
  const elevation = finiteNumber(point?.elevation, defaults.elevation) ?? defaults.elevation;
  const width = Math.max(1, finiteNumber(point?.width, defaults.width) ?? defaults.width);
  const height = Math.max(1, finiteNumber(point?.height, defaults.height) ?? defaults.height);
  const depth = Math.max(1, finiteNumber(point?.depth, defaults.depth) ?? defaults.depth);
  const shape = finiteNumber(point?.shape, defaults.shape) ?? defaults.shape;
  const level = String(point?.level ?? defaults.level ?? "");
  const action = String(point?.action ?? defaults.action ?? DEFAULT_MOVEMENT_ACTION);
  return {
    x: clean.x,
    y: clean.y,
    elevation,
    width,
    height,
    depth,
    shape,
    level,
    action,
    terrain: null,
    snapped: point?.snapped !== false,
    explicit: point?.explicit === true || explicit === true,
    checkpoint: point?.checkpoint === true || checkpoint === true,
    intermediate: point?.intermediate === true || intermediate === true
  };
}

function requestedWaypoints(document, points) {
  const lastIndex = points.length - 1;
  return points
    .map((point, index) => movementWaypoint(document, point, {
      explicit: index > 0 && index < lastIndex,
      checkpoint: index === lastIndex,
      intermediate: false
    }))
    .filter(Boolean);
}

function completePath(document, requested) {
  if (requested.length < 2) return requested;
  if (typeof document?.getCompleteMovementPath !== "function") return requested;
  try {
    const complete = document.getCompleteMovementPath(requested);
    return Array.isArray(complete) && complete.length >= 2 ? complete : requested;
  } catch (exception) {
    warn("Unable to ask Foundry for a complete planned movement path; using stored waypoints.", exception);
    return requested;
  }
}

function measurementForPath(document, path) {
  if (path.length < 2 || typeof document?.measureMovementPath !== "function") return null;
  try {
    const result = document.measureMovementPath(path);
    return Array.isArray(result?.waypoints) ? result.waypoints : null;
  } catch (exception) {
    warn("Unable to measure planned movement for core token ruler preview; using fallback costs.", exception);
    return null;
  }
}

function segmentCostFromMeasurement(measurements, index, point, previousPoint) {
  const current = measurements?.[index];
  const previous = measurements?.[index - 1];
  const cumulative = finiteNumber(current?.cost ?? current?.distance);
  const previousCumulative = finiteNumber(previous?.cost ?? previous?.distance, 0) ?? 0;
  if (cumulative !== null) return Math.max(0, cumulative - previousCumulative);
  return sceneDistanceBetween(previousPoint, point);
}

function sanitizePlannedPath(document, path, measurements) {
  const cleanPath = [];
  for (const [index, rawPoint] of path.entries()) {
    const previous = cleanPath.at(-1) ?? null;
    const waypoint = movementWaypoint(document, rawPoint, {
      explicit: rawPoint?.explicit === true,
      checkpoint: rawPoint?.checkpoint === true || index === path.length - 1,
      intermediate: rawPoint?.intermediate === true || (index > 0 && index < path.length - 1 && rawPoint?.explicit !== true)
    });
    if (!waypoint || samePoint(waypoint, previous)) continue;

    waypoint.cost = index === 0 ? 0 : segmentCostFromMeasurement(measurements, index, waypoint, previous);
    if (!Number.isFinite(waypoint.cost)) waypoint.cost = 0;
    cleanPath.push(waypoint);
  }

  if (cleanPath.length) {
    cleanPath[0].cost = 0;
    cleanPath[0].checkpoint = false;
    cleanPath[0].intermediate = false;
  }
  if (cleanPath.length > 1) cleanPath[cleanPath.length - 1].checkpoint = true;
  return cleanPath.length >= 2 ? cleanPath : [];
}

function buildCorePlannedPath(token, points) {
  const document = token?.document;
  const requested = requestedWaypoints(document, points);
  const complete = completePath(document, requested);
  const measurements = measurementForPath(document, complete);
  return sanitizePlannedPath(document, complete, measurements);
}

function removeLegacyDomLayer() {
  document.getElementById(LEGACY_DOM_LAYER_ID)?.remove();
}

function destroyPixiChild(child) {
  try {
    child?.destroy?.({ children: true });
  } catch (_err) {
    child?.destroy?.();
  }
}

function removeLegacyPixiLayerFrom(parent) {
  const children = Array.from(parent?.children ?? []);
  for (const child of children) {
    if (child?.name !== LEGACY_PIXI_LAYER_NAME) continue;
    parent.removeChild?.(child);
    destroyPixiChild(child);
  }
}

function removeLegacyPreviewLayers() {
  removeLegacyDomLayer();
  if (!canvas?.ready) return;
  removeLegacyPixiLayerFrom(canvas.tokens);
  removeLegacyPixiLayerFrom(canvas.stage);
  removeLegacyPixiLayerFrom(canvas.app?.stage);
  legacyLayersCleaned = true;
}

function ensureLegacyPreviewLayersRemoved() {
  if (legacyLayersCleaned && !document.getElementById(LEGACY_DOM_LAYER_ID)) return;
  removeLegacyPreviewLayers();
}

function clearCoreRuler(token) {
  if (!token?.ruler) return;
  try {
    token.ruler.clear?.();
    token.ruler.visible = false;
  } catch (exception) {
    warn("Unable to clear core token ruler movement-plan preview.", exception);
  }
}

function detachPreviewClearHandlers() {
  const token = previewEventToken;
  if (!token?.off) {
    previewEventToken = null;
    return;
  }
  token.off("pointerdown", handlePreviewPointerDown);
  token.off("mousedown", handlePreviewPointerDown);
  token.off("rightdown", handlePreviewPointerDown);
  token.off("dragstart", handlePreviewPointerDown);
  previewEventToken = null;
}

function handlePreviewPointerDown() {
  pointerDown = true;
  clearMovementPlanPreview();
}

function handleGlobalPointerDown() {
  pointerDown = true;
  if (activeTokenId) clearMovementPlanPreview();
}

function handleGlobalPointerUp() {
  pointerDown = false;
}

function attachPreviewClearHandlers(token) {
  if (!token?.on || previewEventToken === token) return;
  detachPreviewClearHandlers();
  previewEventToken = token;
  token.on("pointerdown", handlePreviewPointerDown);
  token.on("mousedown", handlePreviewPointerDown);
  token.on("rightdown", handlePreviewPointerDown);
  token.on("dragstart", handlePreviewPointerDown);
}

function getActiveRulerToken() {
  if (!activeRulerTokenId || !canvas?.ready) return null;
  return canvas.tokens?.get?.(activeRulerTokenId) ?? null;
}

function previewWaypoint(waypoint, movementId = PREVIEW_USER_ID) {
  return {
    ...waypoint,
    userId: PREVIEW_USER_ID,
    movementId,
    subpathId: movementId
  };
}

function previewRulerData(foundPath) {
  const movementId = `${PREVIEW_USER_ID}:${activeTokenId ?? "token"}`;
  return {
    ...RULER_PREVIEW_OPERATION_FLAG,
    passedWaypoints: [],
    pendingWaypoints: foundPath.map(point => previewWaypoint(point, movementId)),
    plannedMovement: {}
  };
}

function renderCoreRulerPreview(token, foundPath) {
  const ruler = token?.ruler;
  if (!ruler || typeof ruler.refresh !== "function") return false;

  try {
    ruler.visible = true;
    ruler.refresh(previewRulerData(foundPath));
    activeRulerTokenId = token.id ?? token.document?.id ?? null;
    attachPreviewClearHandlers(token);
    return true;
  } catch (exception) {
    warn("Unable to render planned movement with the core token ruler.", exception);
    clearCoreRuler(token);
    return false;
  }
}

function renderPreviewForToken(token) {
  const measureId = performanceDiagnostics.markStart("movementPlanPreview.render");
  let combatantId = null;
  let waypointCount = 0;
  let rendered = false;
  try {
    ensureLegacyPreviewLayersRemoved();
    if (pointerDown) {
      clearCoreRuler(token);
      return;
    }

    const combat = game.combat;
    const combatant = token && combat?.started
      ? combatantForTokenDocument(combat, token?.document ?? token)
      : null;
    combatantId = combatant?.id ?? null;
    if (!combatant || !previewAllowed(combat, combatant)) {
      activeCombatantId = null;
      clearCoreRuler(token);
      return;
    }

    const movement = getCombatantState(combatant).movement;
    const points = plannedRouteForToken(token, movement);
    if (points.length < 2) {
      activeCombatantId = null;
      clearCoreRuler(token);
      return;
    }

    const foundPath = buildCorePlannedPath(token, points);
    waypointCount = foundPath.length;
    if (foundPath.length < 2 || !renderCoreRulerPreview(token, foundPath)) {
      activeCombatantId = null;
      return;
    }

    activeCombatantId = combatant.id;
    rendered = true;
    performanceDiagnostics.count("movementPlanPreview.render", 1, {
      combatantId: combatant.id,
      renderer: "core-token-ruler",
      waypointCount: foundPath.length
    });
  } finally {
    performanceDiagnostics.markEnd(measureId, { combatantId, waypointCount, rendered });
  }
}

/**
 * Clear all currently rendered movement-plan preview artifacts.
 *
 * @returns {void}
 */
export function clearMovementPlanPreview() {
  const token = getActiveRulerToken();
  if (token) clearCoreRuler(token);
  detachPreviewClearHandlers();
  activeTokenId = null;
  activeCombatantId = null;
  activeRulerTokenId = null;
  removeLegacyPreviewLayers();
}

/**
 * Re-render the active token's planned route preview when one is active.
 *
 * @returns {void}
 */
export function refreshMovementPlanPreview() {
  if (!activeTokenId || !canvas?.ready) {
    clearMovementPlanPreview();
    return;
  }
  const token = canvas.tokens?.get?.(activeTokenId) ?? null;
  if (!token) {
    clearMovementPlanPreview();
    return;
  }
  renderPreviewForToken(token);
}

function onHoverToken(token, hovered) {
  if (pointerDown) {
    if (!hovered || activeTokenId === token?.id) clearMovementPlanPreview();
    return;
  }
  if (!hovered) {
    if (!activeTokenId || activeTokenId === token?.id) clearMovementPlanPreview();
    return;
  }

  const nextTokenId = token?.id ?? null;
  if (!nextTokenId) return;
  if (activeRulerTokenId && activeRulerTokenId !== nextTokenId) clearMovementPlanPreview();
  activeTokenId = nextTokenId;
  renderPreviewForToken(token);
}

function refreshIfActiveCombatant(combatant) {
  if (!activeCombatantId || combatant?.id !== activeCombatantId) return;
  RenderCoordinator.invalidate("movementPlanPreview", { reason: "combatant-update" });
}

function refreshIfActiveToken(document) {
  const tokenId = document?.id ?? document?._id ?? null;
  if (!activeTokenId || tokenId !== activeTokenId) return;
  RenderCoordinator.invalidate("movementPlanPreview", { reason: "token-update" });
}

/**
 * Register canvas, token, and render-coordinator hooks for route previews.
 *
 * @returns {void}
 */
export function registerMovementPlanPreviewHooks() {
  if (hooksRegistered) return;
  hooksRegistered = true;

  RenderCoordinator.register("movementPlanPreview", refreshMovementPlanPreview);

  globalThis.window?.addEventListener?.("pointerdown", handleGlobalPointerDown, { capture: true, passive: true });
  globalThis.window?.addEventListener?.("pointerup", handleGlobalPointerUp, { capture: true, passive: true });
  globalThis.window?.addEventListener?.("blur", handleGlobalPointerUp, { capture: true, passive: true });

  Hooks.on("hoverToken", onHoverToken);
  Hooks.on("preMoveToken", clearMovementPlanPreview);
  Hooks.on("moveToken", clearMovementPlanPreview);
  Hooks.on("canvasReady", clearMovementPlanPreview);
  Hooks.on("canvasTearDown", clearMovementPlanPreview);
  Hooks.on("deleteCombat", clearMovementPlanPreview);
  Hooks.on("updateCombat", () => {
    if (activeTokenId) RenderCoordinator.invalidate("movementPlanPreview", { reason: "combat-update" });
  });
  Hooks.on("updateCombatant", refreshIfActiveCombatant);
  Hooks.on("deleteCombatant", refreshIfActiveCombatant);
  Hooks.on("updateToken", refreshIfActiveToken);
  Hooks.on("refreshToken", token => {
    if (activeTokenId && token?.id === activeTokenId) RenderCoordinator.invalidate("movementPlanPreview", { reason: "token-refresh" });
  });
  Hooks.on("destroyToken", token => {
    if (activeTokenId && token?.id === activeTokenId) clearMovementPlanPreview();
  });
}
