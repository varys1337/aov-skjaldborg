import { MOVEMENT_PLAN_VISIBILITY, MOVEMENT_PLAN_VISIBILITY_DEFAULT, MODULE_ID } from "./constants.mjs";
import { runtimeSettings } from "./runtime-settings.mjs";

/**
 * Resolve the TokenDocument represented by a Combatant.
 *
 * @param {Combatant|null|undefined} combatant Combatant source.
 * @returns {TokenDocument|object|null}
 */
function combatantTokenDocument(combatant) {
  return combatant?.token?.document ?? combatant?.token ?? null;
}

/**
 * Test whether a user has observer-or-better visibility for a combatant's
 * private tactical data. GM users always pass unless a feature explicitly
 * disables GM visibility.
 *
 * @param {User|null|undefined} user Foundry user.
 * @param {Combatant|null|undefined} combatant Combatant source.
 * @returns {boolean}
 */
export function canUserObserveCombatant(user, combatant) {
  if (!user || !combatant) return false;
  if (user.isGM) return true;
  const token = combatantTokenDocument(combatant);
  if (token?.testUserPermission?.(user, "OBSERVER")) return true;
  return combatant.actor?.testUserPermission?.(user, "OBSERVER") ?? false;
}

/**
 * Test whether movement distance/route details may be shown to the user.
 * This deliberately uses observer-or-better permissions, not mere token
 * visibility, so NPC tactical plans are not leaked to Limited/None players.
 *
 * @param {User|null|undefined} user Foundry user.
 * @param {Combatant|null|undefined} combatant Combatant source.
 * @returns {boolean}
 */
export function canUserViewMovementDetails(user, combatant) {
  return canUserObserveCombatant(user, combatant);
}

/**
 * Read and normalize the world movement-plan preview visibility setting.
 *
 * @returns {string}
 */
export function movementPlanVisibilitySetting() {
  const value = runtimeSettings.movementPlanVisibility;
  return Object.values(MOVEMENT_PLAN_VISIBILITY).includes(value)
    ? value
    : MOVEMENT_PLAN_VISIBILITY_DEFAULT;
}

/**
 * Test whether a stored movement trajectory may be rendered on canvas hover.
 *
 * @param {User|null|undefined} user Foundry user.
 * @param {Combatant|null|undefined} combatant Combatant source.
 * @returns {boolean}
 */
export function canUserViewMovementPlanPreview(user, combatant) {
  const visibility = movementPlanVisibilitySetting();
  if (visibility === MOVEMENT_PLAN_VISIBILITY.NONE) return false;
  if (visibility === MOVEMENT_PLAN_VISIBILITY.EVERYONE) return true;
  return canUserObserveCombatant(user, combatant);
}
