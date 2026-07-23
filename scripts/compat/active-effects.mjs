import {
  DISENGAGING_STATUS_ID,
  ENGAGED_STATUS_ID,
  EVADING_STATUS_ID,
  GRAPPLED_STATUS_ID,
  IMPALED_STATUS_ID,
  INJURY_STATUS_ID,
  IMMOBILIZED_STATUS_ID,
  MODULE_ID,
  MOUNTED_STATUS_ID
} from "../constants.mjs";
import { warn } from "../logger.mjs";

const PRIORITY_STATUS_IDS = Object.freeze([
  MOUNTED_STATUS_ID,
  ENGAGED_STATUS_ID,
  DISENGAGING_STATUS_ID,
  EVADING_STATUS_ID,
  GRAPPLED_STATUS_ID,
  IMMOBILIZED_STATUS_ID,
  IMPALED_STATUS_ID,
  INJURY_STATUS_ID,
  "prone",
  "stunned"
]);
const MODULE_MANAGED_FLAGS = Object.freeze([
  "managedEngagement",
  "managedDisengaging",
  "managedKnockbackStatus",
  "grapple",
  "managedEvading",
  "managedReactionPenalty",
  "stunStatus",
  "impalement",
  "injuryThreshold"
]);
const STATUS_EFFECT_DOCUMENT_IDS = Object.freeze({
  [ENGAGED_STATUS_ID]: "SkjEngaged000001",
  [MOUNTED_STATUS_ID]: "SkjMounted000001",
  [DISENGAGING_STATUS_ID]: "SkjDisengaging01",
  [GRAPPLED_STATUS_ID]: "SkjGrappled00001",
  [IMMOBILIZED_STATUS_ID]: "SkjImmobilized01",
  [EVADING_STATUS_ID]: "SkjEvading000001",
  [IMPALED_STATUS_ID]: "SkjImpaled000001",
  [INJURY_STATUS_ID]: "SkjInjury0000001"
});

/**
 * Clone data using Foundry's structured clone helper so persisted flag payloads
 * are not shared with caller-owned mutable objects.
 *
 * @param {unknown} value Value to clone.
 * @returns {unknown}
 */
function clone(value) {
  return foundry.utils.deepClone(value);
}

function staleDeleteMessage(exception) {
  return /ActiveEffect\s+"[^"]+"\s+does not exist/i.test(String(exception?.message ?? exception));
}

function effectStillEmbedded(effect) {
  const id = String(effect?.id ?? effect?._id ?? "");
  if (!id) return false;
  const parent = effect?.parent ?? effect?.actor ?? effect?.item ?? null;
  const effects = parent?.effects ?? null;
  if (!effects) return true;
  if (typeof effects.get === "function") return !!effects.get(id);
  return Array.from(effects ?? []).some(candidate => String(candidate?.id ?? candidate?._id ?? "") === id);
}

/**
 * Delete an ActiveEffect if it still exists, tolerating stale duplicate cleanup.
 *
 * @param {ActiveEffect|object|null} effect Candidate ActiveEffect.
 * @param {{reason?: string}} [options={}] Deletion context.
 * @returns {Promise<boolean>} Whether a delete request succeeded.
 */
export async function safeDeleteActiveEffect(effect, { reason = "active-effect-cleanup" } = {}) {
  if (typeof effect?.delete !== "function") return false;
  if (!effectStillEmbedded(effect)) return false;
  try {
    await effect.delete();
    return true;
  }
  catch (exception) {
    if (staleDeleteMessage(exception)) return false;
    warn(`Failed to delete Skjaldborg ActiveEffect during ${reason}.`, exception);
    return false;
  }
}

/**
 * Build Foundry's conventional localization key for a core status id when the
 * active catalog cannot provide a configured name.
 *
 * @param {string|null|undefined} statusId Status id.
 * @returns {string}
 */
