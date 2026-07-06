import { ACTION_CATEGORIES, DISENGAGEMENT_METHODS, DISENGAGEMENT_STATUS, ENGAGEMENT_STATUS, FLAG_KEYS, INTENT_STATUS, MODULE_ID, MODULE_VERSION, MOVEMENT_PLAN_STATUS, PHASES } from "../constants.mjs";
import { AoVAdapter } from "../adapter/aov-adapter.mjs";
import { runtimeSettings } from "../runtime-settings.mjs";
import { firstEnabledPhase, getEnabledPhases } from "./phase-structure.mjs";
import { performanceDiagnostics } from "../performance/performance-monitor.mjs";

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

function stateComparisonValue(value) {
  if (Array.isArray(value)) return value.map(stateComparisonValue);
  if (!value || typeof value !== "object") return value;
  const entries = Object.entries(value)
    .filter(([key]) => key !== "updatedAt")
    .sort(([left], [right]) => left.localeCompare(right));
  return Object.fromEntries(entries.map(([key, entry]) => [key, stateComparisonValue(entry)]));
}

function stableStateString(value) {
  return JSON.stringify(stateComparisonValue(value));
}

export function stateMeaningfullyChanged(current, next) {
  return stableStateString(current) !== stableStateString(next);
}

const SCOPED_COMBATANT_STATE_COMPARE_KEYS = new Set(["movement", "engagement", "reactionCount"]);

function scopedValueChanged(current, next, key) {
  if (key === "reactionCount") return Number(current?.reactionCount ?? 0) !== Number(next?.reactionCount ?? 0);
  return stableStateString(current?.[key]) !== stableStateString(next?.[key]);
}

export function combatantStateMeaningfullyChanged(current, next, patch = null) {
  const keys = Object.keys(patch ?? {});
  if (keys.length && keys.every(key => SCOPED_COMBATANT_STATE_COMPARE_KEYS.has(key))) {
    return keys.some(key => scopedValueChanged(current, next, key));
  }
  return stateMeaningfullyChanged(current, next);
}

function stateUpdateReason(options = {}) {
  return options?.[MODULE_ID]?.reason ?? options?.reason ?? "";
}

function countStateWriteMetric(name, amount, detail = null) {
  performanceDiagnostics.count(name, amount, detail);
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
    enabled: runtimeSettings.enabled === true,
    phase: getEnabledPhases().includes(systemPhase) ? systemPhase : firstEnabledPhase(),
    logicalRound: AoVAdapter.getSystemLogicalRound(combat),
    requireAllCommit: runtimeSettings.requireAllCommit === true,
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
    version: MODULE_VERSION,
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
        targetDex: null,
        targetCombatantId: null,
        position: "",
        tiebreakerInt: null
      },
      waitInterrupt: {
        enabled: false,
        text: ""
      },
      splitCount: 1,
      fixedRank: null,
      runeCarryover: false
    },
    runeMagic: defaultRuneMagicState(),
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
      reason: "",
      egress: {
        status: "none",
        ignoredPartnerIds: [],
        method: DISENGAGEMENT_METHODS.NONE,
        sourceRound: null,
        activatedAt: null,
        reason: ""
      }
    },
    disengagement: {
      method: DISENGAGEMENT_METHODS.NONE,
      status: DISENGAGEMENT_STATUS.NONE,
      declaredRound: null,
      resolvesAtRound: null,
      partnerIds: [],
      mountedAtDeclaration: false,
      opponentMountedAtDeclaration: false,
      defensiveOnly: false,
      freeAttackResolved: false,
      opportunityAttackerId: null,
      opportunityAttackerIds: [],
      opportunityMode: "one",
      reason: ""
    },
    dexLedger: null,
    planningInitiative: {
      logicalRound: null,
      baselineInitiative: null,
      externalAdjustment: 0,
      projectedInitiative: null,
      updatedAt: 0
    },
    scheduledActions: [],
    reactionCount: 0,
    gmNotes: "",
    activeGroupId: null,
    updatedAt: Date.now()
  };
}

/**
 * Build the default Rune Script combat tracking state.
 *
 * @returns {import("../types.mjs").SkjaldborgRuneMagicState}
 */
