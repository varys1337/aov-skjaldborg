import { AoVAdapter } from "../adapter/aov-adapter.mjs";
import {
  ACTION_CATEGORIES,
  MODULE_ID,
  MOVEMENT_DEBUG_CATEGORIES,
  MOVEMENT_DEBUG_LEVELS,
  MOVEMENT_PLAN_STATUS,
  PHASES
} from "../constants.mjs";
import { debug, warn } from "../logger.mjs";
import { getCombatState, getCombatantState, updateCombatantState, updateCombatState } from "./state.mjs";
import { syncEngagedStatusEffect } from "./engagement-status.mjs";
import { getReadiedWeapon } from "./weapon-state.mjs";
import {
  appendRoutePoint,
  cleanMovementPoint,
  normalizeMovementRoute,
  sameMovementPoint
} from "./movement-route.mjs";
import { movementDebug, movementDebugWarn, newMovementDebugRunId } from "./movement-debugger.mjs";
import { settleMovementWrites } from "./authoritative-write-queue.mjs";
import { applyMovementDexResults } from "./resolution-queue.mjs";
import { isMovementPlanningPhase, shouldExecuteMovementImmediately } from "./phase-structure.mjs";
import { RenderCoordinator } from "../ui/render-coordinator.mjs";
import { performanceDiagnostics } from "../performance/performance-monitor.mjs";
import {
  canEstablishEngagementAfterMovement,
  engagementMovementLimitGridUnits,
  sceneDistanceToGridUnits
} from "./movement-eligibility.mjs";
import { addEngagementPartner } from "./engagement-links.mjs";

export { cleanMovementPoint, normalizeMovementRoute } from "./movement-route.mjs";

const activeRuns = new Map();
const movementRunLocks = new Map();
const activeEngagementPairs = new Map();
const movementRulerDrafts = new Map();
const movementCaptureNotificationBatches = new Map();
const MOVEMENT_RULER_CAPTURE_PATCH = Symbol.for("aov-skjaldborg.movement-ruler-capture");
const DEFAULT_GRID_SIZE = 100;
const DEFAULT_MOVEMENT_TICK_DELAY_MS = 250;
const MOVEMENT_CAPTURE_NOTIFICATION_WINDOW_MS = 350;
const MAX_BLOCKED_TICKS = 8;
const FRIENDLY_DISPOSITION = 1;
const HOSTILE_DISPOSITION = -1;
const DEFAULT_ENGAGEMENT_REACH_UNITS = 1;
const MEDIUM_REACH_LENGTH_METERS = 1.4;
const MEDIUM_ENGAGEMENT_REACH_UNITS = 2;
const LONG_REACH_LENGTH_METERS = 2.4;
const LONG_ENGAGEMENT_REACH_UNITS = 3;

/**
 * Resolve the grid size used to convert pixel distance to grid units.
 *
 * @returns {number}
 */
function gridSize() {
  return Number(canvas.scene?.grid?.size ?? canvas.grid?.size) || DEFAULT_GRID_SIZE;
}

/**
 * Batch movement-captured confirmations without flooding the UI during rapid
 * ruler corrections.
 *
 * @param {{combatId?: string|null, combatantId?: string|null, tokenId?: string|null}} detail Capture detail.
 * @returns {void}
 */
function notifyMovementPlanCaptured(detail = {}) {
  const notificationKey = detail.combatId || "no-combat";
  const batch = movementCaptureNotificationBatches.get(notificationKey) ?? {
    combatantIds: new Set(),
    tokenIds: new Set(),
    count: 0,
    timer: null
  };
  batch.count += 1;
  if (detail.combatantId) batch.combatantIds.add(detail.combatantId);
  if (detail.tokenId) batch.tokenIds.add(detail.tokenId);
  if (batch.timer) {
    performanceDiagnostics.count("movement.capture.notification.suppressed", 1, {
      combatId: detail.combatId ?? null,
      combatantId: detail.combatantId ?? null,
      tokenId: detail.tokenId ?? null
    });
    return;
  }

  batch.timer = globalThis.setTimeout(() => {
    movementCaptureNotificationBatches.delete(notificationKey);
    const combatantCount = Math.max(batch.combatantIds.size, batch.tokenIds.size, batch.count);
    const message = combatantCount > 1
      ? game.i18n.format("AOV_SKJALDBORG.MovementAutomation.PlansCaptured", { count: combatantCount })
      : game.i18n.localize("AOV_SKJALDBORG.MovementAutomation.PlanCaptured");
    ui.notifications.info(message);
    performanceDiagnostics.count("movement.capture.notification.shown", 1, {
      combatId: detail.combatId ?? null,
      count: combatantCount
    });
  }, MOVEMENT_CAPTURE_NOTIFICATION_WINDOW_MS);

  movementCaptureNotificationBatches.set(notificationKey, batch);
}

/**
 * Resolve the scene-unit distance represented by one grid space.
 *
 * @returns {number}
 */
function gridDistance() {
  return Number(canvas.scene?.grid?.distance) || 1;
}

/**
 * Measure a point path in scene units.
 *
 * @param {{x: number, y: number}[]} points Canvas points.
 * @returns {number}
 */
function measureSceneDistance(points) {
  if (!Array.isArray(points) || points.length < 2) return 0;
  return AoVAdapter.measureDistanceFromWaypoints(points);
}

/**
 * Measure two token centers in grid spaces.
 *
 * @param {{x: number, y: number}} a First center.
 * @param {{x: number, y: number}} b Second center.
 * @returns {number}
 */
export function measureGridUnits(a, b) {
  return Math.hypot(Number(b.x) - Number(a.x), Number(b.y) - Number(a.y)) / gridSize();
}

/**
 * Build a center-like point from a TokenDocument when the placeable is absent.
 *
 * @param {TokenDocument|object|null} document Token document.
 * @returns {{x: number, y: number}|null}
 */
export function tokenCenter(document) {
  const objectCenter = cleanMovementPoint(document?.object?.center);
  if (objectCenter) return objectCenter;
  const origin = cleanMovementPoint(document);
  if (!origin) return null;
  const width = Number(document?.width) || 1;
  const height = Number(document?.height) || 1;
  const size = gridSize();
  return {
    x: Math.round(origin.x + ((width * size) / 2)),
    y: Math.round(origin.y + ((height * size) / 2))
  };
}

/**
 * Build the source-position center of a TokenDocument.
 *
 * Movement engagement must compare persisted checkpoint positions rather than
 * an in-flight Placeable animation. Foundry movement waypoints use top-left
 * pixel coordinates, so this helper deliberately prefers the document source.
 *
 * @param {TokenDocument|object|null} document Token document.
 * @returns {{x: number, y: number}|null}
 */
export function tokenSourceCenter(document) {
  const origin = cleanMovementPoint(document?._source) ?? cleanMovementPoint(document);
  if (!origin) return null;
  const width = Number(document?.width ?? document?._source?.width) || 1;
  const height = Number(document?.height ?? document?._source?.height) || 1;
  const size = gridSize();
  return {
    x: Math.round(origin.x + ((width * size) / 2)),
    y: Math.round(origin.y + ((height * size) / 2))
  };
}

/**
 * Resolve the occupied grid rectangle for a token top-left source point.
 *
 * The v14 movement engine uses occupied grid footprints for RAW
 * engagement and collision checks instead of center-to-center ruler distance.
 *
 * @param {TokenDocument|object|null} document Token document.
 * @param {object|null} [sourcePoint=null] Optional top-left point override.
 * @returns {{minX: number, minY: number, maxX: number, maxY: number}|null}
 */
export function tokenSourceGridRect(document, sourcePoint = null) {
  const origin = cleanMovementPoint(sourcePoint) ?? cleanMovementPoint(document?._source) ?? cleanMovementPoint(document);
  if (!origin) return null;
  const width = Math.max(1, Number(document?.width ?? document?._source?.width) || 1);
  const height = Math.max(1, Number(document?.height ?? document?._source?.height) || 1);
  const size = gridSize();
  return {
    minX: Math.floor(origin.x / size),
    minY: Math.floor(origin.y / size),
    maxX: Math.ceil((origin.x + (width * size)) / size) - 1,
    maxY: Math.ceil((origin.y + (height * size)) / size) - 1
  };
}

/**
 * Measure occupied-grid separation. Diagonal adjacency counts as 1.
 *
 * @param {object|null} first First occupied grid rectangle.
 * @param {object|null} second Second occupied grid rectangle.
 * @returns {number}
 */
export function measureOccupiedGridSeparation(first, second) {
  if (!first || !second) return Number.POSITIVE_INFINITY;
  const gapX = first.maxX < second.minX
    ? second.minX - first.maxX
    : second.maxX < first.minX
      ? first.minX - second.maxX
      : 0;
  const gapY = first.maxY < second.minY
    ? second.minY - first.maxY
    : second.maxY < first.minY
      ? first.minY - second.maxY
      : 0;
  return Math.max(gapX, gapY);
}

/**
 * Determine whether two occupied grid rectangles overlap.
 *
 * @param {object|null} first First rectangle.
 * @param {object|null} second Second rectangle.
 * @returns {boolean}
 */
function gridRectsOverlap(first, second) {
  return measureOccupiedGridSeparation(first, second) === 0;
}

/**
 * Expand a stored movement route into stoppable grid-step checkpoints.
 *
 * Foundry v14 movement can stop or pause only at checkpoint waypoints. The
 * public complete-path helper supplies intermediate path positions; the module
 * marks each positional step as a checkpoint so engagement can halt at the
 * first applicable grid unit.
 *
 * @param {TokenDocument|object|null} document Token document.
 * @param {unknown[]} storedWaypoints Stored top-left movement waypoints.
 * @returns {object[]} Stoppable movement waypoints.
 */
export function movementExecutionWaypoints(document, storedWaypoints) {
  const measureId = performanceDiagnostics.markStart("movement.executionWaypoints");
  try {
  const requested = [];
  if (Array.isArray(storedWaypoints)) {
    for (const waypoint of storedWaypoints) appendRoutePoint(requested, waypoint);
  }
  movementDebug(MOVEMENT_DEBUG_CATEGORIES.EXPANSION, "start-expansion", () => ({
    tokenId: document?.id ?? document?._id ?? null,
    source: cleanMovementPoint(document?._source) ?? cleanMovementPoint(document),
    storedCount: storedWaypoints?.length ?? 0,
    requestedCount: requested.length,
    requested
  }), { level: MOVEMENT_DEBUG_LEVELS.TRACE, tokenId: document?.id ?? document?._id ?? null });
  if (!requested.length) return [];

  const current = cleanMovementPoint(document?._source) ?? cleanMovementPoint(document);
  let origin = current ?? cleanMovementPoint(requested[0]);
  if (!origin) return [];

  const size = gridSize();
  const checkpoints = [];

  const pushSegmentCheckpoints = (segmentOrigin, expanded, routeWaypoint, segmentIndex) => {
    const routeDestination = cleanMovementPoint(routeWaypoint);
    if (!routeDestination || sameMovementPoint(routeDestination, segmentOrigin)) return;

    let stepOrigin = segmentOrigin;
    for (const rawWaypoint of expanded) {
      const stepDestination = cleanMovementPoint(rawWaypoint);
      if (!stepDestination || sameMovementPoint(stepDestination, stepOrigin)) continue;
      const deltaX = stepDestination.x - stepOrigin.x;
      const deltaY = stepDestination.y - stepOrigin.y;
      const steps = Math.max(1, Math.ceil(Math.max(Math.abs(deltaX), Math.abs(deltaY)) / size));
      for (let step = 1; step <= steps; step += 1) {
        const point = {
          x: Math.round(stepOrigin.x + ((deltaX * step) / steps)),
          y: Math.round(stepOrigin.y + ((deltaY * step) / steps))
        };
        if (sameMovementPoint(point, current) || sameMovementPoint(point, cleanMovementPoint(checkpoints.at(-1)))) continue;
        const finalSegmentPoint = sameMovementPoint(point, routeDestination);
        checkpoints.push({
          ...(finalSegmentPoint ? routeWaypoint : rawWaypoint),
          ...point,
          checkpoint: true,
          routeIndex: segmentIndex,
          segmentIndex,
          explicitCorner: finalSegmentPoint,
          intermediate: !finalSegmentPoint || routeWaypoint?.intermediate === true,
          explicit: finalSegmentPoint ? routeWaypoint?.explicit === true : rawWaypoint?.explicit === true,
          snapped: rawWaypoint?.snapped !== false && routeWaypoint?.snapped !== false
        });
      }
      stepOrigin = stepDestination;
    }
  };

  for (const [segmentIndex, routeWaypoint] of requested.entries()) {
    const destination = cleanMovementPoint(routeWaypoint);
    if (!destination || sameMovementPoint(destination, origin)) continue;
    let expanded = [];
    let expansionSource = "fallback";
    if (typeof document?.getCompleteMovementPath === "function") {
      try {
        const complete = document.getCompleteMovementPath([
          { ...origin, checkpoint: true, snapped: true },
          routeWaypoint
        ]);
        if (Array.isArray(complete)) {
          expanded = complete;
          expansionSource = "getCompleteMovementPath";
        }
      }
      catch (err) {
        warn(err);
        movementDebugWarn(MOVEMENT_DEBUG_CATEGORIES.EXPANSION, "complete-path-error", () => ({
          tokenId: document?.id ?? document?._id ?? null,
          origin,
          destination,
          error: String(err?.message ?? err)
        }), { tokenId: document?.id ?? document?._id ?? null });
      }
    }
    if (!expanded.length) expanded = [routeWaypoint];
    if (!sameMovementPoint(cleanMovementPoint(expanded.at(-1)), destination)) expanded.push(routeWaypoint);
    const beforeCount = checkpoints.length;
    pushSegmentCheckpoints(origin, expanded, routeWaypoint, segmentIndex);
    movementDebug(MOVEMENT_DEBUG_CATEGORIES.EXPANSION, "segment-expanded", () => ({
      tokenId: document?.id ?? document?._id ?? null,
      segmentIndex,
      origin,
      destination,
      expansionSource,
      expandedCount: expanded.length,
      checkpointDelta: checkpoints.length - beforeCount,
      expanded,
      checkpoints: checkpoints.slice(beforeCount)
    }), { level: MOVEMENT_DEBUG_LEVELS.TRACE, tokenId: document?.id ?? document?._id ?? null });
    origin = destination;
  }

  const expandedSegmentCount = new Set(checkpoints.map(point => Number(point.segmentIndex ?? point.routeIndex)).filter(Number.isFinite)).size;
  if (requested.length > 1 && expandedSegmentCount < 2) {
    movementDebugWarn(MOVEMENT_DEBUG_CATEGORIES.EXPANSION, "multi-route-expanded-too-short", () => ({
      requested,
      expandedSegmentCount,
      checkpoints
    }), { tokenId: document?.id ?? document?._id ?? null });
  }
  movementDebug(MOVEMENT_DEBUG_CATEGORIES.EXPANSION, "finish-expansion", () => ({
    requestedCount: requested.length,
    expandedSegmentCount,
    checkpointCount: checkpoints.length,
    checkpoints
  }), { level: MOVEMENT_DEBUG_LEVELS.VERBOSE, tokenId: document?.id ?? document?._id ?? null });
  return checkpoints;
  } finally {
    performanceDiagnostics.markEnd(measureId, {
      tokenId: document?.id ?? document?._id ?? null,
      storedCount: storedWaypoints?.length ?? 0
    });
  }
}

