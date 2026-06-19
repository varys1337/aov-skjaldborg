import { ENGAGED_STATUS_ID, ENGAGEMENT_STATUS, MODULE_ID, MOVEMENT_DEBUG_CATEGORIES, MOVEMENT_DEBUG_LEVELS } from "../constants.mjs";
import { warn } from "../logger.mjs";
import { getCombatantState, updateCombatantState } from "./state.mjs";
import { movementDebug, movementDebugWarn } from "./movement-debugger.mjs";

const ENGAGED_EFFECT_NAME = "AOV_SKJADLBORG.StatusEffects.Engaged";
const ENGAGED_EFFECT_ICON = "icons/svg/combat.svg";
let engagementEffectSyncDepth = 0;

/**
 * Return the configured Engaged status-effect definition.
 *
 * @returns {object}
 */
export function engagedStatusEffectConfig() {
  return {
    id: ENGAGED_STATUS_ID,
    name: ENGAGED_EFFECT_NAME,
    img: ENGAGED_EFFECT_ICON
  };
}

/**
 * Register the module-owned Engaged status with Foundry's status-effect catalog.
 *
 * Foundry v13 exposes configured status effects through CONFIG.statusEffects.
 * AoV and other packages can replace that catalog during init, so registration
 * is deliberately idempotent and repeated at init, setup, and ready.
 *
 * @returns {void}
 */
export function registerEngagedStatusEffect() {
  const config = engagedStatusEffectConfig();
  const effects = CONFIG?.statusEffects;

  // Defensive compatibility with the v13 record shape and collection-like
  // test doubles. The official v13 API defines an id-keyed record, but using
  // set() when present prevents a silent non-enumerable property on a Map.
  if (effects && typeof effects.set === "function") {
    effects.set(ENGAGED_STATUS_ID, config);
    return config;
  }

  if (Array.isArray(effects)) {
    const index = effects.findIndex(effect => effect?.id === ENGAGED_STATUS_ID);
    if (index >= 0) effects.splice(index, 1, config);
    else effects.push(config);
    return config;
  }

  if (effects && typeof effects === "object") {
    try {
      effects[ENGAGED_STATUS_ID] = config;
      if (effects[ENGAGED_STATUS_ID]?.id === ENGAGED_STATUS_ID) return config;
    }
    catch (_err) {
      // Fall through to replacing a non-extensible catalog.
    }
  }

  try {
    CONFIG.statusEffects = { ...(effects ?? {}), [ENGAGED_STATUS_ID]: config };
  }
  catch (err) {
    warn("Unable to register the Engaged status effect in CONFIG.statusEffects", err);
  }
  return config;
}

/**
 * Determine whether an ActiveEffect represents the module-owned Engaged state.
 *
 * @param {ActiveEffect|object|null} effect Candidate effect.
 * @returns {boolean}
 */
function isEngagedEffect(effect) {
  if (!effect) return false;
  if (effect.statuses?.has?.(ENGAGED_STATUS_ID)) return true;
  if (Array.from(effect.statuses ?? []).includes(ENGAGED_STATUS_ID)) return true;
  return effect.getFlag?.(MODULE_ID, "managedEngagement") === true
    || effect.flags?.[MODULE_ID]?.managedEngagement === true;
}

/**
 * Determine whether an effect still visibly applies the Engaged status.
 *
 * @param {ActiveEffect|object|null} effect Candidate effect.
 * @returns {boolean}
 */
function hasActiveEngagedStatus(effect) {
  if (!effect || effect.disabled === true) return false;
  if (effect.statuses?.has?.(ENGAGED_STATUS_ID)) return true;
  return Array.from(effect.statuses ?? []).includes(ENGAGED_STATUS_ID);
}

/**
 * Read persisted engagement records from an ActiveEffect.
 *
 * @param {ActiveEffect|object|null} effect Engaged effect.
 * @returns {Record<string, object>}
 */