function fallbackEffectName(statusId) {
  const suffix = String(statusId ?? "")
    .replace(/(^|-)([a-z])/g, (_match, _dash, character) => character.toUpperCase())
    .replace(/[^A-Za-z0-9]+/g, "");
  return suffix ? `EFFECT.Status${suffix}` : "EFFECT.Status";
}

/**
 * Resolve the v14 ActiveEffect icon display value for "always show".
 *
 * @returns {number}
 */
export function alwaysShowIconMode() {
  const modes = globalThis.CONST?.ACTIVE_EFFECT_ICON_DISPLAY_MODES
    ?? CONFIG?.ActiveEffect?.iconDisplayModes
    ?? {};
  const value = modes.ALWAYS ?? modes.always ?? 2;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 2;
}

/**
 * Build a v14-compatible status-effect catalog entry.
 *
 * @param {string} id Status id.
 * @param {string} name Localization key or label.
 * @param {string} img Icon path.
 * @returns {object}
 */
export function statusEffectConfig(id, name, img) {
  const config = { id, name, label: name, img, icon: img, statuses: [id], showIcon: alwaysShowIconMode() };
  if (isPriorityStatusId(id)) config.flags = { [MODULE_ID]: { priorityStatus: true } };
  const documentId = STATUS_EFFECT_DOCUMENT_IDS[id];
  if (documentId) config._id = documentId;
  return config;
}

/**
 * Whether a status id should be surfaced first in the Token HUD palette.
 *
 * @param {string|null|undefined} statusId Candidate status id.
 * @returns {boolean}
 */
export function isPriorityStatusId(statusId) {
  return PRIORITY_STATUS_IDS.includes(String(statusId ?? ""));
}

function statusConfigId(config) {
  return String(config?.id ?? config?._id ?? config?.statuses?.[0] ?? "");
}

function prioritizeStatusEffectArray(effects) {
  effects.sort((a, b) => {
    const aIndex = PRIORITY_STATUS_IDS.indexOf(statusConfigId(a));
    const bIndex = PRIORITY_STATUS_IDS.indexOf(statusConfigId(b));
    const aPriority = aIndex >= 0;
    const bPriority = bIndex >= 0;
    if (aPriority && bPriority) return aIndex - bIndex;
    if (aPriority) return -1;
    if (bPriority) return 1;
    return 0;
  });
}

function prioritizeStatusEffectObject(effects) {
  const entries = Object.entries(effects ?? {});
  if (!entries.length) return effects;
  const priority = [];
  const rest = [];
  for (const entry of entries) {
    const config = entry[1];
    const index = PRIORITY_STATUS_IDS.indexOf(statusConfigId(config) || entry[0]);
    if (index >= 0) priority.push({ entry, index });
    else rest.push(entry);
  }
  if (!priority.length) return effects;
  priority.sort((a, b) => a.index - b.index);
  CONFIG.statusEffects = Object.fromEntries(priority.map(item => item.entry).concat(rest));
  return CONFIG.statusEffects;
}

function prioritizeStatusEffectMap(effects) {
  if (typeof effects?.entries !== "function" || typeof effects?.clear !== "function") return;
  const entries = Array.from(effects.entries());
  const priority = [];
  const rest = [];
  for (const entry of entries) {
    const index = PRIORITY_STATUS_IDS.indexOf(statusConfigId(entry[1]) || entry[0]);
    if (index >= 0) priority.push({ entry, index });
    else rest.push(entry);
  }
  if (!priority.length) return;
  priority.sort((a, b) => a.index - b.index);
  effects.clear();
  for (const [key, value] of priority.map(item => item.entry).concat(rest)) effects.set(key, value);
}

/**
 * Keep Skjaldborg-relevant statuses grouped first in the status catalog.
 *
 * @returns {void}
 */
export function prioritizeStatusEffects() {
  try {
    const effects = CONFIG?.statusEffects;
    if (Array.isArray(effects)) prioritizeStatusEffectArray(effects);
    else if (typeof effects?.set === "function") prioritizeStatusEffectMap(effects);
    else if (effects && typeof effects === "object") prioritizeStatusEffectObject(effects);
  } catch (exception) {
    warn("Unable to prioritize Skjaldborg status effects in CONFIG.statusEffects.", exception);
  }
}