/**
 * Normalize a route into plain ordered movement points.
 *
 * @param {unknown[]} points Candidate route points.
 * @param {{x: number, y: number}|null} [origin=null] Optional origin to omit.
 * @returns {object[]}
 */
function cleanMovementRoute(points, origin = null) {
  const route = [];
  if (!Array.isArray(points)) return route;
  for (const point of points) {
    const clean = cleanMovementPoint(point);
    if (!clean) continue;
    if (!route.length && sameMovementPoint(clean, cleanMovementPoint(origin))) continue;
    appendRoutePoint(route, point);
  }
  return route;
}

/**
 * Return whether every required point occurs in the same order within a route.
 *
 * @param {object[]} route Candidate containing route.
 * @param {object[]} required Ordered points that must be retained.
 * @returns {boolean}
 */
function routeContainsOrderedPoints(route, required) {
  if (!required.length) return true;
  let index = 0;
  for (const point of route) {
    if (!sameMovementPoint(cleanMovementPoint(point), cleanMovementPoint(required[index]))) continue;
    index += 1;
    if (index >= required.length) return true;
  }
  return false;
}

/**
 * Merge a live ruler draft with the final Foundry movement operation.
 *
 * The final `pending.waypoints` route is preferred when it already contains
 * every explicit ruler corner. If the final operation only exposes its current
 * destination, the cached explicit corners are retained and the destination is
 * appended. The largest shared suffix/prefix is removed when two partial route
 * revisions are joined.
 *
 * @param {unknown[]} draftRoute Explicit corners captured from TokenRuler data.
 * @param {unknown[]} operationRoute Route captured from preMoveToken.
 * @param {object|null} [destination=null] Final movement destination.
 * @returns {object[]}
 */
export function mergeMovementRoutes(draftRoute, operationRoute, destination = null) {
  const draft = cleanMovementRoute(draftRoute);
  const operation = cleanMovementRoute(operationRoute);
  let merged;

  if (!draft.length) merged = operation;
  else if (!operation.length) merged = draft;
  else if (routeContainsOrderedPoints(operation, draft)) merged = operation;
  else if (routeContainsOrderedPoints(draft, operation)) merged = draft;
  else {
    let overlap = Math.min(draft.length, operation.length);
    while (overlap > 0) {
      const draftTail = draft.slice(draft.length - overlap);
      const operationHead = operation.slice(0, overlap);
      const matches = draftTail.every((point, index) => {
        return sameMovementPoint(cleanMovementPoint(point), cleanMovementPoint(operationHead[index]));
      });
      if (matches) break;
      overlap -= 1;
    }
    merged = [...draft, ...operation.slice(overlap)];
  }

  const result = cleanMovementRoute(merged);
  if (destination && !sameMovementPoint(cleanMovementPoint(destination), cleanMovementPoint(result.at(-1)))) {
    appendRoutePoint(result, destination);
  }
  return result;
}

/**
 * Read the current user's planned movement from TokenRuler refresh data.
 *
 * `foundPath` contains the complete preview path. Only user-authored explicit
 * points and checkpoints are treated as bankable route corners while the drag
 * is still active. The final destination is supplied authoritatively by the
 * subsequent preMoveToken operation.
 *
 * @param {object} [rulerData={}] TokenRuler refresh data.
 * @param {string|null} [userId=game.user.id] User whose route is being read.
 * @returns {{source: string|null, plannedUserId: string|null, plannedUserIds: string[], foundPath: object[], explicitWaypoints: object[], passedWaypoints: object[], pendingWaypoints: object[], searching: boolean, hidden: boolean, history: object[], unreachableWaypoints: object[]}}
 */
export function movementRouteFromRulerData(rulerData = {}, userId = game.user?.id ?? null) {
  const plannedByUser = rulerData?.plannedMovement && typeof rulerData.plannedMovement === "object"
    ? rulerData.plannedMovement
    : {};
  const plannedUserIds = Object.keys(plannedByUser);
  const fallbackUserId = plannedUserIds.length === 1 ? plannedUserIds[0] : null;
  const plannedUserId = userId && plannedByUser[userId] ? userId : fallbackUserId;
  const plannedMovement = plannedUserId ? plannedByUser[plannedUserId] : null;
  const plannedFoundPath = cleanMovementRoute(plannedMovement?.foundPath ?? []);
  const pendingWaypoints = cleanMovementRoute(rulerData?.pendingWaypoints ?? []);
  const foundPath = plannedFoundPath.length ? plannedFoundPath : pendingWaypoints;
  const explicitWaypoints = cleanMovementRoute(
    foundPath.filter(point => point?.explicit === true || point?.checkpoint === true)
  );
  return {
    source: plannedFoundPath.length ? "plannedMovement.foundPath" : pendingWaypoints.length ? "pendingWaypoints" : null,
    plannedUserId,
    plannedUserIds,
    foundPath,
    explicitWaypoints,
    passedWaypoints: cleanMovementRoute(rulerData?.passedWaypoints ?? []),
    pendingWaypoints,
    searching: plannedMovement?.searching === true,
    hidden: plannedMovement?.hidden === true,
    history: cleanMovementRoute(plannedMovement?.history ?? []),
    unreachableWaypoints: cleanMovementRoute(plannedMovement?.unreachableWaypoints ?? [])
  };
}

/**
 * Read the authoritative user-authored waypoint list from a Foundry v14
 * preMoveToken operation.
 *
 * During a drag movement, TokenMovementData.pending contains only the portion
 * of the measured path which remains after the current checkpoint, while
 * TokenMovementData.destination can identify that current checkpoint. The
 * update operation separately retains the complete authored waypoint list in
 * operation.movement[tokenId].waypoints. That operation route must therefore
 * take precedence when finalizing a banked movement declaration.
 *
 * @param {TokenDocument|object|null} document Token document.
 * @param {object} [operation={}] Foundry document update operation.
 * @returns {{source: string|null, tokenId: string|null, availableTokenIds: string[], waypoints: object[]}}
 */
export function movementRouteFromOperation(document, operation = {}) {
  const tokenId = document?.id ?? document?._id ?? null;
  const movement = operation?.movement && typeof operation.movement === "object"
    ? operation.movement
    : null;
  const availableTokenIds = movement
    ? Object.entries(movement)
      .filter(([, value]) => value && typeof value === "object" && Array.isArray(value.waypoints))
      .map(([id]) => id)
    : [];

  const candidates = [];
  const addCandidate = (source, value) => {
    const points = Array.isArray(value)
      ? value
      : Array.isArray(value?.waypoints)
        ? value.waypoints
        : [];
    const waypoints = cleanMovementRoute(points, cleanMovementPoint(document?._source) ?? cleanMovementPoint(document));
    if (waypoints.length) candidates.push({ source, waypoints });
  };

  if (tokenId && movement?.[tokenId]) {
    addCandidate(`operation.movement.${tokenId}.waypoints`, movement[tokenId]);
  }
  addCandidate("operation.movement.waypoints", movement);
  addCandidate("operation.waypoints", operation?.waypoints);

  if (!candidates.length && availableTokenIds.length === 1) {
    const fallbackTokenId = availableTokenIds[0];
    addCandidate(`operation.movement.${fallbackTokenId}.waypoints`, movement[fallbackTokenId]);
  }

  const selected = candidates[0] ?? null;
  return {
    source: selected?.source ?? null,
    tokenId,
    availableTokenIds,
    waypoints: selected?.waypoints ?? []
  };
}

/**
 * Build a stable cache key for one user's ruler draft.
 *
 * @param {TokenDocument|object|null} document Token document.
 * @param {string|null} [userId=game.user.id] Planning user id.
 * @returns {string|null}
 */
function movementRulerDraftKey(document, userId = game.user?.id ?? null) {
  const tokenId = document?.id ?? document?._id ?? null;
  if (!tokenId || !userId) return null;
  const sceneId = document?.parent?.id ?? canvas.scene?.id ?? "no-scene";
  return `${sceneId}:${tokenId}:${userId}`;
}

/**
 * Create a compact route signature used to suppress duplicate ruler refreshes.
 *
 * @param {object[]} route Movement route.
 * @returns {string}
 */
function movementRouteSignature(route) {
  return JSON.stringify(cleanMovementRoute(route).map(point => [
    point.x,
    point.y,
    point.explicit === true,
    point.checkpoint === true
  ]));
}

/**
 * Return a monotonic route revision suitable for asynchronous socket writes.
 *
 * @param {...unknown} revisions Existing revision values.
 * @returns {number}
 */
function nextMovementRouteRevision(...revisions) {
  const current = Math.max(0, ...revisions.map(value => Number(value) || 0));
  return Math.max(Date.now(), current + 1);
}

/**
 * Add route-capture metadata to a movement plan.
 *
 * @param {object} plan Movement plan.
 * @param {object} metadata Capture metadata.
 * @returns {object}
 */
function annotateMovementPlan(plan, metadata) {
  return {
    ...plan,
    routeRevision: Number(metadata.routeRevision) || 0,
    routeId: String(metadata.routeId ?? ""),
    captureSource: String(metadata.captureSource ?? ""),
    capturedAt: Number(metadata.capturedAt) || Date.now(),
    draft: metadata.draft === true
  };
}

/**
 * Read the stored module route from a combatant movement flag.
 *
 * `movement.route` is canonical. `movement.waypoints` remains a compatibility
 * alias for movement plans written by earlier builds.
 *
 * @param {object|null} movement Combatant movement state.
 * @returns {object[]}
 */
function storedMovementRoute(movement) {
  if (Array.isArray(movement?.route) && movement.route.length) return movement.route;
  return Array.isArray(movement?.waypoints) ? movement.waypoints : [];
}

/**
 * Return compact route-state data for movement diagnostics.
 *
 * @param {object|null} movement Combatant movement state.
 * @returns {object|null}
 */
function storedMovementSummary(movement) {
  if (!movement || typeof movement !== "object") return null;
  const route = storedMovementRoute(movement);
  return {
    planStatus: movement.planStatus ?? "",
    draft: movement.draft === true,
    routeId: movement.routeId ?? "",
    routeRevision: Number(movement.routeRevision) || 0,
    captureSource: movement.captureSource ?? "",
    origin: cleanMovementPoint(movement.origin),
    destination: cleanMovementPoint(movement.destination),
    routeCount: route.length,
    distance: Number(movement.distance) || 0,
    stoppedReason: movement.stoppedReason ?? ""
  };
}

/**
 * Return compact Foundry movement-shape diagnostics without preserving stale
 * history arrays in high-frequency console logs.
 *
 * @param {object|null} movement Foundry movement-like object.
 * @returns {object|null}
 */
function foundryMovementSummary(movement) {
  if (!movement || typeof movement !== "object") return null;
  const count = value => Array.isArray(value?.waypoints) ? value.waypoints.length : 0;
  return {
    id: movement.id ?? null,
    state: movement.state ?? null,
    method: movement.method ?? null,
    destination: cleanMovementPoint(movement.destination),
    routeCount: Array.isArray(movement.route) ? movement.route.length : 0,
    waypointCount: Array.isArray(movement.waypoints) ? movement.waypoints.length : 0,
    pathCount: Array.isArray(movement.path) ? movement.path.length : 0,
    pendingWaypointCount: count(movement.pending),
    passedWaypointCount: count(movement.passed),
    unrecordedHistoryWaypointCount: count(movement.history?.unrecorded),
    recordedHistoryWaypointCount: count(movement.history?.recorded)
  };
}

/**
 * Bank a newly created explicit ruler waypoint as a draft movement revision.
 *
 * Draft revisions are persisted so the HUD and Combatant flag reflect every
 * Ctrl-authored corner. They are marked `draft: true` and are therefore never
 * executed unless preMoveToken finalizes the route.
 *
 * @param {TokenDocument|object} document Token document.
 * @param {object} rulerData TokenRuler refresh data.
 * @param {(action: string, payload?: object) => Promise<unknown>} requestGm GM request function.
 * @returns {void}
 */
function bankRulerMovementDraft(document, rulerData, requestGm) {
  const decision = movementCaptureDecision(document, {}, game.combat);
  if (!decision.capture || decision.reason !== "ok") return;
  const key = movementRulerDraftKey(document);
  if (!key) return;

  const rulerRoute = movementRouteFromRulerData(rulerData);
  const origin = cleanMovementPoint(document?._source) ?? cleanMovementPoint(document);
  const explicitWaypoints = cleanMovementRoute(rulerRoute.explicitWaypoints, origin);
  const signature = movementRouteSignature(explicitWaypoints);
  const previousDraft = movementRulerDrafts.get(key) ?? null;

  if (!explicitWaypoints.length || previousDraft?.signature === signature) return;

  movementDebug(MOVEMENT_DEBUG_CATEGORIES.CAPTURE, "ruler-refresh-observed", () => ({
    combatantId: decision.combatant.id,
    tokenId: document?.id ?? document?._id ?? null,
    currentUserId: game.user?.id ?? null,
    routeSource: rulerRoute.source,
    plannedUserId: rulerRoute.plannedUserId,
    plannedUserIds: rulerRoute.plannedUserIds,
    searching: rulerRoute.searching,
    hidden: rulerRoute.hidden,
    foundPathCount: rulerRoute.foundPath.length,
    explicitWaypointCount: explicitWaypoints.length,
    explicitWaypoints,
    pendingWaypointCount: rulerRoute.pendingWaypoints.length,
    passedWaypointCount: rulerRoute.passedWaypoints.length,
    historyWaypointCount: rulerRoute.history.length,
    unreachableWaypointCount: rulerRoute.unreachableWaypoints.length,
    signature,
    previousSignature: previousDraft?.signature ?? null
  }), {
    combatId: decision.combat.id,
    combatantId: decision.combatant.id,
    tokenId: document?.id ?? document?._id ?? null,
    phase: getCombatState(decision.combat).phase,
    level: MOVEMENT_DEBUG_LEVELS.TRACE
  });

  const combatantState = getCombatantState(decision.combatant);
  const routeRevision = nextMovementRouteRevision(
    combatantState.movement?.routeRevision,
    previousDraft?.routeRevision
  );
  const routeId = previousDraft?.routeId
    || `ruler:${document?.id ?? document?._id}:${game.user?.id ?? "unknown"}:${Date.now()}`;
  const capturedAt = Date.now();
  const draftPlan = annotateMovementPlan(
    movementPlanFromOperation(document, {
      id: routeId,
      origin,
      pending: { waypoints: explicitWaypoints },
      destination: explicitWaypoints.at(-1)
    }),
    {
      routeRevision,
      routeId,
      captureSource: "token-ruler-refresh",
      capturedAt,
      draft: true
    }
  );

  const draft = {
    key,
    sceneId: document?.parent?.id ?? canvas.scene?.id ?? null,
    tokenId: document?.id ?? document?._id ?? null,
    userId: game.user?.id ?? null,
    combatId: decision.combat.id,
    combatantId: decision.combatant.id,
    routeId,
    routeRevision,
    capturedAt,
    signature,
    explicitWaypoints,
    foundPath: rulerRoute.foundPath,
    pendingWaypoints: rulerRoute.pendingWaypoints,
    passedWaypoints: rulerRoute.passedWaypoints,
    history: rulerRoute.history,
    unreachableWaypoints: rulerRoute.unreachableWaypoints,
    previousMovement: previousDraft?.previousMovement
      ?? foundry.utils.deepClone(combatantState.movement),
    finalized: false,
    persisted: true
  };
  movementRulerDrafts.set(key, draft);

  movementDebug(MOVEMENT_DEBUG_CATEGORIES.CAPTURE, "ruler-waypoint-banked", () => ({
    combatantId: decision.combatant.id,
    tokenId: document?.id ?? document?._id ?? null,
    routeId,
    routeRevision,
    explicitWaypointCount: explicitWaypoints.length,
    explicitWaypoints,
    foundPathCount: rulerRoute.foundPath.length,
    foundPath: rulerRoute.foundPath,
    searching: rulerRoute.searching,
    unreachableWaypoints: rulerRoute.unreachableWaypoints,
    previousBankedMovement: storedMovementSummary(combatantState.movement),
    draftPlan: storedMovementSummary(draftPlan)
  }), {
    combatId: decision.combat.id,
    combatantId: decision.combatant.id,
    tokenId: document?.id ?? document?._id ?? null,
    phase: getCombatState(decision.combat).phase,
    level: MOVEMENT_DEBUG_LEVELS.TRACE
  });

  void requestGm("recordMovement", {
    combatId: decision.combat.id,
    combatantId: decision.combatant.id,
    movement: draftPlan
  }).then(() => {
    RenderCoordinator.invalidateCombatTracker("movement-plan-recorded");
  }).catch(warn);
}