function engagementRecords(effect) {
  const records = effect?.getFlag?.(MODULE_ID, "engagements")
    ?? effect?.flags?.[MODULE_ID]?.engagements
    ?? {};
  if (!records || typeof records !== "object" || Array.isArray(records)) return {};
  return foundry.utils.deepClone(records);
}

/**
 * Build the status-effect record for a combatant's authoritative module state.
 *
 * @param {Combatant|object} combatant Combatant document.
 * @param {object} engagement Engagement state.
 * @param {Combat|null} combat Active combat.
 * @returns {object}
 */
function buildEngagementRecord(combatant, engagement, combat) {
  const partnerIds = Array.from(new Set((engagement?.partnerIds ?? []).filter(Boolean)));
  const partnerTokenIds = [];
  const partnerActorIds = [];
  for (const partnerId of partnerIds) {
    const partner = combat?.combatants?.get?.(partnerId)
      ?? Array.from(combat?.combatants ?? []).find(candidate => candidate?.id === partnerId)
      ?? null;
    if (partner?.tokenId) partnerTokenIds.push(partner.tokenId);
    if (partner?.actorId) partnerActorIds.push(partner.actorId);
  }

  return {
    combatId: combat?.id ?? combatant?.parent?.id ?? null,
    combatantId: combatant?.id ?? null,
    tokenId: combatant?.tokenId ?? combatant?.token?.id ?? null,
    actorId: combatant?.actorId ?? combatant?.actor?.id ?? null,
    status: engagement?.status ?? ENGAGEMENT_STATUS.NONE,
    engaged: engagement?.engaged === true,
    partnerIds,
    partnerTokenIds: Array.from(new Set(partnerTokenIds)),
    partnerActorIds: Array.from(new Set(partnerActorIds)),
    reachUnits: Number(engagement?.reachUnits) || 1,
    reason: String(engagement?.reason ?? ""),
    updatedAt: Date.now()
  };
}

/**
 * Resolve the Actor which owns the visual Engaged ActiveEffect.
 *
 * @param {Combatant|object|null} combatant Combatant document.
 * @returns {Actor|object|null}
 */
function effectActorForCombatant(combatant) {
  return combatant?.actor ?? combatant?.token?.actor ?? combatant?.token?.object?.actor ?? null;
}

/**
 * Synchronize a Combatant engagement record into the Actor's Engaged effect.
 *
 * The Combatant flag remains authoritative for workflow rules. The ActiveEffect
 * mirrors that state for token visualization and carries a combatant-keyed copy
 * of all persisted engagement data, including partner Combatant and Token ids.
 *
 * @param {Combatant|object} combatant Combatant document.
 * @param {object} engagement Authoritative engagement state.
 * @param {Combat|null} [combat=game.combat] Active combat.
 * @returns {Promise<ActiveEffect|object|null>}
 */
