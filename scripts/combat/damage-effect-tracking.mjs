import {
  DAMAGE_EFFECT_SOURCE_FLAG,
  DAMAGE_EFFECT_TRACKING_FLAG,
  IMPALED_STATUS_ID,
  INJURY_STATUS_ID,
  MODULE_ID
} from "../constants.mjs";
import {
  effectHasStatus,
  injuryThresholdSeverityFromEffects,
  moduleFlag,
  registerStatusEffect,
  statusEffectConfig,
  upsertDocumentStatusEffect
} from "../compat/active-effects.mjs";
import {
  aovCards,
  idTypeMatch,
  numberOr,
  recentFlaggedMessages,
  safeFromUuid
} from "./automation-helpers.mjs";
import { warn } from "../logger.mjs";
import { guardedUpdate } from "../utils/guarded-document-writes.mjs";

const IMPALED_EFFECT_NAME = "AOV_SKJALDBORG.StatusEffects.Impaled";
const INJURY_EFFECT_NAME = "AOV_SKJALDBORG.StatusEffects.Injury";
const IMPALED_EFFECT_ICON = "icons/svg/blood.svg";
const INJURY_EFFECT_ICON = "icons/svg/bones.svg";
const DAMAGE_SOURCE_MATCH_WINDOW_MS = 10 * 60 * 1000;
const processingMessages = new Set();
const processingItems = new Set();
let hooksRegistered = false;

const DAMAGE_TYPE_ALIASES = Object.freeze({
  impale: "i",
  impaling: "i",
  thrust: "i",
  thrusting: "i",
  cutandthrust: "ct",
  "cut-and-thrust": "ct",
  slash: "s",
  slashing: "s",
  crush: "c",
  crushing: "c",
  handtohand: "h",
  "hand-to-hand": "h"
});

/**
 * Register damage effect status catalog entries.
 *
 * @returns {void}
 */
export function registerDamageEffectStatusEffects() {
  registerStatusEffect(statusEffectConfig(IMPALED_STATUS_ID, IMPALED_EFFECT_NAME, IMPALED_EFFECT_ICON), {
    warning: "Unable to register Skjaldborg impaled status effect"
  });
  registerStatusEffect(statusEffectConfig(INJURY_STATUS_ID, INJURY_EFFECT_NAME, INJURY_EFFECT_ICON), {
    warning: "Unable to register Skjaldborg injury status effect"
  });
}

function localize(key) {
  return game.i18n.localize(key);
}

function format(key, data = {}) {
  return game.i18n.format(key, data);
}

function normalizeDamageType(value) {
  const source = String(value ?? "").trim().toLowerCase();
  const compact = source.replace(/[\s_]/g, "");
  return DAMAGE_TYPE_ALIASES[source] ?? DAMAGE_TYPE_ALIASES[compact] ?? source;
}

function weaponDamageType(weapon) {
  return normalizeDamageType(
    weapon?.system?.damType
      ?? weapon?.system?.damageType
      ?? weapon?.system?.damage_type
      ?? ""
  );
}

function participantActor(id, type) {
  const participantId = String(id ?? "");
  const participantType = String(type ?? "");
  if (!participantId) return null;
  if (participantType === "actor") return game.actors?.get?.(participantId) ?? null;
  if (participantType === "token") {
    return game.actors?.tokens?.[participantId]
      ?? canvas?.tokens?.placeables?.find?.(token => token?.document?.id === participantId)?.actor
      ?? canvas?.scene?.tokens?.get?.(participantId)?.actor
      ?? null;
  }
  return game.actors?.get?.(participantId) ?? null;
}

function actorItem(actor, itemId) {
  const id = String(itemId ?? "");
  if (!actor || !id) return null;
  return actor.items?.get?.(id)
    ?? (Array.isArray(actor.items) ? actor.items.find(item => item?.id === id) : null)
    ?? null;
}

async function actorFromSourceUuid(source, key, fallbackId, fallbackType) {
  const actor = await safeFromUuid(source?.[key]);
  return actor ?? participantActor(fallbackId, fallbackType);
}