/**
 * Restore the movement plan that existed before an unfinished ruler drag.
 *
 * @param {object} draft Cached ruler draft.
 * @param {(action: string, payload?: object) => Promise<unknown>} requestGm GM request function.
 * @returns {void}
 */
function restoreCancelledRulerDraft(draft, requestGm) {
  if (!draft?.persisted || draft.finalized || !draft.previousMovement) return;
  const combat = AoVAdapter.getCombatById?.(draft.combatId) ?? game.combat;
  const combatant = AoVAdapter.getCombatantById?.(combat, draft.combatantId)
    ?? combat?.combatants?.get?.(draft.combatantId)
    ?? null;
  const tokenId = draft.tokenId ?? null;
  const sceneId = draft.sceneId ?? canvas.scene?.id ?? "no-scene";
  if (!combatant || !combat?.started) return;

  const routeRevision = nextMovementRouteRevision(
    draft.routeRevision,
    getCombatantState(combatant).movement?.routeRevision
  );
  const restored = annotateMovementPlan(foundry.utils.deepClone(draft.previousMovement), {
    routeRevision,
    routeId: draft.previousMovement.routeId || `restore:${sceneId}:${tokenId}:${Date.now()}`,
    captureSource: "token-ruler-cancel-restore",
    capturedAt: Date.now(),
    draft: draft.previousMovement.draft === true
  });

  movementDebug(MOVEMENT_DEBUG_CATEGORIES.CAPTURE, "ruler-draft-cancelled", () => ({
    combatantId: combatant.id,
    tokenId,
    cancelledRouteId: draft.routeId,
    cancelledRevision: draft.routeRevision,
    restored
  }), {
    combatId: combat.id,
    combatantId: combatant.id,
    tokenId,
    phase: getCombatState(combat).phase,
    level: MOVEMENT_DEBUG_LEVELS.VERBOSE
  });

  void requestGm("recordMovement", {
    combatId: combat.id,
    combatantId: combatant.id,
    movement: restored
  }).then(() => RenderCoordinator.invalidateCombatTracker("movement-plan-cancelled")).catch(warn);
}

/**
 * Wrap the documented TokenRuler refresh surface to observe live route edits.
 *
 * @param {(action: string, payload?: object) => Promise<unknown>} requestGm GM request function.
 * @returns {boolean}
 */
function installMovementRulerCapture(requestGm) {
  const activeRuler = globalThis.canvas?.tokens?.placeables
    ?.find?.(token => token?.ruler)?.ruler
    ?? null;
  const RulerClass = globalThis.CONFIG?.Token?.rulerClass
    ?? globalThis.foundry?.canvas?.placeables?.tokens?.TokenRuler
    ?? activeRuler?.constructor
    ?? null;
  const prototype = RulerClass?.prototype;
  if (!prototype || typeof prototype.refresh !== "function") {
    movementDebugWarn(MOVEMENT_DEBUG_CATEGORIES.CAPTURE, "token-ruler-unavailable", () => ({
      hasConfigRulerClass: !!globalThis.CONFIG?.Token?.rulerClass,
      hasNamespacedRulerClass: !!globalThis.foundry?.canvas?.placeables?.tokens?.TokenRuler
    }));
    return false;
  }
  if (prototype[MOVEMENT_RULER_CAPTURE_PATCH]) return true;

  const originalRefresh = prototype.refresh;
  const originalClear = prototype.clear;
  Object.defineProperty(prototype, MOVEMENT_RULER_CAPTURE_PATCH, {
    configurable: false,
    enumerable: false,
    value: true
  });

  prototype.refresh = function skjaldborgRefreshMovementRuler(rulerData) {
    const result = originalRefresh.call(this, rulerData);
    const moduleData = rulerData?.[MODULE_ID];
    if (moduleData?.movementPlanPreview === true) return result;
    try {
      bankRulerMovementDraft(this.token?.document ?? this.token, rulerData, requestGm);
    }
    catch (err) {
      warn(err);
      movementDebugWarn(MOVEMENT_DEBUG_CATEGORIES.CAPTURE, "ruler-refresh-capture-error", () => ({
        error: String(err?.stack ?? err?.message ?? err)
      }));
    }
    return result;
  };

  if (typeof originalClear === "function") {
    prototype.clear = function skjaldborgClearMovementRuler(...args) {
      const document = this.token?.document ?? this.token;
      const key = movementRulerDraftKey(document);
      const draft = key ? movementRulerDrafts.get(key) : null;
      const result = originalClear.apply(this, args);
      queueMicrotask(() => {
        if (!key || movementRulerDrafts.get(key) !== draft) return;
        movementRulerDrafts.delete(key);
        restoreCancelledRulerDraft(draft, requestGm);
      });
      return result;
    };
  }

  movementDebug(MOVEMENT_DEBUG_CATEGORIES.CAPTURE, "token-ruler-capture-installed", () => ({
    rulerClass: RulerClass.name ?? "TokenRuler"
  }), { level: MOVEMENT_DEBUG_LEVELS.VERBOSE });
  return true;
}

/**
 * Normalize a Foundry v14 Token movement operation into a storable module plan.
 *
 * The movement hook supplies movement data and operation options separately.
 * Preserve both because ctrl-authored waypoints may be exposed by either
 * surface depending on the initiating core workflow.
 *
 * @param {TokenDocument|object} document Token document.
 * @param {object} [movement={}] Token movement data.
 * @param {object} [operation={}] Token movement operation options.
 * @returns {import("../types.mjs").SkjaldborgMovementPlan}
 */
export function movementPlanFromOperation(document, movement = {}, operation = {}) {
  const movementPayload = movement && typeof movement === "object" ? movement : {};
  const operationPayload = operation && typeof operation === "object" ? operation : {};
  const origin = cleanMovementPoint(movementPayload.origin)
    ?? cleanMovementPoint(document?._source)
    ?? cleanMovementPoint(document)
    ?? tokenCenter(document);
  const operationRoute = movementRouteFromOperation(document, operationPayload);
  const routePayload = operationRoute.waypoints.length
    ? { route: operationRoute.waypoints }
    : {
        ...movementPayload,
        operation: operationPayload
      };
  const baseNormalized = normalizeMovementRoute(routePayload, {
    document: operationRoute.waypoints.length ? null : document,
    origin
  });
  const normalized = operationRoute.waypoints.length
    ? {
        ...baseNormalized,
        source: operationRoute.source,
        candidates: [{
          source: operationRoute.source,
          priority: 0,
          count: operationRoute.waypoints.length,
          points: operationRoute.waypoints
        }]
      }
    : baseNormalized;
  const { route, waypoints, destination, source, truncated, candidates } = normalized;
  const measuredPath = [origin, ...waypoints].filter(Boolean);
  const plan = {
    mode: "planned",
    origin,
    destination: destination ?? waypoints.at(-1) ?? null,
    route,
    waypoints,
    distance: measureSceneDistance(measuredPath),
    units: String(canvas.scene?.grid?.units ?? ""),
    manual: false,
    planStatus: waypoints.length ? MOVEMENT_PLAN_STATUS.PLANNED : MOVEMENT_PLAN_STATUS.NONE,
    startedAt: null,
    completedAt: null,
    stoppedReason: "",
    routeRevision: 0,
    routeId: String(movementPayload.id ?? ""),
    captureSource: source ?? "",
    capturedAt: Date.now(),
    draft: false
  };
  movementDebug(MOVEMENT_DEBUG_CATEGORIES.CAPTURE, "movement-plan-from-operation", () => ({
    tokenId: document?.id ?? document?._id ?? null,
    movementId: movementPayload.id ?? null,
    movementState: movementPayload.state ?? null,
    movementMethod: movementPayload.method ?? null,
    movementChain: movementPayload.chain ?? [],
    origin,
    destination: plan.destination,
    routeSource: source,
    routeCandidates: candidates,
    pendingWaypointCount: movementPayload.pending?.waypoints?.length ?? 0,
    passedWaypointCount: movementPayload.passed?.waypoints?.length ?? 0,
    unrecordedHistoryWaypointCount: movementPayload.history?.unrecorded?.waypoints?.length ?? 0,
    recordedHistoryWaypointCount: movementPayload.history?.recorded?.waypoints?.length ?? 0,
    truncated,
    movementSummary: foundryMovementSummary(movementPayload),
    operationKeys: Object.keys(operationPayload),
    operationMovementTokenIds: operationPayload.movement && typeof operationPayload.movement === "object"
      ? Object.keys(operationPayload.movement)
      : [],
    operationRouteSource: operationRoute.source,
    operationRouteTokenId: operationRoute.tokenId,
    operationRouteAvailableTokenIds: operationRoute.availableTokenIds,
    operationRouteWaypointCount: operationRoute.waypoints.length,
    operationRouteWaypoints: operationRoute.waypoints,
    waypointCount: plan.waypoints.length,
    distance: plan.distance,
    plan
  }), { level: MOVEMENT_DEBUG_LEVELS.TRACE, tokenId: document?.id ?? document?._id ?? null });
  return plan;
}

/**
 * Normalize an AoV weapon length string to meters.
 *
 * @param {unknown} value AoV weapon length string.
 * @returns {number|null}
 */
export function parseWeaponLengthMeters(value) {
  const text = String(value ?? "").toLowerCase();
  const matches = [...text.matchAll(/(\d+(?:[.,]\d+)?)/g)].map(match => Number(match[1].replace(",", ".")));
  const numeric = matches.filter(Number.isFinite);
  if (!numeric.length) return null;
  const amount = Math.max(...numeric);
  if (/\b(cm|centimeter|centimeters|centimetre|centimetres)\b/.test(text)) return amount / 100;
  if (/\b(mm|millimeter|millimeters|millimetre|millimetres)\b/.test(text)) return amount / 1000;
  if (/\b(ft|feet|foot)\b/.test(text)) return amount * 0.3048;
  if (/\b(in|inch|inches)\b/.test(text)) return amount * 0.0254;
  if (/\b(yd|yard|yards)\b/.test(text)) return amount * 0.9144;
  return amount > 10 ? amount / 100 : amount;
}

/**
 * Determine whether a weapon item can establish melee engagement reach.
 *
 * @param {Item|object|null} item AoV weapon item.
 * @returns {boolean}
 */
function weaponCanEstablishReach(item) {
  if (item?.type !== "weapon") return false;
  if (Number(item?.system?.equipStatus) !== 1) return false;
  const weaponType = String(item?.system?.weaponType ?? "");
  if (weaponType === "missile") return false;
  return true;
}

/**
 * Resolve the best available melee length for an equipped AoV weapon.
 *
 * @param {Item|object|null} item AoV weapon item.
 * @returns {number|null}
 */
export function weaponReachLengthMeters(item) {
  if (!weaponCanEstablishReach(item)) return null;
  return parseWeaponLengthMeters(item?.system?.length);
}

/**
 * Convert a weapon length in meters to fixed grid-unit engagement reach.
 *
 * @param {number|null} meters Weapon length in meters.
 * @returns {number}
 */
export function reachUnitsFromLength(meters) {
  if (!Number.isFinite(meters)) return DEFAULT_ENGAGEMENT_REACH_UNITS;
  if (meters >= LONG_REACH_LENGTH_METERS) return LONG_ENGAGEMENT_REACH_UNITS;
  if (meters >= MEDIUM_REACH_LENGTH_METERS) return MEDIUM_ENGAGEMENT_REACH_UNITS;
  return DEFAULT_ENGAGEMENT_REACH_UNITS;
}

/**
 * Determine melee reach from the actor's module-managed readied weapon.
 *
 * @param {Actor|object|null} actor Actor document.
 * @returns {number}
 */
export function reachUnitsForActor(actor) {
  const weapon = getReadiedWeapon(actor);
  if (!weapon || !weaponCanEstablishReach(weapon)) return DEFAULT_ENGAGEMENT_REACH_UNITS;
  return reachUnitsFromLength(weaponReachLengthMeters(weapon));
}

/**
 * Determine melee reach from the combatant's one currently readied weapon.
 *
 * @param {Combatant|object|null} combatant Foundry Combatant document.
 * @returns {number}
 */
export function reachUnitsForCombatant(combatant) {
  return reachUnitsForActor(combatant?.actor);
}

/**
 * Determine whether two token dispositions are hostile opposites.
 *
 * @param {number|null|undefined} a First disposition.
 * @param {number|null|undefined} b Second disposition.
 * @returns {boolean}
 */
export function areOpposingDispositions(a, b) {
  const friendly = globalThis.CONST?.TOKEN_DISPOSITIONS?.FRIENDLY ?? FRIENDLY_DISPOSITION;
  const hostile = globalThis.CONST?.TOKEN_DISPOSITIONS?.HOSTILE ?? HOSTILE_DISPOSITION;
  return (Number(a) === friendly && Number(b) === hostile)
    || (Number(a) === hostile && Number(b) === friendly);
}

/**
 * Resolve a TokenDocument for a combatant.
 *
 * @param {Combatant|object|null} combatant Foundry Combatant.
 * @returns {TokenDocument|object|null}
 */
function tokenDocumentForCombatant(combatant) {
  return combatant?.token?.object?.document
    ?? combatant?.token?.document
    ?? combatant?.token
    ?? canvas.scene?.tokens?.get?.(combatant?.tokenId)
    ?? null;
}

/**
 * Iterate combatants from either Foundry Collections or plain Maps.
 *
 * @param {Combat|null|undefined} combat Combat document.
 * @returns {Combatant[]}
 */
function combatantValues(combat) {
  return Array.from(combat?.combatants ?? []).map(entry => Array.isArray(entry) ? entry[1] : entry);
}

/**
 * Resolve a combatant for a TokenDocument.
 *
 * @param {Combat|null} combat Active combat.
 * @param {TokenDocument|object|null} document Token document.
 * @returns {Combatant|null}
 */
function combatantForTokenDocument(combat, document) {
  const tokenId = document?.id ?? document?._id;
  if (!combat || !tokenId) return null;
  return combatantValues(combat).find(combatant => {
    return combatant.tokenId === tokenId
      || combatant.token?.id === tokenId
      || combatant.token?.object?.id === tokenId
      || combatant.token?.object?.document?.id === tokenId;
  }) ?? null;
}

const ENGAGEMENT_EGRESS_ACTIVE = "active";

function activeEgressPartnerIds(state) {
  const egress = state?.engagement?.egress ?? {};
  if (egress.status !== ENGAGEMENT_EGRESS_ACTIVE) return [];
  return Array.from(new Set((egress.ignoredPartnerIds ?? []).filter(Boolean)));
}