export async function syncEngagedStatusEffect(combatant, engagement, combat = game.combat) {
  engagementEffectSyncDepth += 1;
  try {
    const actor = effectActorForCombatant(combatant);
    if (!actor) return null;

    const effects = Array.from(actor.effects ?? []);
    const effect = effects.find(isEngagedEffect) ?? null;
    const records = engagementRecords(effect);
    const combatantId = String(combatant?.id ?? "");
    if (!combatantId) return effect;

    if (engagement?.engaged === true && engagement?.status === ENGAGEMENT_STATUS.ENGAGED) {
      records[combatantId] = buildEngagementRecord(combatant, engagement, combat);
    }
    else {
      delete records[combatantId];
    }

    const hasRecords = Object.keys(records).length > 0;
    movementDebug(MOVEMENT_DEBUG_CATEGORIES.STATUS, "sync-engaged-effect", () => ({
      combatantId,
      actorId: actor?.id ?? null,
      hasExistingEffect: !!effect,
      hasRecords,
      engagement,
      records
    }), { combatId: combat?.id ?? null, combatantId, level: MOVEMENT_DEBUG_LEVELS.VERBOSE });
    if (!hasRecords) {
      if (effect?.delete) await effect.delete();
      return null;
    }

    const flags = {
      [MODULE_ID]: {
        managedEngagement: true,
        engagements: records
      }
    };

    if (effect?.update) {
      await effect.update({
        name: game.i18n.localize(ENGAGED_EFFECT_NAME),
        img: ENGAGED_EFFECT_ICON,
        disabled: false,
        statuses: [ENGAGED_STATUS_ID],
        [`flags.${MODULE_ID}.managedEngagement`]: true,
        [`flags.${MODULE_ID}.engagements`]: records
      });
      return effect;
    }

    // Use the v13 public status API when available. This creates the same
    // configured effect used by the default Assign Status Effects palette.
    if (typeof actor.toggleStatusEffect === "function") {
      await actor.toggleStatusEffect(ENGAGED_STATUS_ID, { active: true });
      const configured = Array.from(actor.effects ?? []).find(isEngagedEffect) ?? null;
      if (configured?.update) {
        await configured.update({
          name: game.i18n.localize(ENGAGED_EFFECT_NAME),
          img: ENGAGED_EFFECT_ICON,
          disabled: false,
          statuses: [ENGAGED_STATUS_ID],
          [`flags.${MODULE_ID}.managedEngagement`]: true,
          [`flags.${MODULE_ID}.engagements`]: records
        });
      }
      return configured;
    }

    if (typeof actor.createEmbeddedDocuments !== "function") return null;
    const [created = null] = await actor.createEmbeddedDocuments("ActiveEffect", [{
      name: game.i18n.localize(ENGAGED_EFFECT_NAME),
      img: ENGAGED_EFFECT_ICON,
      disabled: false,
      statuses: [ENGAGED_STATUS_ID],
      flags
    }]);
    return created;
  }
  finally {
    engagementEffectSyncDepth = Math.max(0, engagementEffectSyncDepth - 1);
  }
}

/**
 * Iterate combatants from either Foundry Collections or plain Maps.
 *
 * @param {Combat|null|undefined} combat Combat document.
 * @returns {Combatant[]}
 */
function combatantValues(combat) {
  return Array.from(combat?.combatants ?? []).map(entry => Array.isArray(entry) ? entry[1] : entry);
}

/**
 * Resolve a combatant referenced by an engagement effect record.
 *
 * @param {object} record Engagement record.
 * @param {Combat|null} combat Active combat.
 * @returns {Combatant|object|null}
 */
function combatantFromRecord(record, combat) {
  const combatants = combatantValues(combat);
  return combatants.find(combatant => {
    return combatant?.id === record?.combatantId
      || combatant?.tokenId === record?.tokenId
      || combatant?.actorId === record?.actorId;
  }) ?? null;
}

/**
 * Clear one combatant's engagement and repair reciprocal partner flags.
 *
 * @param {Combatant|object} combatant Combatant whose effect was removed.
 * @param {Combat|null} combat Active combat.
 * @returns {Promise<void>}
 */
