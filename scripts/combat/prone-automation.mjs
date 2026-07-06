import { IMMOBILIZED_STATUS_ID, MODULE_ID } from "../constants.mjs";
import { effectHasStatus, effectIsActive } from "../compat/active-effects.mjs";
import { actorItems, normalizeDescriptor, numberOr } from "../utils/document-data.mjs";
import { registerCombatRule } from "./rule-kernel.mjs";

export const PRONE_STATUS_ID = "prone";
export const CORE_IMMOBILIZED_STATUS_ID = "immobilized";
export const PRONE_ATTACK_PENALTY = -40;
export const DEFENSELESS_TARGET_BONUS = 40;

const NATURAL_WEAPON_OVERRIDE_FLAG = "proneNaturalWeapon";

const NATURAL_DAMAGE_DESCRIPTORS = Object.freeze(new Set([
  "natural",
  "naturalwpn",
  "handtohand",
  "handtohandweapons",
  "unarmed",
  "unarmedcombat",
  "fist",
  "fists",
  "kick",
  "kicks",
  "claw",
  "claws",
  "bite",
  "grapple"
]));

/**
 * Resolve the Actor that should be inspected for a token-scoped status.
 * Token Actor data is preferred so unlinked tokens do not collapse onto their
 * base Actor status collection.
 *
 * @param {Actor|object|null|undefined} actor Fallback Actor.
 * @param {Token|TokenDocument|object|null|undefined} [token=null] Candidate token or token document.
 * @returns {Actor|object|null}
 */
function statusActor(actor, token = null) {
  const document = token?.document ?? token ?? null;
  return document?.actor ?? actor ?? null;
}

/**
 * Test whether an Actor currently has an active status id.
 *
 * @param {Actor|object|null|undefined} actor Actor whose ActiveEffects are inspected.
 * @param {string} statusId Foundry status id.
 * @returns {boolean}
 */
export function actorHasActiveStatus(actor, statusId) {
  if (!actor || !statusId) return false;
  return Array.from(actor.effects ?? []).some(effect => effectIsActive(effect) && effectHasStatus(effect, statusId));
}

/**
 * Whether a participant is currently Prone.
 *
 * @param {Actor|object|null|undefined} actor Fallback Actor.
 * @param {Token|TokenDocument|object|null|undefined} [token=null] Candidate token or token document.
 * @returns {boolean}
 */
export function participantIsProne(actor, token = null) {
  return actorHasActiveStatus(statusActor(actor, token), PRONE_STATUS_ID);
}

/**
 * Whether a participant is currently immobilized by either the module-owned
 * status id or a core/system status id named "immobilized".
 *
 * @param {Actor|object|null|undefined} actor Fallback Actor.
 * @param {Token|TokenDocument|object|null|undefined} [token=null] Candidate token or token document.
 * @returns {boolean}
 */
export function participantIsImmobilized(actor, token = null) {
  const owner = statusActor(actor, token);
  return actorHasActiveStatus(owner, IMMOBILIZED_STATUS_ID) || actorHasActiveStatus(owner, CORE_IMMOBILIZED_STATUS_ID);
}

/**
 * Whether a weapon should keep its natural-weapon damage modifier exception
 * while the attacker is prone.
 *
 * AoV data distinguishes intrinsic natural weapons by `weaponType`, while many
 * unarmed attacks are authored as hand-to-hand weapons. The RAW exception cites
 * fists, kicks, claws, etc., so this helper accepts both explicit natural
 * descriptors and hand-to-hand/unarmed descriptors.
 *
 * @param {Item|object|null|undefined} weapon Candidate weapon Item.
 * @returns {boolean}
 */
function explicitNaturalWeaponOverride(weapon) {
  const value = weapon?.getFlag?.(MODULE_ID, NATURAL_WEAPON_OVERRIDE_FLAG)
    ?? weapon?.flags?.[MODULE_ID]?.[NATURAL_WEAPON_OVERRIDE_FLAG]
    ?? null;
  return typeof value === "boolean" ? value : null;
}

export function isProneNaturalDamageWeapon(weapon) {
  if (weapon?.type !== "weapon") return false;
  const override = explicitNaturalWeaponOverride(weapon);
  if (override !== null) return override;
  const descriptors = [
    weapon.system?.weaponType,
    weapon.system?.weaponCat,
    weapon.system?.weaponCatName,
    weapon.name
  ].map(normalizeDescriptor).filter(Boolean);
  return descriptors.some(descriptor => {
    if (NATURAL_DAMAGE_DESCRIPTORS.has(descriptor)) return true;
    return descriptor.includes("natural")
      || descriptor.includes("handtohand")
      || descriptor.includes("unarmed");
  });
}

