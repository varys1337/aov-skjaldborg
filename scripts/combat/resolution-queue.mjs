import { AoVAdapter } from "../adapter/aov-adapter.mjs";
import { INTENT_STATUS, MODULE_ID, RESOLUTION_STATUS } from "../constants.mjs";
import { buildScheduledActions, computeDexLedger } from "./dex-ledger.mjs";
import {
  getCombatState,
  getCombatantState,
  updateCombatState,
  updateCombatantState
} from "./state.mjs";

/** @type {Map<string, Promise<unknown>>} */
const immediateQueueLocks = new Map();

/**
 * Group queue actions by exact DEX and INT.
 *
 * @param {import("../types.mjs").SkjaldborgResolutionAction} action Resolution action.
 * @returns {string}
 */
function groupKey(action) {
  return `${action.dex}:${action.int}`;
}

/**
 * Sort actions in AoV DEX/INT resolution order.
 *
 * @param {import("../types.mjs").SkjaldborgResolutionAction[]} queue Actions to sort.
 * @returns {import("../types.mjs").SkjaldborgResolutionAction[]}
 */
function sortQueue(queue) {
  return queue.sort((a, b) => (
    (b.dex - a.dex)
    || (b.int - a.int)
    || a.actorName.localeCompare(b.actorName)
    || a.id.localeCompare(b.id)
  ));
}

/**
 * Return whether a projected initiative materially differs from the value
 * already stored on the embedded Combatant. Avoiding no-op writes prevents a
 * completed Movement projection from firing a second identical update when
 * Resolution immediately builds its action queue.
 *
 * @param {Combatant} combatant Foundry Combatant document.
 * @param {number|null} projectedInitiative Projected AoV DEX.INT initiative.
 * @returns {boolean}
 */
function requiresInitiativeUpdate(combatant, projectedInitiative) {
  if (!Number.isFinite(projectedInitiative)) return false;
  const current = Number(combatant?.initiative);
  return !Number.isFinite(current) || Math.abs(current - projectedInitiative) > 0.000001;
}

/**
 * Rebuild exact-DEX simultaneous groups for a queue.
 *
 * @param {import("../types.mjs").SkjaldborgResolutionAction[]} queue Resolution queue.
 * @returns {import("../types.mjs").SkjaldborgSimultaneousGroup[]}
 */
function buildSimultaneousGroups(queue) {
  for (const action of queue) delete action.groupId;

  const grouped = new Map();
  for (const action of queue) {
    const key = groupKey(action);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(action);
  }

  const simultaneousGroups = [];
  let groupIndex = 1;
  for (const [key, actions] of grouped.entries()) {
    if (actions.length < 2) continue;
    const groupId = `sim-${groupIndex}`;
    for (const action of actions) action.groupId = groupId;
    const [dex, int] = key.split(":").map(Number);
    const statuses = new Set(actions.map(action => action.status));
    let status = RESOLUTION_STATUS.PENDING;
    if (statuses.size === 1) status = actions[0].status;
    else if (statuses.has(RESOLUTION_STATUS.ACTIVE)) status = RESOLUTION_STATUS.ACTIVE;
    else if (statuses.has(RESOLUTION_STATUS.CARRYOVER)) status = RESOLUTION_STATUS.CARRYOVER;

    simultaneousGroups.push({
      id: groupId,
      dex,
      int,
      actionIds: actions.map(action => action.id),
      status
    });
    groupIndex += 1;
  }
  return simultaneousGroups;
}

/**
 * Return whether a combatant has announced an actionable declaration.
 *
 * @param {import("../types.mjs").SkjaldborgCombatantState} state Combatant state.
 * @returns {boolean}
 */
function hasAnnouncedIntent(state) {
  return [INTENT_STATUS.COMMITTED, INTENT_STATUS.HELD].includes(state?.intent?.status);
}

/**
 * Serialize immediate queue reconstruction for one Combat. Player declarations
 * for different Combatants may arrive at the GM concurrently, but Combat flags
 * are persisted as one object and therefore require one authoritative merge.
 *
 * @template T
 * @param {Combat} combat Foundry Combat document.
 * @param {() => Promise<T>} operation Queue update.
 * @returns {Promise<T>}
 */
function enqueueImmediateQueueWrite(combat, operation) {
  const key = combat?.uuid ?? combat?.id;
  if (!key) return operation();
  const previous = immediateQueueLocks.get(key) ?? Promise.resolve();
  let current;
  current = previous
    .catch(() => undefined)
    .then(operation)
    .finally(() => {
      if (immediateQueueLocks.get(key) === current) immediateQueueLocks.delete(key);
    });
  immediateQueueLocks.set(key, current);
  return current;
}

