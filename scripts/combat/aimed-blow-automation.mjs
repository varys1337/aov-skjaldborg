/**
 * Aimed Blow follow-up automation.
 *
 * Attack and missile dialogs store an unresolved `aimedBlow` flag on the
 * source AoV combat card. The GM client matches later AoV damage messages by
 * participant and weapon metadata, then resolves the damage card to the
 * selected body location or selected equipped item. Render-time click capture
 * remains only as a fallback for cards that reach the hit-location button.
 */
import { MODULE_ID } from "../constants.mjs";
import { warn } from "../logger.mjs";
import { incrementCounter } from "../performance/performance-monitor.mjs";
import {
  aovCards,
  idTypeMatch,
  recentFlaggedMessages,
  safeFromUuid
} from "./automation-helpers.mjs";

const AIMED_MATCH_WINDOW_MS = 10 * 60 * 1000;

let hooksRegistered = false;
let aovCheckApiPromise = null;
let aovCombatChatPromise = null;

/**
 * Resolve the pending chat-message HTMLElement defensively.
 *
 * @param {HTMLElement|ArrayLike<HTMLElement>|null|undefined} html Pending message HTML.
 * @returns {HTMLElement|null}
 */
function resolveChatMessageElement(html) {
  if (!html) return null;
  if (typeof html.querySelector === "function") return html;
  const candidate = html[0];
  return candidate && typeof candidate.querySelector === "function" ? candidate : null;
}

/**
 * Load AoV's combat chat renderer without making it a public module contract.
 *
 * @returns {Promise<{AOVCheck: Function}>}
 */
async function getAoVCheckApi() {
  if (!aovCheckApiPromise) {
    const path = "systems/aov/system/apps/checks.mjs";
    const route = foundry.utils.getRoute?.(path) ?? `/${path}`;
    aovCheckApiPromise = import(route)
      .then(module => {
        if (typeof module.AOVCheck?.startChat !== "function") {
          throw new Error("The Age of Vikings combat chat renderer is unavailable.");
        }
        return { AOVCheck: module.AOVCheck };
      })
      .catch(exception => {
        aovCheckApiPromise = null;
        throw exception;
      });
  }
  return aovCheckApiPromise;
}

/**
 * Load AoV's core combat chat handler for the normal fallback path.
 *
 * @returns {Promise<{COCard: Function}>}
 */
async function getAoVCombatChatApi() {
  if (!aovCombatChatPromise) {
    const path = "systems/aov/system/chat/combat-chat.mjs";
    const route = foundry.utils.getRoute?.(path) ?? `/${path}`;
    aovCombatChatPromise = import(route)
      .then(module => {
        if (typeof module.COCard?.COHitLoc !== "function") {
          throw new Error("The Age of Vikings hit-location workflow is unavailable.");
        }
        return { COCard: module.COCard };
      })
      .catch(exception => {
        aovCombatChatPromise = null;
        throw exception;
      });
  }
  return aovCombatChatPromise;
}

/**
 * Resolve an AoV participant id/type pair into its Actor document.
 *
 * @param {unknown} participantId AoV participant id.
 * @param {unknown} participantType AoV participant type.
 * @returns {Actor|null}
 */
function actorFromParticipant(participantId, participantType) {
  const id = String(participantId ?? "");
  const type = String(participantType ?? "");
  if (!id) return null;
  if (type === "token") return game.actors?.tokens?.[id] ?? null;
  if (type === "actor") return game.actors?.get?.(id) ?? null;
  return null;
}

/**
 * Whether core AoV automatic damage application is currently enabled.
 *
 * @returns {boolean}
 */
function autoDamageEnabled() {
  try {
    return !!game.settings.get("aov", "autoDmg");
  } catch (_exception) {
    return false;
  }
}

/**
 * Read the current armor points from a target hit location.
 *
 * @param {Actor} actor Target Actor.
 * @param {Item} hitLocation Target hit-location Item.
 * @returns {number}
 */
