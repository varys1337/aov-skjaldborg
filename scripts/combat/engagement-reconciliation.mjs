import { ENGAGEMENT_STATUS, MODULE_ID, MOVEMENT_DEBUG_CATEGORIES, MOVEMENT_DEBUG_LEVELS } from "../constants.mjs";
import { AoVAdapter } from "../adapter/aov-adapter.mjs";
import { warn } from "../logger.mjs";
import { removeEngagementPartners } from "./engagement-links.mjs";
import { syncEngagementVisuals } from "./engagement-status.mjs";
import { getCombatantState, updateCombatantStates } from "./state.mjs";
import {
  areOpposingDispositions,
  buildEngagementSnapshot,
  effectiveEngagementReachThreshold,
  measureOccupiedGridSeparation,
  reachUnitsForCombatant,
  tokenSourceGridRect
} from "./movement-controller.mjs";
import { movementEngagementEligibility } from "./movement-eligibility.mjs";
import { combatantById, combatantValues, tokenDocumentForCombatant } from "./combatant-token-resolution.mjs";
import { movementDebug, movementDebugWarn } from "./movement-debugger.mjs";
import { RenderCoordinator } from "../ui/render-coordinator.mjs";

const reconciliationLocks = new Map();

function pairKey(first, second) {
  return [String(first?.id ?? ""), String(second?.id ?? "")].sort().join("::");
}

function activePartnerIds(combatant) {
  const engagement = getCombatantState(combatant).engagement ?? {};
  if (engagement.status !== ENGAGEMENT_STATUS.ENGAGED || engagement.engaged !== true) return [];
  return Array.from(new Set((engagement.partnerIds ?? []).filter(Boolean)));
}

function cachedToken(scan, combatant) {
  return scan?.tokenByCombatantId?.get?.(combatant?.id) ?? tokenDocumentForCombatant(combatant);
}

function cachedRect(scan, combatant, token) {
  return scan?.rectByCombatantId?.get?.(combatant?.id) ?? tokenSourceGridRect(token);
}

function cachedReach(scan, combatant) {
  return scan?.reachByCombatantId?.get?.(combatant?.id) ?? reachUnitsForCombatant(combatant);
}

function cachedEngagementEligibility(scan, combatant) {
  const state = scan?.stateById?.get?.(combatant?.id) ?? getCombatantState(combatant);
  return movementEngagementEligibility(combatant, state?.movement?.distance);
}

function staleEngagementReason(combat, first, second, scan = null) {
  if (!second) return "missing-partner";
  if (!AoVAdapter.isCombatantCapable(first) || !AoVAdapter.isCombatantCapable(second)) return "incapable";

  const firstToken = cachedToken(scan, first);
  const secondToken = cachedToken(scan, second);
  if (!firstToken || !secondToken) return "missing-token";
  if (!areOpposingDispositions(firstToken.disposition, secondToken.disposition)) return "non-opposing";

  const firstRect = cachedRect(scan, first, firstToken);
  const secondRect = cachedRect(scan, second, secondToken);
  const separation = measureOccupiedGridSeparation(firstRect, secondRect);
  const firstReach = cachedReach(scan, first);
  const secondReach = cachedReach(scan, second);
  const firstEligibility = cachedEngagementEligibility(scan, first);
  const secondEligibility = cachedEngagementEligibility(scan, second);
  const pairEligibility = {
    firstEligibility: {
      canEngage: firstEligibility.canEngage,
      movedGridUnits: firstEligibility.gridUnits,
      limitGridUnits: firstEligibility.limit
    },
    secondEligibility: {
      canEngage: secondEligibility.canEngage,
      movedGridUnits: secondEligibility.gridUnits,
      limitGridUnits: secondEligibility.limit
    }
  };
  const { rawThreshold, effectiveThreshold, threshold } = effectiveEngagementReachThreshold(firstReach, secondReach, pairEligibility);
  const inReach = Number.isFinite(separation) && Number.isFinite(threshold) && separation <= threshold;

  movementDebug(MOVEMENT_DEBUG_CATEGORIES.ENGAGEMENT, "stale-engagement-reach-check", () => ({
    firstCombatantId: first?.id ?? null,
    secondCombatantId: second?.id ?? null,
    firstTokenId: firstToken?.id ?? firstToken?._id ?? null,
    secondTokenId: secondToken?.id ?? secondToken?._id ?? null,
    firstRect,
    secondRect,
    distanceMetric: firstRect?.metric === "gridless-pixels" || secondRect?.metric === "gridless-pixels" ? "gridless-edge-euclidean" : "grid-chebyshev",
    firstReach,
    secondReach,
    rawThreshold,
    effectiveThreshold,
    threshold,
    firstEligibility: pairEligibility.firstEligibility,
    secondEligibility: pairEligibility.secondEligibility,
    separation,
    inReach
  }), { combatId: combat?.id ?? null, combatantId: first?.id ?? null, level: MOVEMENT_DEBUG_LEVELS.TRACE });

  if (!Number.isFinite(separation) || !Number.isFinite(threshold)) return "invalid-reach";
  return inReach ? "" : "out-of-reach";
}