/**
 * Await any current Streamlined Combat queue update for a Combat.
 *
 * @param {Combat|null|undefined} combat Foundry Combat document.
 * @returns {Promise<void>}
 */
export async function settleImmediateResolutionWrites(combat) {
  const key = combat?.uuid ?? combat?.id;
  if (!key) return;
  while (immediateQueueLocks.has(key)) {
    await Promise.allSettled([immediateQueueLocks.get(key)]);
  }
}

/**
 * Build and persist all per-combatant DEX ledgers and scheduled actions.
 *
 * The returned queue is independent from Foundry's `Combat.turns`. Primary
 * projected initiatives are written back to the AoV tracker for display only.
 *
 * @param {Combat} combat Foundry Combat document.
 * @param {{announcedOnly?: boolean}} [options={}] Queue construction policy.
 * @returns {Promise<{queue: import("../types.mjs").SkjaldborgResolutionAction[], simultaneousGroups: import("../types.mjs").SkjaldborgSimultaneousGroup[], carryover: import("../types.mjs").SkjaldborgResolutionAction[]}>}
 */
export async function buildResolutionQueue(combat, { announcedOnly = false } = {}) {
  const queue = [];
  const carryover = [];
  const initiativeUpdates = [];
  const combatantUpdates = [];

  for (const combatant of combat.combatants) {
    if (!AoVAdapter.isCombatantCapable(combatant)) continue;
    const state = getCombatantState(combatant);
    if (announcedOnly && !hasAnnouncedIntent(state)) continue;
    const ledger = computeDexLedger(combatant, state);
    const actions = buildScheduledActions(combatant, state, ledger);
    for (const action of actions) {
      if (action.carryover) carryover.push(action);
      else queue.push(action);
    }
    combatantUpdates.push(updateCombatantState(combatant, {
      dexLedger: ledger,
      scheduledActions: actions,
      activeGroupId: null
    }));
    if (requiresInitiativeUpdate(combatant, ledger.projectedInitiative)) {
      initiativeUpdates.push({ _id: combatant.id, initiative: ledger.projectedInitiative });
    }
  }

  sortQueue(queue);
  for (const action of queue) action.status = RESOLUTION_STATUS.PENDING;
  const simultaneousGroups = buildSimultaneousGroups(queue);

  await Promise.all(combatantUpdates);
  if (initiativeUpdates.length && game.user.isGM) {
    await combat.updateEmbeddedDocuments("Combatant", initiativeUpdates, { turnEvents: false, combatTurn: combat.turn });
  }

  return { queue, simultaneousGroups, carryover };
}

/**
 * Apply the Movement-stage DEX projection after every planned token has reached
 * a terminal movement state. At this point each movement distance represents
 * measured travel rather than a declared route, so the tracker can safely be
 * re-ranked before Resolution begins.
 *
 * This operation updates only the per-combatant DEX ledger and displayed AoV
 * initiative. Resolution actions are built separately when Resolution starts,
 * leaving a clean boundary for later Resolution hooks or rules effects.
 *
 * @param {Combat} combat Foundry Combat document.
 * @returns {Promise<import("../types.mjs").SkjaldborgDexLedger[]>} Applied ledgers.
 */
export async function applyMovementDexResults(combat) {
  const ledgers = [];
  const initiativeUpdates = [];
  const combatantUpdates = [];

  for (const combatant of combat?.combatants ?? []) {
    if (!AoVAdapter.isCombatantCapable(combatant)) continue;
    const state = getCombatantState(combatant);
    const ledger = computeDexLedger(combatant, state, { includeMovementPenalty: true });
    ledgers.push(ledger);
    combatantUpdates.push(updateCombatantState(combatant, { dexLedger: ledger }));
    if (requiresInitiativeUpdate(combatant, ledger.projectedInitiative)) {
      initiativeUpdates.push({ _id: combatant.id, initiative: ledger.projectedInitiative });
    }
  }

  await Promise.all(combatantUpdates);
  if (initiativeUpdates.length && game.user?.isGM) {
    await combat.updateEmbeddedDocuments("Combatant", initiativeUpdates, {
      turnEvents: false,
      combatTurn: combat.turn,
      [MODULE_ID]: { movementDexProjection: true }
    });
  }

  return ledgers;
}