function egressIgnoresPartner(state, partnerId) {
  if (!partnerId) return false;
  return activeEgressPartnerIds(state).includes(partnerId);
}

async function clearEgressPartner(combatant, partnerId, reason = "egress-cleared") {
  if (!combatant?.id || !partnerId) return false;
  const state = getCombatantState(combatant);
  const egress = state.engagement?.egress ?? {};
  if (egress.status !== ENGAGEMENT_EGRESS_ACTIVE) return false;
  const current = activeEgressPartnerIds(state);
  if (!current.includes(partnerId)) return false;
  const remaining = current.filter(id => id !== partnerId);
  await updateCombatantState(combatant, {
    engagement: {
      ...state.engagement,
      egress: {
        ...egress,
        status: remaining.length ? ENGAGEMENT_EGRESS_ACTIVE : "none",
        ignoredPartnerIds: remaining,
        reason
      }
    }
  });
  movementDebug(MOVEMENT_DEBUG_CATEGORIES.ENGAGEMENT, "engagement-egress-cleared", () => ({
    combatantId: combatant.id,
    partnerId,
    remaining,
    reason
  }), { combatId: combatant.combat?.id ?? game.combat?.id ?? null, combatantId: combatant.id, level: MOVEMENT_DEBUG_LEVELS.VERBOSE });
  return true;
}

async function clearSeparatedEgressPair(combatant, partner, reason = "egress-separated") {
  const first = await clearEgressPartner(combatant, partner?.id, reason);
  const second = await clearEgressPartner(partner, combatant?.id, reason);
  return first || second;
}

function pairHasActiveEgress(mover, moverState, other, otherState) {
  return egressIgnoresPartner(moverState, other?.id) || egressIgnoresPartner(otherState, mover?.id);
}

async function shouldSkipEngagementForEgress(combat, mover, moverState, other, otherState, separation, threshold, run) {
  if (!pairHasActiveEgress(mover, moverState, other, otherState)) return false;
  if (Number.isFinite(separation) && Number.isFinite(threshold) && separation > threshold) {
    await clearSeparatedEgressPair(mover, other, "egress-separated");
    return false;
  }
  movementDebug(MOVEMENT_DEBUG_CATEGORIES.ENGAGEMENT, "engagement-egress-skip", () => ({
    moverId: mover?.id ?? null,
    otherId: other?.id ?? null,
    separation,
    threshold,
    moverEgress: moverState.engagement?.egress ?? null,
    otherEgress: otherState.engagement?.egress ?? null
  }), { runId: run?.runId, tick: run?.tick, combatId: combat?.id ?? null, combatantId: mover?.id ?? null, level: MOVEMENT_DEBUG_LEVELS.VERBOSE });
  return true;
}

async function finalizeMovementEgresses(combat) {
  if (!combat) return 0;
  const run = activeRuns.get(combat?.id);
  const combatants = combatantValues(combat).filter(AoVAdapter.isCombatantCapable.bind(AoVAdapter));
  const byId = new Map(combatants.map(combatant => [combatant.id, combatant]));
  const processed = new Set();
  let resolved = 0;

  for (const combatant of combatants) {
    const state = getCombatantState(combatant);
    const egressPartnerIds = activeEgressPartnerIds(state);
    if (!egressPartnerIds.length) continue;
    const document = tokenDocumentForCombatant(combatant);
    const rect = tokenSourceGridRect(document);

    for (const partnerId of egressPartnerIds) {
      const partner = byId.get(partnerId);
      if (!partner) {
        if (await clearEgressPartner(combatant, partnerId, "egress-partner-missing")) resolved += 1;
        continue;
      }
      const key = engagementPairKey(combatant, partner);
      if (processed.has(key)) continue;
      processed.add(key);

      const partnerDocument = tokenDocumentForCombatant(partner);
      const partnerRect = tokenSourceGridRect(partnerDocument);
      if (!rect || !partnerRect || !areOpposingDispositions(document?.disposition, partnerDocument?.disposition)) {
        if (await clearSeparatedEgressPair(combatant, partner, "egress-invalid-final-state")) resolved += 1;
        continue;
      }

      const threshold = Math.max(reachUnitsForCombatant(combatant), reachUnitsForCombatant(partner));
      const separation = measureOccupiedGridSeparation(rect, partnerRect);
      if (!Number.isFinite(separation) || !Number.isFinite(threshold) || separation > threshold) {
        if (await clearSeparatedEgressPair(combatant, partner, "egress-final-separated")) resolved += 1;
        continue;
      }

      const latestState = getCombatantState(combatant);
      const latestPartnerState = getCombatantState(partner);
      const pairEligibility = pairCanEstablishEngagement(combat, combatant, latestState, partner, latestPartnerState);
      if (!pairEligibility.canEngage) {
        movementDebug(MOVEMENT_DEBUG_CATEGORIES.ENGAGEMENT, "egress-final-still-in-reach-but-cannot-engage", () => ({
          combatantId: combatant.id,
          partnerId: partner.id,
          separation,
          threshold,
          combatantEligibility: pairEligibility.firstEligibility,
          partnerEligibility: pairEligibility.secondEligibility
        }), { runId: run?.runId, combatId: combat?.id, combatantId: combatant.id, level: MOVEMENT_DEBUG_LEVELS.VERBOSE });
        if (await clearSeparatedEgressPair(combatant, partner, "egress-final-half-move-ineligible")) resolved += 1;
        continue;
      }

      movementDebug(MOVEMENT_DEBUG_CATEGORIES.ENGAGEMENT, "egress-ended-still-in-reach", () => ({
        combatantId: combatant.id,
        partnerId: partner.id,
        separation,
        threshold,
        combatantEligibility: pairEligibility.firstEligibility,
        partnerEligibility: pairEligibility.secondEligibility
      }), { runId: run?.runId, combatId: combat?.id, combatantId: combatant.id, level: MOVEMENT_DEBUG_LEVELS.VERBOSE });
      await engagePair(combat, combatant, partner);
      if (await clearSeparatedEgressPair(combatant, partner, "egress-final-reengaged")) resolved += 1;
    }
  }

  if (resolved) RenderCoordinator.invalidateCombatTracker("movement-egress-finalized");
  return resolved;
}

/**
 * Check whether a document update belongs to module-owned movement execution.
 *
 * @param {object} [operation={}] Token movement operation.
 * @returns {boolean}
 */
export function isInternalMovementOperation(operation = {}) {
  const moduleOperation = operation?.[MODULE_ID];
  if (moduleOperation?.movementExecution === true) return true;
  const reason = String(moduleOperation?.reason ?? "");
  return ["grapple-throw", "knockback"].includes(reason);
}

/**
 * Whether this token movement should be captured in the active planning surface.
 *
 * @param {TokenDocument|object} document Token document.
 * @param {object} [operation={}] Token movement operation options.
 * @param {Combat|null} [combat=game.combat] Active combat.
 * @returns {{capture: boolean, combat: Combat|null, combatant: Combatant|null, reason: string}}
 */
export function movementCaptureDecision(document, operation = {}, combat = game.combat) {
  if (isInternalMovementOperation(operation)) return { capture: false, combat, combatant: null, reason: "internal" };
  if (!AoVAdapter.enabledSetting) return { capture: false, combat, combatant: null, reason: "disabled" };
  if (!combat?.started) return { capture: false, combat, combatant: null, reason: "not-started" };
  const state = getCombatState(combat);
  if (!state.enabled || !isMovementPlanningPhase(state.phase)) {
    return { capture: false, combat, combatant: null, reason: "phase" };
  }
  if (
    state.movementRun?.status === MOVEMENT_PLAN_STATUS.EXECUTING
    && !shouldExecuteMovementImmediately(state.phase)
  ) {
    return { capture: false, combat, combatant: null, reason: "movement-running" };
  }
  const combatant = combatantForTokenDocument(combat, document);
  if (!combatant) return { capture: false, combat, combatant: null, reason: "non-combatant" };
  if (!AoVAdapter.canUserControlCombatant(game.user, combatant)) return { capture: false, combat, combatant, reason: "permission" };
  const combatantState = getCombatantState(combatant);
  const actionCategory = combatantState.intent?.actionCategory;
  if (
    combatantState.engagement?.engaged
    && ![ACTION_CATEGORIES.RETREAT, "flee"].includes(actionCategory)
  ) {
    return { capture: true, combat, combatant, reason: "engaged-blocked" };
  }
  return { capture: true, combat, combatant, reason: "ok" };
}

/**
 * Log one movement-capture decision.
 *
 * @param {TokenDocument|object} document Token document.
 * @param {object} movement Foundry movement payload.
 * @param {object} operation Foundry movement operation options.
 * @param {object} decision Capture decision.
 * @returns {void}
 */
function debugCaptureDecision(document, movement, operation, decision) {
  const category = MOVEMENT_DEBUG_CATEGORIES.CAPTURE;
  const payload = () => ({
    reason: decision.reason,
    capture: decision.capture,
    combatStarted: decision.combat?.started === true,
    phase: getCombatState(decision.combat).phase,
    combatantId: decision.combatant?.id ?? null,
    tokenSource: cleanMovementPoint(document?._source) ?? cleanMovementPoint(document),
    movement,
    operation
  });
  const meta = {
    combatId: decision.combat?.id ?? null,
    combatantId: decision.combatant?.id ?? null,
    tokenId: document?.id ?? document?._id ?? null,
    phase: getCombatState(decision.combat).phase,
    level: MOVEMENT_DEBUG_LEVELS.VERBOSE
  };
  movementDebug(category, "capture-decision", payload, meta);
  if (decision.capture && !isMovementPlanningPhase(getCombatState(decision.combat).phase)) {
    movementDebugWarn(category, "unexpected-capture-gate", payload, meta);
  }
}

/**
 * Display scrolling text over a token if the canvas interface is available.
 *
 * @param {TokenDocument|object|null} document Token document.
 * @param {string} text Text to display.
 * @returns {Promise<void>}
 */
async function showScrollingText(document, text) {
  const center = tokenCenter(document);
  if (!center || !canvas.interface?.createScrollingText) {
    movementDebug(MOVEMENT_DEBUG_CATEGORIES.ENGAGEMENT, "scrolling-text-unavailable", () => ({
      tokenId: document?.id ?? document?._id ?? null,
      text,
      center,
      hasInterface: !!canvas.interface?.createScrollingText
    }), { tokenId: document?.id ?? document?._id ?? null, level: MOVEMENT_DEBUG_LEVELS.TRACE });
    return;
  }
  movementDebug(MOVEMENT_DEBUG_CATEGORIES.ENGAGEMENT, "scrolling-text", () => ({
    tokenId: document?.id ?? document?._id ?? null,
    text,
    center
  }), { tokenId: document?.id ?? document?._id ?? null, level: MOVEMENT_DEBUG_LEVELS.TRACE });
  await canvas.interface.createScrollingText(center, text, {
    anchor: globalThis.CONST?.TEXT_ANCHOR_POINTS?.CENTER,
    direction: globalThis.CONST?.TEXT_ANCHOR_POINTS?.TOP,
    distance: 40,
    duration: 1400,
    jitter: 0.15
  });
}

/**
 * Mark a combatant's movement plan with a new status.
 *
 * @param {Combatant|object} combatant Combatant document.
 * @param {string} status New plan status.
 * @param {object} [patch={}] Additional movement fields.
 * @returns {Promise<unknown>}
 */
async function markMovementStatus(combatant, status, patch = {}) {
  const state = getCombatantState(combatant);
  return updateCombatantState(combatant, {
    movement: {
      ...state.movement,
      planStatus: status,
      ...patch
    }
  });
}

/**
 * Calculate actual traveled distance from movement history where possible.
 *
 * @param {TokenDocument|object|null} document Token document.
 * @param {import("../types.mjs").SkjaldborgMovementPlan} plan Stored movement plan.
 * @returns {number}
 */
export function actualMovementDistance(document, plan) {
  const history = Array.isArray(document?.movementHistory) ? document.movementHistory : [];
  const historyPoints = history.map(cleanMovementPoint).filter(Boolean);
  if (historyPoints.length > 1) return measureSceneDistance(historyPoints);

  const current = cleanMovementPoint(document) ?? tokenCenter(document);
  const path = [plan?.origin, current].map(cleanMovementPoint).filter(Boolean);
  return measureSceneDistance(path);
}

/**
 * Measure the module-owned path traveled by one movement context.
 *
 * @param {object|null|undefined} context Active movement context.
 * @returns {number|null}
 */
function contextMovementDistance(context) {
  const path = Array.isArray(context?.traveledWaypoints)
    ? context.traveledWaypoints.map(cleanMovementPoint).filter(Boolean)
    : [];
  return path.length > 1 ? measureSceneDistance(path) : null;
}

/**
 * Resolve the active movement context for a combatant.
 *
 * @param {Combat|null} combat Active combat.
 * @param {Combatant|object|null} combatant Combatant document.
 * @returns {object|null}
 */
function activeMovementContext(combat, combatant) {
  return activeRuns.get(combat?.id)?.contextsByCombatantId?.get(combatant?.id) ?? null;
}

/**
 * Resolve how far a combatant has actually moved in the current Movement
 * phase, expressed in RAW grid units instead of scene measuring units.
 *
 * @param {Combat|null} combat Active combat.
 * @param {Combatant|object|null} combatant Combatant document.
 * @param {import("../types.mjs").SkjaldborgCombatantState} state Combatant state.
 * @returns {number}
 */
function currentMovementGridUnits(combat, combatant, state) {
  const context = activeMovementContext(combat, combatant);
  const contextDistance = contextMovementDistance(context);
  const movement = state?.movement ?? {};
  const fallbackDistance = [
    MOVEMENT_PLAN_STATUS.COMPLETED,
    MOVEMENT_PLAN_STATUS.STOPPED,
    MOVEMENT_PLAN_STATUS.FAILED
  ].includes(movement.planStatus)
    ? Number(movement.distance ?? 0)
    : 0;
  return sceneDistanceToGridUnits(contextDistance ?? fallbackDistance);
}

/**
 * Determine whether a combatant can participate in a newly established
 * engagement now.
 *
 * RAW movement eligibility is per combatant, not per pair. A combatant that
 * has exceeded the engagement movement limit cannot be pulled into a new
 * reciprocal engagement by an otherwise eligible opponent. Existing
 * engagements and explicit disengagement/egress flows are handled elsewhere.
 *
 * @param {Combat|null} combat Active combat.
 * @param {Combatant|object|null} combatant Combatant document.
 * @param {import("../types.mjs").SkjaldborgCombatantState} state Combatant state.
 * @returns {{canEngage: boolean, movedGridUnits: number, limitGridUnits: number}}
 */
function combatantEngagementEligibility(combat, combatant, state) {
  const movedGridUnits = currentMovementGridUnits(combat, combatant, state);
  const limitGridUnits = engagementMovementLimitGridUnits(combatant);
  return {
    canEngage: canEstablishEngagementAfterMovement(combatant, movedGridUnits),
    movedGridUnits,
    limitGridUnits
  };
}

function pairCanEstablishEngagement(combat, first, firstState, second, secondState) {
  const firstEligibility = combatantEngagementEligibility(combat, first, firstState);
  const secondEligibility = combatantEngagementEligibility(combat, second, secondState);
  const blockingCombatantIds = [];
  if (!firstEligibility.canEngage && first?.id) blockingCombatantIds.push(first.id);
  if (!secondEligibility.canEngage && second?.id) blockingCombatantIds.push(second.id);
  return {
    canEngage: firstEligibility.canEngage && secondEligibility.canEngage,
    firstEligibility,
    secondEligibility,
    blockingCombatantIds
  };
}

