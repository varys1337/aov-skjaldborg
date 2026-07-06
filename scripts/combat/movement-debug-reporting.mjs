import { cleanMovementPoint } from "./movement-route.mjs";

/**
 * Read the stored module route from a combatant movement flag.
 *
 * `movement.route` is canonical. `movement.waypoints` remains a compatibility
 * alias for movement plans written by earlier builds.
 *
 * @param {object|null} movement Combatant movement state.
 * @returns {object[]}
 */
export function storedMovementRoute(movement) {
  if (Array.isArray(movement?.route) && movement.route.length) return movement.route;
  return Array.isArray(movement?.waypoints) ? movement.waypoints : [];
}

/**
 * Return compact route-state data for movement diagnostics.
 *
 * @param {object|null} movement Combatant movement state.
 * @returns {object|null}
 */
export function storedMovementSummary(movement) {
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
export function foundryMovementSummary(movement) {
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