function matchesDamageSource(source, card) {
  if (!source || source.resolved === true || !card) return false;
  const targetMatches = idTypeMatch(source.targetParticipantId, source.targetParticipantType, card.targetId, card.targetType)
    || idTypeMatch(source.targetActorId, "actor", card.targetId, card.targetType)
    || idTypeMatch(source.targetTokenId, "token", card.targetId, card.targetType);
  if (!targetMatches) return false;

  const attackerMatches = idTypeMatch(source.attackerParticipantId, source.attackerParticipantType, card.particId, card.particType)
    || idTypeMatch(source.attackerActorId, "actor", card.particId, card.particType)
    || idTypeMatch(source.attackerTokenId, "token", card.particId, card.particType);
  if (!attackerMatches) return false;

  const sourceWeaponId = String(source.weaponId ?? "");
  const cardWeaponId = String(card.skillId ?? "");
  return !sourceWeaponId || !cardWeaponId || sourceWeaponId === cardWeaponId;
}

function findDamageSource(message, card) {
  const direct = message.getFlag?.(MODULE_ID, DAMAGE_EFFECT_SOURCE_FLAG) ?? null;
  if (matchesDamageSource(direct, card)) return { message, source: direct };

  const [match = null] = recentFlaggedMessages({
    excludeMessage: message,
    flag: DAMAGE_EFFECT_SOURCE_FLAG,
    windowMs: DAMAGE_SOURCE_MATCH_WINDOW_MS,
    predicate: entry => matchesDamageSource(entry.flag, card)
  });
  return match ? { message: match.message, source: match.flag } : null;
}

function resolvedDamageType(card, weapon, source = null) {
  const sourceType = normalizeDamageType(source?.damageType);
  if (sourceType) return sourceType;
  const cardType = normalizeDamageType(card?.damType);
  if (cardType) return cardType;
  const weaponType = weaponDamageType(weapon);
  return weaponType === "ct" ? "i" : weaponType;
}

/**
 * Whether an AoV damage card qualifies for impalement tracking.
 *
 * @param {object} card AoV damage card.
 * @param {{weapon?: Item|object|null, source?: object|null}} [context={}] Context.
 * @returns {boolean}
 */
export function isImpalingDamageCard(card, { weapon = null, source = null } = {}) {
  const successLevel = String(card?.successLevel ?? "");
  if (!["3", "4"].includes(successLevel)) return false;
  if (numberOr(card?.rollVal, 0) <= 0) return false;
  if (!String(card?.targetLocID ?? card?.targetWpnId ?? "").trim()) return false;
  return resolvedDamageType(card, weapon, source) === "i";
}

/**
 * Compute single-blow injury threshold severity.
 *
 * @param {unknown} damage Final post-absorption damage.
 * @param {unknown} hitLocationHp Maximum HP in the hit location.
 * @returns {0|1|2|3}
 */
export function injurySeverity(damage, hitLocationHp) {
  const finalDamage = numberOr(damage, 0);
  const hpMax = numberOr(hitLocationHp, 0);
  if (finalDamage <= 0 || hpMax <= 0 || finalDamage < hpMax) return 0;
  if (finalDamage >= hpMax * 3) return 3;
  if (finalDamage >= hpMax * 2) return 2;
  return 1;
}

/**
 * Whether an incoming injury severity should create or update a tracker effect.
 *
 * @param {unknown} existingSeverity Current tracked severity.
 * @param {unknown} incomingSeverity Newly resolved severity.
 * @returns {boolean}
 */
export function shouldApplyInjurySeverity(existingSeverity, incomingSeverity) {
  const existing = numberOr(existingSeverity, 0);
  const incoming = numberOr(incomingSeverity, 0);
  return incoming > 0 && incoming > existing;
}

function locationKind(hitLocation) {
  const name = String(hitLocation?.name ?? "").toLowerCase();
  const locType = String(hitLocation?.system?.locType ?? "").toLowerCase();
  if (locType === "limb" || /\b(arm|leg)\b/u.test(name)) {
    return /\bleg\b/u.test(name) ? "leg" : (/\barm\b/u.test(name) ? "arm" : "limb");
  }
  if (/\babdomen\b/u.test(name)) return "abdomen";
  if (/\bchest\b/u.test(name)) return "chest";
  if (/\bhead\b/u.test(name)) return "head";
  return locType || "location";
}

