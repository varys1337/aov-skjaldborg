import { ACTION_CATEGORIES, EVADING_STATUS_ID, MODULE_ID } from "../constants.mjs";
import { runtimeSettings } from "../runtime-settings.mjs";
import { AoVAdapter } from "../adapter/aov-adapter.mjs";
import {
  canMirrorActorStatusEffect,
  effectHasStatus,
  effectIsActive,
  moduleFlag,
  registerStatusEffect,
  safeDeleteActiveEffect,
  statusEffectConfig,
  upsertActorStatusEffect
} from "../compat/active-effects.mjs";
import { RenderCoordinator } from "../ui/render-coordinator.mjs";
import { warn } from "../logger.mjs";

export const EVADE_MODES = Object.freeze({
  RANGED: "ranged",
  FIGHTING_DEFENSIVELY: "fighting-defensively"
});

export const EVADE_ATTACK_SCOPES = Object.freeze({
  RANGED: "ranged-attacks",
  ALL: "all-attacks"
});

const EVADING_EFFECT_NAME = "AOV_SKJALDBORG.StatusEffects.Evading";
const EVADING_EFFECT_ICON = "icons/svg/wingfoot.svg";
const ROUND_CLEANUP_REASONS = new Set(["combat-round", "combat-update-round"]);
const cleanupLocks = new Map();
let statusEffectMode = "unknown";
let hooksRegistered = false;

/**
 * Return the configured Evading status-effect definition.
 *
 * @returns {object}
 */
export function evadingStatusEffectConfig() {
  return statusEffectConfig(EVADING_STATUS_ID, EVADING_EFFECT_NAME, EVADING_EFFECT_ICON);
}

/**
 * Register the module-owned Evading status with Foundry's status-effect catalog.
 *
 * @returns {object|null}
 */
export function registerEvadingStatusEffect() {
  const result = registerStatusEffect(evadingStatusEffectConfig(), {
    warning: "Unable to register the Evading status effect in CONFIG.statusEffects"
  });
  statusEffectMode = result.mode;
  return result.config;
}

/**
 * Return the current status-effect compatibility mode.
 *
 * @returns {"unknown"|"native"|"module-fallback"|"disabled"}
 */
export function getEvadingStatusEffectMode() {
  return statusEffectMode;
}

/**
 * Whether the universal Fighting Defensively interpretation is enabled.
 *
 * @returns {boolean}
 */
export function evadeFightingDefensivelyEnabled() {
  try {
    return runtimeSettings.evadeFightingDefensively === true;
  } catch (_exception) {
    return false;
  }
}

/**
 * Resolve the current Evade tagging mode.
 *
 * @returns {"ranged"|"fighting-defensively"}
 */
export function currentEvadeMode() {
  return evadeFightingDefensivelyEnabled() ? EVADE_MODES.FIGHTING_DEFENSIVELY : EVADE_MODES.RANGED;
}

/**
 * Resolve the Actor on which the Evading ActiveEffect should be created.
 *
 * @param {Combatant|object|null} combatant Combatant document.
 * @returns {Actor|object|null}
 */
function actorForCombatant(combatant) {
  return combatant?.token?.actor
    ?? combatant?.token?.object?.actor
    ?? combatant?.actor
    ?? null;
}

/**
 * Whether a candidate effect is the module-owned Evading marker.
 *
 * @param {ActiveEffect|object|null} effect Candidate effect.
 * @returns {boolean}
 */
export function isEvadingEffect(effect) {
  return effectHasStatus(effect, EVADING_STATUS_ID)
    || moduleFlag(effect, "managedEvading") === true;
}

/**
 * Read the module's Evade metadata from an ActiveEffect.
 *
 * @param {ActiveEffect|object|null} effect Candidate effect.
 * @returns {object|null}
 */
export function evadingEffectData(effect) {
  const data = moduleFlag(effect, "evade") ?? null;
  return data && typeof data === "object" ? data : null;
}

/**
 * Return all Evading effects on an Actor.
 *
 * @param {Actor|object|null} actor Actor document.
 * @returns {(ActiveEffect|object)[]}
 */
export function evadingEffectsForActor(actor) {
  return Array.from(actor?.effects ?? []).filter(isEvadingEffect);
}

/**
 * Return the active Evading state for an Actor, suitable for later automation.
 *
 * @param {Actor|object|null} actor Actor document.
 * @returns {object|null}
 */
export function getActorEvadingState(actor) {
  const effect = evadingEffectsForActor(actor).find(effect => effectIsActive(effect)) ?? null;
  const data = evadingEffectData(effect);
  return data ? foundry.utils.deepClone(data) : null;
}

