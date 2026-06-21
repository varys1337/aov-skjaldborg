import { AoVAdapter } from "../adapter/aov-adapter.mjs";
import { MODULE_ID, MOVEMENT_PLAN_STATUS, PHASE_ORDER, PHASES, RESOLUTION_STATUS } from "../constants.mjs";
import { warn } from "../logger.mjs";
import { createPhaseReport } from "./chat-report.mjs";
import { isMovementRunActive, startMovementPhase } from "./movement-controller.mjs";
import { settleMovementWrites } from "./authoritative-write-queue.mjs";
import {
  initializePlanningInitiativeTracking,
  isDynamicPlanningInitiativeActive,
  isDynamicPlanningInitiativeEnabled,
  settlePlanningInitiativeWrites
} from "./planning-initiative.mjs";
import {
  buildResolutionQueue,
  refreshAllImmediateResolutionActions,
  setActionStatus,
  settleImmediateResolutionWrites
} from "./resolution-queue.mjs";
import {
  canonicalTransitionPath,
  firstEnabledPhase,
  getEnabledPhases,
  isPhaseEnabled,
  nextEnabledPhase,
  shouldQueueResolutionImmediately
} from "./phase-structure.mjs";
import {
  clearCombatState,
  getCombatState,
  getCombatantState,
  combatantStateUpdateData,
  updateCombatantState,
  resetCombatantRoundState,
  setCombatState,
  snapshotCombat,
  updateCombatState
} from "./state.mjs";
import { RenderCoordinator } from "../ui/render-coordinator.mjs";

/**
 * Combat documents currently executing a module-owned core navigation call.
 *
 * This transient guard prevents the preUpdateCombat integration from
 * intercepting the module's own calls to Combat#nextTurn, Combat#nextRound,
 * Combat#startCombat, or Combat#update. It is not persisted UI or rules state.
 *
 * @type {WeakSet<object>}
 */
const internalCombatUpdates = new WeakSet();

/** @type {Map<string, Promise<unknown>>} */
const turnAdvanceLocks = new Map();

/** @type {Map<string, Promise<unknown>>} */
const phaseAdvanceLocks = new Map();

/**
 * Run a Foundry Combat navigation operation without re-entering the module's
 * preUpdateCombat interception.
 *
 * @template T
 * @param {Combat} combat Foundry Combat document.
 * @param {() => Promise<T>} operation Navigation operation.
 * @returns {Promise<T>}
 */
async function runInternalCombatUpdate(combat, operation) {
  internalCombatUpdates.add(combat);
  try {
    return await operation();
  }
  finally {
    internalCombatUpdates.delete(combat);
  }
}

/**
 * Build namespaced update options for module-owned direct Combat updates.
 *
 * @param {string} reason Diagnostic reason for the update.
 * @param {number} [direction=0] Foundry combat navigation direction.
 * @returns {object}
 */
function internalUpdateOptions(reason, direction = 0) {
  return {
    direction,
    [MODULE_ID]: {
      internal: true,
      reason
    }
  };
}

/**
 * Get the next configured phase in canonical rules order.
 *
 * @param {string} phase Current phase id.
 * @returns {"intent"|"movement"|"resolution"|"bookkeeping"}
 */
function nextPhase(phase) {
  return nextEnabledPhase(phase);
}

/**
 * Localize a string key.
 *
 * @param {string} key Localization key.
 * @returns {string}
 */
function localize(key) {
  return game.i18n.localize(key);
}

/**
 * List Combatants whose ruler route is still stored as a transient draft.
 * Drafts are not executable plans. They are reported to the GM when leaving
 * Statement, but do not impose a hard phase-navigation gate.
 *
 * @param {Combat} combat Foundry Combat document.
 * @returns {string[]}
 */
export function pendingMovementDraftNames(combat) {
  const names = [];
  for (const combatant of combat?.combatants ?? []) {
    const movement = getCombatantState(combatant).movement;
    const route = Array.isArray(movement?.route) && movement.route.length
      ? movement.route
      : movement?.waypoints;
    if (movement?.draft === true && Array.isArray(route) && route.length) names.push(combatant.name);
  }
  return names;
}