/**
 * Localization key for one hit-location injury consequence.
 *
 * @param {Item|object|null} hitLocation Hit location item.
 * @param {1|2|3} severity Injury severity.
 * @returns {string}
 */
export function injuryDescriptionKey(hitLocation, severity) {
  const kind = locationKind(hitLocation);
  if (severity === 1) {
    if (kind === "leg") return "AOV_SKJALDBORG.DamageEffects.InjuryDescriptions.Leg1x";
    if (kind === "arm") return "AOV_SKJALDBORG.DamageEffects.InjuryDescriptions.Arm1x";
    if (kind === "abdomen") return "AOV_SKJALDBORG.DamageEffects.InjuryDescriptions.Abdomen1x";
    if (kind === "chest") return "AOV_SKJALDBORG.DamageEffects.InjuryDescriptions.Chest1x";
    if (kind === "head") return "AOV_SKJALDBORG.DamageEffects.InjuryDescriptions.Head1x";
    return "AOV_SKJALDBORG.DamageEffects.InjuryDescriptions.Location1x";
  }
  if (severity === 2) {
    if (["arm", "leg", "limb"].includes(kind)) return "AOV_SKJALDBORG.DamageEffects.InjuryDescriptions.Limb2x";
    return "AOV_SKJALDBORG.DamageEffects.InjuryDescriptions.Vital2x";
  }
  if (["arm", "leg", "limb"].includes(kind)) return "AOV_SKJALDBORG.DamageEffects.InjuryDescriptions.Limb3x";
  return "AOV_SKJALDBORG.DamageEffects.InjuryDescriptions.Vital3x";
}

function grossDamage(card) {
  const damageBeforeAbsorb = Number(card?.damageBeforeAbsorb);
  if (Number.isFinite(damageBeforeAbsorb)) return Math.max(0, damageBeforeAbsorb);
  return Math.max(0, numberOr(card?.rollVal, 0) + numberOr(card?.armourAbsorb, 0) + numberOr(card?.weaponAbsorb, 0));
}

function effectTargetKey(type, id) {
  return `${type}:${String(id ?? "")}`;
}

function collectionValues(collection) {
  if (!collection) return [];
  if (typeof collection.values === "function") return Array.from(collection.values());
  return Array.from(collection ?? []);
}

function changedPath(changed, path) {
  if (!changed || !path) return false;
  if (Object.hasOwn(changed, path)) return true;
  if (foundry.utils.getProperty(changed, path) !== undefined) return true;
  const parts = String(path).split(".");
  let value = changed;
  for (const part of parts) {
    if (!value || typeof value !== "object" || !(part in value)) return false;
    value = value[part];
  }
  return true;
}

function messageTracking(message) {
  return foundry.utils.deepClone(message?.getFlag?.(MODULE_ID, DAMAGE_EFFECT_TRACKING_FLAG) ?? {});
}

function cardByPending(message, pending) {
  return aovCards(message)[Number(pending?.damageCardIndex)] ?? pending?.card ?? null;
}

function hitLocationInjurySeverity(hitLocation) {
  return injuryThresholdSeverityFromEffects(hitLocation?.effects);
}

function existingInjuryEffect(hitLocation) {
  const targetKey = effectTargetKey("hitLocation", hitLocation?.id);
  return Array.from(hitLocation?.effects ?? []).find(effect => {
    const data = moduleFlag(effect, "injuryThreshold");
    return effectHasStatus(effect, INJURY_STATUS_ID) && data?.targetKey === targetKey;
  }) ?? null;
}

function processedEntryKey(index, card) {
  return [
    index,
    String(card?.targetLocID ?? ""),
    String(card?.targetWpnId ?? ""),
    String(card?.successLevel ?? ""),
    String(card?.rollVal ?? "")
  ].join("|");
}