/**
 * Register a status-effect catalog entry across supported v14 catalog shapes.
 *
 * @param {object} config Status-effect config.
 * @param {{warning?: string}} [options={}] Options.
 * @returns {{config: object|null, mode: "native"|"module-fallback"|"disabled"}}
 */
export function registerStatusEffect(config, { warning = "Unable to register Skjaldborg status effect" } = {}) {
  if (!config?.id) return { config: null, mode: "disabled" };
  let effects = CONFIG?.statusEffects;
  if (!effects) {
    try {
      CONFIG.statusEffects = {};
      effects = CONFIG.statusEffects;
    } catch (exception) {
      warn(warning, exception);
      return { config: null, mode: "disabled" };
    }
  }

  // Foundry and systems may expose CONFIG.statusEffects as an object, array, or
  // collection-like value during startup. Registering against each known shape
  // keeps this module from replacing AoV-owned catalog state unnecessarily.
  if (effects && typeof effects.set === "function") {
    effects.set(config.id, config);
    prioritizeStatusEffects();
    return { config, mode: "native" };
  }

  if (Array.isArray(effects)) {
    const index = effects.findIndex(effect => effect?.id === config.id);
    if (index >= 0) effects.splice(index, 1, config);
    else effects.push(config);
    prioritizeStatusEffects();
    return { config, mode: "module-fallback" };
  }

  if (effects && typeof effects === "object") {
    try {
      effects[config.id] = config;
      prioritizeStatusEffects();
      return { config, mode: "native" };
    } catch (_exception) {
      // Replace a non-extensible catalog below.
    }
  }

  try {
    CONFIG.statusEffects = { ...(effects ?? {}), [config.id]: config };
    prioritizeStatusEffects();
    return { config, mode: "module-fallback" };
  } catch (exception) {
    warn(warning, exception);
    return { config: null, mode: "disabled" };
  }
}

/**
 * Resolve a status config from the current catalog.
 *
 * @param {string} statusId Status id.
 * @returns {object|null}
 */
export function getStatusEffectConfig(statusId) {
  const effects = CONFIG?.statusEffects;
  return effects?.get?.(statusId)
    ?? (Array.isArray(effects) ? effects.find(effect => effect?.id === statusId) : effects?.[statusId])
    ?? null;
}

/**
 * Whether this effect carries a specific v14 status id.
 *
 * @param {ActiveEffect|object|null} effect Candidate effect.
 * @param {string|null|undefined} statusId Status id.
 * @returns {boolean}
 */
export function effectHasStatus(effect, statusId) {
  if (!effect || !statusId) return false;
  if (effect.statuses?.has?.(statusId)) return true;
  if (Array.from(effect.statuses ?? []).includes(statusId)) return true;
  if (effect.getFlag?.("core", "statusId") === statusId) return true;
  return effect.flags?.core?.statusId === statusId;
}

/**
 * Read one module flag from an ActiveEffect.
 *
 * @param {ActiveEffect|object|null} effect Candidate effect.
 * @param {string} key Module flag key.
 * @returns {unknown}
 */
export function moduleFlag(effect, key) {
  return effect?.getFlag?.(MODULE_ID, key) ?? effect?.flags?.[MODULE_ID]?.[key];
}

/**
 * Whether the ActiveEffect is enabled and not suppressed by the owning system.
 *
 * @param {ActiveEffect|object|null} effect Candidate effect.
 * @returns {boolean}
 */
export function effectIsActive(effect) {
  if (!effect || effect.disabled === true || effect.isSuppressed === true) return false;
  if (typeof effect.active === "boolean") return effect.active;
  return true;
}

/**
 * Whether the runtime can mirror a module status onto an Actor ActiveEffect.
 *
 * @param {Actor|object|null} actor Candidate Actor.
 * @param {{enabled?: boolean}} [options={}] Feature-level availability.
 * @returns {boolean}
 */