/**
 * Clear non-executable ruler drafts after reporting them during phase advance.
 *
 * @param {Combat} combat Foundry Combat document.
 * @returns {Promise<string[]>} Cleared Combatant names.
 */
async function clearPendingMovementDrafts(combat) {
  const updates = [];
  const names = [];
  const now = Date.now();
  for (const combatant of combat?.combatants ?? []) {
    const movement = getCombatantState(combatant).movement;
    const route = Array.isArray(movement?.route) && movement.route.length
      ? movement.route
      : movement?.waypoints;
    if (movement?.draft !== true || !Array.isArray(route) || !route.length) continue;
    names.push(combatant.name);
    const routeRevision = Math.max(now, Number(movement.routeRevision ?? 0) + 1);
    updates.push(combatantStateUpdateData(combatant, {
      movement: {
        ...foundry.utils.deepClone(movement),
        mode: "none",
        destination: null,
        route: [],
        waypoints: [],
        distance: 0,
        planStatus: MOVEMENT_PLAN_STATUS.NONE,
        stoppedReason: "draft-skipped",
        routeRevision,
        routeId: "",
        captureSource: "draft-skipped",
        capturedAt: now,
        draft: false
      }
    }));
  }
  if (updates.length) {
    await combat.updateEmbeddedDocuments("Combatant", updates, {
      [MODULE_ID]: {
        internal: true,
        reason: "movement-drafts-skipped"
      }
    });
  }
  return names;
}

/**
 * Convert a resolution queue into the bookkeeping result ledger.
 *
 * @param {object[]} queue Resolution actions.
 * @returns {object[]}
 */
function bookkeepingLedgerFromQueue(queue = []) {
  return queue.map(action => ({
    id: action.id,
    actorName: action.actorName,
    label: action.label,
    status: action.status
  }));
}

/**
 * GM-authoritative controller for Skjaldborg phase transitions.
 *
 * This class never replaces AoV's Combat document class. It stores module state
 * in flags, advances AoV's underlying staged combat only when leaving
 * Bookkeeping for a new Intent round, and delegates queue building to the DEX
 * ledger subsystem.
 */
export class PhaseController {
  /**
   * Enable full workflow state for a Combat.
   *
   * @param {Combat|null} [combat=game.combat] Foundry Combat document.
   * @returns {Promise<import("../types.mjs").SkjaldborgCombatState|null>}
   */
  static async initialize(combat = game.combat) {
    if (!combat) return null;
    const state = getCombatState(combat);
    const next = {
      ...state,
      enabled: true,
      phase: getEnabledPhases().includes(state.phase) ? state.phase : firstEnabledPhase(),
      logicalRound: state.logicalRound || AoVAdapter.getSystemLogicalRound(combat),
      requireAllCommit: game.settings.get(MODULE_ID, "requireAllCommit"),
      recoverySnapshot: snapshotCombat(combat)
    };
    await setCombatState(combat, next);
    await this.reconcilePlanningTurnMode(combat);
    await createPhaseReport(combat, next);
    RenderCoordinator.invalidateCombatTracker("phase-start-workflow");
    return next;
  }

  /**
   * Remove full workflow state for a Combat.
   *
   * @param {Combat|null} [combat=game.combat] Foundry Combat document.
   * @returns {Promise<boolean|null>}
   */
  static async disable(combat = game.combat) {
    if (!combat) return null;
    await clearCombatState(combat);
    RenderCoordinator.invalidateCombatTracker("phase-clear-workflow");
    return true;
  }

  /**
   * Validate whether the Intent phase can advance.
   *
   * @param {Combat} combat Foundry Combat document.
   * @returns {{ok: boolean, missing: string[]}}
   */
  static canAdvanceFromIntent(combat) {
    const requireAllCommit = game.settings.get(MODULE_ID, "requireAllCommit") === true;
    if (!requireAllCommit) return { ok: true, missing: [] };
    const missing = [];
    for (const combatant of combat.combatants) {
      if (!AoVAdapter.isCombatantCapable(combatant)) continue;
      const combatantState = getCombatantState(combatant);
      if (!["committed", "held"].includes(combatantState.intent?.status)) missing.push(combatant.name);
    }
    return { ok: missing.length === 0, missing };
  }