async function applyImpaledEffect({ message, card, index, sourceMatch, targetActor, attackerActor, weapon, targetItem, stuckIn }) {
  const targetKey = effectTargetKey(stuckIn, targetItem.id);
  const locationName = targetItem?.name ?? String(card.targetLoc ?? "");
  const weaponName = weapon?.name ?? sourceMatch?.source?.weaponName ?? String(card.label ?? "");
  const description = format("AOV_SKJALDBORG.DamageEffects.ImpaledDescription", {
    target: locationName,
    weapon: weaponName || localize("AOV_SKJALDBORG.DamageEffects.UnknownWeapon")
  });
  const name = format("AOV_SKJALDBORG.DamageEffects.ImpaledName", { target: locationName });
  await upsertDocumentStatusEffect(targetItem, {
    statusId: IMPALED_STATUS_ID,
    name,
    img: IMPALED_EFFECT_ICON,
    description,
    useToggle: false,
    predicate: effect => {
      const data = moduleFlag(effect, "impalement");
      return effectHasStatus(effect, IMPALED_STATUS_ID) && data?.targetKey === targetKey;
    },
    moduleFlags: {
      impalement: {
        resolved: false,
        targetKey,
        stuckIn,
        sourceMessageId: sourceMatch?.message?.id ?? null,
        damageMessageId: message.id,
        damageCardIndex: index,
        createdAt: Date.now(),
        attackerActorUuid: attackerActor?.uuid ?? sourceMatch?.source?.attackerActorUuid ?? null,
        attackerActorId: attackerActor?.id ?? sourceMatch?.source?.attackerActorId ?? null,
        targetActorUuid: targetActor?.uuid ?? sourceMatch?.source?.targetActorUuid ?? null,
        targetActorId: targetActor?.id ?? sourceMatch?.source?.targetActorId ?? null,
        weaponUuid: weapon?.uuid ?? sourceMatch?.source?.weaponUuid ?? null,
        weaponId: weapon?.id ?? sourceMatch?.source?.weaponId ?? String(card.skillId ?? ""),
        weaponName,
        hitLocationId: stuckIn === "hitLocation" ? targetItem.id : "",
        hitLocationName: stuckIn === "hitLocation" ? locationName : "",
        targetWeaponId: stuckIn === "weapon" ? targetItem.id : "",
        targetWeaponName: stuckIn === "weapon" ? locationName : "",
        finalDamage: numberOr(card.rollVal, 0),
        grossDamage: grossDamage(card),
        successLevel: String(card.successLevel ?? ""),
        damageType: resolvedDamageType(card, weapon, sourceMatch?.source ?? null)
      }
    }
  });
  return { applied: true, type: "impalement", targetKey };
}

async function applyInjuryEffect({ message, card, index, targetActor, hitLocation }) {
  const severity = injurySeverity(card.rollVal, hitLocation?.system?.hpMax);
  if (!severity) return null;
  const existing = existingInjuryEffect(hitLocation);
  const existingSeverity = numberOr(moduleFlag(existing, "injuryThreshold")?.severity, 0);
  if (!shouldApplyInjurySeverity(existingSeverity, severity)) {
    return { applied: false, type: "injury", targetKey: effectTargetKey("hitLocation", hitLocation.id), severity: existingSeverity };
  }

  const targetKey = effectTargetKey("hitLocation", hitLocation.id);
  const name = format("AOV_SKJALDBORG.DamageEffects.InjuryName", {
    severity: `${severity}x`,
    target: hitLocation.name
  });
  const description = localize(injuryDescriptionKey(hitLocation, severity));
  await upsertDocumentStatusEffect(hitLocation, {
    statusId: INJURY_STATUS_ID,
    name,
    img: INJURY_EFFECT_ICON,
    description,
    useToggle: false,
    predicate: effect => {
      const data = moduleFlag(effect, "injuryThreshold");
      return effectHasStatus(effect, INJURY_STATUS_ID) && data?.targetKey === targetKey;
    },
    moduleFlags: {
      injuryThreshold: {
        targetKey,
        severity,
        sourceMessageId: message.id,
        damageMessageId: message.id,
        damageCardIndex: index,
        createdAt: Date.now(),
        targetActorUuid: targetActor?.uuid ?? null,
        targetActorId: targetActor?.id ?? null,
        hitLocationId: hitLocation.id,
        hitLocationName: hitLocation.name,
        locationKind: locationKind(hitLocation),
        finalDamage: numberOr(card.rollVal, 0),
        hitLocationHpMax: numberOr(hitLocation.system?.hpMax, 0)
      }
    }
  });
  return { applied: true, type: "injury", targetKey, severity };
}

