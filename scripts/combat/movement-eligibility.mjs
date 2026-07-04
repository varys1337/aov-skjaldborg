import { AoVAdapter } from "../adapter/aov-adapter.mjs";

const DEFAULT_MOVEMENT_ALLOWANCE = 10;
const DISTANCE_EPSILON = 1e-6;

/**
 * Resolve the current scene distance represented by one grid space.
 *
 * Engagement movement eligibility is a RAW grid-unit rule, independent of
 * whether the scene displays feet, yards, meters, or another measuring label.
 *
 * @returns {number}
 */
export function gridUnitSceneDistance() {
  const value = Number(globalThis.canvas?.scene?.grid?.distance);
  return Number.isFinite(value) && value > 0 ? value : 1;
}

/**
 * Convert a scene-distance value into neutral grid units.
 *
 * @param {number|null|undefined} distance Scene distance stored in movement state.
 * @returns {number}
 */
export function sceneDistanceToGridUnits(distance) {
  const numeric = Number(distance);
  if (!Number.isFinite(numeric) || numeric <= 0) return 0;
  return numeric / gridUnitSceneDistance();
}

/**
 * Read the actor MOV value used for RAW half-move engagement eligibility.
 *
 * @param {Combatant|object|null} combatant Combatant whose actor supplies MOV.
 * @returns {number}
 */
export function movementAllowanceGridUnits(combatant) {
  const actor = combatant?.actor ?? combatant?.token?.actor ?? combatant?.token?.object?.actor ?? null;
  const mov = Number(AoVAdapter.getMov(actor));
  return Number.isFinite(mov) && mov > 0 ? mov : DEFAULT_MOVEMENT_ALLOWANCE;
}

/**
 * A combatant can establish close-combat engagement only after moving no more
 * than their RAW half-move allowance. In AoV terms this is the actor's MOV
 * value measured in neutral grid units.
 *
 * @param {Combatant|object|null} combatant Combatant document.
 * @returns {number}
 */
export function engagementMovementLimitGridUnits(combatant) {
  return movementAllowanceGridUnits(combatant);
}

/**
 * Determine whether a combatant can still establish engagement this round.
 *
 * @param {Combatant|object|null} combatant Combatant document.
 * @param {number|null|undefined} movedGridUnits Distance already moved in grid units.
 * @returns {boolean}
 */
export function canEstablishEngagementAfterMovement(combatant, movedGridUnits) {
  const moved = Number(movedGridUnits);
  if (!Number.isFinite(moved) || moved <= 0) return true;
  return moved <= engagementMovementLimitGridUnits(combatant) + DISTANCE_EPSILON;
}

/**
 * Build a tracker-friendly movement eligibility summary.
 *
 * @param {Combatant|object|null} combatant Combatant document.
 * @param {number|null|undefined} sceneDistance Scene distance stored in movement state.
 * @returns {{gridUnits: number, limit: number, canEngage: boolean}}
 */
export function movementEngagementEligibility(combatant, sceneDistance) {
  const gridUnits = sceneDistanceToGridUnits(sceneDistance);
  const limit = engagementMovementLimitGridUnits(combatant);
  return {
    gridUnits,
    limit,
    canEngage: canEstablishEngagementAfterMovement(combatant, gridUnits)
  };
}