  /**
   * Advance to the requested phase, applying phase-entry side effects.
   *
   * @param {Combat|null} [combat=game.combat] Foundry Combat document.
   * @param {string|null} [requestedPhase=null] Explicit target phase or next phase.
   * @returns {Promise<import("../types.mjs").SkjaldborgCombatState|null>}
   */
  static async advance(combat = game.combat, requestedPhase = null, { forceCycle = false } = {}) {
    const key = combat?.uuid ?? combat?.id ?? null;
    if (!key) return this._advanceUnlocked(combat, requestedPhase, { forceCycle });

    const pending = phaseAdvanceLocks.get(key);
    if (pending) return pending;

    let operation;
    operation = this._advanceUnlocked(combat, requestedPhase, { forceCycle }).finally(() => {
      if (phaseAdvanceLocks.get(key) === operation) phaseAdvanceLocks.delete(key);
    });
    phaseAdvanceLocks.set(key, operation);
    return operation;
  }

  /**
   * Execute one unlocked phase transition.
   *
   * @param {Combat|null} combat Foundry Combat document.
   * @param {string|null} requestedPhase Explicit target phase or next phase.
   * @param {{forceCycle?: boolean}} options Transition options.
   * @returns {Promise<import("../types.mjs").SkjaldborgCombatState|null>}
   * @protected
   */
  static async _advanceUnlocked(combat, requestedPhase, { forceCycle = false } = {}) {
    if (!game.user.isGM) {
      ui.notifications.warn(localize("AOV_SKJALDBORG.Warnings.GmOnly"));
      return null;
    }
    if (!combat) return null;
    let state = getCombatState(combat);
    if (!state.enabled) state = await this.initialize(combat);

    const currentPhase = PHASE_ORDER.includes(state.phase) ? state.phase : firstEnabledPhase();
    const targetPhase = requestedPhase ?? nextPhase(currentPhase);
    const configuredPhases = getEnabledPhases();
    const fullCycle = forceCycle || (requestedPhase === null && targetPhase === currentPhase);

    if (!configuredPhases.includes(targetPhase)) {
      ui.notifications.warn(localize("AOV_SKJALDBORG.Warnings.DisabledPhase"));
      return state;
    }
    if (targetPhase === currentPhase && !fullCycle) return state;

    // Explicit GM phase controls are navigation commands, not validation
    // requests. Any enabled target may be selected; the canonical path still
    // runs every crossed phase's required side effects in rules order.
    const transitionPath = canonicalTransitionPath(currentPhase, targetPhase, { forceCycle: fullCycle });

    if (currentPhase === PHASES.INTENT) {
      const writesSettled = await settleMovementWrites(combat.id, { quietMs: 500, timeoutMs: 3000 });
      const pendingDrafts = pendingMovementDraftNames(combat);
      if (!writesSettled) {
        ui.notifications.warn(game.i18n.format("AOV_SKJALDBORG.Warnings.MovementPlansPending", {
          names: pendingDrafts.join(", ") || game.i18n.localize("AOV_SKJALDBORG.Warnings.UnknownMovementPlan")
        }));
        return state;
      }
      if (pendingDrafts.length) {
        ui.notifications.warn(game.i18n.format("AOV_SKJALDBORG.Warnings.MovementDraftsSkipped", {
          names: pendingDrafts.join(", ")
        }));
        await clearPendingMovementDrafts(combat);
      }
      const validation = this.canAdvanceFromIntent(combat);
      if (!validation.ok) {
        ui.notifications.warn(game.i18n.format("AOV_SKJALDBORG.Warnings.Uncommitted", { names: validation.missing.join(", ") }));
        return state;
      }
    }

    if (currentPhase === PHASES.MOVEMENT && isMovementRunActive(combat)) {
      ui.notifications.warn(localize("AOV_SKJALDBORG.Warnings.MovementRunning"));
      return state;
    }

    await settlePlanningInitiativeWrites(combat);

    // Streamlined declarations can update the Combat-level queue while the GM
    // is using tracker controls. Snapshot only after those authoritative writes
    // have settled so a round transition cannot archive an older queue value.
    await settleImmediateResolutionWrites(combat);
    state = getCombatState(combat);

    const patch = {
      phase: targetPhase,
      recoverySnapshot: snapshotCombat(combat)
    };
    let queue = foundry.utils.deepClone(state.resolutionQueue ?? []);
    let simultaneousGroups = foundry.utils.deepClone(state.simultaneousGroups ?? []);
    let carryover = foundry.utils.deepClone(state.carryover ?? []);
    let bookkeepingLedger = foundry.utils.deepClone(state.bookkeepingLedger ?? []);
    let archivedRounds = foundry.utils.deepClone(state.archivedRounds ?? []);
    let logicalRound = state.logicalRound;
    let movementRun = foundry.utils.deepClone(state.movementRun ?? {});

    // Execute skipped-phase automation in canonical rules order. This matters
    // for compressed cycles such as Resolution-only: Bookkeeping must archive
    // the completed round before Intent resets it, and the new round's
    // Resolution queue must be prepared only after that reset.
    for (const crossedPhase of transitionPath) {
      if (crossedPhase === PHASES.MOVEMENT) {
        if (crossedPhase !== targetPhase) {
          await startMovementPhase(combat, { positionAtLast: false });
          movementRun = foundry.utils.deepClone(getCombatState(combat).movementRun ?? movementRun);
        }
        continue;
      }

      if (crossedPhase === PHASES.RESOLUTION) {
        if (isPhaseEnabled(PHASES.RESOLUTION)) {
          const resolution = await buildResolutionQueue(combat, {
            announcedOnly: !isPhaseEnabled(PHASES.INTENT)
          });
          queue = resolution.queue;
          simultaneousGroups = resolution.simultaneousGroups;
          carryover = resolution.carryover;
        }
        // When Resolution is disabled, declarations have already been merged
        // into the live queue at announcement time. Preserve their statuses
        // rather than rebuilding them all as pending at this hidden boundary.
        continue;
      }

      if (crossedPhase === PHASES.BOOKKEEPING) {
        bookkeepingLedger = bookkeepingLedgerFromQueue(queue);
        if (!isPhaseEnabled(PHASES.BOOKKEEPING)) {
          Hooks.callAll?.("aovSkjaldborgImmediateBookkeeping", combat, bookkeepingLedger, {
            phase: currentPhase,
            reason: "phase-disabled"
          });
        }
        continue;
      }

      if (crossedPhase === PHASES.INTENT) {
        archivedRounds = [
          ...archivedRounds,
          {
            logicalRound,
            queue,
            bookkeepingLedger,
            completedAt: Date.now()
          }
        ].slice(-10);
        logicalRound = await this.advanceSystemToNextIntentRound(combat, logicalRound);
        await resetCombatantRoundState(combat);
        await this.applyCarryoverToNextRound(combat, carryover);
        queue = [];
        simultaneousGroups = [];
        bookkeepingLedger = [];
        carryover = [];
        movementRun = {
          status: "none",
          startedAt: null,
          completedAt: null,
          pendingCombatantIds: []
        };
      }
    }

    Object.assign(patch, {
      logicalRound,
      resolutionQueue: queue,
      simultaneousGroups,
      bookkeepingLedger,
      carryover,
      archivedRounds,
      movementRun
    });

    let next = await updateCombatState(combat, patch);
    if (targetPhase === PHASES.INTENT && isDynamicPlanningInitiativeEnabled()) {
      await initializePlanningInitiativeTracking(combat);
      await this.clearCurrentTurn(combat, "planning-simultaneous");
    } else if (targetPhase === PHASES.MOVEMENT) {
      await this.clearCurrentTurn(combat, "movement-simultaneous");
    } else {
      await this.resetTurnToFirst(combat);
    }
    await createPhaseReport(combat, next);
    RenderCoordinator.invalidateCombatTracker("phase-advance");

    // In the tactical structure, all predeclared routes execute together while
    // Movement remains visibly active. Await completion so another native Next
    // Round click cannot enter Resolution before the run has actually started.
    if (targetPhase === PHASES.MOVEMENT) {
      try {
        await startMovementPhase(combat, { positionAtLast: false });
        if (shouldQueueResolutionImmediately()) {
          await refreshAllImmediateResolutionActions(combat, { preserveStatus: true });
        }
        next = getCombatState(combat);

        // Movement remains a real visible orchestration phase while routes are
        // executing. Once every route is terminal, continue automatically to
        // the next configured phase instead of parking the tracker at the last
        // initiative entry. A Movement-only custom structure remains stable to
        // avoid an automatic one-phase recursion loop.
        const automaticTarget = nextEnabledPhase(PHASES.MOVEMENT);
        if (automaticTarget !== PHASES.MOVEMENT) {
          return this._advanceUnlocked(combat, automaticTarget, { forceCycle: false });
        }
      }
      catch (exception) {
        warn(exception);
        ui.notifications.error(exception?.message ?? localize("AOV_SKJALDBORG.MovementAutomation.MoveFailed"));
        throw exception;
      }
    }
    return next;
  }