/**
 * Whether this runtime can mirror Evade into Actor ActiveEffects.
 *
 * @param {Actor|object|null} actor Candidate Actor.
 * @returns {boolean}
 */
function canMirrorEvadingEffect(actor) {
  return canMirrorActorStatusEffect(actor, { enabled: statusEffectMode !== "disabled" });
}

/**
 * Build persisted metadata for Evade/Fighting Defensively.
 *
 * This payload intentionally does not apply mechanical modifiers yet. It records
 * enough rule context for the later ranged-attack and all-attacks automation pass.
 *
 * @param {Combat|null} combat Active Combat.
 * @param {Combatant|object|null} combatant Declaring Combatant.
 * @returns {object}
 */
function buildEvadeData(combat, combatant) {
  const mode = currentEvadeMode();
  const logicalRound = AoVAdapter.getSystemLogicalRound(combat);
  return {
    active: true,
    sourceAction: ACTION_CATEGORIES.DEFEND,
    mode,
    attackScope: mode === EVADE_MODES.FIGHTING_DEFENSIVELY
      ? EVADE_ATTACK_SCOPES.ALL
      : EVADE_ATTACK_SCOPES.RANGED,
    rangedOnly: mode === EVADE_MODES.RANGED,
    fightingDefensively: mode === EVADE_MODES.FIGHTING_DEFENSIVELY,
    rangedAttackPenalty: -40,
    movementAnglePenaltyStacks: true,
    halfMove: true,
    forfeitsActions: true,
    freeDodgeWithoutIncreasingReactionPenalty: mode === EVADE_MODES.FIGHTING_DEFENSIVELY,
    combatId: combat?.id ?? combatant?.parent?.id ?? null,
    combatantId: combatant?.id ?? null,
    tokenId: combatant?.tokenId ?? combatant?.token?.id ?? null,
    tokenUuid: combatant?.token?.uuid ?? combatant?.token?.document?.uuid ?? null,
    actorId: combatant?.actorId ?? combatant?.actor?.id ?? null,
    actorUuid: actorForCombatant(combatant)?.uuid ?? combatant?.actor?.uuid ?? null,
    declaredRound: logicalRound,
    expiresAtLogicalRound: Number.isFinite(logicalRound) ? logicalRound + 1 : null,
    declaredAt: Date.now()
  };
}

/**
 * Create/update the Evading ActiveEffect for an Actor.
 *
 * @param {Actor|object|null} actor Target Actor.
 * @param {object} options Effect context.
 * @param {Combat|null} [options.combat=null] Active Combat.
 * @param {Combatant|object|null} [options.combatant=null] Declaring Combatant.
 * @returns {Promise<object|null>} Result payload.
 */
export async function activateEvadingForActor(actor, { combat = null, combatant = null } = {}) {
  if (!actor) throw new Error(game.i18n.localize("AOV_SKJALDBORG.Warnings.ActorUnavailable"));
  if (!actor.isOwner && !game.user?.isGM) {
    throw new Error(game.i18n.localize("AOV_SKJALDBORG.Warnings.NotOwner"));
  }
  if (!canMirrorEvadingEffect(actor)) {
    throw new Error(game.i18n.localize("AOV_SKJALDBORG.Warnings.EvadeEffectUnavailable"));
  }

  const data = buildEvadeData(combat, combatant);
  const effect = await upsertActorStatusEffect(actor, {
    statusId: EVADING_STATUS_ID,
    name: game.i18n.localize(EVADING_EFFECT_NAME),
    img: EVADING_EFFECT_ICON,
    moduleFlags: {
      managedEvading: true,
      evade: data
    },
    predicate: isEvadingEffect,
    useToggle: true
  });

  if (effect) await deleteDuplicateEvadingEffects(actor, effect);
  RenderCoordinator.invalidateCombatTracker("evade-status");
  return {
    active: true,
    mode: data.mode,
    attackScope: data.attackScope,
    combatId: data.combatId,
    combatantId: data.combatantId,
    effectId: effect?.id ?? effect?._id ?? null
  };
}

/**
 * Create/update the Evading ActiveEffect for a combatant's represented Actor.
 *
 * @param {Combat|null} combat Active Combat.
 * @param {Combatant|object|null} combatant Declaring Combatant.
 * @returns {Promise<object|null>} Result payload.
 */
export async function activateEvadingForCombatant(combat, combatant) {
  const actor = actorForCombatant(combatant);
  return activateEvadingForActor(actor, { combat, combatant });
}

