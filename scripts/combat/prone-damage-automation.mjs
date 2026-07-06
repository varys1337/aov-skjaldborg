/**
 * Prone RAW downstream damage and hit-location automation.
 *
 * AoV's Combat Card remains the core workflow owner. Skjaldborg intercepts the
 * damage button only when a source attack card carries prone downstream rules,
 * then delegates the actual roll creation back through AoV's documented module
 * entry points after applying the RAW modifier suppression to the roll config.
 */
import { MODULE_ID } from "../constants.mjs";
import { AoVAdapter } from "../adapter/aov-adapter.mjs";
import { warn } from "../logger.mjs";
import { incrementCounter } from "../performance/performance-monitor.mjs";
import { guardedModuleFlag, guardedUpdate } from "../utils/guarded-document-writes.mjs";
import {
  actorFromAoVParticipant,
  aovCards,
  autoDamageEnabled,
  grossDamage,
  idTypeMatch,
  locationArmor,
  resolveChatMessageElement,
  safeFromUuid,
  showDice3dForRoll
} from "./automation-helpers.mjs";

const PRONE_SOURCE_FLAG = "proneAttackModifier";
const PRONE_DAMAGE_FLAG = "proneDamageRules";

let hooksRegistered = false;
const resolvingProneDamageMessages = new Set();

function primitiveRules(rules) {
  if (!rules || typeof rules !== "object") return null;
  return {
    attackerProne: rules.attackerProne === true,
    targetProne: rules.targetProne === true,
    targetHumanoid: rules.targetHumanoid === true,
    targetStandingHumanoid: rules.targetStandingHumanoid === true,
    naturalWeapon: rules.naturalWeapon === true,
    suppressDamageModifier: rules.suppressDamageModifier === true,
    basicWeaponDamageOnly: rules.basicWeaponDamageOnly === true || (rules.suppressDamageModifier === true && rules.naturalWeapon !== true),
    oneDieHitLocation: rules.oneDieHitLocation === true,
    hitLocationFormula: String(rules.hitLocationFormula ?? "1D10"),
    reason: String(rules.reason ?? "")
  };
}

export function shouldApplyProneDamageRules(sourceFlag) {
  const rules = primitiveRules(sourceFlag?.damageRules ?? sourceFlag);
  return rules?.suppressDamageModifier === true
    || rules?.basicWeaponDamageOnly === true
    || rules?.oneDieHitLocation === true;
}

function sourceFlagForDamageButton(message, button) {
  const sourceFlag = message?.getFlag?.(MODULE_ID, PRONE_SOURCE_FLAG) ?? null;
  if (!shouldApplyProneDamageRules(sourceFlag)) return null;
  const cards = aovCards(message);
  const index = Number(button?.dataset?.card ?? 0);
  const card = cards[Number.isInteger(index) ? index : 0] ?? cards[0] ?? null;
  if (!card || card.rollType !== "WP") return null;
  return { sourceFlag, card, index: Number.isInteger(index) ? index : 0 };
}

async function resolveFlaggedActorAndToken(flag, actorId, actorType) {
  const token = await safeFromUuid(flag?.attackerTokenUuid) ?? null;
  const actor = token?.actor
    ?? await safeFromUuid(flag?.attackerActorUuid)
    ?? actorFromAoVParticipant(actorId, actorType);
  return { actor, token };
}

function damageConfigFromSource(source, actor, token, button, event, rules) {
  return AoVAdapter.normalizeAovCheckRequest({
    rollType: "DAMAGE",
    cardType: "UNOPPOSED",
    shiftKey: rules?.basicWeaponDamageOnly === true ? true : Boolean(event?.shiftKey),
    actor,
    token: token ?? actor?.token ?? null,
    characteristic: false,
    combatAction: source.card.combatAction,
    skillId: source.card.skillId,
    targetId: source.card.targetId,
    targetType: source.card.targetType,
    targetWpnId: button?.dataset?.targetWpnId ?? source.card.targetWpnId,
    successLevel: String(source.card.successLevel ?? "99"),
    wpnBlock: source.card.wpnBlock,
    wpnDam: source.card.wpnDam,
    armourBlock: source.card.armourBlock,
    damageCF: source.card.damageCF,
    origID: source.card.origID
  });
}

