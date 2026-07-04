import { DEFENSE_REACTION_STEP, MODULE_ID } from "../constants.mjs";
import { AoVAdapter } from "../adapter/aov-adapter.mjs";
import { alwaysShowIconMode, effectIsActive, moduleFlag } from "../compat/active-effects.mjs";
import { warn } from "../logger.mjs";
import { RenderCoordinator } from "../ui/render-coordinator.mjs";

const REACTION_EFFECT_FLAG = "managedReactionPenalty";
const REACTION_EFFECT_DATA_FLAG = "reactionPenalty";
const REACTION_EFFECT_ICON = "icons/svg/shield.svg";
const PARRY_BONUS_KEY = "system.parryBonus";
const DODGE_EFFECTS_KEY = "system.cidFlagItems.i.skill.dodge.system.effects";
const cleanupLocks = new Map();
let hooksRegistered = false;

/**
 * Resolve the represented Actor for a Combatant.
 *
 * @param {Combatant|object|null} combatant Combatant document.
 * @returns {Actor|object|null}
 */
export function reactionActorForCombatant(combatant) {
  return combatant?.token?.actor
    ?? combatant?.token?.object?.actor
    ?? combatant?.actor
    ?? null;
}

/**
 * Derive the RAW cumulative next-reaction penalty from reactions already used.
 *
 * @param {number} reactionCount Reactions already used this logical round.
 * @returns {number}
 */
export function reactionPenaltyForCount(reactionCount) {
  return Math.max(0, Math.trunc(Number(reactionCount) || 0)) * DEFENSE_REACTION_STEP;
}

/**
 * Whether a candidate ActiveEffect is the module-owned reaction penalty effect.
 *
 * @param {ActiveEffect|object|null} effect Candidate effect.
 * @returns {boolean}
 */
export function isReactionPenaltyEffect(effect) {
  return moduleFlag(effect, REACTION_EFFECT_FLAG) === true;
}

/**
 * Return all module-owned reaction penalty effects on an Actor.
 *
 * @param {Actor|object|null} actor Actor document.
 * @returns {(ActiveEffect|object)[]}
 */
export function reactionPenaltyEffectsForActor(actor) {
  return Array.from(actor?.effects ?? []).filter(isReactionPenaltyEffect);
}

/**
 * Read reaction penalty metadata from an ActiveEffect.
 *
 * @param {ActiveEffect|object|null} effect Candidate effect.
 * @returns {object|null}
 */
function reactionPenaltyEffectData(effect) {
  const data = moduleFlag(effect, REACTION_EFFECT_DATA_FLAG) ?? null;
  return data && typeof data === "object" ? data : null;
}

/**
 * Build AoV-native mechanical effect changes.
 *
 * @param {number} penalty Negative penalty value.
 * @returns {object[]}
 */
function reactionEffectChanges(penalty) {
  const mode = globalThis.CONST?.ACTIVE_EFFECT_MODES?.ADD ?? 2;
  return [
    {
      key: PARRY_BONUS_KEY,
      mode,
      type: "add",
      value: penalty
    },
    {
      key: DODGE_EFFECTS_KEY,
      mode,
      type: "add",
      value: penalty
    }
  ];
}

/**
 * Build module metadata stored on the reaction penalty effect.
 *
 * @param {Combat|null} combat Active combat.
 * @param {Combatant|object|null} combatant Combatant document.
 * @param {number} reactionCount Used reaction count.
 * @param {number} penalty Derived penalty.
 * @returns {object}
 */
function reactionEffectData(combat, combatant, reactionCount, penalty) {
  return {
    combatId: combat?.id ?? combatant?.parent?.id ?? null,
    combatantId: combatant?.id ?? null,
    actorId: combatant?.actorId ?? combatant?.actor?.id ?? null,
    actorUuid: reactionActorForCombatant(combatant)?.uuid ?? combatant?.actor?.uuid ?? null,
    logicalRound: AoVAdapter.getSystemLogicalRound(combat),
    reactionCount,
    penalty,
    updatedAt: Date.now()
  };
}

/**
 * Delete all module-owned reaction penalty effects from one Actor.
 *
 * @param {Actor|object|null} actor Actor document.
 * @returns {Promise<number>} Number of deleted effects.
 */
