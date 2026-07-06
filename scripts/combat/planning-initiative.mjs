import { AoVAdapter } from "../adapter/aov-adapter.mjs";
import { MODULE_ID, PHASES } from "../constants.mjs";
import { computeDexLedger } from "./dex-ledger.mjs";
import { getCombatState, getCombatantState, updateCombatantState } from "./state.mjs";

/** @type {Map<string, Promise<unknown>>} */
const planningInitiativeLocks = new Map();

/**
 * Convert a value to a finite number.
 *
 * @param {unknown} value Candidate value.
 * @param {number|null} [fallback=null] Fallback.
 * @returns {number|null}
 */
function numberOr(value, fallback = null) {
  if (value === null || value === undefined || value === "") return fallback;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

/**
 * Extract the DEX-rank portion of AoV's `DEX.INT` initiative convention.
 *
 * @param {unknown} initiative Candidate initiative value.
 * @returns {number|null}
 */
export function dexRankFromInitiative(initiative) {
  const numeric = numberOr(initiative, null);
  if (numeric === null) return null;
  return Math.trunc(numeric);
}

/**
 * Read the advanced simultaneous Planning setting safely.
 *
 * @returns {boolean}
 */
export function isDynamicPlanningInitiativeEnabled() {
  try {
    return runtimeSettings.dynamicPlanningInitiative === true;
  }
  catch (_exception) {
    return false;
  }
}

/**
 * Whether Planning currently uses the no-active-turn, live DEX tracker.
 *
 * @param {Combat|null|undefined} combat Foundry Combat document.
 * @returns {boolean}
 */
export function isDynamicPlanningInitiativeActive(combat) {
  if (!combat?.started || !isDynamicPlanningInitiativeEnabled()) return false;
  const state = getCombatState(combat);
  return state.enabled && state.phase === PHASES.INTENT;
}

/**
 * Project a ledger to AoV's decimal initiative display, including DEX 0.
 *
 * @param {import("../types.mjs").SkjaldborgDexLedger} ledger DEX ledger.
 * @returns {number}
 */
function projectedInitiative(ledger) {
  return AoVAdapter.projectInitiative(Math.max(0, Number(ledger.finalDex) || 0), ledger.int);
}

/**
 * Serialize one combatant's live Planning initiative updates.
 *
 * @template T
 * @param {Combatant} combatant Target Combatant.
 * @param {() => Promise<T>} operation Update operation.
 * @returns {Promise<T>}
 */
function enqueuePlanningInitiativeWrite(combatant, operation) {
  const key = combatant?.uuid ?? combatant?.id;
  if (!key) return operation();
  const previous = planningInitiativeLocks.get(key) ?? Promise.resolve();
  let current;
  current = previous
    .catch(() => undefined)
    .then(operation)
    .finally(() => {
      if (planningInitiativeLocks.get(key) === current) planningInitiativeLocks.delete(key);
    });
  planningInitiativeLocks.set(key, current);
  return current;
}

/**
 * Await any live Planning initiative write for a Combat.
 *
 * @param {Combat|null|undefined} combat Foundry Combat document.
 * @returns {Promise<void>}
 */
export async function settlePlanningInitiativeWrites(combat) {
  const keys = Array.from(combat?.combatants ?? [], combatant => combatant.uuid ?? combatant.id);
  while (keys.some(key => planningInitiativeLocks.has(key))) {
    await Promise.allSettled(keys
      .map(key => planningInitiativeLocks.get(key))
      .filter(Boolean));
  }
}

/**
 * Build initial live Planning tracking data while preserving the initiative
 * already visible in the tracker. This makes enabling the option mid-round
 * non-destructive: any difference from the module's current declaration ledger
 * is recorded as an external Planning adjustment rather than overwritten.
 *
 * @param {Combatant} combatant Target Combatant.
 * @param {number} logicalRound Current logical round.
 * @returns {Promise<import("../types.mjs").SkjaldborgCombatantState>}
 */
async function initializeCombatantTracking(combatant, logicalRound) {
  const state = getCombatantState(combatant);
  const ledgerWithoutExternal = computeDexLedger(combatant, state, {
    includePlanningAdjustment: false
  });
  const currentInitiative = numberOr(combatant.initiative, ledgerWithoutExternal.projectedInitiative);
  const currentRank = dexRankFromInitiative(currentInitiative);
  const expectedRank = Number(ledgerWithoutExternal.finalDex) || 0;
  const externalAdjustment = currentRank === null ? 0 : currentRank - expectedRank;
  const trackedState = {
    ...state,
    planningInitiative: {
      logicalRound,
      baselineInitiative: AoVAdapter.projectInitiative(ledgerWithoutExternal.baseDex, ledgerWithoutExternal.int),
      externalAdjustment,
      projectedInitiative: currentInitiative,
      updatedAt: Date.now()
    }
  };
  const ledger = computeDexLedger(combatant, trackedState);
  return updateCombatantState(combatant, {
    planningInitiative: trackedState.planningInitiative,
    dexLedger: ledger
  });
}

/**
 * Initialize all capable combatants for one simultaneous Planning phase.
 *
 * @param {Combat|null|undefined} combat Foundry Combat document.
 * @returns {Promise<void>}
 */
export async function initializePlanningInitiativeTracking(combat) {
  if (!isDynamicPlanningInitiativeActive(combat)) return;
  const logicalRound = Number(getCombatState(combat).logicalRound) || 1;
  const operations = [];
  for (const combatant of combat.combatants ?? []) {
    if (!AoVAdapter.isCombatantCapable(combatant)) continue;
    operations.push(enqueuePlanningInitiativeWrite(
      combatant,
      () => initializeCombatantTracking(combatant, logicalRound)
    ));
  }
  await Promise.all(operations);
}

/**
 * Recalculate and persist one combatant's live Planning initiative after a
 * declaration or finalized movement-plan change. Planned route distance is
 * excluded by the DEX ledger until authoritative token movement reaches a
 * terminal state; hidden/immediate Movement therefore remains supported.
 *
 * The resulting Combatant update is marked so the generic update hook does not
 * mistake this module projection for an external initiative adjustment.
 *
 * @param {Combat|null|undefined} combat Foundry Combat document.
 * @param {Combatant|null|undefined} combatant Target Combatant.
 * @returns {Promise<import("../types.mjs").SkjaldborgDexLedger|null>}
 */
export function refreshPlanningInitiative(combat, combatant) {
  if (!combatant || !isDynamicPlanningInitiativeActive(combat)) return Promise.resolve(null);
  return enqueuePlanningInitiativeWrite(combatant, async () => {
    let state = getCombatantState(combatant);
    const logicalRound = Number(getCombatState(combat).logicalRound) || 1;
    if (Number(state.planningInitiative?.logicalRound) !== logicalRound) {
      await initializeCombatantTracking(combatant, logicalRound);
      state = getCombatantState(combatant);
    }

    const ledger = computeDexLedger(combatant, state);
    const initiative = projectedInitiative(ledger);
    const nextPlanning = {
      ...state.planningInitiative,
      logicalRound,
      baselineInitiative: Number.isFinite(Number(state.planningInitiative?.baselineInitiative))
        ? Number(state.planningInitiative.baselineInitiative)
        : AoVAdapter.projectInitiative(ledger.baseDex, ledger.int),
      externalAdjustment: Number(state.planningInitiative?.externalAdjustment) || 0,
      projectedInitiative: initiative,
      updatedAt: Date.now()
    };

    await updateCombatantState(combatant, {
      planningInitiative: nextPlanning,
      dexLedger: ledger
    });

    if (Math.abs(Number(combatant.initiative) - initiative) > 0.0001) {
      await combat.updateEmbeddedDocuments("Combatant", [{
        _id: combatant.id,
        initiative
      }], {
        turnEvents: false,
        [MODULE_ID]: {
          planningProjection: true
        }
      });
    }
    return ledger;
  });
}

/**
 * Capture an initiative change made by the AoV system, another module, or a GM
 * while simultaneous Planning is active. The difference from the last module
 * projection is stored as an external DEX adjustment and survives later
 * movement and Resolution queue recalculation for the current round.
 *
 * @param {Combatant|null|undefined} combatant Updated Combatant.
 * @param {object} changed Differential Combatant update.
 * @param {object} [options={}] Document update options.
 * @returns {Promise<import("../types.mjs").SkjaldborgDexLedger|null>}
 */
export function captureExternalPlanningInitiativeChange(combatant, changed, options = {}) {
  const combat = combatant?.parent ?? null;
  if (!combatant || !Object.prototype.hasOwnProperty.call(changed ?? {}, "initiative")) return Promise.resolve(null);
  if (changed.initiative === null || changed.initiative === undefined || changed.initiative === "") {
    return Promise.resolve(null);
  }
  if (options?.[MODULE_ID]?.planningProjection === true) return Promise.resolve(null);
  if (options?.[MODULE_ID]?.movementDexProjection === true) return Promise.resolve(null);
  if (options?.[MODULE_ID]?.planningExternalHandled === true) return Promise.resolve(null);
  if (!isDynamicPlanningInitiativeActive(combat)) return Promise.resolve(null);

  return enqueuePlanningInitiativeWrite(combatant, async () => {
    const state = getCombatantState(combatant);
    const logicalRound = Number(getCombatState(combat).logicalRound) || 1;
    const incomingInitiative = numberOr(changed.initiative, combatant.initiative);
    const incomingRank = dexRankFromInitiative(incomingInitiative);

    const expectedLedger = computeDexLedger(combatant, state);
    const expectedProjection = numberOr(
      state.planningInitiative?.projectedInitiative,
      projectedInitiative(expectedLedger)
    );
    const expectedRank = dexRankFromInitiative(expectedProjection) ?? (Number(expectedLedger.finalDex) || 0);
    const rankDelta = incomingRank === null ? 0 : incomingRank - expectedRank;
    const externalAdjustment = (Number(state.planningInitiative?.externalAdjustment) || 0) + rankDelta;

    const trackedState = {
      ...state,
      planningInitiative: {
        logicalRound,
        baselineInitiative: Number.isFinite(Number(state.planningInitiative?.baselineInitiative))
          ? Number(state.planningInitiative.baselineInitiative)
          : AoVAdapter.projectInitiative(expectedLedger.baseDex, expectedLedger.int),
        externalAdjustment,
        projectedInitiative: incomingInitiative,
        updatedAt: Date.now()
      }
    };
    const ledger = computeDexLedger(combatant, trackedState);
    await updateCombatantState(combatant, {
      planningInitiative: trackedState.planningInitiative,
      dexLedger: ledger
    });
    return ledger;
  });
}