export function canMirrorActorStatusEffect(actor, { enabled = true } = {}) {
  if (!enabled || !actor) return false;
  return typeof CONFIG?.ActiveEffect?.documentClass === "function"
    && (
      typeof actor.toggleStatusEffect === "function"
      || typeof actor.createEmbeddedDocuments === "function"
      || Array.from(actor.effects ?? []).some(effect => typeof effect?.update === "function")
    );
}

/**
 * Read the highest Skjaldborg injury-threshold severity from an effect list.
 *
 * @param {Iterable<ActiveEffect|object>|null|undefined} effects Candidate effects.
 * @returns {0|1|2|3}
 */
export function injuryThresholdSeverityFromEffects(effects) {
  let severity = 0;
  for (const effect of Array.from(effects ?? [])) {
    if (!effectIsActive(effect) || !effectHasStatus(effect, INJURY_STATUS_ID)) continue;
    const value = Number(moduleFlag(effect, "injuryThreshold")?.severity);
    if (Number.isFinite(value)) severity = Math.max(severity, Math.min(3, Math.max(0, Math.trunc(value))));
  }
  return /** @type {0|1|2|3} */ (severity);
}

/**
 * Resolve the owning Actor for direct Actor effects and item-embedded effects.
 *
 * @param {ActiveEffect|object|null} effect Candidate effect.
 * @returns {Actor|object|null}
 */
export function effectParentActor(effect) {
  if (!effect) return null;
  if (effect.actor?.id) return effect.actor;
  const parent = effect.parent ?? null;
  if (parent?.documentName === "Actor") return parent;
  if (parent?.actor?.id) return parent.actor;
  if (parent?.parent?.documentName === "Actor") return parent.parent;
  if (effect.item?.actor?.id) return effect.item.actor;
  return null;
}

/**
 * Whether an effect is embedded directly on an Actor rather than an Item.
 *
 * @param {ActiveEffect|object|null} effect Candidate effect.
 * @returns {boolean}
 */
export function isDirectActorEffect(effect) {
  if (!effect) return false;
  const parent = effect.parent ?? null;
  if (parent?.documentName === "Actor") return true;
  if (parent?.documentName === "Item") return false;
  if (effect.item?.documentName === "Item" || effect.item?.id) return false;
  return !!effect.actor?.id;
}

/**
 * Whether an effect carries one of Skjaldborg's managed status flags.
 *
 * @param {ActiveEffect|object|null} effect Candidate effect.
 * @returns {boolean}
 */
export function isModuleManagedEffect(effect) {
  return MODULE_MANAGED_FLAGS.some(key => moduleFlag(effect, key) !== undefined);
}

/**
 * Human-readable type label for a module-managed ActiveEffect.
 *
 * @param {ActiveEffect|object|null} effect Candidate effect.
 * @returns {string}
 */
export function moduleManagedEffectLabel(effect) {
  if (moduleFlag(effect, "managedEngagement") !== undefined) return game.i18n.localize("AOV_SKJALDBORG.StatusEffects.Engaged");
  if (moduleFlag(effect, "managedDisengaging") !== undefined) return game.i18n.localize("AOV_SKJALDBORG.StatusEffects.Disengaging");
  if (moduleFlag(effect, "managedEvading") !== undefined) return game.i18n.localize("AOV_SKJALDBORG.StatusEffects.Evading");
  if (moduleFlag(effect, "managedReactionPenalty") !== undefined) return game.i18n.localize("AOV_SKJALDBORG.StatusEffects.ReactionPenalty");
  if (moduleFlag(effect, "stunStatus") !== undefined) return game.i18n.localize("AOV_SKJALDBORG.StunDialog.StatusName");
  if (moduleFlag(effect, "impalement") !== undefined) return game.i18n.localize("AOV_SKJALDBORG.StatusEffects.Impaled");
  if (moduleFlag(effect, "injuryThreshold") !== undefined) return game.i18n.localize("AOV_SKJALDBORG.StatusEffects.Injury");
  if (moduleFlag(effect, "managedKnockbackStatus") !== undefined) return effect?.name ?? game.i18n.localize("EFFECT.StatusProne");
  const grapple = moduleFlag(effect, "grapple");
  if (grapple !== undefined) {
    return grapple?.immobilized === true
      ? game.i18n.localize("AOV_SKJALDBORG.StatusEffects.Immobilized")
      : game.i18n.localize("AOV_SKJALDBORG.StatusEffects.Grappled");
  }
  return effect?.name ?? "";
}