export async function deleteReactionPenaltyEffectsForActor(actor) {
  let removed = 0;
  for (const effect of reactionPenaltyEffectsForActor(actor)) {
    if (typeof effect?.delete !== "function") continue;
    try {
      await effect.delete();
      removed += 1;
    } catch (exception) {
      warn(exception);
    }
  }
  return removed;
}

/**
 * Delete duplicate reaction effects after a primary effect has been updated.
 *
 * @param {Actor|object|null} actor Actor document.
 * @param {ActiveEffect|object|null} primary Primary effect to keep.
 * @returns {Promise<void>}
 */
async function deleteDuplicateReactionPenaltyEffects(actor, primary) {
  for (const duplicate of reactionPenaltyEffectsForActor(actor).filter(effect => effect && effect !== primary)) {
    if (typeof duplicate?.delete !== "function") continue;
    try {
      await duplicate.delete();
    } catch (exception) {
      warn(exception);
    }
  }
}

/**
 * Create or update the module-managed AoV reaction penalty ActiveEffect.
 *
 * @param {Combat|null} combat Active combat.
 * @param {Combatant|object|null} combatant Combatant document.
 * @param {number} reactionCount Used reaction count.
 * @returns {Promise<object|null>} Reconciliation result.
 */
export async function reconcileReactionPenaltyEffect(combat, combatant, reactionCount) {
  if (!game.user?.isGM) return null;
  const actor = reactionActorForCombatant(combatant);
  if (!actor) return null;
  const count = Math.max(0, Math.trunc(Number(reactionCount) || 0));
  const penalty = reactionPenaltyForCount(count);
  if (penalty === 0) {
    const removed = await deleteReactionPenaltyEffectsForActor(actor);
    if (removed > 0) RenderCoordinator.invalidateCombatTracker("reaction-penalty-clear");
    return { active: false, reactionCount: count, penalty, removed };
  }
  if (typeof actor.createEmbeddedDocuments !== "function") return null;

  const name = game.i18n.localize("AOV_SKJALDBORG.StatusEffects.ReactionPenalty");
  const data = reactionEffectData(combat, combatant, count, penalty);
  const changes = reactionEffectChanges(penalty);
  const updateData = {
    name,
    img: REACTION_EFFECT_ICON,
    disabled: false,
    showIcon: alwaysShowIconMode(),
    changes,
    "system.changes": changes,
    [`flags.${MODULE_ID}.${REACTION_EFFECT_FLAG}`]: true,
    [`flags.${MODULE_ID}.${REACTION_EFFECT_DATA_FLAG}`]: data
  };

  const existing = reactionPenaltyEffectsForActor(actor).find(effectIsActive)
    ?? reactionPenaltyEffectsForActor(actor)[0]
    ?? null;
  let effect = existing;
  if (effect?.update) {
    effect = await effect.update(updateData);
  } else {
    const createData = {
      name,
      img: REACTION_EFFECT_ICON,
      disabled: false,
      showIcon: alwaysShowIconMode(),
      changes,
      system: { changes },
      flags: {
        [MODULE_ID]: {
          [REACTION_EFFECT_FLAG]: true,
          [REACTION_EFFECT_DATA_FLAG]: data
        }
      }
    };
    [effect = null] = await actor.createEmbeddedDocuments("ActiveEffect", [createData]);
  }

  await deleteDuplicateReactionPenaltyEffects(actor, effect);
  RenderCoordinator.invalidateCombatTracker("reaction-penalty-sync");
  return {
    active: true,
    reactionCount: count,
    penalty,
    effectId: effect?.id ?? effect?._id ?? null
  };
}

/**
 * Remove all module-managed reaction penalty effects for combatants in a Combat.
 *
 * @param {Combat|null} combat Active combat.
 * @param {{reason?: string}} [options={}] Cleanup options.
 * @returns {Promise<number>} Number of deleted effects.
 */
export async function clearReactionPenaltyEffectsForCombat(combat, { reason = "combat-round" } = {}) {
  if (!game.user?.isGM || !combat) return 0;
  const lockKey = `${combat.id}:${reason}`;
  if (cleanupLocks.has(lockKey)) return cleanupLocks.get(lockKey);

  const operation = (async () => {
    let removed = 0;
    const seenActors = new Set();
    for (const combatant of combat.combatants ?? []) {
      const actor = reactionActorForCombatant(combatant);
      const actorKey = String(actor?.uuid ?? actor?.id ?? actor?._id ?? "");
      if (!actor || seenActors.has(actorKey)) continue;
      seenActors.add(actorKey);
      removed += await deleteReactionPenaltyEffectsForActor(actor);
    }
    if (removed > 0) RenderCoordinator.invalidateCombatTracker(`reaction-penalty-${reason}`);
    return removed;
  })().finally(() => {
    if (cleanupLocks.get(lockKey) === operation) cleanupLocks.delete(lockKey);
  });

  cleanupLocks.set(lockKey, operation);
  return operation;
}