function applyProneDamageSuppressionToConfig(config, rules) {
  const next = config;
  if (rules?.suppressDamageModifier === true) {
    next.db = "0";
    next.dbLabel = "n";
    next.damBonus = 0;
    next.proneDamageModifierSuppressed = true;
  }
  if (rules?.basicWeaponDamageOnly === true) {
    next.successLevel = "2";
    next.shiftKey = true;
    next.proneBasicWeaponDamageOnly = true;
    next.proneBasicDamageCapApplied = true;
  }
  return next;
}

async function markDamageMessage(messageId, sourceMessage, source, rules) {
  const message = game.messages?.get?.(messageId) ?? null;
  if (!message?.setFlag) return null;
  await guardedModuleFlag(message, PRONE_DAMAGE_FLAG, {
    ...primitiveRules(rules),
    resolved: false,
    createdAt: Date.now(),
    sourceMessageId: sourceMessage?.id ?? null,
    sourceCardIndex: source.index,
    attackerActorUuid: source.sourceFlag.attackerActorUuid ?? null,
    attackerActorId: source.sourceFlag.attackerActorId ?? null,
    attackerTokenUuid: source.sourceFlag.attackerTokenUuid ?? null,
    attackerTokenId: source.sourceFlag.attackerTokenId ?? null,
    attackerParticipantId: source.sourceFlag.attackerParticipantId ?? source.card.particId ?? null,
    attackerParticipantType: source.sourceFlag.attackerParticipantType ?? source.card.particType ?? null,
    weaponUuid: source.sourceFlag.weaponUuid ?? null,
    weaponId: source.sourceFlag.weaponId ?? source.card.skillId ?? null,
    targetActorUuid: source.sourceFlag.targetActorUuid ?? null,
    targetActorId: source.sourceFlag.targetActorId ?? null,
    targetTokenUuid: source.sourceFlag.targetTokenUuid ?? null,
    targetTokenId: source.sourceFlag.targetTokenId ?? null,
    targetParticipantId: source.sourceFlag.targetParticipantId ?? source.card.targetId ?? null,
    targetParticipantType: source.sourceFlag.targetParticipantType ?? source.card.targetType ?? null
  }, { category: "chat.proneDamageFlag" });
  if (sourceMessage?.update) {
    await guardedUpdate(sourceMessage, {
      [`flags.${MODULE_ID}.${PRONE_SOURCE_FLAG}.damageMessageId`]: message.id,
      [`flags.${MODULE_ID}.${PRONE_SOURCE_FLAG}.damageResolvedAt`]: Date.now()
    }, { category: "chat.proneSourceLink" });
  }
  return message;
}

async function resolveCoreDamageButton(sourceMessage, button, event, source) {
  const rules = primitiveRules(source.sourceFlag.damageRules);
  const { actor, token } = await resolveFlaggedActorAndToken(source.sourceFlag, source.card.particId, source.card.particType);
  if (!actor) throw new Error(game.i18n.localize("AOV_SKJALDBORG.Warnings.ActorUnavailable"));

  const config = await damageConfigFromSource(source, actor, token, button, event, rules);
  if (!config) return false;
  applyProneDamageSuppressionToConfig(config, rules);
  const messageId = await AoVAdapter.startAovCheck(config);
  if (messageId === false) return false;
  const damageMessage = await markDamageMessage(messageId, sourceMessage, source, rules);
  if (damageMessage) await resolveProneDamageMessage(damageMessage);

  const resolveConfig = {
    presetType: String(button?.dataset?.preset ?? "damage-card"),
    targetChatId: sourceMessage.id,
    origin: game.user?.id ?? null,
    originGM: game.user?.isGM ?? false,
    event,
    dataset: button?.dataset ?? {},
    targetWpnId: button?.dataset?.targetWpnId ?? source.card.targetWpnId ?? ""
  };
  if (game.user?.isGM) await AoVAdapter.resolveAovDamage(resolveConfig);
  else {
    const availableGM = game.users?.find?.(user => user.active && user.isGM)?.id ?? null;
    if (availableGM) {
      game.socket.emit("system.aov", {
        type: "resolveDam",
        to: availableGM,
        value: { config: resolveConfig }
      });
    } else ui.notifications.warn(game.i18n.localize("AOV.noAvailableGM"));
  }
  return true;
}