async function resolveTrackingContext(message, card) {
  const sourceMatch = findDamageSource(message, card);
  const targetActor = await actorFromSourceUuid(sourceMatch?.source, "targetActorUuid", card.targetId, card.targetType);
  const attackerActor = await actorFromSourceUuid(sourceMatch?.source, "attackerActorUuid", card.particId, card.particType);
  const sourceWeapon = await safeFromUuid(sourceMatch?.source?.weaponUuid);
  const weapon = sourceWeapon ?? actorItem(attackerActor, String(card.skillId ?? sourceMatch?.source?.weaponId ?? ""));
  const targetWeaponId = String(card.targetWpnId ?? "");
  const targetLocationId = String(card.targetLocID ?? "");
  const targetWeapon = actorItem(targetActor, targetWeaponId);
  const locationOrEquipment = actorItem(targetActor, targetLocationId);
  const stuckIn = targetWeapon?.type === "weapon" ? "weapon" : (locationOrEquipment?.type === "weapon" ? "weapon" : "hitLocation");
  const impaleTargetItem = stuckIn === "weapon" ? (targetWeapon ?? locationOrEquipment) : locationOrEquipment;
  const hitLocation = locationOrEquipment?.type === "hitloc" ? locationOrEquipment : null;
  return { sourceMatch, targetActor, attackerActor, weapon, impaleTargetItem, stuckIn, hitLocation };
}

async function processDamageCard(message, card, index) {
  if (!String(card?.targetLocID ?? card?.targetWpnId ?? "").trim()) {
    return { status: "pending", reason: "target-location-unresolved", results: [] };
  }
  const context = await resolveTrackingContext(message, card);
  if (!context.targetActor) {
    return { status: "pending", reason: "target-actor-unavailable", results: [] };
  }
  const pending = {
    status: "pending",
    resolved: false,
    reason: "damage-application-pending",
    createdAt: Date.now(),
    damageMessageId: message.id,
    damageCardIndex: index,
    card: foundry.utils.deepClone(card),
    targetActorId: context.targetActor.id,
    targetActorUuid: context.targetActor.uuid ?? null,
    hitLocationId: context.hitLocation?.id ?? "",
    targetWeaponId: context.stuckIn === "weapon" ? context.impaleTargetItem?.id ?? "" : "",
    targetItemId: context.impaleTargetItem?.id ?? "",
    targetItemType: context.stuckIn,
    finalDamage: numberOr(card.rollVal, 0),
    grossDamage: grossDamage(card),
    injurySeverity: 0,
    impalementEligible: false
  };

  if (context.hitLocation) {
    pending.injurySeverity = injurySeverity(card.rollVal, context.hitLocation.system?.hpMax);
  } else if (String(card?.targetLocID ?? "").trim() && !context.impaleTargetItem) {
    return { status: "pending", reason: "hit-location-unavailable", results: [] };
  }
  if (context.impaleTargetItem && isImpalingDamageCard(card, { weapon: context.weapon, source: context.sourceMatch?.source ?? null })) {
    pending.impalementEligible = true;
  }

  if (!pending.injurySeverity && !pending.impalementEligible) {
    return { status: "skipped", reason: "no-threshold-or-impalement", results: [] };
  }

  return {
    status: "pending",
    reason: "damage-application-pending",
    pending,
    results: []
  };
}

function itemActor(item) {
  return item?.parent?.documentName === "Actor" ? item.parent : (item?.actor ?? item?.parent ?? null);
}

function pendingMatchesAppliedItem(pending, item, changed = {}) {
  const actor = itemActor(item);
  if (!actor || String(actor.id ?? "") !== String(pending?.targetActorId ?? "")) return false;
  if (item?.type === "wound") {
    return String(item.system?.hitLocId ?? "") === String(pending.hitLocationId ?? "");
  }
  if (item?.type === "hitloc") {
    if (!changedPath(changed, "system.npcDmg")) return false;
    const changedDamage = Number(foundry.utils.getProperty(changed, "system.npcDmg"));
    if (Number.isFinite(changedDamage) && changedDamage <= 0) return false;
    return String(item.id ?? "") === String(pending.hitLocationId ?? "");
  }
  if (item?.type === "weapon") {
    if (!changedPath(changed, "system.currHP")) return false;
    return String(item.id ?? "") === String(pending.targetWeaponId || pending.targetItemId || "");
  }
  return false;
}