/**
 * Build status-effect data through the configured v14 ActiveEffect class.
 *
 * @param {string} statusId Status id.
 * @param {Actor|object|null} actor Owning Actor.
 * @returns {Promise<object>}
 */
export async function statusEffectDocumentData(statusId, actor = null) {
  const effectClass = CONFIG?.ActiveEffect?.documentClass ?? foundry.documents?.ActiveEffect ?? globalThis.ActiveEffect;
  if (typeof effectClass?.fromStatusEffect !== "function") return {};
  try {
    const effect = await effectClass.fromStatusEffect(statusId, { parent: actor });
    return effect?.toObject?.() ?? {};
  } catch (exception) {
    warn(`Unable to build Skjaldborg ActiveEffect from status ${statusId}; falling back to explicit data.`, exception);
    return {};
  }
}

/**
 * Convert module flag data to Foundry update paths.
 *
 * @param {object} [moduleFlags={}] Module flag data.
 * @returns {Record<string, unknown>}
 */
function flattenModuleFlags(moduleFlags = {}) {
  return Object.fromEntries(Object.entries(moduleFlags).map(([key, value]) => [`flags.${MODULE_ID}.${key}`, clone(value)]));
}

async function statusEffectUpdateData(statusId, parent, { name = null, img = null, description = null, moduleFlags = {} } = {}) {
  const statusData = await statusEffectDocumentData(statusId, parent);
  const config = getStatusEffectConfig(statusId) ?? {};
  const displayName = name ?? statusData.name ?? config.name ?? fallbackEffectName(statusId);
  const icon = img ?? statusData.img ?? config.img ?? config.icon ?? "icons/svg/aura.svg";
  const updateData = {
    ...statusData,
    name: displayName,
    img: icon,
    ...(description !== null ? { description: String(description ?? "") } : {}),
    disabled: false,
    showIcon: alwaysShowIconMode(),
    statuses: [statusId],
    [`flags.core.statusId`]: statusId,
    ...flattenModuleFlags(moduleFlags)
  };
  delete updateData._id;
  return updateData;
}

async function statusEffectCreateData(statusId, parent, { name = null, img = null, description = null, moduleFlags = {} } = {}) {
  const statusData = await statusEffectDocumentData(statusId, parent);
  const config = getStatusEffectConfig(statusId) ?? {};
  const displayName = name ?? statusData.name ?? config.name ?? fallbackEffectName(statusId);
  const icon = img ?? statusData.img ?? config.img ?? config.icon ?? "icons/svg/aura.svg";
  const createData = {
    ...statusData,
    name: displayName,
    img: icon,
    ...(description !== null ? { description: String(description ?? "") } : {}),
    disabled: false,
    showIcon: alwaysShowIconMode(),
    statuses: [statusId],
    flags: {
      ...(statusData.flags ?? {}),
      core: { ...(statusData.flags?.core ?? {}), statusId },
      [MODULE_ID]: clone(moduleFlags)
    }
  };
  delete createData._id;
  return createData;
}

/**
 * Create or update an embedded ActiveEffect on any document that owns effects.
 *
 * @param {Document|object|null} document Owning Actor or Item document.
 * @param {object} options Status-effect options.
 * @param {string} options.statusId Status id.
 * @param {string} [options.name] Effect display name.
 * @param {string} [options.img] Effect icon.
 * @param {string|null} [options.description] Effect description.
 * @param {object} [options.moduleFlags={}] Module flags to preserve.
 * @param {(effect: ActiveEffect|object) => boolean} [options.predicate] Duplicate lookup predicate.
 * @returns {Promise<ActiveEffect|object|null>}
 */