async function clearCombatantEngagement(combatant, combat) {
  const state = getCombatantState(combatant);
  const partners = Array.from(new Set(state.engagement?.partnerIds ?? []));
  movementDebug(MOVEMENT_DEBUG_CATEGORIES.STATUS, "clear-combatant-engagement", () => ({
    combatantId: combatant?.id,
    partners,
    before: state.engagement
  }), { combatId: combat?.id ?? null, combatantId: combatant?.id, level: MOVEMENT_DEBUG_LEVELS.VERBOSE });
  await updateCombatantState(combatant, {
    engagement: {
      status: ENGAGEMENT_STATUS.NONE,
      engaged: false,
      partnerIds: [],
      reachUnits: state.engagement?.reachUnits ?? 1,
      reason: "status-removed"
    }
  });

  for (const partnerId of partners) {
    const partner = combatantValues(combat).find(candidate => candidate?.id === partnerId);
    if (!partner) continue;
    const partnerState = getCombatantState(partner);
    const partnerIds = (partnerState.engagement?.partnerIds ?? []).filter(id => id !== combatant.id);
    const engagement = {
      ...partnerState.engagement,
      status: partnerIds.length ? ENGAGEMENT_STATUS.ENGAGED : ENGAGEMENT_STATUS.NONE,
      engaged: partnerIds.length > 0,
      partnerIds,
      reason: partnerIds.length ? partnerState.engagement?.reason : "partner-status-removed"
    };
    movementDebug(MOVEMENT_DEBUG_CATEGORIES.STATUS, "clear-partner-engagement", () => ({
      sourceCombatantId: combatant?.id,
      partnerId,
      before: partnerState.engagement,
      after: engagement
    }), { combatId: combat?.id ?? null, combatantId: partnerId, level: MOVEMENT_DEBUG_LEVELS.VERBOSE });
    await updateCombatantState(partner, { engagement });
    await syncEngagedStatusEffect(partner, engagement, combat);
  }
}

/**
 * Clear module engagement data represented by a removed/disabled effect.
 *
 * @param {ActiveEffect|object|null} effect Engaged ActiveEffect.
 * @returns {Promise<void>}
 */
async function clearEngagementFromEffect(effect) {
  if (!game.user?.isGM || !effect || engagementEffectSyncDepth > 0) return;
  const records = engagementRecords(effect);
  const combat = game.combat;
  movementDebug(MOVEMENT_DEBUG_CATEGORIES.STATUS, "clear-effect-records", () => ({
    effectId: effect.id ?? effect._id ?? null,
    records
  }), { combatId: combat?.id ?? null, level: MOVEMENT_DEBUG_LEVELS.VERBOSE });
  if (!Object.keys(records).length) {
    movementDebugWarn(MOVEMENT_DEBUG_CATEGORIES.STATUS, "effect-cleanup-no-records", () => ({
      effectId: effect.id ?? effect._id ?? null,
      flags: effect.flags
    }), { combatId: combat?.id ?? null });
  }
  engagementEffectSyncDepth += 1;
  try {
    for (const record of Object.values(records)) {
      const combatant = combatantFromRecord(record, combat);
      if (!combatant) {
        movementDebugWarn(MOVEMENT_DEBUG_CATEGORIES.STATUS, "effect-record-no-combatant", () => ({
          record
        }), { combatId: combat?.id ?? null });
      }
      if (!combatant) continue;
      await clearCombatantEngagement(combatant, combat);
    }
  }
  catch (err) {
    warn(err);
  }
  finally {
    engagementEffectSyncDepth = Math.max(0, engagementEffectSyncDepth - 1);
  }
  ui.combat?.render?.();
}

/**
 * Register manual Engaged ActiveEffect cleanup hooks.
 *
 * @returns {void}
 */
export function registerEngagedStatusHooks() {
  Hooks.on("deleteActiveEffect", effect => {
    if (!isEngagedEffect(effect)) return;
    void clearEngagementFromEffect(effect);
  });

  Hooks.on("updateActiveEffect", effect => {
    if (!isEngagedEffect(effect) || hasActiveEngagedStatus(effect)) return;
    void clearEngagementFromEffect(effect);
  });
}

/**
 * Reconcile persisted Combatant engagement flags into visual status effects.
 *
 * @param {Combat|null} [combat=game.combat] Active combat.
 * @returns {Promise<void>}
 */
export async function reconcileEngagedStatusEffects(combat = game.combat) {
  if (!game.user?.isGM || !combat) return;
  for (const combatant of Array.from(combat.combatants ?? [])) {
    try {
      await syncEngagedStatusEffect(combatant, getCombatantState(combatant).engagement, combat);
    }
    catch (err) {
      warn(err);
    }
  }
}