/**
 * Immediately insert or replace one combatant's announced action in the live
 * Resolution queue. This is the announce-and-act bridge used when Statement is
 * omitted by Streamlined Combat. A movement refresh may preserve an already
 * assigned action status while recalculating its DEX from actual travel.
 *
 * @param {Combat} combat Foundry Combat document.
 * @param {Combatant} combatant Declaring combatant.
 * @param {{preserveStatus?: boolean}} [options={}] Merge policy.
 * @returns {Promise<import("../types.mjs").SkjaldborgCombatState>}
 */
export function refreshImmediateResolutionActions(combat, combatant, { preserveStatus = false } = {}) {
  return enqueueImmediateQueueWrite(combat, async () => {
    const combatantState = getCombatantState(combatant);
    const ledger = computeDexLedger(combatant, combatantState);
    const scheduledActions = hasAnnouncedIntent(combatantState)
      ? buildScheduledActions(combatant, combatantState, ledger)
      : [];

    const combatState = getCombatState(combat);
    const existingQueue = foundry.utils.deepClone(combatState.resolutionQueue ?? []);
    const existingById = new Map(existingQueue
      .filter(action => action.combatantId === combatant.id)
      .map(action => [action.id, action]));
    const queue = existingQueue.filter(action => action.combatantId !== combatant.id);

    const carryover = foundry.utils.deepClone(combatState.carryover ?? [])
      .filter(action => action.combatantId !== combatant.id);

    for (const action of scheduledActions) {
      if (action.carryover) {
        action.status = RESOLUTION_STATUS.CARRYOVER;
        carryover.push(action);
        continue;
      }
      const previous = existingById.get(action.id);
      action.status = preserveStatus && previous?.status
        ? previous.status
        : RESOLUTION_STATUS.PENDING;
      if (action.status === RESOLUTION_STATUS.CARRYOVER) {
        carryover.push({ ...action, carryover: true });
      }
      queue.push(action);
    }

    sortQueue(queue);
    const simultaneousGroups = buildSimultaneousGroups(queue);
    await updateCombatantState(combatant, {
      dexLedger: ledger,
      scheduledActions,
      activeGroupId: null
    });

    if (requiresInitiativeUpdate(combatant, ledger.projectedInitiative) && game.user?.isGM) {
      await combat.updateEmbeddedDocuments("Combatant", [{
        _id: combatant.id,
        initiative: ledger.projectedInitiative
      }], { turnEvents: false, combatTurn: combat.turn });
    }

    return updateCombatState(combat, {
      resolutionQueue: queue,
      simultaneousGroups,
      carryover
    });
  });
}

/**
 * Recalculate every capable combatant's immediate action after movement or other
 * shared DEX changes. Existing outcome statuses can be retained while numeric
 * ordering and simultaneous groups are rebuilt.
 *
 * @param {Combat} combat Foundry Combat document.
 * @param {{preserveStatus?: boolean}} [options={}] Merge policy.
 * @returns {Promise<void>}
 */
export async function refreshAllImmediateResolutionActions(combat, { preserveStatus = false } = {}) {
  for (const combatant of combat?.combatants ?? []) {
    if (!AoVAdapter.isCombatantCapable(combatant)) continue;
    await refreshImmediateResolutionActions(combat, combatant, { preserveStatus });
  }
}

/**
 * Update the status of a single queued action and synchronize group/carryover state.
 *
 * @param {Combat} combat Foundry Combat document.
 * @param {string} actionId Resolution action id.
 * @param {"pending"|"active"|"resolved"|"skipped"|"carryover"} status New action status.
 * @returns {Promise<boolean>} Whether an action was found and updated.
 */
export function setActionStatus(combat, actionId, status) {
  return enqueueImmediateQueueWrite(combat, async () => {
    const state = combat.getFlag(MODULE_ID, "combatState") ?? {};
    const queue = foundry.utils.deepClone(state.resolutionQueue ?? []);
    let carryover = foundry.utils.deepClone(state.carryover ?? []);
    const action = queue.find(a => a.id === actionId);
    if (!action) return false;

    if (status === RESOLUTION_STATUS.ACTIVE) {
      for (const queued of queue) {
        if (queued.status === RESOLUTION_STATUS.ACTIVE) queued.status = RESOLUTION_STATUS.PENDING;
      }
    }

    action.status = status;
    carryover = carryover.filter(candidate => candidate.id !== action.id);
    if (status === RESOLUTION_STATUS.CARRYOVER) {
      carryover.push({ ...action, carryover: true });
    }
    const simultaneousGroups = buildSimultaneousGroups(queue);

    await combat.setFlag(MODULE_ID, "combatState", {
      ...state,
      resolutionQueue: queue,
      simultaneousGroups,
      carryover,
      updatedAt: Date.now()
    });
    return true;
  });
}