/**
 * Read the checkpoint pacing delay.
 *
 * @returns {number}
 */
function movementTickDelayMs() {
  const value = Number(game.settings.get(MODULE_ID, "movementTickDelayMs"));
  if (!Number.isFinite(value)) return DEFAULT_MOVEMENT_TICK_DELAY_MS;
  return Math.max(0, Math.min(1000, Math.round(value)));
}

/**
 * Await the configured movement tick delay.
 *
 * @returns {Promise<void>}
 */
async function waitMovementTickDelay() {
  const delay = movementTickDelayMs();
  if (delay <= 0) return;
  await new Promise(resolve => globalThis.setTimeout(resolve, delay));
}

/**
 * Build a stable unordered key for an engagement pair.
 *
 * @param {Combatant|object} first First combatant.
 * @param {Combatant|object} second Second combatant.
 * @returns {string}
 */
function engagementPairKey(first, second) {
  return [String(first?.id ?? ""), String(second?.id ?? "")].sort().join(":");
}

function combatantOrderIndex(combatants, combatant) {
  return Math.max(0, combatants.findIndex(candidate => candidate?.id === combatant?.id));
}

/**
 * Mark combatants as stopped in the in-memory run before any document writes.
 * This prevents a following checkpoint from being submitted while engagement
 * flags and Active Effects are still being persisted.
 *
 * @param {Combat|null} combat Active combat.
 * @param {...(Combatant|object|null)} combatants Combatants to stop.
 * @returns {void}
 */
function markRunCombatantsStopped(combat, ...combatants) {
  const run = activeRuns.get(combat?.id);
  if (!run) return;
  run.stoppedCombatantIds ??= new Set();
  for (const combatant of combatants) {
    if (combatant?.id) run.stoppedCombatantIds.add(combatant.id);
  }
}

/**
 * Test the in-memory movement stop latch for a combatant.
 *
 * @param {Combat|null} combat Active combat.
 * @param {Combatant|object|null} combatant Combatant document.
 * @returns {boolean}
 */
function isRunCombatantStopped(combat, combatant) {
  return activeRuns.get(combat?.id)?.stoppedCombatantIds?.has(combatant?.id) === true;
}

/**
 * Build current token footprint occupancy for this combat.
 *
 * @param {Combat|null} combat Active combat.
 * @returns {{combatant: object, document: object, rect: object}[]}
 */
function currentCombatOccupancy(combat) {
  return combatantValues(combat)
    .filter(AoVAdapter.isCombatantCapable.bind(AoVAdapter))
    .map(combatant => {
      const document = tokenDocumentForCombatant(combatant);
      return { combatant, document, rect: tokenSourceGridRect(document) };
    })
    .filter(entry => entry.document && entry.rect);
}

/**
 * Find whether a proposed checkpoint footprint is occupied or reserved.
 *
 * @param {object} context Movement context.
 * @param {object} waypoint Candidate checkpoint waypoint.
 * @param {object[]} occupancy Current combat token occupancy.
 * @param {object[]} reservations Current tick reservations.
 * @returns {object|null}
 */
function movementFootprintBlocker(context, waypoint, occupancy, reservations) {
  const rect = tokenSourceGridRect(context.document, waypoint);
  if (!rect) return null;
  for (const entry of occupancy) {
    if (entry.combatant?.id === context.combatant?.id) continue;
    if (gridRectsOverlap(rect, entry.rect)) return { type: "occupied", rect, blocker: entry.combatant };
  }
  for (const reservation of reservations) {
    if (reservation.combatant?.id === context.combatant?.id) continue;
    if (gridRectsOverlap(rect, reservation.rect)) return { type: "reserved", rect, blocker: reservation.combatant };
  }
  return null;
}

/**
 * Find whether the next checkpoint footprint is blocked this tick.
 *
 * @param {object} context Movement context.
 * @param {object} checkpoint Candidate checkpoint.
 * @param {object[]} occupancy Current combat token occupancy.
 * @param {object[]} reservations Current tick reservations.
 * @returns {object|null}
 */
function movementCheckpointBlocker(context, checkpoint, occupancy, reservations) {
  return movementFootprintBlocker(context, checkpoint, occupancy, reservations);
}

/**
 * Reserve the occupied footprint for one checkpoint.
 *
 * @param {object} context Movement context.
 * @param {object} checkpoint Candidate checkpoint.
 * @param {object[]} reservations Current tick reservations.
 * @returns {object|null}
 */
function reserveMovementCheckpoint(context, checkpoint, reservations) {
  const rect = tokenSourceGridRect(context.document, checkpoint);
  if (!rect) return null;
  reservations.push({ combatant: context.combatant, rect });
  return { checkpoint, rect };
}

/**
 * Safely stop a movement context which cannot progress.
 *
 * @param {object} context Movement context.
 * @param {string} reason Stop reason.
 * @returns {Promise<void>}
 */
async function stopMovementContext(context, reason) {
  if (context.status !== MOVEMENT_PLAN_STATUS.EXECUTING) return;
  const distance = contextMovementDistance(context);
  await markMovementStatus(context.combatant, MOVEMENT_PLAN_STATUS.STOPPED, {
    distance: distance ?? actualMovementDistance(context.document, getCombatantState(context.combatant).movement),
    completedAt: Date.now(),
    stoppedReason: reason
  });
  context.status = MOVEMENT_PLAN_STATUS.STOPPED;
}

/**
 * Select all unblocked operations for one scheduler tick.
 *
 * @param {Combat} combat Active combat.
 * @param {object[]} contexts Movement contexts.
 * @returns {Promise<{operations: object[], blocked: object[]}>}
 */
async function selectMovementTickOperations(combat, contexts) {
  const run = activeRuns.get(combat?.id);
  const occupancy = currentCombatOccupancy(combat);
  const reservations = [];
  const operations = [];
  const blocked = [];
  movementDebug(MOVEMENT_DEBUG_CATEGORIES.COLLISION, "tick-occupancy", () => ({
    occupancy: occupancy.map(entry => ({
      combatantId: entry.combatant?.id,
      tokenId: entry.document?.id ?? entry.document?._id ?? null,
      rect: entry.rect
    }))
  }), { runId: run?.runId, tick: run?.tick, combatId: combat?.id, level: MOVEMENT_DEBUG_LEVELS.TRACE });

  for (const context of contexts) {
    const waypoints = nextMovementWaypoints(combat, context);
    if (!waypoints.length) {
      if (context.status === MOVEMENT_PLAN_STATUS.EXECUTING) await completeMovementContext(context);
      continue;
    }
    const [waypoint] = waypoints;
    const blocker = movementCheckpointBlocker(context, waypoint, occupancy, reservations);
    if (blocker) {
      context.blockedTicks = Number(context.blockedTicks ?? 0) + 1;
      blocked.push({ context, waypoint, blocker });
      movementDebug(MOVEMENT_DEBUG_CATEGORIES.COLLISION, "checkpoint-blocked", () => ({
        combatantId: context.combatant?.id,
        tokenId: context.document?.id ?? context.document?._id ?? null,
        checkpointIndex: context.index,
        segmentIndex: context.segmentIndex,
        checkpoint: waypoint,
        blockedTicks: context.blockedTicks,
        blocker: {
          type: blocker.type,
          combatantId: blocker.blocker?.id ?? null,
          rect: blocker.rect
        }
      }), {
        runId: run?.runId,
        tick: run?.tick,
        combatId: combat?.id,
        combatantId: context.combatant?.id,
        tokenId: context.document?.id ?? context.document?._id ?? null,
        level: MOVEMENT_DEBUG_LEVELS.VERBOSE
      });
      continue;
    }
    const reservedFootprint = reserveMovementCheckpoint(context, waypoint, reservations);
    context.blockedTicks = 0;
    operations.push({ context, waypoints });
    movementDebug(MOVEMENT_DEBUG_CATEGORIES.SCHEDULER, "checkpoint-reserved", () => ({
      combatantId: context.combatant?.id,
      checkpointIndex: context.index,
      segmentIndex: context.segmentIndex,
      checkpoint: waypoint,
      reservedFootprint
    }), {
      runId: run?.runId,
      tick: run?.tick,
      combatId: combat?.id,
      combatantId: context.combatant?.id,
      tokenId: context.document?.id ?? context.document?._id ?? null,
      level: MOVEMENT_DEBUG_LEVELS.TRACE
    });
  }

  if (blocked.length) {
    await checkMovementEngagements(combat);
    for (const { context } of blocked) {
      if (!canExecuteContext(combat, context)) {
        context.status = MOVEMENT_PLAN_STATUS.STOPPED;
        continue;
      }
      if (Number(context.blockedTicks ?? 0) < MAX_BLOCKED_TICKS) continue;
      movementDebugWarn(MOVEMENT_DEBUG_CATEGORIES.COLLISION, "blocked-stop-threshold", () => ({
        combatantId: context.combatant?.id,
        blockedTicks: context.blockedTicks,
        index: context.index,
        remaining: context.waypoints.length - context.index
      }), { runId: run?.runId, tick: run?.tick, combatId: combat?.id, combatantId: context.combatant?.id });
      await stopMovementContext(context, "blocked");
      await showScrollingText(context.document, game.i18n.localize("AOV_SKJALDBORG.MovementAutomation.Blocked"));
    }
  }

  movementDebug(MOVEMENT_DEBUG_CATEGORIES.SCHEDULER, "tick-selection", () => ({
    operations: operations.map(({ context, waypoints }) => ({
      combatantId: context.combatant?.id,
      index: context.index,
      segmentIndex: context.segmentIndex,
      waypoints
    })),
    blocked: blocked.map(({ context, waypoint, blocker }) => ({
      combatantId: context.combatant?.id,
      index: context.index,
      segmentIndex: context.segmentIndex,
      waypoint,
      blockerType: blocker.type,
      blockerCombatantId: blocker.blocker?.id ?? null,
      blockedTicks: context.blockedTicks
    }))
  }), { runId: run?.runId, tick: run?.tick, combatId: combat?.id, level: MOVEMENT_DEBUG_LEVELS.VERBOSE });
  return { operations, blocked };
}

/**
 * Mark two combatants engaged and stop any executing movement.
 *
 * @param {Combat} combat Active combat.
 * @param {Combatant} first First combatant.
 * @param {Combatant} second Second combatant.
 * @returns {Promise<void>}
 */
async function engagePair(combat, first, second) {
  const run = activeRuns.get(combat?.id);
  const firstStateBefore = getCombatantState(first);
  const secondStateBefore = getCombatantState(second);
  if (
    firstStateBefore.engagement?.partnerIds?.includes(second?.id)
    && secondStateBefore.engagement?.partnerIds?.includes(first?.id)
  ) {
    movementDebug(MOVEMENT_DEBUG_CATEGORIES.ENGAGEMENT, "engage-pair-already-latched", () => ({
      first: first?.id,
      second: second?.id
    }), { runId: run?.runId, tick: run?.tick, combatId: combat?.id, level: MOVEMENT_DEBUG_LEVELS.VERBOSE });
    return;
  }

  const pairs = [
    [first, second],
    [second, first]
  ];

  // Latch both participants before stopMovement or any awaited persistence.
  markRunCombatantsStopped(combat, first, second);
  movementDebug(MOVEMENT_DEBUG_CATEGORIES.ENGAGEMENT, "engage-pair-latched", () => ({
    first: first?.id,
    second: second?.id
  }), { runId: run?.runId, tick: run?.tick, combatId: combat?.id });

  /*
   * Request interruption before any awaited work. Foundry only permits the
   * initiating user to stop movement, and only while a movement is active.
   * The module's authoritative execution now advances one checkpoint at a
   * time, so this call is a defensive interruption for a checkpoint currently
   * being animated rather than the primary stopping mechanism.
   */
  for (const [combatant] of pairs) {
    const state = getCombatantState(combatant);
    if (state.movement?.planStatus !== MOVEMENT_PLAN_STATUS.EXECUTING) continue;
    const document = tokenDocumentForCombatant(combatant);
    try {
      document?.stopMovement?.();
      movementDebug(MOVEMENT_DEBUG_CATEGORIES.STOP, "stop-movement-requested", () => ({
        combatantId: combatant?.id,
        tokenId: document?.id ?? document?._id ?? null,
        reason: "engagement"
      }), { runId: run?.runId, tick: run?.tick, combatId: combat?.id, combatantId: combatant?.id, tokenId: document?.id ?? document?._id ?? null });
    }
    catch (err) {
      warn(err);
      movementDebugWarn(MOVEMENT_DEBUG_CATEGORIES.STOP, "stop-movement-error", () => ({
        combatantId: combatant?.id,
        error: String(err?.message ?? err)
      }), { runId: run?.runId, tick: run?.tick, combatId: combat?.id, combatantId: combatant?.id });
    }
  }

  await Promise.all(pairs.map(async ([combatant, partner]) => {
    const document = tokenDocumentForCombatant(combatant);
    const state = getCombatantState(combatant);
    const wasExecuting = state.movement?.planStatus === MOVEMENT_PLAN_STATUS.EXECUTING;
    const context = activeMovementContext(combat, combatant);
    const contextDistance = contextMovementDistance(context);
    const distance = wasExecuting
      ? (contextDistance ?? actualMovementDistance(document, state.movement))
      : state.movement?.distance;
    const engagement = {
      ...addEngagementPartner(state.engagement, partner.id),
      reachUnits: reachUnitsForCombatant(combatant),
      reason: "opposing-reach"
    };

    await updateCombatantState(combatant, {
      movement: {
        ...state.movement,
        distance: Number.isFinite(distance) ? distance : state.movement?.distance,
        planStatus: wasExecuting ? MOVEMENT_PLAN_STATUS.STOPPED : state.movement?.planStatus,
        completedAt: wasExecuting ? Date.now() : state.movement?.completedAt,
        stoppedReason: wasExecuting ? "engaged" : state.movement?.stoppedReason
      },
      engagement
    });
    movementDebug(MOVEMENT_DEBUG_CATEGORIES.ENGAGEMENT, "engagement-state-written", () => ({
      combatantId: combatant?.id,
      partnerId: partner?.id,
      wasExecuting,
      distance,
      movement: getCombatantState(combatant).movement,
      engagement
    }), { runId: run?.runId, tick: run?.tick, combatId: combat?.id, combatantId: combatant?.id, level: MOVEMENT_DEBUG_LEVELS.VERBOSE });
    await syncEngagedStatusEffect(combatant, engagement, combat);
    await showScrollingText(document, game.i18n.localize("AOV_SKJALDBORG.MovementAutomation.Engaged"));
  }));

  RenderCoordinator.invalidateCombatTracker("movement-engagement");
  movementDebug(MOVEMENT_DEBUG_CATEGORIES.ENGAGEMENT, "engaged-movement-pair", () => ({
    first: first?.id,
    second: second?.id
  }), { runId: run?.runId, tick: run?.tick, combatId: combat?.id });
}

/**
 * Find and resolve any current engagement contacts.
 *
 * During an active Movement run this normally scans only combatants whose
 * movement context is executing. At Movement phase boundaries, callers can
 * include stationary combatants so hostile tokens which began the phase already
 * inside weapon reach are engaged even if neither token submitted a route.
 *
 * @param {Combat} combat Active combat.
 * @param {object} [options={}] Scan options.
 * @param {boolean} [options.includeStationary=false] Whether to scan non-moving combatants too.
 * @param {string} [options.reason="movement-contact"] Debug reason for the scan.
 * @returns {Promise<number>} Number of engagement pairs resolved.
 */
