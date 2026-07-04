import { AoVAdapter } from "../adapter/aov-adapter.mjs";
import {
  ACTION_CATEGORIES,
  DEX_MODIFIERS,
  DISENGAGEMENT_METHODS,
  DISENGAGEMENT_STATUS,
  MODULE_ID,
  MOVEMENT_DEBUG_CATEGORIES,
  MOVEMENT_DEBUG_LEVELS,
  MOVEMENT_PLAN_STATUS,
  ROUNDING_POLICIES
} from "../constants.mjs";
import { movementDebug } from "./movement-debugger.mjs";

/**
 * Convert a value to a finite number.
 *
 * @param {unknown} value Candidate numeric value.
 * @param {number|null} [fallback=0] Fallback when conversion fails.
 * @returns {number|null}
 */
function numberOr(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

/**
 * Determine the scene distance corresponding to one AoV movement penalty unit.
 *
 * AoV rules use 3 metres / 10 feet. If the scene units are not recognizable,
 * the current grid distance is used as a conservative fallback.
 *
 * @returns {number}
 */
function movementUnitDistance() {
  const units = String(canvas.scene?.grid?.units ?? "").toLowerCase();
  if (["ft", "feet", "foot"].includes(units)) return 10;
  if (["m", "meter", "meters", "metre", "metres"].includes(units)) return 3;
  return numberOr(canvas.scene?.grid?.distance, 5) || 5;
}

/**
 * Apply the configured partial-movement rounding policy.
 *
 * @param {number} rawUnits Raw distance divided by one movement penalty unit.
 * @returns {number}
 */
function roundMovementUnits(rawUnits) {
  const policy = game.settings.get(MODULE_ID, "movementRounding");
  if (policy === ROUNDING_POLICIES.FLOOR) return Math.floor(rawUnits);
  if (policy === ROUNDING_POLICIES.NEAREST) return Math.round(rawUnits);
  return Math.ceil(rawUnits);
}

/**
 * Push a non-zero DEX modifier into the ledger.
 *
 * @param {{label: string, value: number}[]} modifiers Accumulated modifiers.
 * @param {string} label Localization key.
 * @param {number} value Modifier value.
 * @returns {void}
 */
function addModifier(modifiers, label, value) {
  if (!value) return;
  modifiers.push({ label, value });
}

/**
 * Calculate the full DEX ledger for a combatant's current declaration.
 *
 * @param {Combatant} combatant Foundry Combatant document.
 * @param {import("../types.mjs").SkjaldborgCombatantState} combatantState Module combatant state.
 * @param {{includePlanningAdjustment?: boolean, includeMovementPenalty?: boolean}} [options={}] Calculation options.
 * @returns {import("../types.mjs").SkjaldborgDexLedger}
 */
export function computeDexLedger(
  combatant,
  combatantState,
  { includePlanningAdjustment = true, includeMovementPenalty = true } = {}
) {
  const actor = combatant.actor;
  const baseDex = AoVAdapter.getDex(actor);
  let int = AoVAdapter.getInt(actor);
  const mov = AoVAdapter.getMov(actor);
  const intent = combatantState.intent ?? {};
  const movement = combatantState.movement ?? {};
  const modifiers = [];

  const intentModifiers = intent.modifiers ?? {};
  let dynamicPlanningEnabled = false;
  try {
    dynamicPlanningEnabled = game.settings.get(MODULE_ID, "dynamicPlanningInitiative") === true;
  }
  catch (_exception) {
    dynamicPlanningEnabled = false;
  }
  const planningAdjustment = includePlanningAdjustment && dynamicPlanningEnabled
    ? numberOr(combatantState.planningInitiative?.externalAdjustment, 0)
    : 0;
  addModifier(modifiers, "AOV_SKJALDBORG.Dex.PlanningInitiativeAdjustment", planningAdjustment);
  addModifier(modifiers, "AOV_SKJALDBORG.Dex.DrawWeapon", intentModifiers.drawWeapon ? DEX_MODIFIERS.DRAW_WEAPON : 0);
  addModifier(modifiers, "AOV_SKJALDBORG.Dex.SheatheWeapon", intentModifiers.sheatheWeapon ? DEX_MODIFIERS.SHEATHE_WEAPON : 0);
  addModifier(modifiers, "AOV_SKJALDBORG.Dex.Surprised", intentModifiers.surprised ? DEX_MODIFIERS.SURPRISED : 0);

  // A stored PLANNED route describes intended travel, not distance already
  // travelled. Movement DEX is therefore eligible only after the authoritative
  // movement run has placed the plan in a terminal state and replaced the
  // stored distance with the measured travelled distance. This prevents live
  // Planning initiative from charging a route before the token has moved.
  const movementTerminal = [
    MOVEMENT_PLAN_STATUS.COMPLETED,
    MOVEMENT_PLAN_STATUS.STOPPED,
    MOVEMENT_PLAN_STATUS.FAILED
  ].includes(movement.planStatus);
  const movementPenaltyEligible = includeMovementPenalty && movementTerminal;
  const recordedDistance = numberOr(movement.distance, 0);
  const distance = movementPenaltyEligible ? recordedDistance : 0;
  const movementUnits = distance > 0 ? roundMovementUnits(distance / movementUnitDistance()) : 0;
  const movementPenalty = movementUnits > 0 && !intentModifiers.fullMove ? -movementUnits : 0;
  addModifier(modifiers, "AOV_SKJALDBORG.Dex.Movement", movementPenalty);

  const fixedRank = numberOr(intent.fixedRank, null);
  const fixedRankValue = Number.isFinite(fixedRank) && fixedRank > 0 ? fixedRank : null;
  const modifierTotal = modifiers.reduce((total, m) => total + numberOr(m.value), 0);
  let finalDex = intentModifiers.fullMove ? 0 : baseDex + modifierTotal;
  if (fixedRankValue !== null) finalDex = fixedRankValue;

  if (intent.delay?.enabled) {
    const targetDex = numberOr(intent.delay.targetDex, null);
    if (Number.isFinite(targetDex) && targetDex > 0) finalDex = Math.min(finalDex, targetDex);
    const tiebreakerInt = numberOr(intent.delay.tiebreakerInt, null);
    if (Number.isFinite(tiebreakerInt)) int = tiebreakerInt;
  }

  const preventedThisRound = finalDex <= 0;
  const projectedInitiative = preventedThisRound
    ? null
    : Number((finalDex + ((Number(int) || 0) / 100)).toFixed(2));

  const ledger = {
    combatantId: combatant.id,
    actorId: actor?.id ?? null,
    baseDex,
    int,
    mov,
    distance,
    movementUnits,
    movementPenalty,
    planningAdjustment,
    modifiers,
    modifierTotal,
    fixedRank: fixedRankValue,
    finalDex,
    projectedInitiative,
    preventedThisRound,
    carryoverReason: preventedThisRound ? "AOV_SKJALDBORG.Dex.CarryoverDexZero" : "",
    actionCategory: intent.actionCategory ?? ACTION_CATEGORIES.ATTACK
  };
  movementDebug(MOVEMENT_DEBUG_CATEGORIES.DEX, "compute-dex-ledger", () => ({
    combatantId: combatant.id,
    actorId: actor?.id ?? null,
    movement: {
      recordedDistance,
      distance,
      movementUnitDistance: movementUnitDistance(),
      movementUnits,
      movementPenalty,
      movementPenaltyEligible,
      includeMovementPenalty,
      planStatus: movement.planStatus,
      stoppedReason: movement.stoppedReason,
      waypointCount: movement.waypoints?.length ?? 0
    },
    intentModifiers,
    ledger
  }), { combatantId: combatant.id, level: MOVEMENT_DEBUG_LEVELS.VERBOSE });
  return ledger;
}

/**
 * Build one or more scheduled actions from a DEX ledger.
 *
 * Split attacks are represented as separate module actions but not duplicate
 * Foundry Combatants. DEX 0 or rune carryover creates a carryover entry.
 *
 * @param {Combatant} combatant Foundry Combatant document.
 * @param {import("../types.mjs").SkjaldborgCombatantState} combatantState Module combatant state.
 * @param {import("../types.mjs").SkjaldborgDexLedger} ledger Calculated DEX ledger.
 * @returns {import("../types.mjs").SkjaldborgResolutionAction[]}
 */
export function buildScheduledActions(combatant, combatantState, ledger) {
  const intent = combatantState.intent ?? {};
  const disengagement = combatantState.disengagement ?? {};
  if (disengagement.status === DISENGAGEMENT_STATUS.DECLARED
    && [DISENGAGEMENT_METHODS.RETREAT, DISENGAGEMENT_METHODS.FLEE].includes(disengagement.method)) {
    return [];
  }
  if (ledger.preventedThisRound || intent.runeCarryover) {
    return [{
      id: `${combatant.id}-carryover`,
      combatantId: combatant.id,
      actorId: combatant.actor?.id ?? null,
      actorName: combatant.name,
      actionCategory: intent.actionCategory ?? ACTION_CATEGORIES.OTHER,
      dex: ledger.finalDex,
      int: ledger.int,
      status: "carryover",
      carryover: true,
      label: game.i18n.localize("AOV_SKJALDBORG.Actions.Carryover")
    }];
  }

  const count = Math.max(1, Math.min(4, Math.trunc(numberOr(intent.splitCount, 1))));
  const actions = [];
  const increment = count > 1 ? Math.ceil(Math.max(ledger.finalDex, 1) / count) : 0;
  for (let index = 0; index < count; index += 1) {
    const dex = index === 0 ? ledger.finalDex : ledger.finalDex - (increment * index);
    actions.push({
      id: `${combatant.id}-${index + 1}`,
      combatantId: combatant.id,
      actorId: combatant.actor?.id ?? null,
      actorName: combatant.name,
      actionCategory: intent.actionCategory ?? ACTION_CATEGORIES.ATTACK,
      dex,
      int: ledger.int,
      status: dex > 0 ? "pending" : "carryover",
      carryover: dex <= 0,
      splitIndex: index + 1,
      splitCount: count,
      waitInterrupt: !!intent.waitInterrupt?.enabled,
      waitText: intent.waitInterrupt?.text ?? "",
      publicText: intent.publicText ?? "",
      privateText: intent.privateText ?? "",
      label: count > 1
        ? game.i18n.format("AOV_SKJALDBORG.Actions.SplitLabel", { index: index + 1, count })
        : game.i18n.localize(`AOV_SKJALDBORG.ActionCategories.${intent.actionCategory ?? ACTION_CATEGORIES.ATTACK}`)
    });
  }
  return actions;
}
