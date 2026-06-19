import { ENGAGEMENT_STATUS, FLAG_KEYS, INTENT_STATUS, MODULE_ID, MODULE_VERSION, MOVEMENT_PLAN_STATUS, PHASES } from "../constants.mjs";
import { AoVAdapter } from "../adapter/aov-adapter.mjs";
import { firstEnabledPhase, getEnabledPhases } from "./phase-structure.mjs";

/**
 * Deep clone data before merging or snapshotting Foundry flag payloads.
 *
 * @template T
 * @param {T} value Value to clone.
 * @returns {T}
 */
function clone(value) {
  return foundry.utils.deepClone(value);
}

/**
 * Collapse a recovery snapshot to one level of plain serializable state.
 *
 * Older module versions embedded the previous Combat state including its own
 * recoverySnapshot. Repeating that process created an ever-deepening object
 * chain which Foundry eventually rejected during document update expansion.
 *
 * @param {unknown} snapshot Candidate persisted snapshot.
 * @returns {object|null}
 */
export function sanitizeRecoverySnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return null;

  const rawCombat = snapshot.combat && typeof snapshot.combat === "object" && !Array.isArray(snapshot.combat)
    ? snapshot.combat
    : {};
  const combat = { ...rawCombat };
  delete combat.recoverySnapshot;

  return {
    combat: clone(combat),
    combatants: clone(snapshot.combatants ?? {}),
    round: snapshot.round ?? null,
    turn: snapshot.turn ?? null,
    timestamp: Number(snapshot.timestamp) || Date.now()
  };
}

/**
 * Normalize persisted Combat state before cloning or writing it.
 *
 * @param {unknown} state Candidate Combat state.
 * @returns {object}
 */
function sanitizeCombatState(state, { includeMissingSnapshot = true } = {}) {
  if (!state || typeof state !== "object" || Array.isArray(state)) return {};
  const sanitized = { ...state };
  if (Object.prototype.hasOwnProperty.call(state, "recoverySnapshot")) {
    sanitized.recoverySnapshot = sanitizeRecoverySnapshot(state.recoverySnapshot);
  }
  else if (includeMissingSnapshot) sanitized.recoverySnapshot = null;
  return sanitized;
}

/**
 * Build the default Combat-level module state.
 *
 * @param {Combat|null|undefined} combat Foundry Combat document.
 * @returns {import("../types.mjs").SkjaldborgCombatState}
 */
export function defaultCombatState(combat) {
  const systemPhase = AoVAdapter.getSystemPhase(combat);
  return {
    version: MODULE_VERSION,
    enabled: game.settings.get(MODULE_ID, "enabled"),
    phase: getEnabledPhases().includes(systemPhase) ? systemPhase : firstEnabledPhase(),
    logicalRound: AoVAdapter.getSystemLogicalRound(combat),
    requireAllCommit: game.settings.get(MODULE_ID, "requireAllCommit"),
    movementRun: {
      status: MOVEMENT_PLAN_STATUS.NONE,
      startedAt: null,
      completedAt: null,
      pendingCombatantIds: []
    },
    resolutionQueue: [],
    simultaneousGroups: [],
    bookkeepingLedger: [],
    carryover: [],
    archivedRounds: [],
    recoverySnapshot: null,
    updatedAt: Date.now()
  };
}

/**
 * Build the default Combatant-level module state.
 *
 * @returns {import("../types.mjs").SkjaldborgCombatantState}
 */
export function defaultCombatantState() {
  return {
    intent: {
      status: INTENT_STATUS.UNCOMMITTED,
      actionCategory: "attack",
      publicText: "",
      privateText: "",
      modifiers: {
        drawWeapon: false,
        sheatheWeapon: false,
        surprised: false,
        fullMove: false
      },
      delay: {
        enabled: false,
        targetDex: null
      },
      waitInterrupt: {
        enabled: false,
        text: ""
      },
      splitCount: 1,
      fixedRank: null,
      runeCarryover: false
    },
    movement: {
      mode: "none",
      origin: null,
      destination: null,
      route: [],
      waypoints: [],
      distance: 0,
      units: "",
      manual: true,
      planStatus: MOVEMENT_PLAN_STATUS.NONE,
      startedAt: null,
      completedAt: null,
      stoppedReason: "",
      routeRevision: 0,
      routeId: "",
      captureSource: "",
      capturedAt: 0,
      draft: false
    },
    engagement: {
      status: ENGAGEMENT_STATUS.NONE,
      engaged: false,
      partnerIds: [],
      reachUnits: 1,
      reason: ""
    },
    dexLedger: null,
    scheduledActions: [],
    reactionCount: 0,
    gmNotes: "",
    activeGroupId: null,
    updatedAt: Date.now()
  };
}

/**
 * Read Combat state merged with the current default schema.
 *
 * @param {Combat|null|undefined} combat Foundry Combat document.
 * @returns {import("../types.mjs").SkjaldborgCombatState}
 */