function hitLocations(actor) {
  return actorItems(actor).filter(item => item?.type === "hitloc" && item.system?.locType !== "general");
}

function humanoidLocationNames(actor) {
  return hitLocations(actor).map(item => normalizeDescriptor(item.name));
}

/**
 * Best-effort humanoid test for the RAW 1D10 prone-attacker hit-location rule.
 *
 * AoV does not expose a dedicated creature-shape field. Characters are treated
 * as humanoid. NPCs qualify only when their hit-location names look like a
 * humanoid table, which avoids applying the rule to arbitrary creature tables.
 *
 * @param {Actor|object|null|undefined} actor Target Actor.
 * @returns {boolean}
 */
export function actorUsesHumanoidHitLocations(actor) {
  if (!actor) return false;
  if (actor.type === "character") return true;
  const names = humanoidLocationNames(actor);
  if (names.length < 5) return false;
  const hasHead = names.some(name => name.includes("head"));
  const hasArm = names.some(name => name.includes("arm"));
  const hasLeg = names.some(name => name.includes("leg"));
  const hasTorso = names.some(name => name.includes("chest") || name.includes("abdomen") || name.includes("torso") || name.includes("body"));
  return hasHead && hasArm && hasLeg && hasTorso;
}

/**
 * Build the RAW attack-chance modifier caused by Prone/grounded participants.
 *
 * Rules implemented here are chance modifiers only:
 * - an attacker on the ground suffers -40% to attacks;
 * - an attacker gains +40% to hit an opponent on the ground or immobilized;
 * - parry remains unmodified, so this helper is used only by attack creation.
 *
 * @param {object} context Modifier context.
 * @param {Actor|object|null} [context.attackerActor] Attacker Actor.
 * @param {Token|TokenDocument|object|null} [context.attackerToken] Attacker Token/TokenDocument.
 * @param {Actor|object|null} [context.targetActor] Target Actor.
 * @param {Token|TokenDocument|object|null} [context.targetToken] Target Token/TokenDocument.
 * @returns {{total: number, attackerPenalty: number, targetBonus: number, attackerProne: boolean, targetProne: boolean, targetImmobilized: boolean, modifiers: object[]}}
 */
export function proneAttackModifierContext({
  attackerActor = null,
  attackerToken = null,
  targetActor = null,
  targetToken = null
} = {}) {
  const attackerProne = participantIsProne(attackerActor, attackerToken);
  const targetProne = participantIsProne(targetActor, targetToken);
  const targetImmobilized = participantIsImmobilized(targetActor, targetToken);
  const attackerPenalty = attackerProne ? PRONE_ATTACK_PENALTY : 0;
  const targetBonus = (targetProne || targetImmobilized) ? DEFENSELESS_TARGET_BONUS : 0;
  const modifiers = [];

  if (attackerPenalty) {
    modifiers.push({
      key: "attackerProne",
      value: attackerPenalty,
      statusId: PRONE_STATUS_ID,
      labelKey: "AOV_SKJALDBORG.ProneAutomation.AttackerPronePenalty"
    });
  }
  if (targetBonus) {
    modifiers.push({
      key: targetProne ? "targetProne" : "targetImmobilized",
      value: targetBonus,
      statusId: targetProne ? PRONE_STATUS_ID : IMMOBILIZED_STATUS_ID,
      labelKey: targetProne
        ? "AOV_SKJALDBORG.ProneAutomation.TargetProneBonus"
        : "AOV_SKJALDBORG.ProneAutomation.TargetImmobilizedBonus"
    });
  }

  return {
    total: modifiers.reduce((sum, entry) => sum + numberOr(entry.value, 0), 0),
    attackerPenalty,
    targetBonus,
    attackerProne,
    targetProne,
    targetImmobilized,
    modifiers
  };
}

/**
 * Build the RAW downstream damage and hit-location rules caused by a prone
 * attacker.
 *
 * @param {object} context Rule context.
 * @param {Actor|object|null} [context.attackerActor] Attacker Actor.
 * @param {Token|TokenDocument|object|null} [context.attackerToken] Attacker Token/TokenDocument.
 * @param {Actor|object|null} [context.targetActor] Target Actor.
 * @param {Token|TokenDocument|object|null} [context.targetToken] Target Token/TokenDocument.
 * @param {Item|object|null} [context.weapon] Attack weapon.
 * @param {boolean} [context.aimed=false] Whether a fixed/aimed location was selected.
 * @returns {{attackerProne: boolean, targetProne: boolean, targetHumanoid: boolean, targetStandingHumanoid: boolean, naturalWeapon: boolean, suppressDamageModifier: boolean, basicWeaponDamageOnly: boolean, oneDieHitLocation: boolean, hitLocationFormula: string, reason: string}}
 */