function pendingTrackingEntriesForItem(item, changed = {}) {
  const entries = [];
  for (const message of collectionValues(ui?.chat?.collection ?? game?.messages)) {
    const tracking = message?.getFlag?.(MODULE_ID, DAMAGE_EFFECT_TRACKING_FLAG) ?? null;
    const cards = tracking?.cards ?? {};
    for (const [entryKey, pending] of Object.entries(cards)) {
      if (pending?.resolved === true || pending?.status !== "pending") continue;
      if (pendingMatchesAppliedItem(pending, item, changed)) entries.push({ message, entryKey, pending });
    }
  }
  return entries;
}

function appliedItemMatchScore(pending, item) {
  const appliedDamage = Number(item?.system?.damage);
  if (item?.type === "wound" && Number.isFinite(appliedDamage) && appliedDamage === Number(pending?.finalDamage)) return 0;
  return 1;
}

async function resolvePendingDamageEntry(message, entryKey, pending, appliedItem = null) {
  const tracking = messageTracking(message);
  const current = tracking.cards?.[entryKey];
  if (!current || current.resolved === true || current.status !== "pending") return null;

  const card = cardByPending(message, current);
  const context = await resolveTrackingContext(message, card);
  if (!context.targetActor) return null;
  const results = [];
  if (current.injurySeverity > 0 && context.hitLocation) {
    const injury = await applyInjuryEffect({ message, card, index: current.damageCardIndex, targetActor: context.targetActor, hitLocation: context.hitLocation });
    if (injury) results.push(injury);
  }
  if (current.impalementEligible && context.impaleTargetItem && isImpalingDamageCard(card, { weapon: context.weapon, source: context.sourceMatch?.source ?? null })) {
    results.push(await applyImpaledEffect({
      message,
      card,
      index: current.damageCardIndex,
      sourceMatch: context.sourceMatch,
      targetActor: context.targetActor,
      attackerActor: context.attackerActor,
      weapon: context.weapon,
      targetItem: context.impaleTargetItem,
      stuckIn: context.stuckIn
    }));
  }

  tracking.cards[entryKey] = {
    ...current,
    resolved: true,
    status: results.length ? "resolved" : "skipped",
    reason: results.length ? "" : "damage-applied-no-effect-created",
    resolvedAt: Date.now(),
    appliedItemUuid: appliedItem?.uuid ?? null,
    results
  };
  await guardedUpdate(message, {
    [`flags.${MODULE_ID}.${DAMAGE_EFFECT_TRACKING_FLAG}`]: tracking
  }, { category: "chat.damageEffectTracking" });
  return tracking.cards[entryKey];
}

async function handleMessageUpdate(message) {
  if (!game.user?.isGM) return;
  const key = String(message?.id ?? "");
  if (!key || processingMessages.has(key)) return;
  processingMessages.add(key);
  try {
    const cards = aovCards(message);
    if (!cards.some(card => card?.rollType === "DM")) return;
    const tracking = foundry.utils.deepClone(message.getFlag?.(MODULE_ID, DAMAGE_EFFECT_TRACKING_FLAG) ?? {});
    tracking.cards ??= {};
    let changed = false;
    for (let index = 0; index < cards.length; index += 1) {
      const card = cards[index];
      if (card?.rollType !== "DM" || numberOr(card.rollVal, 0) <= 0) continue;
      if (!String(card.targetLocID ?? card.targetWpnId ?? "").trim()) continue;
      const entryKey = processedEntryKey(index, card);
      if (tracking.cards[entryKey]?.resolved === true) continue;
      if (tracking.cards[entryKey]?.status === "pending") continue;
      const result = await processDamageCard(message, card, index);
      if (result.status === "pending") {
        tracking.cards[entryKey] = result.pending;
        changed = true;
        continue;
      }
      tracking.cards[entryKey] = {
        resolved: true,
        status: result.status,
        reason: result.reason,
        resolvedAt: Date.now(),
        damageCardIndex: index,
        results: result.results
      };
      changed = true;
    }
    if (changed) {
      await guardedUpdate(message, {
        [`flags.${MODULE_ID}.${DAMAGE_EFFECT_TRACKING_FLAG}`]: tracking
      }, { category: "chat.damageEffectTracking" });
    }
  } finally {
    processingMessages.delete(key);
  }
}