function findDamageLocationCard(message) {
  const cards = aovCards(message);
  const index = cards.findIndex(card => (
    card?.rollType === "DM"
    && card.damageCF === true
    && grossDamage(card) > 0
    && !String(card.targetLocID ?? "").trim()
  ));
  return index >= 0 ? { card: cards[index], index } : null;
}

function damageCardMatchesRules(rules, card) {
  if (!rules || rules.resolved === true) return false;
  const targetMatches = idTypeMatch(rules.targetParticipantId, rules.targetParticipantType, card.targetId, card.targetType)
    || idTypeMatch(rules.targetActorId, "actor", card.targetId, card.targetType)
    || idTypeMatch(rules.targetTokenId, "token", card.targetId, card.targetType);
  if (!targetMatches) return false;

  const attackerMatches = idTypeMatch(rules.attackerParticipantId, rules.attackerParticipantType, card.particId, card.particType)
    || idTypeMatch(rules.attackerActorId, "actor", card.particId, card.particType)
    || idTypeMatch(rules.attackerTokenId, "token", card.particId, card.particType);
  if (!attackerMatches) return false;

  const weaponId = String(rules.weaponId ?? "");
  const skillId = String(card.skillId ?? "");
  return !weaponId || !skillId || weaponId === skillId;
}

async function targetActorFromRules(rules, card) {
  return await safeFromUuid(rules.targetActorUuid)
    ?? actorFromAoVParticipant(card.targetId, card.targetType);
}

function hitLocationItems(actor) {
  const items = actor?.items;
  const values = typeof items?.values === "function" ? Array.from(items.values()) : Array.from(items ?? []);
  return values.filter(item => item?.type === "hitloc" && item.system?.locType !== "general");
}

export function hitLocationForRoll(actor, rollResult) {
  const result = Number(rollResult);
  if (!Number.isFinite(result)) return null;
  return hitLocationItems(actor).find(item => {
    const low = Number(item.system?.lowRoll);
    const high = Number(item.system?.highRoll);
    return Number.isFinite(low) && Number.isFinite(high) && result >= low && result <= high;
  }) ?? null;
}

function applyHitLocationToCard(chatCard, targetActor, hitLocation, rollResult) {
  const next = { ...chatCard };
  const armor = locationArmor(targetActor, hitLocation);
  next.targetLoc = `${hitLocation.name} (${targetActor.name}) (${rollResult})`;
  next.targetLocID = hitLocation.id ?? hitLocation._id ?? "";
  if (next.armourBlock) {
    const currentDamage = Number(next.rollVal);
    const damage = Number.isFinite(currentDamage) ? currentDamage : 0;
    next.armourAbsorb = Math.min(damage, armor);
    next.rollVal = damage - next.armourAbsorb;
  }
  return next;
}

async function rerenderAoVMessage(message) {
  const refreshed = game.messages?.get?.(message.id) ?? message;
  const content = await AoVAdapter.createAovCombatCard(refreshed.flags.aov);
  await guardedUpdate(refreshed, { content }, { category: "chat.aovRerender" });
}

function collectionValues(source) {
  if (!source) return [];
  if (Array.isArray(source)) return source;
  if (Array.isArray(source.contents)) return source.contents;
  if (typeof source.values === "function") return Array.from(source.values());
  return Array.from(source).map(entry => Array.isArray(entry) ? entry[1] : entry).filter(Boolean);
}

function authoritativeGmUser() {
  return collectionValues(game.users).find(user => user?.active === true && user?.isGM === true) ?? null;
}

function isAuthoritativeGmClient() {
  if (game.user?.isGM !== true) return false;
  const authoritative = authoritativeGmUser();
  return !authoritative || authoritative.id === game.user.id;
}