export function proneDamageContext({
  attackerActor = null,
  attackerToken = null,
  targetActor = null,
  targetToken = null,
  weapon = null,
  aimed = false
} = {}) {
  const attackerProne = participantIsProne(attackerActor, attackerToken);
  const targetProne = participantIsProne(targetActor, targetToken);
  const targetHumanoid = actorUsesHumanoidHitLocations(targetActor);
  const targetStandingHumanoid = targetHumanoid && !targetProne;
  const naturalWeapon = isProneNaturalDamageWeapon(weapon);
  const basicWeaponDamageOnly = attackerProne && !naturalWeapon;
  return {
    attackerProne,
    targetProne,
    targetHumanoid,
    targetStandingHumanoid,
    naturalWeapon,
    suppressDamageModifier: basicWeaponDamageOnly,
    basicWeaponDamageOnly,
    oneDieHitLocation: attackerProne && targetStandingHumanoid && aimed !== true,
    hitLocationFormula: "1D10",
    reason: attackerProne ? "prone-attacker" : ""
  };
}

/**
 * Return a primitive-only modifier payload suitable for chat message flags.
 *
 * @param {object|null|undefined} context Output of proneAttackModifierContext.
 * @returns {object|null}
 */
export function serializeProneAttackModifierContext(context) {
  if (!context || typeof context !== "object") return null;
  return {
    total: numberOr(context.total, 0),
    attackerPenalty: numberOr(context.attackerPenalty, 0),
    targetBonus: numberOr(context.targetBonus, 0),
    attackerProne: context.attackerProne === true,
    targetProne: context.targetProne === true,
    targetImmobilized: context.targetImmobilized === true,
    modifiers: Array.isArray(context.modifiers)
      ? context.modifiers.map(entry => ({
          key: String(entry?.key ?? ""),
          value: numberOr(entry?.value, 0),
          statusId: String(entry?.statusId ?? ""),
          labelKey: String(entry?.labelKey ?? "")
        }))
      : []
  };
}

/**
 * Return a primitive-only downstream damage/hit-location payload suitable for
 * chat message flags.
 *
 * @param {object|null|undefined} context Output of proneDamageContext.
 * @returns {object|null}
 */
export function serializeProneDamageContext(context) {
  if (!context || typeof context !== "object") return null;
  return {
    attackerProne: context.attackerProne === true,
    targetProne: context.targetProne === true,
    targetHumanoid: context.targetHumanoid === true,
    targetStandingHumanoid: context.targetStandingHumanoid === true,
    naturalWeapon: context.naturalWeapon === true,
    suppressDamageModifier: context.suppressDamageModifier === true,
    basicWeaponDamageOnly: context.basicWeaponDamageOnly === true,
    oneDieHitLocation: context.oneDieHitLocation === true,
    hitLocationFormula: String(context.hitLocationFormula ?? "1D10"),
    reason: String(context.reason ?? "")
  };
}

registerCombatRule({
  id: "prone",
  priority: 100,
  prepareAttackContext(context) {
    const rules = proneAttackModifierContext(context);
    context.proneRules = rules;
    context.proneModifier = rules.total;
    context.ruleMetadata.prone = {
      ...(context.ruleMetadata.prone ?? {}),
      attackModifier: rules.total
    };
    return {
      attackModifier: rules.total,
      attackerProne: rules.attackerProne,
      targetProne: rules.targetProne,
      targetImmobilized: rules.targetImmobilized
    };
  },
  prepareDamageContext(context) {
    const rules = proneDamageContext(context);
    context.proneDamageRules = rules;
    context.ruleMetadata.prone = {
      ...(context.ruleMetadata.prone ?? {}),
      damageRules: serializeProneDamageContext(rules)
    };
    return serializeProneDamageContext(rules);
  },
  prepareHitLocationContext(context) {
    const rules = context.proneDamageRules ?? proneDamageContext(context);
    context.proneDamageRules = rules;
    return {
      oneDieHitLocation: rules.oneDieHitLocation === true,
      hitLocationFormula: rules.hitLocationFormula
    };
  }
});