async function handleAppliedItemChange(item, changed = {}) {
  if (!game.user?.isGM) return;
  const key = String(item?.uuid ?? item?.id ?? "");
  if (!key || processingItems.has(key)) return;
  const entries = pendingTrackingEntriesForItem(item, changed);
  if (!entries.length) return;
  processingItems.add(key);
  try {
    const [entry] = entries.sort((a, b) => {
      const score = appliedItemMatchScore(a.pending, item) - appliedItemMatchScore(b.pending, item);
      if (score) return score;
      return Number(a.pending?.createdAt ?? 0) - Number(b.pending?.createdAt ?? 0);
    });
    await resolvePendingDamageEntry(entry.message, entry.entryKey, entry.pending, item);
  } finally {
    processingItems.delete(key);
  }
}

function hitLocationSeverityClass(severity) {
  const value = Math.trunc(Number(severity));
  return value >= 1 && value <= 3 ? `aov-skjaldborg-hitloc-injury-${value}` : "";
}

function cssEscape(value) {
  return globalThis.CSS?.escape?.(String(value ?? "")) ?? String(value ?? "").replace(/["\\]/g, "\\$&");
}

function hitLocationLabelElement(row) {
  return row?.querySelector?.(
    ".upper.rollable[data-action='viewDoc'], .indent.hit-loc-cell.rollable[data-action='viewDoc'], .rollable[data-action='viewDoc']"
  ) ?? null;
}

function decorateHitLocationInjurySeverity(application, element) {
  const root = element instanceof HTMLElement ? element : element?.[0] ?? null;
  const actor = application?.actor ?? (application?.document?.documentName === "Actor" ? application.document : null);
  if (!root || !actor?.items) return;
  for (const item of collectionValues(actor.items)) {
    if (item?.type !== "hitloc") continue;
    const severity = hitLocationInjurySeverity(item);
    const cssClass = hitLocationSeverityClass(severity);
    const itemId = cssEscape(item.id);
    const rows = root.querySelectorAll?.(
      `.hitlocCell[data-item-id="${itemId}"], .hitLocGridSmall[data-item-id="${itemId}"], .hitLocGridDev[data-item-id="${itemId}"], .hit-loc-row[data-item-id="${itemId}"]`
    ) ?? [];
    for (const row of rows) {
      row.classList.remove("aov-skjaldborg-hitloc-injury-1", "aov-skjaldborg-hitloc-injury-2", "aov-skjaldborg-hitloc-injury-3");
      const label = hitLocationLabelElement(row);
      label?.classList.remove("aov-skjaldborg-hitloc-injury-label");
      if (!cssClass) continue;
      row.classList.add(cssClass);
      row.dataset.skjInjurySeverity = String(severity);
      label?.classList.add("aov-skjaldborg-hitloc-injury-label");
    }
  }
}

/**
 * Register damage effect tracking hooks once.
 *
 * @returns {void}
 */
export function registerDamageEffectTrackingHooks() {
  if (hooksRegistered) return;
  hooksRegistered = true;
  Hooks.on("createChatMessage", message => {
    void handleMessageUpdate(message).catch(exception => warn(exception));
  });
  Hooks.on("updateChatMessage", message => {
    void handleMessageUpdate(message).catch(exception => warn(exception));
  });
  Hooks.on("createItem", item => {
    void handleAppliedItemChange(item).catch(exception => warn(exception));
  });
  Hooks.on("updateItem", (item, changed) => {
    void handleAppliedItemChange(item, changed).catch(exception => warn(exception));
  });
  Hooks.on("renderApplicationV2", (application, element) => {
    decorateHitLocationInjurySeverity(application, element);
  });
}

export const __test = {
  IMPALED_EFFECT_ICON,
  INJURY_EFFECT_ICON,
  DAMAGE_TYPE_ALIASES,
  grossDamage,
  handleMessageUpdate,
  handleAppliedItemChange,
  hitLocationInjurySeverity,
  hitLocationSeverityClass,
  injuryDescriptionKey,
  injurySeverity,
  isHooksRegistered: () => hooksRegistered,
  isImpalingDamageCard,
  matchesDamageSource,
  normalizeDamageType,
  processDamageCard,
  resolvedDamageType,
  shouldApplyInjurySeverity
};