  /**
   * Synchronize the opt-in all-intents validation value into persisted combat
   * state for reports and recovery snapshots. Transition validation itself
   * reads the live world setting so changes take effect immediately.
   *
   * @param {Combat|null} [combat=game.combat] Active combat.
   * @param {boolean} [required=false] New setting value.
   * @returns {Promise<import("../types.mjs").SkjaldborgCombatState|null>}
   */
  static async synchronizeRequireAllCommit(combat = game.combat, required = false) {
    if (!game.user?.isGM || !combat) return null;
    const state = getCombatState(combat);
    if (!state.enabled) return state;
    return updateCombatState(combat, { requireAllCommit: required === true });
  }

  /**
   * Reconcile an active combat after the world phase checklist changes.
   *
   * @param {Combat|null} [combat=game.combat] Foundry Combat document.
   * @returns {Promise<import("../types.mjs").SkjaldborgCombatState|null>}
   */
  static async reconcilePhaseStructure(combat = game.combat) {
    if (!game.user?.isGM || !combat) return null;
    const state = getCombatState(combat);
    if (!state.enabled || getEnabledPhases().includes(state.phase)) {
      RenderCoordinator.invalidateCombatTracker("phase-structure-reconciled");
      return state;
    }
    return this.advance(combat, nextEnabledPhase(state.phase));
  }