export async function checkMovementEngagements(combat, { includeStationary = false, reason = "movement-contact" } = {}) {
  if (!combat) return 0;
  const run = activeRuns.get(combat?.id);
  const combatants = combatantValues(combat).filter(AoVAdapter.isCombatantCapable.bind(AoVAdapter));
  const reachByCombatantId = new Map(combatants.map(combatant => [combatant.id, reachUnitsForCombatant(combatant)]));
  const candidates = [];
  const stats = {
    candidates: 0,
    resolved: 0,
    skippedExisting: 0,
    skippedPending: 0,
    skippedEgress: 0,
    skippedHalfMove: 0,
    skippedInvalid: 0,
    skippedDuplicate: 0,
    stationaryScans: 0
  };
  const consideredPairs = new Set();
  let resolved = 0;

  for (const mover of combatants) {
    const moverStateAtScan = getCombatantState(mover);
    const moverExecuting = moverStateAtScan.movement?.planStatus === MOVEMENT_PLAN_STATUS.EXECUTING;
    if (!moverExecuting && !includeStationary) continue;
    if (!moverExecuting) stats.stationaryScans += 1;
    const moverDocument = tokenDocumentForCombatant(mover);
    const moverRect = tokenSourceGridRect(moverDocument);
    if (!moverRect) continue;
    for (const other of combatants) {
      if (mover.id === other.id) continue;
      const pairKey = engagementPairKey(mover, other);
      if (consideredPairs.has(pairKey)) {
        stats.skippedDuplicate += 1;
        continue;
      }
      consideredPairs.add(pairKey);
      const moverState = getCombatantState(mover);
      if (moverState.engagement?.partnerIds?.includes(other.id)) {
        stats.skippedExisting += 1;
        continue;
      }
      const otherState = getCombatantState(other);
      const pendingEngagement = activeEngagementPairs.get(pairKey);
      if (pendingEngagement) {
        stats.skippedPending += 1;
        continue;
      }
      const otherDocument = tokenDocumentForCombatant(other);
      if (!areOpposingDispositions(moverDocument?.disposition, otherDocument?.disposition)) continue;
      const otherRect = tokenSourceGridRect(otherDocument);
      if (!otherRect) continue;
      const threshold = Math.max(reachByCombatantId.get(mover.id), reachByCombatantId.get(other.id));
      const separation = measureOccupiedGridSeparation(moverRect, otherRect);
      movementDebug(MOVEMENT_DEBUG_CATEGORIES.ENGAGEMENT, "reach-check", () => ({
        moverId: mover.id,
        otherId: other.id,
        moverDisposition: moverDocument?.disposition,
        otherDisposition: otherDocument?.disposition,
        moverRect,
        otherRect,
        moverReach: reachByCombatantId.get(mover.id),
        otherReach: reachByCombatantId.get(other.id),
        threshold,
        separation,
        inReach: separation <= threshold
      }), { runId: run?.runId, tick: run?.tick, combatId: combat?.id, combatantId: mover.id, level: MOVEMENT_DEBUG_LEVELS.TRACE });
      if (!Number.isFinite(separation) || !Number.isFinite(threshold)) {
        stats.skippedInvalid += 1;
        movementDebugWarn(MOVEMENT_DEBUG_CATEGORIES.ENGAGEMENT, "invalid-reach-check", () => ({
          moverId: mover.id,
          otherId: other.id,
          moverRect,
          otherRect,
          threshold,
          separation
        }), { runId: run?.runId, tick: run?.tick, combatId: combat?.id, combatantId: mover.id });
        continue;
      }
      if (await shouldSkipEngagementForEgress(combat, mover, moverState, other, otherState, separation, threshold, run)) {
        stats.skippedEgress += 1;
        continue;
      }
      if (separation > threshold) continue;
      const pairEligibility = pairCanEstablishEngagement(combat, mover, moverState, other, otherState);
      if (!pairEligibility.canEngage) {
        stats.skippedHalfMove += 1;
        movementDebug(MOVEMENT_DEBUG_CATEGORIES.ENGAGEMENT, "engagement-skipped-half-move", () => ({
          moverId: mover.id,
          otherId: other.id,
          moverEligibility: pairEligibility.firstEligibility,
          otherEligibility: pairEligibility.secondEligibility,
          separation,
          threshold
        }), { runId: run?.runId, tick: run?.tick, combatId: combat?.id, combatantId: mover.id, level: MOVEMENT_DEBUG_LEVELS.VERBOSE });
        continue;
      }
      candidates.push({
        mover,
        other,
        pairKey,
        moverOrder: combatantOrderIndex(combatants, mover),
        otherOrder: combatantOrderIndex(combatants, other),
        separation,
        threshold
      });
    }
  }

  candidates.sort((left, right) => {
    const leftContext = activeMovementContext(combat, left.mover);
    const rightContext = activeMovementContext(combat, right.mover);
    return (Number(leftContext?.index) || 0) - (Number(rightContext?.index) || 0)
      || left.separation - right.separation
      || left.moverOrder - right.moverOrder
      || left.otherOrder - right.otherOrder;
  });
  stats.candidates = candidates.length;

  for (const candidate of candidates) {
    const { mover, other, pairKey, separation, threshold } = candidate;
    const pendingBeforeResolve = activeEngagementPairs.get(pairKey);
    if (pendingBeforeResolve) {
      stats.skippedPending += 1;
      await pendingBeforeResolve;
      continue;
    }

    const currentMoverState = getCombatantState(mover);
    const currentOtherState = getCombatantState(other);
    if (
      currentMoverState.engagement?.partnerIds?.includes(other.id)
      || currentOtherState.engagement?.partnerIds?.includes(mover.id)
    ) {
      stats.skippedExisting += 1;
      movementDebug(MOVEMENT_DEBUG_CATEGORIES.ENGAGEMENT, "engage-pair-skipped-existing", () => ({
        moverId: mover.id,
        otherId: other.id,
        moverEngagement: currentMoverState.engagement,
        otherEngagement: currentOtherState.engagement
      }), { runId: run?.runId, tick: run?.tick, combatId: combat?.id, combatantId: mover.id, level: MOVEMENT_DEBUG_LEVELS.VERBOSE });
      continue;
    }
    if (await shouldSkipEngagementForEgress(combat, mover, currentMoverState, other, currentOtherState, separation, threshold, run)) {
      stats.skippedEgress += 1;
      continue;
    }
    const currentEligibility = pairCanEstablishEngagement(combat, mover, currentMoverState, other, currentOtherState);
    if (!currentEligibility.canEngage) {
      stats.skippedHalfMove += 1;
      continue;
    }

    let engagementOperation;
    engagementOperation = engagePair(combat, mover, other).finally(() => {
      if (activeEngagementPairs.get(pairKey) === engagementOperation) activeEngagementPairs.delete(pairKey);
    });
    activeEngagementPairs.set(pairKey, engagementOperation);
    await engagementOperation;
    resolved += 1;
    stats.resolved = resolved;
    movementDebug(MOVEMENT_DEBUG_CATEGORIES.ENGAGEMENT, "engaged-movement-contact", () => ({
      first: mover.id,
      second: other.id,
      separation,
      threshold
    }), { runId: run?.runId, tick: run?.tick, combatId: combat?.id, combatantId: mover.id });
  }

  movementDebug(MOVEMENT_DEBUG_CATEGORIES.ENGAGEMENT, "engagement-pass-summary", () => ({
    ...stats,
    includeStationary,
    reason
  }), {
    runId: run?.runId,
    tick: run?.tick,
    combatId: combat?.id,
    level: resolved ? MOVEMENT_DEBUG_LEVELS.SUMMARY : MOVEMENT_DEBUG_LEVELS.VERBOSE
  });
  return resolved;
}

/**
 * Await the current canvas movement animation, when one exists.
 *
 * @param {Combat} combat Active combat.
 * @param {Combatant} combatant Combatant document.
 * @returns {Promise<{combatantId: string, status: string}>}
 */
async function waitForTokenAnimation(document) {
  const animation = document?.object?.movementAnimationPromise;
  if (!animation || typeof animation.then !== "function") return;
  try {
    await animation;
  }
  catch (err) {
    warn(err);
  }
}

/**
 * Prepare one combatant for deterministic checkpoint execution.
 *
 * @param {Combat} combat Active combat.
 * @param {Combatant} combatant Combatant document.
 * @returns {Promise<object>}
 */
async function prepareCombatantMovement(combat, combatant) {
  const measureId = performanceDiagnostics.markStart("movement.prepareCombatant");
  const document = tokenDocumentForCombatant(combatant);
  const state = getCombatantState(combatant);
  const run = activeRuns.get(combat?.id);
  const plannedWaypoints = [];
  for (const waypoint of storedMovementRoute(state.movement)) appendRoutePoint(plannedWaypoints, waypoint);
  const executionWaypoints = movementExecutionWaypoints(document, plannedWaypoints);
  if (!document?.move || !executionWaypoints.length) {
    movementDebugWarn(MOVEMENT_DEBUG_CATEGORIES.RUN, "prepare-context-unavailable", () => ({
      combatantId: combatant?.id,
      hasMove: !!document?.move,
      plannedWaypoints,
      executionWaypoints
    }), { runId: run?.runId, combatId: combat?.id, combatantId: combatant?.id });
    await markMovementStatus(combatant, MOVEMENT_PLAN_STATUS.FAILED, {
      distance: 0,
      completedAt: Date.now(),
      stoppedReason: "unavailable"
    });
    performanceDiagnostics.markEnd(measureId, {
      combatId: combat?.id ?? null,
      combatantId: combatant?.id ?? null,
      tokenId: document?.id ?? document?._id ?? null,
      status: MOVEMENT_PLAN_STATUS.FAILED,
      plannedCount: plannedWaypoints.length,
      executionCount: executionWaypoints.length
    });
    return {
      combatant,
      document,
      plannedWaypoints,
      executionWaypoints: [],
      waypoints: [],
      traveledWaypoints: [],
      index: 0,
      segmentIndex: 0,
      status: MOVEMENT_PLAN_STATUS.FAILED,
      blockedTicks: 0
    };
  }

  await markMovementStatus(combatant, MOVEMENT_PLAN_STATUS.EXECUTING, {
    startedAt: Date.now(),
    completedAt: null,
    stoppedReason: ""
  });
  const context = {
    combatant,
    document,
    plannedWaypoints,
    executionWaypoints,
    waypoints: executionWaypoints,
    traveledWaypoints: [cleanMovementPoint(state.movement?.origin) ?? cleanMovementPoint(document?._source) ?? cleanMovementPoint(document)].filter(Boolean),
    index: 0,
    segmentIndex: 0,
    status: MOVEMENT_PLAN_STATUS.EXECUTING,
    blockedTicks: 0
  };
  const storedDestination = cleanMovementPoint(state.movement?.destination);
  const plannedRouteTail = cleanMovementPoint(plannedWaypoints.at(-1));
  movementDebug(MOVEMENT_DEBUG_CATEGORIES.RUN, "prepare-context", () => ({
    combatantId: combatant?.id,
    tokenId: document?.id ?? document?._id ?? null,
    plannedCount: plannedWaypoints.length,
    executionCount: executionWaypoints.length,
    plannedWaypoints,
    executionWaypoints,
    traveledWaypoints: context.traveledWaypoints,
    storedDestination,
    plannedRouteTail,
    destinationMatchesRouteTail: !storedDestination || sameMovementPoint(storedDestination, plannedRouteTail)
  }), { runId: run?.runId, combatId: combat?.id, combatantId: combatant?.id, tokenId: document?.id ?? document?._id ?? null, level: MOVEMENT_DEBUG_LEVELS.VERBOSE });
  performanceDiagnostics.markEnd(measureId, {
    combatId: combat?.id ?? null,
    combatantId: combatant?.id ?? null,
    tokenId: document?.id ?? document?._id ?? null,
    status: context.status,
    plannedCount: plannedWaypoints.length,
    executionCount: executionWaypoints.length
  });
  return context;
}

/**
 * Finalize a completed movement context.
 *
 * @param {object} context Movement context.
 * @returns {Promise<void>}
 */
async function completeMovementContext(context) {
  if (context.status !== MOVEMENT_PLAN_STATUS.EXECUTING) return;
  const contextDistance = contextMovementDistance(context);
  const plannedDestination = cleanMovementPoint(context.plannedWaypoints?.at(-1));
  const actualDestination = cleanMovementPoint(context.document?._source) ?? cleanMovementPoint(context.document);
  await markMovementStatus(context.combatant, MOVEMENT_PLAN_STATUS.COMPLETED, {
    distance: contextDistance ?? actualMovementDistance(context.document, getCombatantState(context.combatant).movement),
    completedAt: Date.now(),
    stoppedReason: ""
  });
  context.status = MOVEMENT_PLAN_STATUS.COMPLETED;
  const payload = () => ({
    combatantId: context.combatant?.id ?? null,
    tokenId: context.document?.id ?? context.document?._id ?? null,
    plannedDestination,
    actualDestination,
    destinationMatches: !plannedDestination || sameMovementPoint(plannedDestination, actualDestination),
    index: context.index,
    waypointCount: context.waypoints?.length ?? 0,
    traveledWaypoints: context.traveledWaypoints
  });
  const run = activeRuns.get(context.combatant?.combat?.id ?? game.combat?.id);
  const meta = {
    runId: run?.runId,
    tick: run?.tick,
    combatId: context.combatant?.combat?.id ?? game.combat?.id ?? null,
    combatantId: context.combatant?.id ?? null,
    tokenId: context.document?.id ?? context.document?._id ?? null,
    level: MOVEMENT_DEBUG_LEVELS.VERBOSE
  };
  if (plannedDestination && !sameMovementPoint(plannedDestination, actualDestination)) {
    movementDebugWarn(MOVEMENT_DEBUG_CATEGORIES.SCHEDULER, "context-completed-position-mismatch", payload, meta);
  }
  else movementDebug(MOVEMENT_DEBUG_CATEGORIES.SCHEDULER, "context-completed", payload, meta);
}

/**
 * Return whether a context is still eligible to submit movement.
 *
 * @param {Combat} combat Active combat.
 * @param {object} context Movement context.
 * @returns {boolean}
 */
function canExecuteContext(combat, context) {
  if (context.status !== MOVEMENT_PLAN_STATUS.EXECUTING) return false;
  const state = getCombatantState(context.combatant);
  return !(
    isRunCombatantStopped(combat, context.combatant)
    || state.movement?.planStatus === MOVEMENT_PLAN_STATUS.STOPPED
    || state.engagement?.engaged === true
  );
}

/**
 * Build the single-checkpoint batch submitted by one scheduler tick.
 *
 * @param {object} context Movement context.
 * @returns {object[]} Zero or one waypoint.
 */
export function movementCheckpointBatch(context) {
  const first = context?.waypoints?.[Number(context?.index) || 0];
  return first ? [first] : [];
}

/**
 * Select the next checkpoint for one active context.
 *
 * @param {Combat} combat Active combat.
 * @param {object} context Movement context.
 * @returns {object[]} Waypoints to submit in one documented move call.
 */
function nextMovementWaypoints(combat, context) {
  if (!canExecuteContext(combat, context)) {
    context.status = MOVEMENT_PLAN_STATUS.STOPPED;
    return [];
  }
  return movementCheckpointBatch(context);
}