function locationArmor(actor, hitLocation) {
  const value = actor.type === "npc" ? hitLocation.system?.npcAP : hitLocation.system?.map;
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function grossDamage(card) {
  const damageBeforeAbsorb = Number(card?.damageBeforeAbsorb);
  if (Number.isFinite(damageBeforeAbsorb)) return Math.max(0, damageBeforeAbsorb);
  return Math.max(0, (Number(card?.rollVal ?? 0) || 0) + (Number(card?.armourAbsorb ?? 0) || 0));
}

/**
 * Locate the first unresolved positive AoV damage card that still needs a hit
 * location.
 *
 * @param {ChatMessage|null|undefined} message Candidate ChatMessage.
 * @returns {{card: object, index: number}|null}
 */
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

/**
 * Check whether an unresolved aimed flag plausibly belongs to one AoV damage
 * card.
 *
 * @param {object} aimed Module aimed-blow flag.
 * @param {object} damageCard AoV damage card.
 * @returns {boolean}
 */
function matchesDamageCard(aimed, damageCard) {
  if (aimed?.resolved === true) return false;
  const targetKind = String(aimed?.targetKind ?? "hitLocation");
  if (targetKind === "equipment") {
    if (!String(aimed?.targetWeaponId ?? "").trim() && !String(aimed?.targetWeaponUuid ?? "").trim()) return false;
  } else if (!String(aimed?.hitLocationId ?? "").trim()) return false;

  const targetMatches = idTypeMatch(
    aimed.targetParticipantId,
    aimed.targetParticipantType,
    damageCard.targetId,
    damageCard.targetType
  ) || idTypeMatch(aimed.targetActorId, "actor", damageCard.targetId, damageCard.targetType)
    || idTypeMatch(aimed.targetTokenId, "token", damageCard.targetId, damageCard.targetType);
  if (!targetMatches) return false;

  const hasAttackerMatchFields = !!(
    aimed.attackerParticipantId
    || aimed.attackerActorId
    || aimed.attackerTokenId
  );
  const attackerMatches = !hasAttackerMatchFields || idTypeMatch(
    aimed.attackerParticipantId,
    aimed.attackerParticipantType,
    damageCard.particId,
    damageCard.particType
  ) || idTypeMatch(aimed.attackerActorId, "actor", damageCard.particId, damageCard.particType)
    || idTypeMatch(aimed.attackerTokenId, "token", damageCard.particId, damageCard.particType);
  if (!attackerMatches) return false;

  const weaponId = String(aimed.weaponId ?? "");
  const damageSkillId = String(damageCard.skillId ?? "");
  return !weaponId || !damageSkillId || weaponId === damageSkillId;
}

/**
 * Find a recent unresolved aimed-blow source message for a damage card.
 *
 * @param {ChatMessage} damageMessage AoV damage ChatMessage.
 * @param {object} damageCard AoV damage card.
 * @returns {{message: ChatMessage, aimed: object}|null}
 */
function findMatchingAimedSource(damageMessage, damageCard) {
  const direct = damageMessage.getFlag?.(MODULE_ID, "aimedBlow") ?? null;
  if (matchesDamageCard(direct, damageCard)) return { message: damageMessage, aimed: direct };

  const [match = null] = recentFlaggedMessages({
    excludeMessage: damageMessage,
    flag: "aimedBlow",
    windowMs: AIMED_MATCH_WINDOW_MS,
    predicate: entry => {
      const targetKind = String(entry.flag?.targetKind ?? "hitLocation");
      const hasTarget = targetKind === "equipment"
        ? !!(String(entry.flag?.targetWeaponId ?? "").trim() || String(entry.flag?.targetWeaponUuid ?? "").trim())
        : !!String(entry.flag?.hitLocationId ?? "").trim();
      return hasTarget && matchesDamageCard(entry.flag, damageCard);
    }
  });
  return match ? { message: match.message, aimed: match.flag } : null;
}

/**
 * Resolve target Actor and selected hit-location Item for an aimed source.
 *
 * @param {object} aimed Module aimed-blow flag.
 * @param {object} damageCard AoV damage card.
 * @returns {Promise<{targetActor: Actor|null, hitLocation: Item|null}>}
 */
async function resolveAimedTarget(aimed, damageCard) {
  const flaggedActor = await safeFromUuid(aimed.targetActorUuid);
  const targetActor = flaggedActor ?? actorFromParticipant(damageCard.targetId, damageCard.targetType);
  const hitLocation = targetActor?.items?.get?.(String(aimed.hitLocationId)) ?? null;
  return { targetActor, hitLocation };
}

/**
 * Resolve target Actor and selected equipment Item for an aimed source.
 *
 * @param {object} aimed Module aimed-blow flag.
 * @param {object} damageCard AoV damage card.
 * @returns {Promise<{targetActor: Actor|null, targetWeapon: Item|null}>}
 */
async function resolveAimedEquipmentTarget(aimed, damageCard) {
  const flaggedActor = await safeFromUuid(aimed.targetActorUuid);
  const targetActor = flaggedActor ?? actorFromParticipant(damageCard.targetId, damageCard.targetType);
  const flaggedWeapon = await safeFromUuid(aimed.targetWeaponUuid);
  const targetWeapon = flaggedWeapon ?? targetActor?.items?.get?.(String(aimed.targetWeaponId ?? "")) ?? null;
  return { targetActor, targetWeapon };
}

/**
 * Mutate one damage card to use the module-selected aimed location.
 *
 * @param {object} chatCard AoV damage card.
 * @param {Actor} targetActor Target Actor.
 * @param {Item} hitLocation Selected hit-location Item.
 * @returns {object} Updated card.
 */
function applyAimedLocationToCard(chatCard, targetActor, hitLocation) {
  const next = { ...chatCard };
  const armor = locationArmor(targetActor, hitLocation);
  next.targetLoc = `${hitLocation.name} (${targetActor.name})`;
  next.targetLocID = hitLocation.id;
  if (next.armourBlock) {
    const currentDamage = Number(next.rollVal);
    const damage = Number.isFinite(currentDamage) ? currentDamage : 0;
    next.armourAbsorb = Math.min(damage, armor);
    next.rollVal = damage - next.armourAbsorb;
  }
  return next;
}

/**
 * Mutate one damage card to describe damage against selected equipment.
 *
 * @param {object} chatCard AoV damage card.
 * @param {Item} targetWeapon Selected equipment Item.
 * @param {number} weaponDamage Damage applied to the item.
 * @param {number} damage Rolled damage before item HP comparison.
 * @returns {object} Updated card.
 */
function applyAimedEquipmentToCard(chatCard, targetWeapon, weaponDamage, damage) {
  return {
    ...chatCard,
    damageCF: false,
    targetLoc: game.i18n.format("AOV_SKJALDBORG.AttackDialog.AimedEquipmentDamageCard", {
      weapon: targetWeapon.name,
      damage,
      weaponDamage
    }),
    targetLocID: targetWeapon.id
  };
}

/**
 * Re-render a message's AoV chat content from its current flag state.
 *
 * @param {ChatMessage} message Message to re-render.
 * @returns {Promise<void>}
 */
async function rerenderAoVMessage(message) {
  const refreshed = game.messages?.get?.(message.id) ?? message;
  const { AOVCheck } = await getAoVCheckApi();
  const content = await AOVCheck.startChat(refreshed.flags.aov);
  await refreshed.update({ content });
}

/**
 * Mark the original aimed source resolved without overwriting its metadata.
 *
 * @param {ChatMessage} sourceMessage Original AoV combat message.
 * @param {ChatMessage} damageMessage Resolved damage message.
 * @returns {Promise<void>}
 */
async function markAimedSourceResolved(sourceMessage, damageMessage) {
  if (!sourceMessage?.update) return;
  await sourceMessage.update({
    [`flags.${MODULE_ID}.aimedBlow.resolved`]: true,
    [`flags.${MODULE_ID}.aimedBlow.damageMessageId`]: damageMessage.id,
    [`flags.${MODULE_ID}.aimedBlow.resolvedAt`]: Date.now()
  });
}

/**
 * Resolve one AoV damage ChatMessage to the selected aimed-blow location.
 *
 * @param {ChatMessage} message AoV damage ChatMessage.
 * @param {{card?: object, index?: number, source?: {message: ChatMessage, aimed: object}}} [options={}] Resolution context.
 * @returns {Promise<boolean>} Whether the aimed-blow override was applied.
 */
async function resolveAimedHitLocation(message, options = {}) {
  if (!game.user?.isGM) return false;

  const located = options.card ? { card: options.card, index: Number(options.index ?? 0) } : findDamageLocationCard(message);
  if (!located?.card || !Number.isInteger(located.index)) return false;

  const source = options.source ?? findMatchingAimedSource(message, located.card);
  const aimed = source?.aimed ?? null;
  if (!aimed || aimed.resolved === true) return false;

  const cards = foundry.utils.deepClone(aovCards(message));
  const chatCard = cards[located.index] ?? null;
  if (!chatCard || chatCard.rollType !== "DM" || String(chatCard.targetLocID ?? "").trim()) return false;

  const targetKind = String(aimed.targetKind ?? "hitLocation");
  let newState = autoDamageEnabled() ? "applyDmg" : "closed";
  let damageFlag = {
    resolved: true,
    sourceMessageId: source?.message?.id ?? null,
    targetKind,
    resolvedAt: Date.now()
  };

  if (targetKind === "equipment") {
    const { targetWeapon } = await resolveAimedEquipmentTarget(aimed, located.card);
    if (targetWeapon?.type !== "weapon") {
      ui.notifications.warn(game.i18n.localize("AOV_SKJALDBORG.AttackDialog.AimedEquipmentUnavailable"));
      return false;
    }
    const damage = grossDamage(chatCard);
    const currentHp = Math.max(0, Number(targetWeapon.system?.currHP) || 0);
    const weaponDamage = Math.max(0, damage - currentHp);
    if (weaponDamage > 0) {
      await targetWeapon.update({ "system.currHP": currentHp - weaponDamage }, { [MODULE_ID]: { reason: "aimed-equipment" } });
    }
    cards[located.index] = applyAimedEquipmentToCard(chatCard, targetWeapon, weaponDamage, damage);
    newState = "closed";
    damageFlag = {
      ...damageFlag,
      targetWeaponId: targetWeapon.id,
      targetWeaponName: targetWeapon.name,
      damage,
      weaponDamage
    };
  } else {
    const { targetActor, hitLocation } = await resolveAimedTarget(aimed, located.card);
    if (!targetActor || hitLocation?.type !== "hitloc" || hitLocation.system?.locType === "general") {
      ui.notifications.warn(game.i18n.localize("AOV_SKJALDBORG.AttackDialog.AimedLocationUnavailable"));
      return false;
    }
    cards[located.index] = applyAimedLocationToCard(chatCard, targetActor, hitLocation);
  }

  await message.update({
    "flags.aov.chatCard": cards,
    "flags.aov.state": newState,
    [`flags.${MODULE_ID}.aimedBlowDamage`]: damageFlag
  });
  if (source?.message?.id && source.message.id !== message.id) {
    await markAimedSourceResolved(source.message, message);
  } else if (message.getFlag?.(MODULE_ID, "aimedBlow")) {
    await markAimedSourceResolved(message, message);
  }

  await rerenderAoVMessage(message);
  return true;
}

/**
 * Resolve an AoV damage message when it is created or updated.
 *
 * @param {ChatMessage} message Candidate ChatMessage.
 * @returns {Promise<void>}
 */
async function resolveAimedDamageMessage(message) {
  if (!game.user?.isGM) return;
  incrementCounter("automation.aimed.message", 1, {
    cardType: message.getFlag?.("aov", "cardType") ?? null,
    state: message.getFlag?.("aov", "state") ?? null
  });
  if (message?.getFlag?.(MODULE_ID, "aimedBlowDamage")?.resolved === true) return;
  const located = findDamageLocationCard(message);
  if (!located) return;
  const source = findMatchingAimedSource(message, located.card);
  if (!source) return;
  await resolveAimedHitLocation(message, { ...located, source });
}

/**
 * Continue through AoV's normal hit-location workflow when override is invalid.
 *
 * @param {ChatMessage} message Core AoV combat message.
 * @param {HTMLElement} button Hit-location button.
 * @param {PointerEvent} event Original click event.
 * @returns {Promise<void>}
 */
async function runCoreHitLocationFallback(message, button, event) {
  const { COCard } = await getAoVCombatChatApi();
  await COCard.COHitLoc({
    presetType: String(button.dataset.preset ?? "roll-hitloc-card"),
    targetChatId: message.id,
    origin: game.user?.id ?? null,
    originGM: game.user?.isGM ?? false,
    event,
    dataset: button.dataset
  });
}

/**
 * Bind aimed-blow hit-location override to one rendered AoV damage card.
 *
 * @param {ChatMessage} message Rendered ChatMessage.
 * @param {HTMLElement|ArrayLike<HTMLElement>} html Rendered HTML.
 * @returns {void}
 */
function bindAimedHitLocationOverride(message, html) {
  const located = findDamageLocationCard(message);
  if (!located) return;

  const element = resolveChatMessageElement(html);
  const button = element?.querySelector?.("button[data-preset='roll-hitloc-card']");
  if (!button) return;

  if (game.user?.isGM) {
    void resolveAimedDamageMessage(message).catch(exception => {
      warn(exception);
      ui.notifications.error(game.i18n.localize("AOV_SKJALDBORG.Warnings.ActionFailed"));
    });
  }

  const source = findMatchingAimedSource(message, located.card);
  if (!source || !game.user?.isGM) return;

  button.addEventListener("click", event => {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    void resolveAimedHitLocation(message, { ...located, source })
      .then(applied => applied ? undefined : runCoreHitLocationFallback(message, button, event))
      .catch(exception => {
        warn(exception);
        ui.notifications.error(game.i18n.localize("AOV_SKJALDBORG.Warnings.ActionFailed"));
      });
  }, { capture: true });
}

/**
 * Register Aimed Blow automation hooks once.
 *
 * @returns {void}
 */
export function registerAimedBlowAutomationHooks() {
  if (hooksRegistered) return;
  hooksRegistered = true;
  Hooks.on("createChatMessage", message => {
    void resolveAimedDamageMessage(message).catch(exception => warn(exception));
  });
  Hooks.on("updateChatMessage", message => {
    void resolveAimedDamageMessage(message).catch(exception => warn(exception));
  });
  Hooks.on("renderChatMessageHTML", bindAimedHitLocationOverride);
}

export const __test = {
  grossDamage,
  isHooksRegistered: () => hooksRegistered
};