  /**
   * Move the underlying AoV system round to the next Intent-compatible stage.
   *
   * @param {Combat} combat Foundry Combat document.
   * @param {number|null} [currentLogicalRound=null] Persisted module round.
   * @returns {Promise<number>} Authoritative next logical round.
   */
  static async advanceSystemToNextIntentRound(combat, currentLogicalRound = null) {
    const logicalRound = Math.max(
      1,
      Number(currentLogicalRound) || 0,
      AoVAdapter.getSystemLogicalRound(combat)
    );
    const nextLogicalRound = logicalRound + 1;
    const targetSystemRound = (nextLogicalRound * 2) - 1;

    await runInternalCombatUpdate(combat, async () => {
      const currentSystemRound = Number(combat?.round ?? 0);
      if (currentSystemRound >= targetSystemRound) {
        if (combat.turn !== 0 && Array.from(combat.turns ?? []).length) {
          await combat.update({ turn: 0 }, internalUpdateOptions("round-normalize", 1));
        }
        return;
      }

      /*
       * AoV's current Combat subclass calls super.nextRound() without awaiting
       * or returning it. Consecutive module calls can therefore race against
       * the same source round and leave the tracker on the prior logical round.
       * Preserve AoV's initiative refresh explicitly, then persist the exact
       * odd system-round value which represents the next Intent round.
       */
      if (typeof combat.rollAll === "function") await combat.rollAll();
      const turn = Array.from(combat.turns ?? []).length ? 0 : null;
      const updated = await combat.update(
        { round: targetSystemRound, turn },
        internalUpdateOptions("bookkeeping-next-round", 1)
      );
      const persistedRound = Number(updated?.round ?? combat.round ?? 0);
      if (persistedRound !== targetSystemRound) {
        throw new Error(
          `Skjaldborg failed to persist system round ${targetSystemRound}; current round is ${persistedRound}.`
        );
      }
    });

    return nextLogicalRound;
  }

  /**
   * Determine whether a Combat update belongs to the module's own navigation
   * workflow and must bypass preUpdateCombat interception.
   *
   * @param {Combat|null|undefined} combat Foundry Combat document.
   * @param {object} [options={}] Document update options.
   * @returns {boolean}
   */
  static isInternalCombatUpdate(combat, options = {}) {
    return !!combat && (internalCombatUpdates.has(combat) || options?.[MODULE_ID]?.internal === true);
  }