export function getCombatState(combat) {
  const raw = combat?.getFlag(MODULE_ID, FLAG_KEYS.COMBAT_STATE) ?? {};
  return foundry.utils.mergeObject(defaultCombatState(combat), clone(sanitizeCombatState(raw)), { inplace: false });
}

/**
 * Persist Combat state under the module namespace.
 *
 * @param {Combat} combat Foundry Combat document.
 * @param {Partial<import("../types.mjs").SkjaldborgCombatState>} state State patch.
 * @returns {Promise<import("../types.mjs").SkjaldborgCombatState>}
 */
export async function setCombatState(combat, state) {
  const safeState = sanitizeCombatState(state, { includeMissingSnapshot: false });
  const merged = foundry.utils.mergeObject(getCombatState(combat), safeState, { inplace: false });
  const next = sanitizeCombatState(merged);
  next.updatedAt = Date.now();
  await combat.setFlag(MODULE_ID, FLAG_KEYS.COMBAT_STATE, next);
  return next;
}

/**
 * Merge and persist a partial Combat state update.
 *
 * @param {Combat} combat Foundry Combat document.
 * @param {Partial<import("../types.mjs").SkjaldborgCombatState>} patch State patch.
 * @returns {Promise<import("../types.mjs").SkjaldborgCombatState>}
 */
export async function updateCombatState(combat, patch) {
  return setCombatState(combat, patch);
}

/**
 * Remove all module Combat state.
 *
 * @param {Combat} combat Foundry Combat document.
 * @returns {Promise<unknown>}
 */
export async function clearCombatState(combat) {
  return combat.unsetFlag(MODULE_ID, FLAG_KEYS.COMBAT_STATE);
}

/**
 * Read Combatant state merged with the current default schema.
 *
 * @param {Combatant|null|undefined} combatant Foundry Combatant document.
 * @returns {import("../types.mjs").SkjaldborgCombatantState}
 */
export function getCombatantState(combatant) {
  const raw = combatant?.getFlag(MODULE_ID, FLAG_KEYS.COMBATANT_STATE) ?? {};
  return foundry.utils.mergeObject(defaultCombatantState(), clone(raw), { inplace: false });
}

/**
 * Persist Combatant state under the module namespace.
 *
 * @param {Combatant} combatant Foundry Combatant document.
 * @param {Partial<import("../types.mjs").SkjaldborgCombatantState>} state State patch.
 * @returns {Promise<import("../types.mjs").SkjaldborgCombatantState>}
 */
export async function setCombatantState(combatant, state) {
  const next = foundry.utils.mergeObject(getCombatantState(combatant), state, { inplace: false });
  next.updatedAt = Date.now();
  await combatant.setFlag(MODULE_ID, FLAG_KEYS.COMBATANT_STATE, next);
  return next;
}

/**
 * Merge and persist a partial Combatant state update.
 *
 * @param {Combatant} combatant Foundry Combatant document.
 * @param {Partial<import("../types.mjs").SkjaldborgCombatantState>} patch State patch.
 * @returns {Promise<import("../types.mjs").SkjaldborgCombatantState>}
 */
export async function updateCombatantState(combatant, patch) {
  return setCombatantState(
    combatant,
    foundry.utils.mergeObject(getCombatantState(combatant), patch, { inplace: false })
  );
}

/**
 * Remove all module Combatant state.
 *
 * @param {Combatant} combatant Foundry Combatant document.
 * @returns {Promise<unknown>}
 */
export async function clearCombatantState(combatant) {
  return combatant.unsetFlag(MODULE_ID, FLAG_KEYS.COMBATANT_STATE);
}

/**
 * Capture a recovery snapshot before potentially destructive phase transitions.
 *
 * @param {Combat} combat Foundry Combat document.
 * @returns {object}
 */
export function snapshotCombat(combat) {
  const combatState = getCombatState(combat);
  delete combatState.recoverySnapshot;
  return {
    combat: combatState,
    combatants: Object.fromEntries(Array.from(combat.combatants, c => [c.id, getCombatantState(c)])),
    round: combat.round,
    turn: combat.turn,
    timestamp: Date.now()
  };
}

/**
 * Reset all round-scoped Combatant state while preserving GM notes.
 *
 * @param {Combat} combat Foundry Combat document.
 * @returns {Promise<unknown[]>}
 */
export async function resetCombatantRoundState(combat) {
  const updates = [];
  for (const combatant of combat.combatants) {
    const state = getCombatantState(combatant);
    updates.push(setCombatantState(combatant, {
      ...defaultCombatantState(),
      engagement: foundry.utils.deepClone(state.engagement ?? defaultCombatantState().engagement),
      gmNotes: state.gmNotes
    }));
  }
  return Promise.all(updates);
}

/**
 * Convert a phase id into its localization key.
 *
 * @param {string} phase Phase id.
 * @returns {string}
 */
export function phaseLabelKey(phase) {
  return `AOV_SKJADLBORG.Phases.${phase ?? PHASES.INTENT}`;
}