export async function resolveProneDamageMessage(message) {
  if (!isAuthoritativeGmClient()) return false;
  const messageKey = String(message?.uuid ?? message?.id ?? message?._id ?? "");
  if (!messageKey || resolvingProneDamageMessages.has(messageKey)) return false;
  let rules = message?.getFlag?.(MODULE_ID, PRONE_DAMAGE_FLAG) ?? null;
  if (rules?.oneDieHitLocation !== true || rules.hitLocationResolved === true || rules.resolved === true) return false;
  resolvingProneDamageMessages.add(messageKey);
  try {
    const latestMessage = game.messages?.get?.(message.id) ?? message;
    rules = latestMessage?.getFlag?.(MODULE_ID, PRONE_DAMAGE_FLAG) ?? rules;
    if (rules?.oneDieHitLocation !== true || rules.hitLocationResolved === true || rules.resolved === true) return false;
    const located = findDamageLocationCard(latestMessage);
    if (!located || !damageCardMatchesRules(rules, located.card)) return false;
    const targetActor = await targetActorFromRules(rules, located.card);
    if (!targetActor) return false;

    const formula = String(rules.hitLocationFormula ?? "1D10") || "1D10";
    const roll = await new Roll(formula).evaluate();
    await showDice3dForRoll(roll, "Dice So Nice hit-location roll display failed for Skjaldborg prone automation.");
    const rollResult = Number(roll.total);
    const hitLocation = hitLocationForRoll(targetActor, rollResult);
    if (hitLocation?.type !== "hitloc") {
      ui.notifications.warn(game.i18n.localize("AOV.noSelectableLocations"));
      return false;
    }

    const cards = foundry.utils.deepClone(aovCards(latestMessage));
    const chatCard = cards[located.index] ?? null;
    if (!chatCard || String(chatCard.targetLocID ?? "").trim()) return false;
    cards[located.index] = applyHitLocationToCard(chatCard, targetActor, hitLocation, rollResult);
    await guardedUpdate(latestMessage, {
      "flags.aov.chatCard": cards,
      "flags.aov.state": autoDamageEnabled() ? "applyDmg" : "closed",
      [`flags.${MODULE_ID}.${PRONE_DAMAGE_FLAG}.resolved`]: true,
      [`flags.${MODULE_ID}.${PRONE_DAMAGE_FLAG}.hitLocationResolved`]: true,
      [`flags.${MODULE_ID}.${PRONE_DAMAGE_FLAG}.hitLocationRoll`]: rollResult,
      [`flags.${MODULE_ID}.${PRONE_DAMAGE_FLAG}.targetLocID`]: hitLocation.id ?? hitLocation._id ?? null,
      [`flags.${MODULE_ID}.${PRONE_DAMAGE_FLAG}.targetLocName`]: hitLocation.name ?? "",
      [`flags.${MODULE_ID}.${PRONE_DAMAGE_FLAG}.resolvedAt`]: Date.now()
    }, { category: "chat.proneHitLocation" });
    await rerenderAoVMessage(latestMessage);
    return true;
  } finally {
    resolvingProneDamageMessages.delete(messageKey);
  }
}

async function runCoreHitLocationFallback(message, button, event) {
  await AoVAdapter.resolveAovHitLocation({
    presetType: String(button?.dataset?.preset ?? "roll-hitloc-card"),
    targetChatId: message.id,
    origin: game.user?.id ?? null,
    originGM: game.user?.isGM ?? false,
    event,
    dataset: button?.dataset ?? {}
  });
}

function localizeProneText(key, fallback) {
  const localized = game.i18n?.localize?.(key) ?? key;
  return localized && localized !== key ? localized : fallback;
}

function proneRuleNoteLines(rules) {
  const normalized = primitiveRules(rules);
  if (!normalized) return [];
  const lines = [];
  if (normalized.basicWeaponDamageOnly) {
    lines.push(localizeProneText(
      "AOV_SKJALDBORG.ProneAutomation.BasicWeaponDamageOnly",
      "Prone attack: non-natural weapon is limited to basic weapon damage; damage modifier and special/critical weapon-damage boosts are suppressed."
    ));
  } else if (normalized.suppressDamageModifier) {
    lines.push(localizeProneText(
      "AOV_SKJALDBORG.ProneAutomation.DamageModifierSuppressed",
      "Prone attack: damage modifier suppressed."
    ));
  }
  if (normalized.oneDieHitLocation) {
    lines.push(localizeProneText(
      "AOV_SKJALDBORG.ProneAutomation.OneDieHitLocation",
      "Prone attack: hit location uses 1D10 against a standing humanoid target."
    ));
  }
  return lines;
}

