import { AoVAdapter } from "../adapter/aov-adapter.mjs";
import { PhaseController } from "../combat/phase-controller.mjs";
import { shouldTrackCurrentTurnForPhase } from "../combat/phase-structure.mjs";
import { getCombatState } from "../combat/state.mjs";
import { PHASES } from "../constants.mjs";
import { error } from "../logger.mjs";
import { requestGm } from "../socket.mjs";


/**
 * Prepare Foundry's initial Combat update for turnless Planning.
 *
 * Core Combat#startCombat starts round 1 with the first sorted Combatant as the
 * active turn. Foundry's documented `combatStart` hook runs before that update
 * and explicitly permits mutation of its `{round, turn}` payload, so this is the
 * earliest point at which the module can prevent an artificial first-turn
 * assignment instead of clearing it in a second database update.
 *
 * @param {Combat} combat Combat encounter being started.
 * @param {{round?: number, turn?: number|null}} updateData Mutable core start payload.
 * @returns {boolean} Whether the initial turn cursor was cleared.
 */
export function prepareInitialPlanningTurn(combat, updateData) {
  if (!AoVAdapter.isAoVWorld() || !AoVAdapter.enabledSetting) return false;
  if (getCombatState(combat).phase !== PHASES.INTENT) return false;
  if (shouldTrackCurrentTurnForPhase(PHASES.INTENT)) return false;
  if (!updateData || typeof updateData !== "object") return false;

  updateData.turn = null;
  return true;
}

/**
 * Classify a positive-direction core Combat navigation update.
 *
 * Foundry's Next Turn and Next Round controls both update the Combat document,
 * but a round increase is unambiguous even when the accompanying turn resets to
 * zero. Skjaldborg treats that explicit Next Round request as a phase control,
 * while a same-round turn increase continues through combatants normally.
 *
 * @param {Combat} combat Foundry Combat document.
 * @param {object} changed Candidate differential update data.
 * @param {object} options Candidate document update options.
 * @returns {"round"|"turn"|null}
 */
export function combatNavigationKind(combat, changed, options) {
  if (!combat?.started) return null;
  if (Number(options?.direction ?? 0) <= 0) return null;

  const hasRound = Object.prototype.hasOwnProperty.call(changed ?? {}, "round");
  const hasTurn = Object.prototype.hasOwnProperty.call(changed ?? {}, "turn");
  if (!hasRound && !hasTurn) return null;

  const currentRound = Number(combat.round ?? 0);
  const currentTurn = Number(combat.turn ?? -1);
  const targetRound = Number(hasRound ? changed.round : currentRound);
  const targetTurn = Number(hasTurn ? changed.turn : currentTurn);

  if (targetRound > currentRound) return "round";
  if (targetRound === currentRound && targetTurn > currentTurn) return "turn";
  return null;
}

/**
 * Test whether a candidate update is forward tracker navigation.
 *
 * @param {Combat} combat Foundry Combat document.
 * @param {object} changed Candidate differential update data.
 * @param {object} options Candidate document update options.
 * @returns {boolean}
 */
export function isForwardCombatNavigation(combat, changed, options) {
  return combatNavigationKind(combat, changed, options) !== null;
}

/**
 * Register authoritative forward Combat navigation.
 *
 * The documented preUpdateCombat hook may cancel a Combat update by returning
 * false. Core Next Turn is replayed through the combatant/phase sequence. Core
 * Next Round deliberately overrides the turn cursor and advances one configured
 * Skjaldborg phase directly.
 *
 * @returns {void}
 */
export function registerCombatNavigationHooks(hooks = globalThis.Hooks) {
  hooks.on("combatStart", (combat, updateData) => {
    prepareInitialPlanningTurn(combat, updateData);
  });

  hooks.on("preUpdateCombat", (combat, changed, options) => {
    if (!AoVAdapter.isAoVWorld() || !AoVAdapter.enabledSetting) return;
    if (PhaseController.isInternalCombatUpdate(combat, options)) return;

    const kind = combatNavigationKind(combat, changed, options);
    if (!kind) return;

    let operation;
    if (kind === "round") {
      operation = game.user.isGM
        ? PhaseController.advance(combat)
        : requestGm("advancePhase", { combatId: combat.id, phase: null });
    }
    else {
      operation = game.user.isGM
        ? PhaseController.advanceTurn(combat)
        : requestGm("advanceTurn", { combatId: combat.id });
    }

    void Promise.resolve(operation).catch(cause => {
      error(`Failed to advance authoritative combat ${kind}`, cause);
      ui.notifications.error(cause?.message ?? String(cause));
    });
    return false;
  });
}
