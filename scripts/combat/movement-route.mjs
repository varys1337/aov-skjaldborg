import { MODULE_ID, MOVEMENT_DEBUG_CATEGORIES, MOVEMENT_DEBUG_LEVELS } from "../constants.mjs";
import { movementDebug, movementDebugWarn } from "./movement-debugger.mjs";
import { performanceDiagnostics } from "../performance/performance-monitor.mjs";

const DEFAULT_WAYPOINT_LIMIT = 250;
const TRUNCATION_NOTIFICATION_THROTTLE_MS = 5000;
let lastTruncationNotificationAt = 0;
const ROUTE_SOURCE_PRIORITY = Object.freeze({
  PENDING: 1,
  PAYLOAD: 10,
  NESTED_PENDING: 18,
  NESTED: 20,
  DOCUMENT_PENDING: 25,
  DOCUMENT_DIRECT: 30,
  DOCUMENT_HISTORY: 40,
  DESTINATION: 50
});

/**
 * Convert a candidate point to plain finite coordinates.
 *
 * @param {unknown} point Candidate point.
 * @returns {{x: number, y: number}|null}
 */
export function cleanMovementPoint(point) {
  if (!point || typeof point !== "object") return null;
  const x = Number(point.x);
  const y = Number(point.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x: Math.round(x), y: Math.round(y) };
}

/**
 * Compare two points by value.
 *
 * @param {{x: number, y: number}|null} a First point.
 * @param {{x: number, y: number}|null} b Second point.
 * @returns {boolean}
 */
export function sameMovementPoint(a, b) {
  return !!a && !!b && Number(a.x) === Number(b.x) && Number(a.y) === Number(b.y);
}

/**
 * Append a point unless it duplicates the current route tail.
 *
 * @param {object[]} route Route accumulator.
 * @param {unknown} point Candidate point.
 * @returns {void}
 */
export function appendRoutePoint(route, point) {
  const clean = cleanMovementPoint(point);
  if (!clean || sameMovementPoint(clean, cleanMovementPoint(route.at(-1)))) return;
  route.push(point && typeof point === "object" ? { ...point, ...clean } : clean);
}

/**
 * Return a plain point array from any Foundry movement route-like value.
 *
 * Foundry v14 movement operations store the authoritative path in section
 * objects such as `pending.waypoints`, not in a top-level `waypoints` field.
 *
 * @param {unknown} value Candidate route value.
 * @returns {object[]}
 */
function routeArray(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (Array.isArray(value.waypoints)) return value.waypoints;
  if (Array.isArray(value.path)) return value.path;
  if (Array.isArray(value.route)) return value.route;
  return [];
}

/**
 * Safely read TokenDocument#movement when available.
 *
 * @param {object|null} document Token document.
 * @returns {unknown|null}
 */
function documentMovement(document) {
  try {
    return document?.movement ?? null;
  }
  catch (_err) {
    return null;
  }
}

/**
 * Safely read TokenDocument#movementHistory when available.
 *
 * @param {object|null} document Token document.
 * @returns {unknown[]}
 */
function documentMovementHistory(document) {
  try {
    return Array.isArray(document?.movementHistory) ? document.movementHistory : [];
  }
  catch (_err) {
    return [];
  }
}

/**
 * Determine whether a movement-history route matches the current declaration.
 *
 * @param {unknown[]} history TokenDocument movement history.
 * @param {{x: number, y: number}|null} origin Declared origin.
 * @param {{x: number, y: number}|null} destination Declared destination.
 * @returns {boolean}
 */
function movementHistoryMatches(history, origin, destination) {
  const points = history.map(cleanMovementPoint).filter(Boolean);
  if (points.length < 2 || !origin || !destination) return false;
  return sameMovementPoint(points[0], origin) && sameMovementPoint(points.at(-1), destination);
}

/**
 * Add all standard route surfaces from one movement-shaped object.
 *
 * @param {object[]} candidates Candidate accumulator.
 * @param {string} prefix Diagnostic source prefix.
 * @param {object|null} value Movement-shaped value.
 * @param {number} directPriority Priority for direct route fields.
 * @param {number} pendingPriority Priority for pending section waypoints.
 * @returns {void}
 */
function addMovementCandidates(candidates, prefix, value, directPriority, pendingPriority) {
  if (!value || typeof value !== "object") return;
  const addCandidate = (source, priority, candidate) => {
    const points = routeArray(candidate);
    if (!points.length) return;
    candidates.push({ source, priority, points });
  };

  addCandidate(`${prefix}.pending.waypoints`, pendingPriority, value.pending?.waypoints);
  addCandidate(`${prefix}.pending`, pendingPriority, value.pending);
  addCandidate(`${prefix}.route`, directPriority, value.route);
  addCandidate(`${prefix}.waypoints`, directPriority, value.waypoints);
  addCandidate(`${prefix}.path`, directPriority, value.path);
}

/**
 * Build candidate movement routes from every documented v14 surface and the
 * plain payload shapes retained for compatibility with older builds.
 *
 * @param {object} movement Movement payload.
 * @param {object} options Options.
 * @param {object|null} [options.document=null] Token document.
 * @param {object|null} [options.origin=null] Declared origin.
 * @param {object|null} [options.destination=null] Declared destination.
 * @returns {object[]}
 */