  /**
   * Advance one authoritative Skjaldborg tracker step.
   *
   * Core Next Turn remains the visible control, but its forward update is
   * intercepted and routed here. The method advances through every combatant in
   * Foundry's current sorted `Combat#turns` order. When Foundry's documented
   * `nextCombatant` accessor would wrap the order, it advances exactly one
   * Skjaldborg phase and restarts that phase at turn zero.
   *
   * @param {Combat|null} [combat=game.combat] Foundry Combat document.
   * @returns {Promise<import("../types.mjs").SkjaldborgCombatState|null>}
   */
  static async advanceTurn(combat = game.combat) {
    if (!game.user.isGM) {
      ui.notifications.warn(localize("AOV_SKJALDBORG.Warnings.GmOnly"));
      return null;
    }
    if (!combat?.started) return null;

    const key = combat.uuid ?? combat.id;
    const pending = turnAdvanceLocks.get(key);
    if (pending) return pending;

    let operation;
    operation = this._advanceTurnUnlocked(combat).finally(() => {
      if (turnAdvanceLocks.get(key) === operation) turnAdvanceLocks.delete(key);
    });
    turnAdvanceLocks.set(key, operation);
    return operation;
  }

  /**
   * Execute one unlocked authoritative turn step.
   *
   * @param {Combat} combat Foundry Combat document.
   * @returns {Promise<import("../types.mjs").SkjaldborgCombatState>}
   * @protected
   */
  static async _advanceTurnUnlocked(combat) {
    let state = getCombatState(combat);
    if (!state.enabled) state = await this.initialize(combat);

    // Simultaneous Planning and visible Movement have no combatant turn cursor.
    // Native Next Turn therefore means “advance to the next configured phase”;
    // the relevant phase gates are still enforced by advance().
    if (
      (state.phase === PHASES.INTENT && isDynamicPlanningInitiativeEnabled())
      || state.phase === PHASES.MOVEMENT
    ) {
      return this.advance(combat);
    }

    const turns = Array.from(combat.turns ?? []);
    if (!turns.length) return state;

    const parsedTurn = combat.turn === null || combat.turn === undefined
      ? -1
      : Number(combat.turn);
    const currentTurn = Number.isInteger(parsedTurn) ? parsedTurn : -1;
    const nextCombatant = combat.nextCombatant ?? null;
    const nextTurn = nextCombatant
      ? turns.findIndex(turn => turn.id === nextCombatant.id)
      : -1;

    if (currentTurn < 0 || nextTurn > currentTurn) {
      await runInternalCombatUpdate(combat, () => combat.nextTurn());
      RenderCoordinator.invalidateCombatTracker("phase-next-turn");
      return getCombatState(combat);
    }

    return this.advance(combat);
  }

  /**
   * Reconcile the active Combat turn cursor with the advanced Planning mode.
   * When enabled, Planning deliberately has no current combatant; when disabled
   * again, the first sorted combatant is restored.
   *
   * @param {Combat|null} [combat=game.combat] Foundry Combat document.
   * @returns {Promise<void>}
   */
  static async reconcilePlanningTurnMode(combat = game.combat) {
    if (!game.user?.isGM || !combat?.started) return;
    if (isDynamicPlanningInitiativeActive(combat)) {
      await initializePlanningInitiativeTracking(combat);
      await this.clearCurrentTurn(combat, "planning-mode-reconcile");
      return;
    }
    const state = getCombatState(combat);
    if (state.phase === PHASES.INTENT && combat.turn == null) {
      await this.resetTurnToFirst(combat);
    }
  }

  /**
   * Clear the Foundry turn cursor without changing round or phase state.
   *
   * @param {Combat} combat Foundry Combat document.
   * @param {string} reason Diagnostic reason.
   * @returns {Promise<void>}
   */
  static async clearCurrentTurn(combat, reason = "planning-simultaneous") {
    if (!combat?.started || combat.turn == null) return;
    await combat.update({ turn: null }, { ...internalUpdateOptions(reason), turnEvents: false });
  }