async function clearStalePair(combat, first, second, reason) {
  const secondId = second?.id ?? null;
  const firstState = getCombatantState(first);
  const firstPartners = activePartnerIds(first);
  const firstTargets = secondId ? [secondId] : firstPartners;
  const updates = [];
  const effectSyncs = [];
  const firstEngagement = removeEngagementPartners(firstState.engagement, firstTargets, reason);
  updates.push([first, { engagement: firstEngagement }]);
  effectSyncs.push([first, firstEngagement]);

  if (second) {
    const secondState = getCombatantState(second);
    const secondEngagement = removeEngagementPartners(secondState.engagement, [first.id], reason);
    updates.push([second, { engagement: secondEngagement }]);
    effectSyncs.push([second, secondEngagement]);
  }

  await updateCombatantStates(combat, updates, { [MODULE_ID]: { reason: "stale-engagement-clear" } });
  for (const [combatant, engagement] of effectSyncs) {
    await syncEngagementVisuals(combatant, engagement, combat);
  }

  movementDebug(MOVEMENT_DEBUG_CATEGORIES.ENGAGEMENT, "stale-engagement-cleared", () => ({
    firstCombatantId: first?.id ?? null,
    secondCombatantId: second?.id ?? null,
    reason
  }), { combatId: combat?.id ?? null, combatantId: first?.id ?? null, level: MOVEMENT_DEBUG_LEVELS.VERBOSE });
}

/**
 * Reconcile live engagement pairs with current token position, reach, and
 * combatant capability.
 *
 * Engagement flags are latched during movement to stop movement and show a
 * status marker. At phase boundaries the current battlefield state is checked
 * again so pairs that have moved out of weapon reach, lost an opponent, or
 * contain a defeated/unconscious combatant no longer remain visually engaged.
 *
 * @param {Combat|null} combat Active combat.
 * @param {{reason?: string}} [options={}] Reconciliation options.
 * @returns {Promise<number>} Number of stale engagement pairs cleared.
 */
export async function pruneStaleEngagements(combat, { reason = "phase-end" } = {}) {
  if (!game.user?.isGM || !combat) return 0;
  const lockKey = `${combat.id}:${reason}`;
  if (reconciliationLocks.has(lockKey)) return reconciliationLocks.get(lockKey);

  const operation = (async () => {
    const checked = new Set();
    let cleared = 0;
    const scan = buildEngagementSnapshot(combat, { includeStationary: true });
    for (const combatant of combatantValues(combat)) {
      const partners = activePartnerIds(combatant);
      for (const partnerId of partners) {
        const partner = combatantById(combat, partnerId);
        const key = pairKey(combatant, partner ?? { id: partnerId });
        if (checked.has(key)) continue;
        checked.add(key);
        const staleReason = staleEngagementReason(combat, combatant, partner, scan);
        if (!staleReason) continue;
        try {
          await clearStalePair(combat, combatant, partner, staleReason);
          cleared += 1;
        }
        catch (exception) {
          warn(exception);
          movementDebugWarn(MOVEMENT_DEBUG_CATEGORIES.ENGAGEMENT, "stale-engagement-clear-failed", () => ({
            combatantId: combatant?.id ?? null,
            partnerId,
            reason: staleReason,
            error: String(exception?.message ?? exception)
          }), { combatId: combat?.id ?? null, combatantId: combatant?.id ?? null });
        }
      }
    }
    if (cleared) RenderCoordinator.invalidateCombatTracker(`engagement-reconciled-${reason}`, { parts: ["rows"] });
    movementDebug(MOVEMENT_DEBUG_CATEGORIES.ENGAGEMENT, "stale-engagement-reconciliation-summary", () => ({
      reason,
      checked: checked.size,
      cleared
    }), { combatId: combat?.id ?? null, level: cleared ? MOVEMENT_DEBUG_LEVELS.SUMMARY : MOVEMENT_DEBUG_LEVELS.VERBOSE });
    return cleared;
  })().finally(() => {
    if (reconciliationLocks.get(lockKey) === operation) reconciliationLocks.delete(lockKey);
  });

  reconciliationLocks.set(lockKey, operation);
  return operation;
}

export const __test = {
  staleEngagementReason
};