/**
 * Submit one movement operation and normalize the result.
 *
 * @param {Combat} combat Active combat.
 * @param {object} context Movement context.
 * @param {object[]} waypoints Waypoints for this move call.
 * @returns {Promise<{context: object, waypoints: object[], moved: boolean}>}
 */
async function submitMovementBatch(combat, context, waypoints) {
  const { combatant, document } = context;
  const run = activeRuns.get(combat?.id);
  try {
    movementDebug(MOVEMENT_DEBUG_CATEGORIES.SCHEDULER, "submit-move", () => ({
      combatantId: combatant.id,
      index: context.index,
      segmentIndex: context.segmentIndex,
      waypoints,
      options: {
        [MODULE_ID]: {
          movementExecution: true,
          checkpointExecution: true,
          segmentExecution: false,
          combatantId: combatant.id,
          checkpointIndex: context.index,
          segmentIndex: context.segmentIndex,
          checkpointCount: waypoints.length
        },
        showRuler: false
      }
    }), { runId: run?.runId, tick: run?.tick, combatId: combat?.id, combatantId: combatant.id, tokenId: document?.id ?? document?._id ?? null, level: MOVEMENT_DEBUG_LEVELS.TRACE });
    const moved = await document.move(waypoints, {
      [MODULE_ID]: {
        movementExecution: true,
        checkpointExecution: true,
        segmentExecution: false,
        combatantId: combatant.id,
        checkpointIndex: context.index,
        segmentIndex: context.segmentIndex,
        checkpointCount: waypoints.length
      },
      showRuler: false
    });
    movementDebug(MOVEMENT_DEBUG_CATEGORIES.SCHEDULER, "move-result", () => ({
      combatantId: combatant.id,
      index: context.index,
      segmentIndex: context.segmentIndex,
      moved: moved !== false,
      waypoints
    }), { runId: run?.runId, tick: run?.tick, combatId: combat?.id, combatantId: combatant.id, tokenId: document?.id ?? document?._id ?? null, level: MOVEMENT_DEBUG_LEVELS.VERBOSE });
    return { context, waypoints, moved: moved !== false };
  }
  catch (err) {
    warn(err);
    movementDebugWarn(MOVEMENT_DEBUG_CATEGORIES.SCHEDULER, "move-exception", () => ({
      combatantId: combatant.id,
      index: context.index,
      waypoints,
      error: String(err?.message ?? err)
    }), { runId: run?.runId, tick: run?.tick, combatId: combat?.id, combatantId: combatant.id, tokenId: document?.id ?? document?._id ?? null });
    const latest = getCombatantState(combatant);
    if (
      isRunCombatantStopped(combat, combatant)
      || latest.engagement?.engaged === true
      || latest.movement?.planStatus === MOVEMENT_PLAN_STATUS.STOPPED
    ) {
      context.status = MOVEMENT_PLAN_STATUS.STOPPED;
      return { context, waypoints, moved: false };
    }
    await markMovementStatus(combatant, MOVEMENT_PLAN_STATUS.FAILED, {
      distance: contextMovementDistance(context)
        ?? actualMovementDistance(document, latest.movement),
      completedAt: Date.now(),
      stoppedReason: "exception"
    });
    context.status = MOVEMENT_PLAN_STATUS.FAILED;
    ui.notifications.warn(game.i18n.localize("AOV_SKJALDBORG.MovementAutomation.MoveFailed"));
    return { context, waypoints, moved: false };
  }
}

/**
 * Return the Scene document which can batch the provided movement operations.
 *
 * @param {Combat} combat Active combat.
 * @param {{context: object, waypoints: object[]}[]} operations Movement operations.
 * @returns {Scene|null}
 */
function sceneForMovementBatch(combat, operations) {
  const scene = combat?.scene ?? canvas.scene ?? null;
  if (typeof scene?.moveTokens !== "function") return null;
  if (!operations.length) return null;
  return operations.every(({ context }) => {
    const documentScene = context?.document?.parent ?? null;
    return !documentScene || !scene?.id || documentScene.id === scene.id;
  }) ? scene : null;
}

/**
 * Submit one simultaneous v14 Scene#moveTokens operation and normalize results
 * to the same shape as individual TokenDocument#move calls.
 *
 * @param {Combat} combat Active combat.
 * @param {{context: object, waypoints: object[]}[]} operations Movement operations.
 * @returns {Promise<{context: object, waypoints: object[], moved: boolean}[]>}
 */
async function submitSceneMovementBatch(combat, operations) {
  const scene = sceneForMovementBatch(combat, operations);
  if (!scene) return Promise.all(operations.map(({ context, waypoints }) => submitMovementBatch(combat, context, waypoints)));
  const run = activeRuns.get(combat?.id);
  const instructions = {};
  for (const { context, waypoints } of operations) {
    const tokenId = context?.document?.id ?? context?.document?._id;
    if (!tokenId) continue;
    instructions[tokenId] = {
      waypoints,
      showRuler: false
    };
  }
  if (!Object.keys(instructions).length) return [];

  try {
    movementDebug(MOVEMENT_DEBUG_CATEGORIES.SCHEDULER, "submit-scene-move-tokens", () => ({
      operationCount: operations.length,
      tokenIds: Object.keys(instructions),
      instructions
    }), { runId: run?.runId, tick: run?.tick, combatId: combat?.id, level: MOVEMENT_DEBUG_LEVELS.TRACE });
    const results = await scene.moveTokens(instructions, {
      [MODULE_ID]: {
        movementExecution: true,
        checkpointExecution: true,
        sceneBatchExecution: true,
        checkpointCount: operations.length
      },
      showRuler: false
    });
    return operations.map(({ context, waypoints }) => {
      const tokenId = context?.document?.id ?? context?.document?._id;
      const hasResult = !!tokenId && Object.prototype.hasOwnProperty.call(results ?? {}, tokenId);
      const moved = hasResult ? results[tokenId] !== false : false;
      if (!hasResult) {
        movementDebugWarn(MOVEMENT_DEBUG_CATEGORIES.SCHEDULER, "scene-move-token-missing-result", () => ({
          combatantId: context.combatant?.id,
          tokenId,
          resultKeys: Object.keys(results ?? {}),
          waypoints
        }), { runId: run?.runId, tick: run?.tick, combatId: combat?.id, combatantId: context.combatant?.id, tokenId });
      }
      movementDebug(MOVEMENT_DEBUG_CATEGORIES.SCHEDULER, "scene-move-token-result", () => ({
        combatantId: context.combatant?.id,
        tokenId,
        hasResult,
        moved,
        waypoints
      }), { runId: run?.runId, tick: run?.tick, combatId: combat?.id, combatantId: context.combatant?.id, tokenId, level: MOVEMENT_DEBUG_LEVELS.VERBOSE });
      return { context, waypoints, moved };
    });
  }
  catch (err) {
    warn(err);
    movementDebugWarn(MOVEMENT_DEBUG_CATEGORIES.SCHEDULER, "scene-move-tokens-exception", () => ({
      error: String(err?.message ?? err),
      tokenIds: Object.keys(instructions)
    }), { runId: run?.runId, tick: run?.tick, combatId: combat?.id });
    return Promise.all(operations.map(({ context, waypoints }) => submitMovementBatch(combat, context, waypoints)));
  }
}

/**
 * Execute one simultaneous scheduler tick across all active contexts.
 *
 * @param {Combat} combat Active combat.
 * @param {object[]} contexts All movement contexts.
 * @returns {Promise<void>}
 */
async function executeMovementTick(combat, contexts) {
  const measureId = performanceDiagnostics.markStart("movement.tick");
  const run = activeRuns.get(combat?.id);
  if (run) run.tick = Number(run.tick ?? 0) + 1;
  movementDebug(MOVEMENT_DEBUG_CATEGORIES.SCHEDULER, "tick-start", () => ({
    contexts: contexts.map(context => ({
      combatantId: context.combatant?.id,
      status: context.status,
      index: context.index,
      segmentIndex: context.segmentIndex,
      waypointCount: context.waypoints.length,
      blockedTicks: context.blockedTicks
    }))
  }), { runId: run?.runId, tick: run?.tick, combatId: combat?.id, level: MOVEMENT_DEBUG_LEVELS.VERBOSE });
  const { operations, blocked } = await selectMovementTickOperations(combat, contexts);
  if (!operations.length) {
    if (blocked.length) await waitMovementTickDelay();
    movementDebug(MOVEMENT_DEBUG_CATEGORIES.SCHEDULER, "tick-no-operations", () => ({
      blockedCount: blocked.length
    }), { runId: run?.runId, tick: run?.tick, combatId: combat?.id });
    performanceDiagnostics.markEnd(measureId, {
      combatId: combat?.id ?? null,
      tick: run?.tick ?? null,
      operationCount: 0,
      blockedCount: blocked.length,
      activeCount: contexts.filter(context => context.status === MOVEMENT_PLAN_STATUS.EXECUTING).length
    });
    return;
  }

  const results = (await submitSceneMovementBatch(combat, operations))
    .map(value => ({ status: "fulfilled", value }));
  await Promise.all(operations.map(({ context }) => waitForTokenAnimation(context.document)));

  for (const result of results) {
    if (result.status !== "fulfilled") {
      warn(result.reason);
      continue;
    }
    const { context, waypoints, moved } = result.value;
    const { combatant } = context;
    if (!moved) {
      if (context.status === MOVEMENT_PLAN_STATUS.STOPPED) continue;
      await markMovementStatus(combatant, MOVEMENT_PLAN_STATUS.FAILED, {
        distance: contextMovementDistance(context)
          ?? actualMovementDistance(context.document, getCombatantState(combatant).movement),
        completedAt: Date.now(),
        stoppedReason: "move-returned-false"
      });
      context.status = MOVEMENT_PLAN_STATUS.FAILED;
      continue;
    }

    for (const waypoint of waypoints) appendRoutePoint(context.traveledWaypoints, waypoint);
    context.index += waypoints.length;
    const nextWaypoint = context.waypoints[context.index];
    context.segmentIndex = Number(nextWaypoint?.segmentIndex ?? nextWaypoint?.routeIndex ?? context.segmentIndex + 1);
    movementDebug(MOVEMENT_DEBUG_CATEGORIES.SCHEDULER, "context-advanced", () => ({
      combatantId: context.combatant?.id,
      index: context.index,
      segmentIndex: context.segmentIndex,
      waypointCount: context.waypoints.length,
      completedCheckpoints: waypoints,
      traveledWaypoints: context.traveledWaypoints
    }), { runId: run?.runId, tick: run?.tick, combatId: combat?.id, combatantId: context.combatant?.id, level: MOVEMENT_DEBUG_LEVELS.TRACE });
  }

  await checkMovementEngagements(combat);

  for (const context of contexts) {
    if (context.status !== MOVEMENT_PLAN_STATUS.EXECUTING) continue;
    const { combatant } = context;
    const afterStep = getCombatantState(combatant);
    if (
      isRunCombatantStopped(combat, combatant)
      || afterStep.movement?.planStatus === MOVEMENT_PLAN_STATUS.STOPPED
      || afterStep.engagement?.engaged === true
    ) {
      if (context.index < context.waypoints.length && afterStep.engagement?.engaged !== true && afterStep.movement?.stoppedReason !== "blocked") {
        movementDebugWarn(MOVEMENT_DEBUG_CATEGORIES.SCHEDULER, "context-stopped-with-remaining-route", () => ({
          combatantId: combatant?.id,
          index: context.index,
          waypointCount: context.waypoints.length,
          movement: afterStep.movement,
          engagement: afterStep.engagement
        }), { runId: run?.runId, tick: run?.tick, combatId: combat?.id, combatantId: combatant?.id });
      }
      context.status = MOVEMENT_PLAN_STATUS.STOPPED;
      continue;
    }
    if (context.index >= context.waypoints.length) await completeMovementContext(context);
  }

  movementDebug(MOVEMENT_DEBUG_CATEGORIES.SCHEDULER, "tick-end", () => ({
    contexts: contexts.map(context => ({
      combatantId: context.combatant?.id,
      status: context.status,
      index: context.index,
      segmentIndex: context.segmentIndex,
      waypointCount: context.waypoints.length,
      blockedTicks: context.blockedTicks
    }))
  }), { runId: run?.runId, tick: run?.tick, combatId: combat?.id, level: MOVEMENT_DEBUG_LEVELS.VERBOSE });

  await waitMovementTickDelay();
  performanceDiagnostics.markEnd(measureId, {
    combatId: combat?.id ?? null,
    tick: run?.tick ?? null,
    operationCount: operations.length,
    blockedCount: blocked.length,
    activeCount: contexts.filter(context => context.status === MOVEMENT_PLAN_STATUS.EXECUTING).length
  });
}

/**
 * Return planned combatants in the encounter's authoritative turn order.
 *
 * @param {Combat} combat Active combat.
 * @param {Combatant[]} planned Planned combatants.
 * @returns {Combatant[]}
 */
function orderMovementCombatants(combat, planned) {
  const byId = new Map(planned.map(combatant => [combatant.id, combatant]));
  const ordered = [];
  for (const combatant of Array.from(combat?.turns ?? [])) {
    const plannedCombatant = byId.get(combatant?.id);
    if (!plannedCombatant) continue;
    ordered.push(plannedCombatant);
    byId.delete(combatant.id);
  }
  for (const combatant of planned) {
    if (byId.delete(combatant.id)) ordered.push(combatant);
  }
  return ordered;
}

/**
 * Whether the current combat movement run is still executing.
 *
 * @param {Combat|null} combat Active combat.
 * @returns {boolean}
 */
export function isMovementRunActive(combat) {
  const state = getCombatState(combat);
  return state.movementRun?.status === MOVEMENT_PLAN_STATUS.EXECUTING;
}

/**
 * Start deterministic Movement-phase checkpoint execution for planned combatants.
 *
 * @param {Combat|null} combat Active combat.
 * @param {object} [options={}] Reserved for compatibility with older callers.
 * @returns {Promise<object|null>}
 */
export async function startMovementPhase(combat = game.combat, options = {}) {
  if (!game.user?.isGM || !combat) return null;
  const key = combat.uuid ?? combat.id;
  const pending = movementRunLocks.get(key);
  if (pending) {
    await pending;
    return startMovementPhase(combat, options);
  }

  let operation;
  operation = startMovementPhaseUnlocked(combat).finally(() => {
    if (movementRunLocks.get(key) === operation) movementRunLocks.delete(key);
  });
  movementRunLocks.set(key, operation);
  return operation;
}

/**
 * Execute one serialized movement run. Plans finalized while another run is in
 * progress are picked up by the next queued pass rather than being stranded in
 * PLANNED state by the active-run guard.
 *
 * @param {Combat} combat Active combat.
 * @returns {Promise<object|null>}
 * @protected
 */
