import { ENGAGEMENT_STATUS, MOVEMENT_DEBUG_CATEGORIES, MOVEMENT_DEBUG_LEVELS } from "../constants.mjs";
import { AoVAdapter } from "../adapter/aov-adapter.mjs";
import { warn } from "../logger.mjs";
import { removeEngagementPartners } from "./engagement-links.mjs";
import { syncEngagedStatusEffect } from "./engagement-status.mjs";
import { getCombatantState, updateCombatantState } from "./state.mjs";
import {
  areOpposingDispositions,
  measureOccupiedGridSeparation,
  reachUnitsForCombatant,
  tokenSourceGridRect
} from "./movement-controller.mjs";
import { movementDebug, movementDebugWarn } from "./movement-debugger.mjs";
import { RenderCoordinator } from "../ui/render-coordinator.mjs";

const reconciliationLocks = new Map();

function combatantValues(combat) {
  return Array.from(combat?.combatants ?? []).map(entry => Array.isArray(entry) ? entry[1] : entry);
}

function combatantById(combat, id) {
  return combat?.combatants?.get?.(id) ?? combatantValues(combat).find(candidate => candidate?.id === id) ?? null;
}

function pairKey(first, second) {
  return [String(first?.id ?? ""), String(second?.id ?? "")].sort().join("::");
}

function tokenDocumentForCombatant(combatant) {
  return combatant?.token?.object?.document
    ?? combatant?.token?.document
    ?? combatant?.token
    ?? canvas?.scene?.tokens?.get?.(combatant?.tokenId)
    ?? combatant?.parent?.scene?.tokens?.get?.(combatant?.tokenId)
    ?? game.scenes?.get?.(combatant?.sceneId)?.tokens?.get?.(combatant?.tokenId)
    ?? null;
}

function activePartnerIds(combatant) {
  const engagement = getCombatantState(combatant).engagement ?? {};
  if (engagement.status !== ENGAGEMENT_STATUS.ENGAGED || engagement.engaged !== true) return [];
  return Array.from(new Set((engagement.partnerIds ?? []).filter(Boolean)));
}

function staleEngagementReason(combat, first, second) {
  if (!second) return "missing-partner";
  if (!AoVAdapter.isCombatantCapable(first) || !AoVAdapter.isCombatantCapable(second)) return "incapable";

  const firstToken = tokenDocumentForCombatant(first);
  const secondToken = tokenDocumentForCombatant(second);
  if (!firstToken || !secondToken) return "missing-token";
  if (!areOpposingDispositions(firstToken.disposition, secondToken.disposition)) return "non-opposing";

  const firstRect = tokenSourceGridRect(firstToken);
  const secondRect = tokenSourceGridRect(secondToken);
  const separation = measureOccupiedGridSeparation(firstRect, secondRect);
  const threshold = Math.max(reachUnitsForCombatant(first), reachUnitsForCombatant(second));
  const inReach = Number.isFinite(separation) && Number.isFinite(threshold) && separation <= threshold;

  movementDebug(MOVEMENT_DEBUG_CATEGORIES.ENGAGEMENT, "stale-engagement-reach-check", () => ({
    firstCombatantId: first?.id ?? null,
    secondCombatantId: second?.id ?? null,
    firstTokenId: firstToken?.id ?? firstToken?._id ?? null,
    secondTokenId: secondToken?.id ?? secondToken?._id ?? null,
    firstRect,
    secondRect,
    firstReach: reachUnitsForCombatant(first),
    secondReach: reachUnitsForCombatant(second),
    threshold,
    separation,
    inReach
  }), { combatId: combat?.id ?? null, combatantId: first?.id ?? null, level: MOVEMENT_DEBUG_LEVELS.TRACE });

  if (!Number.isFinite(separation) || !Number.isFinite(threshold)) return "invalid-reach";
  return inReach ? "" : "out-of-reach";
}

async function writeEngagement(combat, combatant, engagement) {
  await updateCombatantState(combatant, { engagement });
  await syncEngagedStatusEffect(combatant, engagement, combat);
}

async function clearStalePair(combat, first, second, reason) {
  const secondId = second?.id ?? null;
  const firstState = getCombatantState(first);
  const firstPartners = activePartnerIds(first);
  const firstTargets = secondId ? [secondId] : firstPartners;
  await writeEngagement(combat, first, removeEngagementPartners(firstState.engagement, firstTargets, reason));

  if (second) {
    const secondState = getCombatantState(second);
    await writeEngagement(combat, second, removeEngagementPartners(secondState.engagement, [first.id], reason));
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
    for (const combatant of combatantValues(combat)) {
      const partners = activePartnerIds(combatant);
      for (const partnerId of partners) {
        const partner = combatantById(combat, partnerId);
        const key = pairKey(combatant, partner ?? { id: partnerId });
        if (checked.has(key)) continue;
        checked.add(key);
        const staleReason = staleEngagementReason(combat, combatant, partner);
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
    if (cleared) RenderCoordinator.invalidateCombatTracker(`engagement-reconciled-${reason}`);
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
