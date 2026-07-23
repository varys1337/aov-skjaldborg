import { ACTION_CATEGORIES, INTENT_STATUS } from "../constants.mjs";
import { cleanString, cleanStringArray } from "../utils/document-data.mjs";
import { cleanTargetRefs } from "../combat/runic-magic-data.mjs";

export function cleanPositiveNumber(value) {
  if (value === "" || value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

export function cleanFiniteNumber(value) {
  if (value === "" || value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function cleanNonNegativeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, number) : 0;
}

export function cleanDocumentId(value, maxLength = 100) {
  return cleanString(value, maxLength);
}

export function cleanActionCategory(value) {
  const category = cleanString(value, 40);
  if (!category) return ACTION_CATEGORIES.ATTACK;
  if (category === "flee") return ACTION_CATEGORIES.RETREAT;
  return Object.values(ACTION_CATEGORIES).includes(category) ? category : ACTION_CATEGORIES.OTHER;
}

export function cleanIntentStatus(value) {
  return value === INTENT_STATUS.HELD ? INTENT_STATUS.HELD : INTENT_STATUS.COMMITTED;
}

export function sanitizeSocketPayload(payload = {}) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return {};
  return { ...payload };
}

export function sanitizeCombatantWritePayload(payload = {}) {
  const source = sanitizeSocketPayload(payload);
  return {
    ...source,
    combatId: cleanDocumentId(source.combatId),
    combatantId: cleanDocumentId(source.combatantId),
    expectedCombatUpdatedAt: cleanFiniteNumber(source.expectedCombatUpdatedAt),
    expectedCombatantUpdatedAt: cleanFiniteNumber(source.expectedCombatantUpdatedAt)
  };
}

export function sanitizeCombatWritePayload(payload = {}) {
  const source = sanitizeSocketPayload(payload);
  return {
    ...source,
    combatId: cleanDocumentId(source.combatId),
    combatantId: cleanDocumentId(source.combatantId),
    expectedCombatUpdatedAt: cleanFiniteNumber(source.expectedCombatUpdatedAt),
    expectedCombatantUpdatedAt: cleanFiniteNumber(source.expectedCombatantUpdatedAt),
    actionId: cleanDocumentId(source.actionId),
    attackerCombatantId: cleanDocumentId(source.attackerCombatantId),
    targetCombatantId: cleanDocumentId(source.targetCombatantId)
  };
}

export function sanitizeCommitIntentPayload(payload = {}) {
  const source = sanitizeCombatantWritePayload(payload);
  return {
    ...source,
    intent: {
      status: cleanIntentStatus(source.intent?.status),
      actionCategory: cleanActionCategory(source.intent?.actionCategory),
      publicText: cleanString(source.intent?.publicText),
      privateText: cleanString(source.intent?.privateText),
      modifiers: {
        drawWeapon: source.intent?.modifiers?.drawWeapon === true,
        sheatheWeapon: source.intent?.modifiers?.sheatheWeapon === true,
        surprised: source.intent?.modifiers?.surprised === true,
        fullMove: source.intent?.modifiers?.fullMove === true
      },
      delay: {
        enabled: source.intent?.delay?.enabled === true,
        targetDex: cleanPositiveNumber(source.intent?.delay?.targetDex),
        targetCombatantId: cleanDocumentId(source.intent?.delay?.targetCombatantId) || null,
        position: ["before", "after"].includes(source.intent?.delay?.position) ? source.intent.delay.position : "",
        tiebreakerInt: cleanFiniteNumber(source.intent?.delay?.tiebreakerInt)
      },
      waitInterrupt: {
        enabled: source.intent?.waitInterrupt?.enabled === true,
        text: cleanString(source.intent?.waitInterrupt?.text)
      },
      splitCount: Math.max(1, Math.min(4, Number.parseInt(source.intent?.splitCount ?? 1, 10) || 1)),
      fixedRank: cleanPositiveNumber(source.intent?.fixedRank),
      runeCarryover: source.intent?.runeCarryover === true
    }
  };
}

export function sanitizeMovementWritePayload(payload = {}) {
  const source = sanitizeCombatantWritePayload(payload);
  return {
    ...source,
    movement: sanitizeSocketPayload(source.movement)
  };
}

export function sanitizeRunicMagicPayload(payload = {}) {
  const source = sanitizeCombatantWritePayload(payload);
  return {
    ...source,
    magicMode: cleanString(source.magicMode, 40),
    itemId: cleanDocumentId(source.itemId),
    itemType: cleanString(source.itemType, 40),
    dexPenalty: Math.max(1, Math.round(Number(source.dexPenalty) || 1)),
    flatMod: Math.round(Number(source.flatMod) || 0),
    customModifierReason: cleanString(source.customModifierReason, 120),
    craftEnabled: source.craftEnabled === true,
    craftMode: cleanString(source.craftMode, 40),
    craftSkillId: cleanDocumentId(source.craftSkillId),
    customCraftTarget: Math.max(1, Math.round(Number(source.customCraftTarget) || 0)),
    prepared: source.prepared === true,
    alreadyCarved: source.alreadyCarved === true,
    resistance: source.resistance === true,
    casterTokenUuid: cleanString(source.casterTokenUuid, 200),
    targetRefs: cleanTargetRefs(source.targetRefs)
  };
}

export function sanitizeDisengagementPayload(payload = {}) {
  const source = sanitizeCombatantWritePayload(payload);
  return {
    ...source,
    method: cleanString(source.method, 40),
    partnerIds: cleanStringArray(source.partnerIds, 100),
    opportunityAttackerId: cleanDocumentId(source.opportunityAttackerId) || null,
    opportunityAttackerIds: cleanStringArray(source.opportunityAttackerIds, 100),
    opportunityMode: cleanString(source.opportunityMode, 20)
  };
}

export function sanitizePromptDefensePayload(payload = {}) {
  const source = sanitizeSocketPayload(payload);
  return {
    attackMessageId: cleanDocumentId(source.attackMessageId) || null,
    tokenUuid: cleanString(source.tokenUuid ?? source.targetTokenUuid, 200),
    actorUuid: cleanString(source.actorUuid ?? source.targetActorUuid, 200),
    incomingWeaponType: cleanString(source.incomingWeaponType, 80)
  };
}

export function sanitizeCommitDefensePayload(payload = {}) {
  const source = sanitizeSocketPayload(payload);
  const actionOption = cleanString(source.actionOption, 40);
  return {
    attackMessageId: cleanDocumentId(source.attackMessageId) || null,
    tokenUuid: cleanString(source.tokenUuid ?? source.targetTokenUuid, 200),
    actorUuid: cleanString(source.actorUuid ?? source.targetActorUuid, 200),
    actionOption: ["none", "dodge", "parry"].includes(actionOption) ? actionOption : "none",
    checkBonus: Math.round(Number(source.checkBonus) || 0),
    itemId: cleanDocumentId(source.itemId) || null
  };
}