/**
 * Remove stale reaction penalty effects whose recorded logical round is older
 * than the current AoV logical round.
 *
 * @param {Combat|null} combat Active combat.
 * @param {{reason?: string}} [options={}] Cleanup options.
 * @returns {Promise<number>} Number of deleted effects.
 */
export async function removeExpiredReactionPenaltyEffects(combat, { reason = "combat-round" } = {}) {
  if (!game.user?.isGM || !combat) return 0;
  const currentRound = AoVAdapter.getSystemLogicalRound(combat);
  let removed = 0;
  const seenActors = new Set();
  for (const combatant of combat.combatants ?? []) {
    const actor = reactionActorForCombatant(combatant);
    const actorKey = String(actor?.uuid ?? actor?.id ?? actor?._id ?? "");
    if (!actor || seenActors.has(actorKey)) continue;
    seenActors.add(actorKey);
    for (const effect of reactionPenaltyEffectsForActor(actor)) {
      const data = reactionPenaltyEffectData(effect);
      const effectRound = Number(data?.logicalRound);
      const expired = Number.isFinite(effectRound) ? effectRound < currentRound : true;
      if (!expired || typeof effect?.delete !== "function") continue;
      try {
        await effect.delete();
        removed += 1;
      } catch (exception) {
        warn(exception);
      }
    }
  }
  if (removed > 0) RenderCoordinator.invalidateCombatTracker(`reaction-penalty-${reason}`);
  return removed;
}

/**
 * Rebuild reaction penalty effects from persisted combatant reaction counts.
 *
 * @param {Combat|null} combat Active combat.
 * @param {{reason?: string}} [options={}] Reconciliation options.
 * @returns {Promise<unknown[]>}
 */
export async function reconcileReactionPenaltyEffectsForCombat(combat, { reason = "combat-reconcile" } = {}) {
  if (!game.user?.isGM || !combat) return [];
  const operations = [];
  for (const combatant of combat.combatants ?? []) {
    const count = Number(combatant?.getFlag?.(MODULE_ID, "combatantState")?.reactionCount ?? 0);
    operations.push(reconcileReactionPenaltyEffect(combat, combatant, count));
  }
  const results = await Promise.all(operations);
  RenderCoordinator.invalidateCombatTracker(`reaction-penalty-${reason}`);
  return results;
}

/**
 * Register fallback native-combat cleanup hooks.
 *
 * @returns {void}
 */
export function registerReactionPenaltyEffectHooks() {
  if (hooksRegistered) return;
  hooksRegistered = true;

  Hooks.on("combatRound", (combat, _updateData, updateOptions = {}) => {
    if (!game.user?.isGM) return;
    if (Number(updateOptions?.direction ?? 1) <= 0) return;
    void removeExpiredReactionPenaltyEffects(combat, { reason: "combat-round" });
  });

  Hooks.on("updateCombat", (combat, changed = {}, options = {}) => {
    if (!game.user?.isGM) return;
    if (!Object.prototype.hasOwnProperty.call(changed ?? {}, "round")) return;
    if (Number(options?.direction ?? 1) <= 0) return;
    void removeExpiredReactionPenaltyEffects(combat, { reason: "combat-update-round" });
  });

  Hooks.on("deleteCombatant", combatant => {
    if (!game.user?.isGM) return;
    const actor = reactionActorForCombatant(combatant);
    void deleteReactionPenaltyEffectsForActor(actor);
  });

  Hooks.on("deleteCombat", combat => {
    if (!game.user?.isGM) return;
    void clearReactionPenaltyEffectsForCombat(combat, { reason: "combat-delete" });
  });
}

export const __test = {
  DODGE_EFFECTS_KEY,
  PARRY_BONUS_KEY,
  reactionEffectChanges,
  reactionEffectData,
  reactionPenaltyEffectData
};