export function defaultRuneMagicState() {
  return {
    status: "none",
    itemUuid: null,
    itemId: null,
    itemType: "",
    itemName: "",
    runeCount: 0,
    mpCost: 0,
    maxEffects: 0,
    dexPenalty: 0,
    flatMod: 0,
    flatModReason: "",
    startedRound: null,
    readyRound: null,
    targetRefs: [],
    resistance: false,
    craftSkillId: null,
    craftMessageId: null,
    castMessageId: null,
    eventMessageId: null,
    resistanceMessageIds: [],
    notes: "",
    updatedAt: 0
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
export async function setCombatState(combat, state, options = {}) {
  const current = getCombatState(combat);
  const safeState = sanitizeCombatState(state, { includeMissingSnapshot: false });
  const merged = foundry.utils.mergeObject(current, safeState, { inplace: false });
  const next = sanitizeCombatState(merged);
  if (!stateMeaningfullyChanged(current, next)) {
    countStateWriteMetric("state.combat.write.skipped", 1, {
      combatId: combat?.id ?? null,
      reason: stateUpdateReason(options)
    });
    return current;
  }
  next.updatedAt = Date.now();
  await combat.setFlag(MODULE_ID, FLAG_KEYS.COMBAT_STATE, next);
  countStateWriteMetric("state.combat.write", 1, {
    combatId: combat?.id ?? null,
    reason: stateUpdateReason(options)
  });
  return next;
}

/**
 * Merge and persist a partial Combat state update.
 *
 * @param {Combat} combat Foundry Combat document.
 * @param {Partial<import("../types.mjs").SkjaldborgCombatState>} patch State patch.
 * @returns {Promise<import("../types.mjs").SkjaldborgCombatState>}
 */
export async function updateCombatState(combat, patch, options = {}) {
  return setCombatState(combat, patch, options);
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
  const state = foundry.utils.mergeObject(defaultCombatantState(), clone(raw), { inplace: false });
  if (state.intent?.actionCategory === "flee") {
    state.intent.actionCategory = ACTION_CATEGORIES.RETREAT;
  }
  return state;
}

/**
 * Persist Combatant state under the module namespace.
 *
 * @param {Combatant} combatant Foundry Combatant document.
 * @param {Partial<import("../types.mjs").SkjaldborgCombatantState>} state State patch.
 * @returns {Promise<import("../types.mjs").SkjaldborgCombatantState>}
 */
export async function setCombatantState(combatant, state, options = {}) {
  const current = getCombatantState(combatant);
  const next = foundry.utils.mergeObject(current, state, { inplace: false });
  if (!combatantStateMeaningfullyChanged(current, next, state)) {
    countStateWriteMetric("state.combatant.write.skipped", 1, {
      combatantId: combatant?.id ?? null,
      combatId: combatant?.parent?.id ?? combatant?.combat?.id ?? null,
      reason: stateUpdateReason(options)
    });
    return current;
  }
  next.updatedAt = Date.now();
  await combatant.setFlag(MODULE_ID, FLAG_KEYS.COMBATANT_STATE, next);
  countStateWriteMetric("state.combatant.write", 1, {
    combatantId: combatant?.id ?? null,
    combatId: combatant?.parent?.id ?? combatant?.combat?.id ?? null,
    reason: stateUpdateReason(options)
  });
  return next;
}

/**
 * Build a Combatant embedded-document update for module state.
 *
 * @param {Combatant} combatant Combatant document.
 * @param {Partial<import("../types.mjs").SkjaldborgCombatantState>} patch State patch.
 * @returns {object}
 */
export function combatantStateUpdateData(combatant, patch, { skipUnchanged = false, reason = "" } = {}) {
  const current = getCombatantState(combatant);
  const next = foundry.utils.mergeObject(current, patch, { inplace: false });
  if (skipUnchanged && !combatantStateMeaningfullyChanged(current, next, patch)) {
    countStateWriteMetric("state.combatant.embeddedUpdate.skipped", 1, {
      combatantId: combatant?.id ?? null,
      combatId: combatant?.parent?.id ?? combatant?.combat?.id ?? null,
      reason
    });
    return null;
  }
  next.updatedAt = Date.now();
  return {
    _id: combatant.id,
    [`flags.${MODULE_ID}.${FLAG_KEYS.COMBATANT_STATE}`]: next
  };
}

/**
 * Batch multiple Combatant state writes through the parent Combat document.
 *
 * This preserves the existing full-state merge semantics from
 * `combatantStateUpdateData` while reducing embedded Combatant flag writes for
 * pair and phase operations which update more than one combatant at once.
 *
 * @param {Combat|null|undefined} combat Parent Combat document.
 * @param {Array<[Combatant|object|null, Partial<import("../types.mjs").SkjaldborgCombatantState>|null|undefined]>} entries Combatant/patch pairs.
 * @param {object} [options={}] Foundry embedded-document update options.
 * @returns {Promise<unknown[]>} Updated Combatant documents or fallback write results.
 */
export async function updateCombatantStates(combat, entries = [], options = {}) {
  if (!combat || !Array.isArray(entries) || !entries.length) return [];
  const byId = new Map();
  for (const [combatant, patch] of entries) {
    if (!combatant?.id || !patch || typeof patch !== "object" || Array.isArray(patch)) continue;
    const parentCombat = combatant.parent ?? combatant.combat ?? null;
    if (parentCombat && parentCombat !== combat) {
      throw new Error(`Cannot batch Skjaldborg combatant state across Combat documents: ${combatant.id}`);
    }
    const existing = byId.get(combatant.id);
    const nextPatch = existing
      ? foundry.utils.mergeObject(existing.patch, patch, { inplace: false })
      : foundry.utils.deepClone(patch);
    byId.set(combatant.id, { combatant, patch: nextPatch });
  }

  const pending = Array.from(byId.values());
  if (!pending.length) return [];

  performanceDiagnostics.count("state.combatant.batch.request", 1, {
    combatId: combat?.id ?? null,
    requested: entries.length,
    updates: pending.length
  });

  if (typeof combat.updateEmbeddedDocuments !== "function") {
    performanceDiagnostics.count("state.combatant.batch.fallback", 1, {
      combatId: combat?.id ?? null,
      updates: pending.length
    });
    return Promise.all(pending.map(({ combatant, patch }) => setCombatantState(combatant, patch, options)));
  }

  const reason = stateUpdateReason(options);
  const updateCandidates = pending.map(({ combatant, patch }) => combatantStateUpdateData(combatant, patch, {
    skipUnchanged: true,
    reason
  }));
  const skipped = updateCandidates.filter(update => update === null).length;
  const updates = updateCandidates.filter(Boolean);
  if (skipped) {
    countStateWriteMetric("state.combatant.batch.skipped", skipped, {
      combatId: combat?.id ?? null,
      reason
    });
  }
  if (!updates.length) return [];
  countStateWriteMetric("state.combatant.batch.write", 1, {
    combatId: combat?.id ?? null,
    reason,
    updates: updates.length
  });
  if (String(reason).startsWith("movement")) {
    countStateWriteMetric("movement.tick.stateWrites", updates.length, { combatId: combat?.id ?? null, reason });
  }
  return combat.updateEmbeddedDocuments("Combatant", updates, {
    ...options,
    [MODULE_ID]: {
      ...(options?.[MODULE_ID] ?? {}),
      batchedCombatantState: true,
      updateCount: updates.length
    }
  });
}

/**
 * Merge and persist a partial Combatant state update.
 *
 * @param {Combatant} combatant Foundry Combatant document.
 * @param {Partial<import("../types.mjs").SkjaldborgCombatantState>} patch State patch.
 * @returns {Promise<import("../types.mjs").SkjaldborgCombatantState>}
 */
export async function updateCombatantState(combatant, patch, options = {}) {
  return setCombatantState(combatant, patch, options);
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
    updates.push([combatant, {
      ...defaultCombatantState(),
      engagement: foundry.utils.deepClone(state.engagement ?? defaultCombatantState().engagement),
      runeMagic: foundry.utils.deepClone(state.runeMagic ?? defaultCombatantState().runeMagic),
      gmNotes: state.gmNotes
    }]);
  }
  return updateCombatantStates(combat, updates, { [MODULE_ID]: { reason: "round-state-reset" } });
}

/**
 * Convert a phase id into its localization key.
 *
 * @param {string} phase Phase id.
 * @returns {string}
 */
export function phaseLabelKey(phase) {
  return `AOV_SKJALDBORG.Phases.${phase ?? PHASES.INTENT}`;
}