  /**
   * Set an arbitrary tracker participant as the current Combatant. This GM-only
   * escape hatch is exposed from the Combat context menu and intentionally
   * bypasses phase navigation interception.
   *
   * @param {Combat|null} [combat=game.combat] Foundry Combat document.
   * @param {string|null} combatantId Target Combatant id.
   * @returns {Promise<Combatant|null>} Selected Combatant.
   */
  static async setCurrentCombatant(combat = game.combat, combatantId = null) {
    if (!game.user?.isGM) {
      ui.notifications.warn(localize("AOV_SKJALDBORG.Warnings.GmOnly"));
      return null;
    }
    if (!combat?.started || !combatantId) return null;
    const turns = Array.from(combat.turns ?? []);
    const turn = turns.findIndex(candidate => candidate.id === combatantId);
    if (turn < 0) return null;
    const combatant = turns[turn];
    if (combat.turn !== turn) {
      const current = combat.turn == null ? -1 : Number(combat.turn);
      const direction = turn === current ? 0 : turn > current ? 1 : -1;
      await combat.update({ turn }, internalUpdateOptions("set-current-combatant", direction));
    }
    RenderCoordinator.invalidateCombatTracker("phase-set-current-combatant");
    return combatant;
  }

  /**
   * Restart the current Skjaldborg phase at the first sorted combatant without
   * changing Foundry's raw system round.
   *
   * @param {Combat} combat Foundry Combat document.
   * @returns {Promise<void>}
   */
  static async resetTurnToFirst(combat) {
    if (!combat?.started || !Array.from(combat.turns ?? []).length) return;
    if (combat.turn === 0) return;
    await combat.update({ turn: 0 }, internalUpdateOptions("phase-reset"));
  }

  /**
   * Set the status of a queued action.
   *
   * @param {Combat} combat Foundry Combat document.
   * @param {string} actionId Resolution action id.
   * @param {"pending"|"active"|"resolved"|"skipped"|"carryover"} [status="resolved"] New action status.
   * @returns {Promise<boolean>}
   */
  static async setActionStatus(combat, actionId, status = RESOLUTION_STATUS.RESOLVED) {
    if (!game.user.isGM) {
      ui.notifications.warn(localize("AOV_SKJALDBORG.Warnings.GmOnly"));
      return false;
    }
    const updated = await setActionStatus(combat, actionId, status);
    const outcomeStatuses = new Set([
      RESOLUTION_STATUS.RESOLVED,
      RESOLUTION_STATUS.SKIPPED,
      RESOLUTION_STATUS.CARRYOVER
    ]);
    if (updated && !isPhaseEnabled(PHASES.BOOKKEEPING) && outcomeStatuses.has(status)) {
      const state = getCombatState(combat);
      const ledger = bookkeepingLedgerFromQueue(state.resolutionQueue ?? []);
      await updateCombatState(combat, { bookkeepingLedger: ledger });
      const action = (state.resolutionQueue ?? []).find(candidate => candidate.id === actionId) ?? null;
      Hooks.callAll?.("aovSkjaldborgImmediateBookkeeping", combat, ledger, {
        phase: state.phase,
        reason: "resolution-outcome",
        action
      });
    }
    RenderCoordinator.invalidateCombatTracker("phase-reset");
    return updated;
  }

  /**
   * Seed carryover actions into next round declarations after round reset.
   *
   * @param {Combat} combat Foundry Combat document.
   * @param {import("../types.mjs").SkjaldborgResolutionAction[]} carryover Carryover actions.
   * @returns {Promise<unknown[]>}
   */
  static async applyCarryoverToNextRound(combat, carryover) {
    const byCombatant = new Map();
    for (const action of carryover) {
      if (!action.combatantId) continue;
      if (!byCombatant.has(action.combatantId)) byCombatant.set(action.combatantId, []);
      byCombatant.get(action.combatantId).push(action);
    }

    const updates = [];
    for (const [combatantId, actions] of byCombatant.entries()) {
      const combatant = combat.combatants.get(combatantId);
      if (!combatant) continue;
      const first = actions[0];
      updates.push(updateCombatantState(combatant, {
        intent: {
          status: "committed",
          actionCategory: first.actionCategory ?? "other",
          publicText: game.i18n.localize("AOV_SKJALDBORG.Actions.Carryover"),
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
        scheduledActions: actions
      }));
    }
    return Promise.all(updates);
  }
}