function movementRouteCandidates(movement, { document = null, origin = null, destination = null } = {}) {
  const candidates = [];
  addMovementCandidates(candidates, "payload", movement, ROUTE_SOURCE_PRIORITY.PAYLOAD, ROUTE_SOURCE_PRIORITY.PENDING);

  for (const [key, value] of Object.entries(movement ?? {})) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    if (!["movement", "operation", "data", "update", "document", "rulerDraft"].includes(key)) continue;
    addMovementCandidates(candidates, `payload.${key}`, value, ROUTE_SOURCE_PRIORITY.NESTED, ROUTE_SOURCE_PRIORITY.NESTED_PENDING);
  }

  const currentMovement = documentMovement(document);
  addMovementCandidates(
    candidates,
    "document.movement",
    currentMovement,
    ROUTE_SOURCE_PRIORITY.DOCUMENT_DIRECT,
    ROUTE_SOURCE_PRIORITY.DOCUMENT_PENDING
  );

  const history = documentMovementHistory(document);
  if (movementHistoryMatches(history, origin, destination)) {
    candidates.push({
      source: "document.movementHistory",
      priority: ROUTE_SOURCE_PRIORITY.DOCUMENT_HISTORY,
      points: history.slice(1)
    });
  }

  if (destination) {
    candidates.push({
      source: "destination",
      priority: ROUTE_SOURCE_PRIORITY.DESTINATION,
      points: [destination]
    });
  }

  return candidates.sort((a, b) => a.priority - b.priority);
}

/**
 * Preserve an ordered movement route from Foundry movement payloads.
 *
 * Only consecutive duplicate points are removed. Non-consecutive repeated
 * corners are valid Ctrl-authored routes and must remain available for
 * execution. A leading point equal to the declared origin is discarded.
 *
 * @param {object} [movement={}] Movement payload.
 * @param {object} [options={}] Normalization options.
 * @param {number} [options.limit=250] Maximum waypoints retained.
 * @param {object|null} [options.document=null] Token document.
 * @param {object|null} [options.origin=null] Declared origin.
 * @returns {{route: object[], waypoints: object[], destination: object|null, source: string|null, truncated: boolean, candidates: object[]}}
 */
export function normalizeMovementRoute(movement = {}, { limit = DEFAULT_WAYPOINT_LIMIT, document = null, origin = null } = {}) {
  const measureId = performanceDiagnostics.markStart("movement.normalizeRoute");
  try {
  const declaredOrigin = cleanMovementPoint(origin)
    ?? cleanMovementPoint(movement.origin)
    ?? cleanMovementPoint(document?._source)
    ?? cleanMovementPoint(document);
  const declaredDestination = cleanMovementPoint(movement.destination) ?? cleanMovementPoint(movement);
  const candidates = movementRouteCandidates(movement, {
    document,
    origin: declaredOrigin,
    destination: declaredDestination
  });
  const selected = candidates[0] ?? null;
  const sourceWaypoints = selected?.points ?? [];
  const waypoints = [];

  for (const waypoint of sourceWaypoints) {
    const clean = cleanMovementPoint(waypoint);
    if (!clean) continue;
    if (!waypoints.length && sameMovementPoint(clean, declaredOrigin)) continue;
    appendRoutePoint(waypoints, waypoint);
    if (waypoints.length >= limit) break;
  }

  const destination = declaredDestination ?? cleanMovementPoint(waypoints.at(-1));
  if (destination && !sameMovementPoint(destination, cleanMovementPoint(waypoints.at(-1))) && waypoints.length < limit) {
    appendRoutePoint(waypoints, destination);
  }

  const sourceCount = sourceWaypoints.length + (destination ? 1 : 0);
  const truncated = waypoints.length >= limit && sourceCount > waypoints.length;
  const candidateSummary = candidates.map(candidate => ({
    source: candidate.source,
    priority: candidate.priority,
    count: candidate.points.length,
    points: candidate.points
  }));

  movementDebug(MOVEMENT_DEBUG_CATEGORIES.ROUTE, "normalize-route", () => ({
    source: selected?.source ?? null,
    candidates: candidateSummary,
    destination,
    origin: declaredOrigin,
    limit,
    waypointCount: waypoints.length,
    waypoints,
    truncated
  }), { level: MOVEMENT_DEBUG_LEVELS.TRACE });

  if (truncated) {
    movementDebugWarn(MOVEMENT_DEBUG_CATEGORIES.ROUTE, "waypoint-limit-truncated", () => ({
      source: selected?.source ?? null,
      limit,
      sourceCount,
      retainedCount: waypoints.length
    }));
    const now = Date.now();
    if (game.user?.isGM && (now - lastTruncationNotificationAt) > TRUNCATION_NOTIFICATION_THROTTLE_MS) {
      lastTruncationNotificationAt = now;
      ui.notifications.warn(game.i18n.format("AOV_SKJALDBORG.Warnings.MovementRouteTruncated", {
        limit,
        module: MODULE_ID
      }));
    }
  }

  return {
    route: waypoints,
    waypoints,
    destination: destination ?? cleanMovementPoint(waypoints.at(-1)) ?? null,
    source: selected?.source ?? null,
    truncated,
    candidates: candidateSummary
  };
  } finally {
    performanceDiagnostics.markEnd(measureId, {
      tokenId: document?.id ?? document?._id ?? null,
      limit
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
export function cleanMovementRoute(points, origin = null) {
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