function proneAutomationNoteHtml(lines) {
  if (!Array.isArray(lines) || !lines.length) return "";
  const body = lines
    .map(line => `<span>${foundry.utils.escapeHTML(String(line ?? ""))}</span>`)
    .join("");
  return `<aside class="skj-prone-raw-note"><i class="fa-solid fa-person-falling" aria-hidden="true"></i><div>${body}</div></aside>`;
}

function insertProneAutomationNote(message, html) {
  const element = resolveChatMessageElement(html);
  if (!element || element.querySelector?.(".skj-prone-raw-note")) return;
  const sourceFlag = message?.getFlag?.(MODULE_ID, PRONE_SOURCE_FLAG) ?? null;
  const damageFlag = message?.getFlag?.(MODULE_ID, PRONE_DAMAGE_FLAG) ?? null;
  const lines = proneRuleNoteLines(sourceFlag?.damageRules ?? damageFlag);
  if (!lines.length) return;
  const target = element.querySelector?.(".roll-details")
    ?? element.querySelector?.(".actor-roll")
    ?? element;
  target.insertAdjacentHTML?.("beforeend", proneAutomationNoteHtml(lines));
}

// Render-safe: binds an explicit damage button click only; it does not roll or
// update documents while historical chat messages are being rendered.
function bindProneDamageButtonOverride(message, html) {
  const element = resolveChatMessageElement(html);
  const button = element?.querySelector?.("button[data-preset='damage-card']");
  if (!button) return;
  const source = sourceFlagForDamageButton(message, button);
  if (!source) return;
  if (button.dataset.skjProneDamageBound === "true") return;
  button.dataset.skjProneDamageBound = "true";
  button.addEventListener("click", event => {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    incrementCounter("automation.prone.damage.click", 1, {
      sourceMessageId: message.id,
      suppressDamageModifier: source.sourceFlag.damageRules?.suppressDamageModifier === true,
      oneDieHitLocation: source.sourceFlag.damageRules?.oneDieHitLocation === true
    });
    void resolveCoreDamageButton(message, button, event, source).catch(exception => {
      warn(exception);
      ui.notifications.error(game.i18n.localize("AOV_SKJALDBORG.Warnings.ActionFailed"));
    });
  }, { capture: true });
}

// Render-safe: binds an explicit GM hit-location click only; automatic prone
// hit-location resolution remains in create/update ChatMessage hooks.
function bindProneHitLocationOverride(message, html) {
  const rules = message?.getFlag?.(MODULE_ID, PRONE_DAMAGE_FLAG) ?? null;
  if (rules?.oneDieHitLocation !== true) return;
  const element = resolveChatMessageElement(html);
  const button = element?.querySelector?.("button[data-preset='roll-hitloc-card']");
  if (!button) return;

  if (!game.user?.isGM) return;
  if (button.dataset.skjProneHitLocationBound === "true") return;
  button.dataset.skjProneHitLocationBound = "true";
  button.addEventListener("click", event => {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    void resolveProneDamageMessage(message)
      .then(applied => applied ? undefined : runCoreHitLocationFallback(message, button, event))
      .catch(exception => {
        warn(exception);
        ui.notifications.error(game.i18n.localize("AOV_SKJALDBORG.Warnings.ActionFailed"));
      });
  }, { capture: true });
}

export function registerProneDamageAutomationHooks() {
  if (hooksRegistered) return;
  hooksRegistered = true;
  Hooks.on("renderChatMessageHTML", (message, html) => {
    bindProneDamageButtonOverride(message, html);
    bindProneHitLocationOverride(message, html);
    insertProneAutomationNote(message, html);
  });
  Hooks.on("createChatMessage", message => {
    void resolveProneDamageMessage(message).catch(exception => warn(exception));
  });
  Hooks.on("updateChatMessage", message => {
    void resolveProneDamageMessage(message).catch(exception => warn(exception));
  });
}

export const __test = {
  applyProneDamageSuppressionToConfig,
  damageCardMatchesRules,
  hitLocationForRoll,
  isAuthoritativeGmClient,
  proneRuleNoteLines,
  proneAutomationNoteHtml,
  shouldApplyProneDamageRules,
  isHooksRegistered: () => hooksRegistered,
  resolvingMessageCount: () => resolvingProneDamageMessages.size
};