/**
 * Remove duplicate Evading effects, keeping the effect just created or updated.
 *
 * @param {Actor|object|null} actor Actor document.
 * @param {ActiveEffect|object|null} primary Effect to keep.
 * @returns {Promise<void>}
 */
async function deleteDuplicateEvadingEffects(actor, primary) {
  const duplicates = evadingEffectsForActor(actor).filter(effect => effect && effect !== primary);
  for (const duplicate of duplicates) {
    await safeDeleteActiveEffect(duplicate, { reason: "evading-duplicate" });
  }
}

/**
 * Determine whether an Evading effect should expire at a specific logical round.
 *
 * @param {ActiveEffect|object|null} effect Candidate effect.
 * @param {Combat|null} combat Active combat.
 * @param {number} logicalRound New logical round.
 * @returns {boolean}
 */
function evadingEffectExpired(effect, combat, logicalRound) {
  if (!isEvadingEffect(effect)) return false;
  if (!effectIsActive(effect)) return false;
  const data = evadingEffectData(effect);
  if (!data) return moduleFlag(effect, "managedEvading") === true;
  if (data.combatId && combat?.id && data.combatId !== combat.id) return false;
  const expiresAt = Number(data.expiresAtLogicalRound);
  return Number.isFinite(expiresAt) ? expiresAt <= logicalRound : true;
}

/**
 * Remove expired Evading effects for combatants represented in a Combat.
 *
 * @param {Combat|null} combat Active Combat.
 * @param {object} [options={}] Cleanup options.
 * @param {number|null} [options.logicalRound=null] New logical round.
 * @param {string} [options.reason="combat-round"] Debug reason.
 * @returns {Promise<number>} Number of removed effects.
 */
export async function removeExpiredEvadingEffects(combat, { logicalRound = null, reason = "combat-round" } = {}) {
  if (!game.user?.isGM || !combat) return 0;
  const round = Number.isFinite(Number(logicalRound))
    ? Number(logicalRound)
    : AoVAdapter.getSystemLogicalRound(combat);
  const lockKey = `${combat.id}:${round}:${reason}`;
  if (cleanupLocks.has(lockKey)) return cleanupLocks.get(lockKey);

  const operation = (async () => {
    let removed = 0;
    const seenActors = new Set();
    for (const combatant of combat.combatants ?? []) {
      const actor = actorForCombatant(combatant);
      const actorKey = String(actor?.uuid ?? actor?.id ?? actor?._id ?? "");
      if (!actor || seenActors.has(actorKey)) continue;
      seenActors.add(actorKey);
      const expired = evadingEffectsForActor(actor).filter(effect => evadingEffectExpired(effect, combat, round));
      for (const effect of expired) {
        if (await safeDeleteActiveEffect(effect, { reason })) removed += 1;
      }
    }
    if (removed > 0) RenderCoordinator.invalidateCombatTracker(`evade-status-${reason}`);
    return removed;
  })().finally(() => {
    if (cleanupLocks.get(lockKey) === operation) cleanupLocks.delete(lockKey);
  });

  cleanupLocks.set(lockKey, operation);
  return operation;
}

/**
 * Register combat-round hooks for automatic Evading expiry.
 *
 * @returns {void}
 */
export function registerEvadingStatusHooks(hooks = globalThis.Hooks) {
  if (hooksRegistered) return;
  hooksRegistered = true;

  hooks.on("combatRound", (combat, updateData, updateOptions = {}) => {
    if (!game.user?.isGM) return;
    if (Number(updateOptions?.direction ?? 1) <= 0) return;
    const nextLogicalRound = AoVAdapter.getSystemLogicalRound({ round: Number(updateData?.round ?? combat?.round ?? 0) });
    void removeExpiredEvadingEffects(combat, { logicalRound: nextLogicalRound, reason: "combat-round" }).catch(exception => {
      warn("Failed to remove expired Evading effects after combatRound.", exception);
    });
  });

  hooks.on("updateCombat", (combat, changed = {}, options = {}) => {
    if (!game.user?.isGM) return;
    if (!Object.prototype.hasOwnProperty.call(changed ?? {}, "round")) return;
    if (Number(options?.direction ?? 1) <= 0) return;
    const nextLogicalRound = AoVAdapter.getSystemLogicalRound(combat);
    void removeExpiredEvadingEffects(combat, { logicalRound: nextLogicalRound, reason: "combat-update-round" }).catch(exception => {
      warn("Failed to remove expired Evading effects after updateCombat.", exception);
    });
  });
}

export const __test = {
  ROUND_CLEANUP_REASONS,
  buildEvadeData,
  evadingEffectExpired
};