export async function upsertDocumentStatusEffect(document, {
  statusId,
  name = null,
  img = null,
  description = null,
  moduleFlags = {},
  predicate = null
} = {}) {
  if (!document || !statusId) return null;
  const finder = typeof predicate === "function" ? predicate : effect => effectHasStatus(effect, statusId);
  const existing = Array.from(document.effects ?? []).find(finder) ?? null;
  const options = { name, img, description, moduleFlags };

  if (existing?.update) return existing.update(await statusEffectUpdateData(statusId, document, options));

  if (typeof document.createEmbeddedDocuments !== "function") return null;
  const [created = null] = await document.createEmbeddedDocuments("ActiveEffect", [await statusEffectCreateData(statusId, document, options)]);
  return created;
}

/**
 * Create or update a direct Actor ActiveEffect mirror for a status.
 *
 * @param {Actor|object|null} actor Owning Actor.
 * @param {object} options Status-effect options.
 * @param {string} options.statusId Status id.
 * @param {string} [options.name] Effect display name.
 * @param {string} [options.img] Effect icon.
 * @param {string|null} [options.description] Effect description.
 * @param {object} [options.moduleFlags={}] Module flags to preserve.
 * @param {(effect: ActiveEffect|object) => boolean} [options.predicate] Duplicate lookup predicate.
 * @param {boolean} [options.useToggle=true] Whether to try Actor#toggleStatusEffect first.
 * @returns {Promise<ActiveEffect|object|null>}
 */
export async function upsertActorStatusEffect(actor, {
  statusId,
  name = null,
  img = null,
  description = null,
  moduleFlags = {},
  predicate = null,
  useToggle = true
} = {}) {
  if (!actor || !statusId) return null;
  const finder = typeof predicate === "function" ? predicate : effect => effectHasStatus(effect, statusId);
  const current = () => Array.from(actor.effects ?? []).find(finder) ?? null;
  let existing = current();
  const options = { name, img, description, moduleFlags };

  if (existing?.update) return existing.update(await statusEffectUpdateData(statusId, actor, options));

  if (useToggle && typeof actor.toggleStatusEffect === "function") {
    try {
      await actor.toggleStatusEffect(statusId, { active: true });
      existing = current();
      if (existing?.update) return existing.update(await statusEffectUpdateData(statusId, actor, options));
      if (existing) return existing;
    } catch (exception) {
      warn(`Actor#toggleStatusEffect failed for Skjaldborg status ${statusId}; falling back to embedded ActiveEffect.`, exception);
    }
  }

  if (typeof actor.createEmbeddedDocuments !== "function") return null;
  const [created = null] = await actor.createEmbeddedDocuments("ActiveEffect", [await statusEffectCreateData(statusId, actor, options)]);
  return created;
}

/**
 * Filter effects shown as quick actionable actor-hotbar statuses.
 *
 * @param {Actor|object|null} actor Actor document.
 * @returns {(ActiveEffect|object)[]}
 */
export function hotbarVisibleEffects(actor) {
  return Array.from(actor?.effects ?? [])
    .filter(effectIsActive)
    .filter(effect => isDirectActorEffect(effect) || isModuleManagedEffect(effect));
}

/**
 * Open an ActiveEffect sheet when the current document exposes one.
 *
 * @param {ActiveEffect|object|null} effect ActiveEffect document.
 * @returns {unknown|null}
 */
export function openEffectSheet(effect) {
  try {
    return effect?.sheet?.render?.({ force: true }) ?? null;
  } catch (exception) {
    warn("Unable to open Skjaldborg ActiveEffect sheet.", exception);
    return null;
  }
}

export const __test = {
  injuryThresholdSeverityFromEffects,
  MODULE_MANAGED_FLAGS,
  PRIORITY_STATUS_IDS,
  STATUS_EFFECT_DOCUMENT_IDS,
  safeDeleteActiveEffect
};