async function startMovementPhaseUnlocked(combat) {
  if (isMovementRunActive(combat)) return getCombatState(combat).movementRun;
  const measureId = performanceDiagnostics.markStart("movement.phase");
  await settleMovementWrites(combat.id, { quietMs: 100, timeoutMs: 1000 });
  const runId = newMovementDebugRunId(combat);

  const planned = orderMovementCombatants(combat, combatantValues(combat).filter(combatant => {
    if (!AoVAdapter.isCombatantCapable(combatant)) return false;
    const state = getCombatantState(combatant);
    const route = storedMovementRoute(state.movement);
    return state.movement?.planStatus === MOVEMENT_PLAN_STATUS.PLANNED
      && state.movement?.draft !== true
      && route.length > 0;
  }));

  if (!planned.length) {
    movementDebug(MOVEMENT_DEBUG_CATEGORIES.RUN, "start-empty-run", () => ({
      plannedCount: 0,
      combatState: getCombatState(combat)
    }), { runId, combatId: combat.id, phase: getCombatState(combat).phase });
    await updateCombatState(combat, {
      movementRun: {
        status: MOVEMENT_PLAN_STATUS.COMPLETED,
        startedAt: Date.now(),
        completedAt: Date.now(),
        pendingCombatantIds: []
      }
    });
    // A real Movement phase boundary also engages hostile combatants which
    // started the phase already inside weapon reach, even when no token moved.
    await checkMovementEngagements(combat, { includeStationary: true, reason: "movement-phase-empty" });
    // A disengaged combatant who does not leave weapon reach by the end of
    // Movement is re-engaged even when no tokens planned movement this phase.
    await finalizeMovementEgresses(combat);
    // Even an empty Movement phase is a real DEX-stage boundary. Re-project
    // Planning-only adjustments before Resolution without charging any planned
    // route distance.
    await applyMovementDexResults(combat);
    performanceDiagnostics.markEnd(measureId, {
      combatId: combat.id,
      runId,
      plannedCount: 0,
      contextCount: 0,
      status: MOVEMENT_PLAN_STATUS.COMPLETED
    });
    return getCombatState(combat).movementRun;
  }

  const run = {
    status: MOVEMENT_PLAN_STATUS.EXECUTING,
    startedAt: Date.now(),
    completedAt: null,
    pendingCombatantIds: planned.map(combatant => combatant.id)
  };
  await updateCombatState(combat, { movementRun: run });
  activeRuns.set(combat.id, {
    runId,
    tick: 0,
    stoppedCombatantIds: new Set(),
    contextsByCombatantId: new Map()
  });
  movementDebug(MOVEMENT_DEBUG_CATEGORIES.RUN, "start-run", () => ({
    plannedCombatantIds: planned.map(combatant => combatant.id),
    planned: planned.map(combatant => ({
      id: combatant.id,
      tokenId: combatant.tokenId,
      movement: getCombatantState(combatant).movement
    }))
  }), { runId, combatId: combat.id, phase: getCombatState(combat).phase, level: MOVEMENT_DEBUG_LEVELS.VERBOSE });

  const contexts = [];
  try {
    // All participants become EXECUTING before the first reach check so tokens
    // already within weapon length engage without taking an extra grid step.
    for (const combatant of planned) {
      const context = await prepareCombatantMovement(combat, combatant);
      contexts.push(context);
      activeRuns.get(combat.id)?.contextsByCombatantId?.set(combatant.id, context);
    }
    await checkMovementEngagements(combat, { includeStationary: true, reason: "movement-phase-start" });

    // v14 scheduler: submit one checkpoint wave through Scene#moveTokens when
    // available, then resolve engagement before any later checkpoint is sent.
    while (contexts.some(context => context.status === MOVEMENT_PLAN_STATUS.EXECUTING)) {
      await executeMovementTick(combat, contexts);
    }
    await finalizeMovementEgresses(combat);
  }
  finally {
    activeRuns.delete(combat.id);
  }

  await checkMovementEngagements(combat, { includeStationary: true, reason: "movement-phase-end" });
  await updateCombatState(combat, {
    movementRun: {
      status: MOVEMENT_PLAN_STATUS.COMPLETED,
      startedAt: run.startedAt,
      completedAt: Date.now(),
      pendingCombatantIds: []
    }
  });

  // Movement penalties are applied once, after every participant has either
  // completed, stopped, or failed. At this point each stored distance is the
  // authoritative travelled distance rather than the route planned earlier.
  await applyMovementDexResults(combat);
  RenderCoordinator.invalidateCombatTracker("movement-run-complete");
  debug("movement run complete", {
    combatId: combat.id,
    results: contexts.map(context => ({ combatantId: context.combatant.id, status: context.status }))
  });
  movementDebug(MOVEMENT_DEBUG_CATEGORIES.RUN, "complete-run", () => ({
    results: contexts.map(context => ({
      combatantId: context.combatant.id,
      status: context.status,
      index: context.index,
      segmentIndex: context.segmentIndex,
      waypointCount: context.waypoints.length,
      traveledWaypoints: context.traveledWaypoints
    }))
  }), { runId, combatId: combat.id, phase: getCombatState(combat).phase });
  performanceDiagnostics.markEnd(measureId, {
    combatId: combat.id,
    runId,
    plannedCount: planned.length,
    contextCount: contexts.length,
    status: MOVEMENT_PLAN_STATUS.COMPLETED
  });
  return getCombatState(combat).movementRun;
}

/**
 * Register token movement hooks.
 *
 * @param {(action: string, payload?: object) => Promise<unknown>} requestGm GM request function.
 * @returns {void}
 */
export function registerMovementHooks(requestGm) {
  installMovementRulerCapture(requestGm);
  Hooks.on("canvasReady", () => installMovementRulerCapture(requestGm));

  Hooks.on("preMoveToken", (document, movement, operation) => {
    const decision = movementCaptureDecision(document, operation);
    debugCaptureDecision(document, movement, operation, decision);
    if (!decision.capture) return undefined;
    if (decision.reason === "engaged-blocked") {
      ui.notifications.warn(game.i18n.localize("AOV_SKJALDBORG.MovementAutomation.EngagedCannotMove"));
      return false;
    }

    const key = movementRulerDraftKey(document);
    const rulerDraft = key ? movementRulerDrafts.get(key) : null;
    const captured = movementPlanFromOperation(document, movement, operation);
    const mergedRoute = mergeMovementRoutes(
      rulerDraft?.explicitWaypoints ?? [],
      captured.waypoints,
      captured.destination
    );
    const combatantState = getCombatantState(decision.combatant);
    const routeRevision = nextMovementRouteRevision(
      combatantState.movement?.routeRevision,
      rulerDraft?.routeRevision
    );
    const routeId = String(movement?.id ?? rulerDraft?.routeId ?? `movement:${document?.id ?? document?._id}:${Date.now()}`);
    const plan = annotateMovementPlan({
      ...captured,
      // The route tail is authoritative. In Foundry v14 movement.destination
      // can refer to the current checkpoint rather than the final authored
      // waypoint when passed and pending sections split the measured path.
      destination: cleanMovementPoint(mergedRoute.at(-1)) ?? cleanMovementPoint(captured.destination),
      route: mergedRoute,
      waypoints: mergedRoute,
      distance: measureSceneDistance([captured.origin, ...mergedRoute].filter(Boolean)),
      planStatus: mergedRoute.length ? MOVEMENT_PLAN_STATUS.PLANNED : MOVEMENT_PLAN_STATUS.NONE
    }, {
      routeRevision,
      routeId,
      captureSource: rulerDraft ? "pre-move-token+ruler-draft" : "pre-move-token",
      capturedAt: Date.now(),
      draft: false
    });

    if (rulerDraft) rulerDraft.finalized = true;
    movementDebug(MOVEMENT_DEBUG_CATEGORIES.CAPTURE, "final-route-selection", () => ({
      combatantId: decision.combatant.id,
      tokenId: document?.id ?? document?._id ?? null,
      routeId,
      routeRevision,
      selectedSource: captured.captureSource,
      operationRouteAuthoritative: captured.captureSource?.startsWith("operation.movement.") === true,
      foundryMovementDestination: cleanMovementPoint(movement?.destination),
      rulerDraftWaypoints: cleanMovementRoute(rulerDraft?.explicitWaypoints ?? []),
      capturedWaypoints: cleanMovementRoute(captured.waypoints ?? []),
      finalWaypoints: cleanMovementRoute(mergedRoute),
      finalDestination: cleanMovementPoint(plan.destination),
      destinationMatchesRouteTail: sameMovementPoint(
        cleanMovementPoint(plan.destination),
        cleanMovementPoint(mergedRoute.at(-1))
      )
    }), {
      combatId: decision.combat.id,
      combatantId: decision.combatant.id,
      tokenId: document?.id ?? document?._id ?? null,
      phase: getCombatState(decision.combat).phase,
      level: MOVEMENT_DEBUG_LEVELS.VERBOSE
    });
    movementDebug(MOVEMENT_DEBUG_CATEGORIES.CAPTURE, "final-route-banked", () => ({
      combatantId: decision.combatant.id,
      tokenId: document?.id ?? document?._id ?? null,
      routeId,
      routeRevision,
      rulerDraft: rulerDraft ? {
        routeId: rulerDraft.routeId,
        routeRevision: rulerDraft.routeRevision,
        explicitWaypoints: rulerDraft.explicitWaypoints,
        foundPath: rulerDraft.foundPath
      } : null,
      preMoveRouteSource: captured.captureSource,
      preMoveRoute: captured.waypoints,
      selectedFinalRouteSource: captured.captureSource?.startsWith("operation.movement.")
        ? "pre-move-operation"
        : rulerDraft
          ? "ruler-draft-merge"
          : "pre-move-fallback",
      foundryMovementDestination: cleanMovementPoint(movement?.destination),
      finalRouteDestination: cleanMovementPoint(mergedRoute.at(-1)),
      mergedRoute,
      finalPlan: plan,
      previousBankedMovement: storedMovementSummary(combatantState.movement),
      rawMovement: movement,
      rawOperation: operation,
      documentMovement: foundryMovementSummary(document?.movement),
      movementHistoryCount: Array.isArray(document?.movementHistory) ? document.movementHistory.length : 0
    }), {
      combatId: decision.combat.id,
      combatantId: decision.combatant.id,
      tokenId: document?.id ?? document?._id ?? null,
      phase: getCombatState(decision.combat).phase,
      level: MOVEMENT_DEBUG_LEVELS.TRACE
    });

    if (plan.planStatus !== MOVEMENT_PLAN_STATUS.PLANNED) return false;
    void requestGm("recordMovement", {
      combatId: decision.combat.id,
      combatantId: decision.combatant.id,
      movement: plan
    }).then(result => {
      if (result === null) return;
      if (key) movementRulerDrafts.delete(key);
      performanceDiagnostics.count("movement.capture.write", 1, {
        combatId: decision.combat.id,
        combatantId: decision.combatant.id,
        tokenId: document?.id ?? document?._id ?? null
      });
      notifyMovementPlanCaptured({
        combatId: decision.combat.id,
        combatantId: decision.combatant.id,
        tokenId: document?.id ?? document?._id ?? null
      });
      RenderCoordinator.invalidateCombatTracker("movement-captured");
    }).catch(exception => {
      warn(exception);
      ui.notifications.error(exception?.message ?? game.i18n.localize("AOV_SKJALDBORG.MovementAutomation.MoveFailed"));
    });
    return false;
  });

  // Foundry v14 documents recordToken as a single-argument notification. It is
  // diagnostic only here; treating its nonexistent second and third arguments
  // as movement data previously created competing, incomplete plan writes.
  Hooks.on("recordToken", document => {
    const decision = movementCaptureDecision(document, {});
    movementDebug(MOVEMENT_DEBUG_CATEGORIES.CAPTURE, "record-token-hook", () => ({
      tokenId: document?.id ?? document?._id ?? null,
      reason: decision.reason,
      capture: decision.capture,
      documentMovement: foundryMovementSummary(document?.movement),
      movementHistoryCount: Array.isArray(document?.movementHistory) ? document.movementHistory.length : 0,
      bankedMovement: decision.combatant ? storedMovementSummary(getCombatantState(decision.combatant).movement) : null
    }), {
      combatId: decision.combat?.id ?? null,
      combatantId: decision.combatant?.id ?? null,
      tokenId: document?.id ?? document?._id ?? null,
      phase: getCombatState(decision.combat).phase,
      level: MOVEMENT_DEBUG_LEVELS.TRACE
    });
  });

  Hooks.on("moveToken", (document, _movement, _operation, user) => {
    if (!game.user?.isGM || user?.id !== game.user.id) return;
    const combat = game.combat;
    const run = activeRuns.get(combat?.id);
    movementDebug(MOVEMENT_DEBUG_CATEGORIES.STOP, "move-token-hook", () => ({
      tokenId: document?.id ?? document?._id ?? null,
      movement: _movement,
      operation: _operation,
      userId: user?.id ?? null,
      isActiveRun: isMovementRunActive(combat)
    }), { runId: run?.runId, tick: run?.tick, combatId: combat?.id, tokenId: document?.id ?? document?._id ?? null, level: MOVEMENT_DEBUG_LEVELS.TRACE });
    const combatState = getCombatState(combat);
    if (!combatState.enabled || combatState.phase !== PHASES.MOVEMENT || !isMovementRunActive(combat)) return;
    const combatant = combatantForTokenDocument(combat, document);
    if (!combatant) return;
    if (getCombatantState(combatant).movement?.planStatus !== MOVEMENT_PLAN_STATUS.EXECUTING) return;
    void checkMovementEngagements(combat).catch(warn);
  });

  Hooks.on("stopToken", document => {
    if (!game.user?.isGM) return;
    const combat = game.combat;
    const run = activeRuns.get(combat?.id);
    const combatant = combatantForTokenDocument(combat, document);
    movementDebug(MOVEMENT_DEBUG_CATEGORIES.STOP, "stop-token-hook", () => ({
      tokenId: document?.id ?? document?._id ?? null,
      combatantId: combatant?.id ?? null,
      hasCombatant: !!combatant
    }), { runId: run?.runId, tick: run?.tick, combatId: combat?.id, combatantId: combatant?.id ?? null, tokenId: document?.id ?? document?._id ?? null, level: MOVEMENT_DEBUG_LEVELS.VERBOSE });
    if (!combatant) return;
    const state = getCombatantState(combatant);
    if (state.movement?.planStatus !== MOVEMENT_PLAN_STATUS.EXECUTING) return;
    const context = activeMovementContext(combat, combatant);
    const contextDistance = contextMovementDistance(context);
    const engagedStop = isRunCombatantStopped(combat, combatant);
    if (context && engagedStop) context.status = MOVEMENT_PLAN_STATUS.STOPPED;
    movementDebug(MOVEMENT_DEBUG_CATEGORIES.STOP, "stop-token-status-write", () => ({
      combatantId: combatant?.id,
      engagedStop,
      contextDistance,
      fallbackDistance: actualMovementDistance(document, state.movement),
      stoppedReason: state.movement?.stoppedReason || (engagedStop ? "engaged" : "stopped"),
      context: context ? {
        index: context.index,
        waypointCount: context.waypoints.length,
        status: context.status,
        traveledWaypoints: context.traveledWaypoints
      } : null
    }), { runId: run?.runId, tick: run?.tick, combatId: combat?.id, combatantId: combatant?.id, tokenId: document?.id ?? document?._id ?? null, level: MOVEMENT_DEBUG_LEVELS.TRACE });
    if (context && !engagedStop) {
      if (context.index < context.waypoints.length) {
        movementDebugWarn(MOVEMENT_DEBUG_CATEGORIES.STOP, "non-authoritative-stop-with-remaining-route", () => ({
          combatantId: combatant?.id,
          index: context.index,
          waypointCount: context.waypoints.length,
          movement: state.movement
        }), { runId: run?.runId, tick: run?.tick, combatId: combat?.id, combatantId: combatant?.id, tokenId: document?.id ?? document?._id ?? null });
      }
      return;
    }
    void markMovementStatus(combatant, MOVEMENT_PLAN_STATUS.STOPPED, {
      distance: contextDistance ?? actualMovementDistance(document, state.movement),
      completedAt: Date.now(),
      stoppedReason: state.movement?.stoppedReason || (engagedStop ? "engaged" : "stopped")
    });
  });
}
