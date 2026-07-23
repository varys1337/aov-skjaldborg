/**
 * Grapple follow-up automation.
 *
 * Grapple workflows create module-authored AoV combat and resistance cards,
 * then resolve hold, immobilize, throw, and damage branches from flagged chat
 * messages. Canvas destination prompts are user-facing, but all actor/token
 * mutations remain GM-routed and guarded by message-stage flags.
 */
import { GRAPPLED_STATUS_ID, IMMOBILIZED_STATUS_ID, MODULE_ID } from "../constants.mjs";
import { AoVAdapter } from "../adapter/aov-adapter.mjs";
import { AOV_TEMPLATES } from "../adapter/aov-contract.mjs";
import { createModuleChatMessage } from "../compat/chat-message.mjs";
import {
  effectHasStatus,
  moduleFlag,
  registerStatusEffect,
  safeDeleteActiveEffect,
  statusEffectConfig,
  upsertActorStatusEffect
} from "../compat/active-effects.mjs";
import { warn, error } from "../logger.mjs";
import { normalizeDescriptor } from "../utils/document-data.mjs";
import { resolveOutOfReachEngagementPair } from "./disengagement.mjs";
import {
  abilityTotal,
  actorName,
  buildCombatAttackCard as buildSharedCombatAttackCard,
  buildResistanceChatCard as buildSharedResistanceChatCard,
  combatantForToken,
  d6TotalToD3,
  evaluateD100,
  evaluateVisibleRoll,
  inlineResultHtml,
  localize,
  numberOr,
  renderActorStackCard as renderSharedActorStackCard,
  renderAoVChat as renderSharedAoVChat,
  resultIconHtml,
  resultLevelLabel,
  safeFromUuid
} from "./automation-helpers.mjs";

const GRAPPLE_FLAG = "grapple";
const GRAPPLE_EFFECT_NAME = "AOV_SKJALDBORG.StatusEffects.Grappled";
const IMMOBILIZED_EFFECT_NAME = "AOV_SKJALDBORG.StatusEffects.Immobilized";
const GRAPPLE_EFFECT_ICON = "icons/svg/net.svg";
const IMMOBILIZED_EFFECT_ICON = "icons/svg/padlock.svg";
const processingMessages = new Set();
const { DialogV2 } = foundry.applications.api;
let hooksRegistered = false;

/**
 * Register Grappled and Immobilized status-effect catalog entries.
 *
 * @returns {void}
 */
export function registerGrappleStatusEffects() {
  registerStatusEffect(statusEffectConfig(GRAPPLED_STATUS_ID, GRAPPLE_EFFECT_NAME, GRAPPLE_EFFECT_ICON), {
    warning: "Unable to register Skjaldborg grappled status effect"
  });
  registerStatusEffect(statusEffectConfig(IMMOBILIZED_STATUS_ID, IMMOBILIZED_EFFECT_NAME, IMMOBILIZED_EFFECT_ICON), {
    warning: "Unable to register Skjaldborg immobilized status effect"
  });
}

function grappleData(effect) {
  return moduleFlag(effect, "grapple") ?? null;
}

/**
 * Test whether an ActiveEffect represents a grapple from one Actor to another.
 *
 * @param {ActiveEffect|object|null} effect Candidate effect.
 * @param {object} [options={}] Match options.
 * @param {string} [options.attackerActorUuid] Source Actor UUID.
 * @param {string} [options.targetActorUuid] Target Actor UUID.
 * @param {string|null} [options.statusId=null] Optional required status id.
 * @returns {boolean}
 */
export function isMatchingGrappleEffect(effect, { attackerActorUuid, targetActorUuid, statusId = null } = {}) {
  if (!effect || effect.disabled === true) return false;
  if (statusId && !effectHasStatus(effect, statusId)) return false;
  const data = grappleData(effect);
  if (!data) return false;
  return String(data.sourceActorUuid ?? "") === String(attackerActorUuid ?? "")
    && String(data.targetActorUuid ?? "") === String(targetActorUuid ?? "");
}

/**
 * Find an existing Grappled hold between a target and attacker.
 *
 * @param {Actor|object|null} targetActor Grappled Actor.
 * @param {Actor|object|null} attackerActor Grappling Actor.
 * @returns {ActiveEffect|object|null}
 */
export function grappleHoldForPair(targetActor, attackerActor) {
  if (!targetActor || !attackerActor) return null;
  return Array.from(targetActor.effects ?? []).find(effect => isMatchingGrappleEffect(effect, {
    attackerActorUuid: attackerActor.uuid,
    targetActorUuid: targetActor.uuid,
    statusId: GRAPPLED_STATUS_ID
  })) ?? null;
}

/**
 * Whether a Grappled hold exists between a target and attacker.
 *
 * @param {Actor|object|null} targetActor Grappled Actor.
 * @param {Actor|object|null} attackerActor Grappling Actor.
 * @returns {boolean}
 */
export function hasGrappleHoldForPair(targetActor, attackerActor) {
  return !!grappleHoldForPair(targetActor, attackerActor);
}

function locationPayload(actor, locationId = "") {
  if (!actor || !locationId) return null;
  const item = actor.items?.get?.(locationId) ?? Array.from(actor.items ?? []).find(candidate => candidate?.id === locationId);
  if (!item || item.type !== "hitloc") return null;
  const low = numberOr(item.system?.lowRoll, 0);
  const high = numberOr(item.system?.highRoll, low);
  return {
    grappledHitLocationId: item.id,
    grappledHitLocationName: item.name,
    grappledHitLocationRollLabel: low === high ? String(low) : `${low}-${high}`,
    armorPoints: actor.type === "npc" ? numberOr(item.system?.npcAP, 0) : numberOr(item.system?.map, 0)
  };
}

function targetLocations(actor) {
  const wellbeing = AoVAdapter.prepareActorWellbeing(actor);
  return Array.isArray(wellbeing.locationList) && wellbeing.locationList.length
    ? wellbeing.locationList
    : Array.from(actor?.items ?? [])
      .filter(item => item.type === "hitloc" && item.system?.locType !== "general")
      .map(item => {
        const low = numberOr(item.system?.lowRoll, 0);
        const high = numberOr(item.system?.highRoll, low);
        return {
          id: item.id,
          name: item.name,
          rollLabel: low === high ? String(low) : `${low}-${high}`,
          ap: actor.type === "npc" ? numberOr(item.system?.npcAP, 0) : numberOr(item.system?.map, 0)
        };
      });
}

function locationForD20(actor, rollTotal) {
  const roll = Number(rollTotal);
  if (!Number.isFinite(roll)) return null;
  const locations = targetLocations(actor);
  return locations.find(location => {
    const [lowRaw, highRaw = lowRaw] = String(location.rollLabel ?? "").split("-");
    const low = Number(lowRaw);
    const high = Number(highRaw);
    return Number.isFinite(low) && Number.isFinite(high) && roll >= low && roll <= high;
  }) ?? null;
}

function renderActorStackCard(options) {
  return renderSharedActorStackCard({
    ...options,
    formClass: "aov-skjaldborg-grapple-chat",
    resultBaseClass: "skj-grapple-chat-result",
    rowClass: "skj-grapple-chat-row"
  });
}

function graspDescription(data) {
  const parts = [];
  if (data?.grappledHitLocationName) {
    const range = data.grappledHitLocationRollLabel ? ` [${data.grappledHitLocationRollLabel}]` : "";
    parts.push(game.i18n.format("AOV_SKJALDBORG.GrappleDialog.GraspedLocationInline", {
      location: data.grappledHitLocationName,
      range
    }));
  }
  if (data?.grappledItemName) {
    parts.push(game.i18n.format("AOV_SKJALDBORG.GrappleDialog.GraspedItemInline", { item: data.grappledItemName }));
  }
  return parts.filter(Boolean).join(" · ");
}

function appendGraspDetail(text, data) {
  const detail = graspDescription(data);
  return detail ? `${text} ${detail}` : text;
}

async function createGrappleResultMessage(context, { actor, resultLevel = 2, label = null, text, extraRows = [] }) {
  const attackerActor = await safeFromUuid(context.attackerActorUuid);
  const content = renderActorStackCard({
    actor,
    title: localize("AOV_SKJALDBORG.GrappleDialog.ResultTitle"),
    label: label ?? localize("AOV_SKJALDBORG.GrappleDialog.ResultTitle"),
    resultHtml: inlineResultHtml({ iconHtml: resultIconHtml(resultLevel), text }),
    resultClass: resultLevel >= 2
      ? "skj-knockback-chat-result--success is-compact"
      : "skj-knockback-chat-result--failure is-compact",
    extraRows,
    showResultTitle: false
  });
  return createModuleChatMessage({
    user: game.user.id,
    speaker: { actor: attackerActor?.id ?? null, alias: localize("AOV_SKJALDBORG.GrappleDialog.ResultTitle") },
    content
  }, { applyDefaultMode: true });
}

async function suppressGrappleDamagePrompt(message) {
  const chatCards = foundry.utils.deepClone(message?.getFlag?.("aov", "chatCard") ?? []);
  if (!Array.isArray(chatCards) || !chatCards.length) return false;
  let changed = false;
  for (const card of chatCards) {
    if (card?.rollDamage === true) {
      card.rollDamage = false;
      changed = true;
    }
  }
  if (!changed) return false;

  const aovFlags = foundry.utils.deepClone(message.flags?.aov ?? {});
  aovFlags.chatCard = chatCards;
  const html = await renderAoVChat(aovFlags.chatTemplate ?? AOV_TEMPLATES.ROLL_COMBAT, aovFlags);
  await message.update({
    "flags.aov.chatCard": chatCards,
    content: html
  });
  return true;
}

function buildCombatAttackCard({ actor, tokenDocument, weapon, targetToken, targetNumber, flatMod, labelSuffix = "" }) {
  return buildSharedCombatAttackCard({
    actor,
    tokenDocument,
    weapon,
    targetToken,
    targetNumber,
    flatMod,
    fallbackLabel: localize("AOV_SKJALDBORG.GrappleDialog.GrappleSkill"),
    labelSuffix
  });
}

function buildResistanceChatCard({ actor, tokenDocument, label, rawScore, active }) {
  return buildSharedResistanceChatCard({ actor, tokenDocument, label, rawScore, active });
}

async function renderAoVChat(template, data) {
  return renderSharedAoVChat(template, data);
}

function attackCard(message) {
  return (message?.getFlag?.("aov", "chatCard") ?? [])[0] ?? null;
}

function defenderCards(message) {
  return (message?.getFlag?.("aov", "chatCard") ?? []).slice(1);
}

function cardResultLevel(card) {
  return Number(card?.resultLevel ?? card?.rollVal ?? card?.rollResult ?? 1);
}

function cardLabel(card) {
  return String(card?.label ?? card?.skillName ?? card?.name ?? card?.itemName ?? "");
}

function cardDescriptor(card) {
  return [cardLabel(card), card?.skillCID, card?.itemCID, card?.itemType, card?.rollType]
    .map(normalizeDescriptor)
    .filter(Boolean)
    .join(" ");
}

function isDodgeCard(card) {
  return cardDescriptor(card).includes("dodge");
}

function isShieldCard(card) {
  return cardDescriptor(card).includes("shield");
}

function isFistOrGrappleCard(card) {
  const descriptor = cardDescriptor(card);
  return descriptor.includes("fist") || descriptor.includes("grapple");
}

function isSuccessfulDefense(card) {
  return cardResultLevel(card) >= 2 || card?.rollSuccess === true;
}

function initialAttackSucceeded(message) {
  const attacker = attackCard(message);
  if (!attacker) return false;
  return cardResultLevel(attacker) >= 2 || attacker.rollDamage === true;
}

function attackFumbled(message) {
  const attacker = attackCard(message);
  return cardResultLevel(attacker) === 0 || attacker?.rollFumble === true;
}

function defenseOutcome(message) {
  const attacker = attackCard(message);
  const attackLevel = Math.max(2, cardResultLevel(attacker));
  const defenses = defenderCards(message).filter(Boolean);
  const successful = defenses.filter(isSuccessfulDefense);
  const dodge = successful.find(isDodgeCard) ?? null;
  if (dodge && cardResultLevel(dodge) >= attackLevel) return { kind: "dodged", card: dodge };
  const fistOrGrapple = successful.find(isFistOrGrappleCard) ?? null;
  if (fistOrGrapple) return { kind: "blocked", card: fistOrGrapple };
  const shield = successful.find(isShieldCard) ?? null;
  if (shield) return { kind: "shield", card: shield };
  const weapon = successful[0] ?? null;
  if (weapon) return { kind: "weaponArm", card: weapon };
  return { kind: "body", card: null };
}

async function createResistanceCard(context, { activeScore, passiveScore, activeLabel, passiveLabel }) {
  const attackerActor = await safeFromUuid(context.attackerActorUuid);
  const targetActor = await safeFromUuid(context.targetActorUuid);
  const attackerToken = await safeFromUuid(context.attackerTokenUuid);
  const targetToken = await safeFromUuid(context.targetTokenUuid);
  if (!attackerActor || !targetActor) {
    ui.notifications.warn(localize("AOV_SKJALDBORG.GrappleDialog.MissingResistanceActors"));
    return null;
  }
  const chatMsgData = {
    rollType: "CH",
    cardType: "RE",
    chatTemplate: AOV_TEMPLATES.ROLL_RESISTANCE,
    state: "open",
    wait: true,
    resultLevel: 0,
    rollResult: undefined,
    chatCard: [
      buildResistanceChatCard({ actor: attackerActor, tokenDocument: attackerToken, label: activeLabel, rawScore: activeScore, active: true }),
      buildResistanceChatCard({ actor: targetActor, tokenDocument: targetToken, label: passiveLabel, rawScore: passiveScore, active: false })
    ]
  };
  const html = await renderAoVChat(chatMsgData.chatTemplate, chatMsgData);
  return createModuleChatMessage({
    user: game.user.id,
    content: html,
    speaker: { actor: attackerActor.id, alias: game.i18n.localize("AOV.card.RE") },
    flags: {
      aov: {
        initiator: attackerActor.id,
        initiatorType: "actor",
        chatTemplate: chatMsgData.chatTemplate,
        state: chatMsgData.state,
        cardType: chatMsgData.cardType,
        rollType: chatMsgData.rollType,
        successLevel: chatMsgData.successLevel,
        chatCard: chatMsgData.chatCard,
        successLevelLabel: ""
      },
      [MODULE_ID]: {
        [GRAPPLE_FLAG]: {
          ...context,
          stage: "resistance",
          resolved: false
        }
      }
    }
  }, { applyDefaultMode: false });
}

async function createImmobilizeResistanceCard(context) {
  const attackerActor = await safeFromUuid(context.attackerActorUuid);
  const targetActor = await safeFromUuid(context.targetActorUuid);
  return createResistanceCard(context, {
    activeScore: abilityTotal(attackerActor, "str"),
    passiveScore: abilityTotal(targetActor, "str"),
    activeLabel: localize("AOV_SKJALDBORG.GrappleDialog.ImmobilizeActiveResistanceLabel"),
    passiveLabel: localize("AOV_SKJALDBORG.GrappleDialog.ImmobilizePassiveResistanceLabel")
  });
}

async function createThrowResistanceCard(context) {
  const attackerActor = await safeFromUuid(context.attackerActorUuid);
  const targetActor = await safeFromUuid(context.targetActorUuid);
  return createResistanceCard(context, {
    activeScore: abilityTotal(attackerActor, "str") + abilityTotal(attackerActor, "dex"),
    passiveScore: abilityTotal(targetActor, "siz") + abilityTotal(targetActor, "dex"),
    activeLabel: localize("AOV_SKJALDBORG.GrappleDialog.ThrowActiveResistanceLabel"),
    passiveLabel: localize("AOV_SKJALDBORG.GrappleDialog.ThrowPassiveResistanceLabel")
  });
}

async function removeGrappleEffects(context) {
  const targetActor = await safeFromUuid(context.targetActorUuid);
  if (!targetActor) return 0;
  const effects = Array.from(targetActor.effects ?? []).filter(effect => isMatchingGrappleEffect(effect, {
    attackerActorUuid: context.attackerActorUuid,
    targetActorUuid: context.targetActorUuid
  }));
  let removed = 0;
  for (const effect of effects) {
    if (await safeDeleteActiveEffect(effect, { reason: "grapple-cleanup" })) removed += 1;
  }
  return removed;
}

async function upsertGrappleEffect(actor, statusId, data) {
  if (!actor || !statusId) return null;
  const nameKey = statusId === IMMOBILIZED_STATUS_ID ? IMMOBILIZED_EFFECT_NAME : GRAPPLE_EFFECT_NAME;
  const icon = statusId === IMMOBILIZED_STATUS_ID ? IMMOBILIZED_EFFECT_ICON : GRAPPLE_EFFECT_ICON;
  return upsertActorStatusEffect(actor, {
    statusId,
    name: localize(nameKey),
    img: icon,
    moduleFlags: { grapple: foundry.utils.deepClone(data) },
    predicate: effect => isMatchingGrappleEffect(effect, {
      attackerActorUuid: data.sourceActorUuid,
      targetActorUuid: data.targetActorUuid,
      statusId
    }),
    useToggle: false
  });
}

async function buildGrappleEffectData(context, extra = {}) {
  const attackerActor = await safeFromUuid(context.attackerActorUuid);
  const targetActor = await safeFromUuid(context.targetActorUuid);
  const attackerToken = await safeFromUuid(context.attackerTokenUuid);
  const targetToken = await safeFromUuid(context.targetTokenUuid);
  return {
    sourceActorUuid: context.attackerActorUuid,
    sourceTokenUuid: context.attackerTokenUuid,
    sourceActorName: actorName(attackerActor),
    sourceTokenName: attackerToken?.name ?? actorName(attackerActor),
    targetActorUuid: context.targetActorUuid,
    targetTokenUuid: context.targetTokenUuid,
    targetActorName: actorName(targetActor),
    targetTokenName: targetToken?.name ?? actorName(targetActor),
    combatId: context.combatId ?? null,
    round: game.combat?.round ?? null,
    logicalRound: game.combat ? AoVAdapter.getSystemLogicalRound(game.combat) : null,
    immobilized: false,
    ...extra
  };
}

async function applyGrappledStatus(context, grasp) {
  const targetActor = await safeFromUuid(context.targetActorUuid);
  const data = await buildGrappleEffectData(context, grasp);
  await upsertGrappleEffect(targetActor, GRAPPLED_STATUS_ID, data);
  return data;
}

async function applyImmobilizedStatus(context, holdData) {
  const targetActor = await safeFromUuid(context.targetActorUuid);
  const data = await buildGrappleEffectData(context, {
    ...(holdData ?? {}),
    immobilized: true
  });
  await upsertGrappleEffect(targetActor, IMMOBILIZED_STATUS_ID, data);
  return data;
}

async function promptWeaponArmLocation(actor) {
  const locations = targetLocations(actor);
  const choices = locations.map(location => `<option value="${foundry.utils.escapeHTML(location.id)}">${foundry.utils.escapeHTML(location.name)} (${foundry.utils.escapeHTML(location.rollLabel ?? "")})</option>`).join("");
  if (!choices) return null;
  const content = `<form class="aov-skjaldborg skj-grapple-location-choice-dialog">
    <p>${foundry.utils.escapeHTML(localize("AOV_SKJALDBORG.GrappleDialog.WeaponArmChoicePrompt"))}</p>
    <select name="locationId">${choices}</select>
  </form>`;
  return DialogV2.prompt({
    classes: ["aov-skjaldborg", "dialog", "skj-grapple-choice-window"],
    window: { title: localize("AOV_SKJALDBORG.GrappleDialog.WeaponArmChoiceTitle") },
    content,
    rejectClose: false,
    modal: true,
    ok: {
      label: localize("AOV_SKJALDBORG.GrappleDialog.ConfirmLocation"),
      callback: (_event, button) => String(button.form.elements.locationId?.value ?? "")
    }
  });
}

async function rollOrResolveInitialLocation(context, targetActor) {
  if (context.locationMode === "manual" && context.manualLocationId) {
    return { location: targetLocations(targetActor).find(location => location.id === context.manualLocationId) ?? null, rollTotal: null };
  }
  const roll = await evaluateVisibleRoll("1d20");
  return { location: locationForD20(targetActor, roll.total), rollTotal: Number(roll.total) };
}

async function resolveInitialHold(context, message) {
  const attackerActor = await safeFromUuid(context.attackerActorUuid);
  const targetActor = await safeFromUuid(context.targetActorUuid);
  if (!attackerActor || !targetActor) return null;

  const defense = defenseOutcome(message);
  if (defense.kind === "dodged") {
    await createGrappleResultMessage(context, {
      actor: targetActor,
      resultLevel: 1,
      text: game.i18n.format("AOV_SKJALDBORG.GrappleDialog.InitialDodged", { target: actorName(targetActor) })
    });
    return null;
  }
  if (defense.kind === "blocked") {
    await createGrappleResultMessage(context, {
      actor: targetActor,
      resultLevel: 1,
      text: game.i18n.format("AOV_SKJALDBORG.GrappleDialog.InitialBlocked", { target: actorName(targetActor), defense: cardLabel(defense.card) })
    });
    return null;
  }

  let grasp;
  if (defense.kind === "shield") {
    grasp = {
      grappleKind: "shield",
      grappledItemName: cardLabel(defense.card) || localize("AOV_SKJALDBORG.GrappleDialog.Shield"),
      grappledItemUuid: defense.card?.itemUuid ?? defense.card?.itemUUID ?? null
    };
  } else if (defense.kind === "weaponArm") {
    const selectedLocationId = await promptWeaponArmLocation(targetActor);
    const location = locationPayload(targetActor, selectedLocationId);
    grasp = {
      grappleKind: "weaponArm",
      grappledItemName: cardLabel(defense.card) || localize("AOV_SKJALDBORG.GrappleDialog.WeaponArm"),
      grappledItemUuid: defense.card?.itemUuid ?? defense.card?.itemUUID ?? null,
      ...(location ?? {})
    };
  } else {
    const { location, rollTotal } = await rollOrResolveInitialLocation(context, targetActor);
    grasp = {
      grappleKind: "body",
      locationRoll: rollTotal,
      ...(locationPayload(targetActor, location?.id) ?? {})
    };
  }

  const data = await applyGrappledStatus(context, grasp);
  const rows = [];
  if (data.grappledHitLocationName) rows.push(game.i18n.format("AOV_SKJALDBORG.GrappleDialog.GraspedLocationRow", {
    location: data.grappledHitLocationName,
    range: data.grappledHitLocationRollLabel ?? ""
  }));
  if (data.grappledItemName) rows.push(game.i18n.format("AOV_SKJALDBORG.GrappleDialog.GraspedItemRow", { item: data.grappledItemName }));
  await createGrappleResultMessage(context, {
    actor: targetActor,
    resultLevel: 2,
    text: appendGraspDetail(game.i18n.format("AOV_SKJALDBORG.GrappleDialog.InitialHoldEstablished", {
      attacker: actorName(attackerActor),
      target: actorName(targetActor)
    }), data),
    extraRows: rows
  });
  return data;
}

function getExistingHoldData(targetActor, context) {
  const hold = Array.from(targetActor?.effects ?? []).find(effect => isMatchingGrappleEffect(effect, {
    attackerActorUuid: context.attackerActorUuid,
    targetActorUuid: context.targetActorUuid,
    statusId: GRAPPLED_STATUS_ID
  })) ?? null;
  return grappleData(hold) ?? null;
}

async function handleSecondGrappleAttackFailed(context, reason = "failed") {
  const attackerActor = await safeFromUuid(context.attackerActorUuid);
  const targetActor = await safeFromUuid(context.targetActorUuid);
  await removeGrappleEffects(context);
  await createGrappleResultMessage(context, {
    actor: targetActor,
    resultLevel: reason === "fumbled" ? 0 : 1,
    text: game.i18n.format("AOV_SKJALDBORG.GrappleDialog.HoldBroken", {
      attacker: actorName(attackerActor),
      target: actorName(targetActor)
    })
  });
}

async function handleGrappleAttackClosed(message, context) {
  await suppressGrappleDamagePrompt(message);
  if (!initialAttackSucceeded(message)) {
    if (context.mode === "immobilize" || context.mode === "throw") {
      await handleSecondGrappleAttackFailed(context, attackFumbled(message) ? "fumbled" : "failed");
    }
    return;
  }

  if (context.mode === "immobilize" || context.mode === "throw") {
    const defense = defenseOutcome(message);
    if (defense.kind === "dodged" || defense.kind === "blocked") {
      await handleSecondGrappleAttackFailed(context, "defended");
      return;
    }
  }

  if (context.mode === "immobilize") {
    await createImmobilizeResistanceCard(context);
  } else if (context.mode === "throw") {
    await createThrowResistanceCard(context);
  } else {
    await resolveInitialHold(context, message);
  }
}

async function handleImmobilizeResistanceClosed(message, context, resultLevel) {
  const attackerActor = await safeFromUuid(context.attackerActorUuid);
  const targetActor = await safeFromUuid(context.targetActorUuid);
  const holdData = getExistingHoldData(targetActor, context);
  if (!holdData) {
    await createGrappleResultMessage(context, {
      actor: targetActor,
      resultLevel: 1,
      text: localize("AOV_SKJALDBORG.GrappleDialog.NoActiveHold")
    });
    return;
  }

  if (resultLevel >= 2) {
    await applyImmobilizedStatus(context, holdData);
    await createGrappleResultMessage(context, {
      actor: targetActor,
      resultLevel,
      text: game.i18n.format("AOV_SKJALDBORG.GrappleDialog.ImmobilizeSucceeded", {
        attacker: actorName(attackerActor),
        target: actorName(targetActor),
        location: holdData.grappledHitLocationName ?? holdData.grappledItemName ?? localize("AOV_SKJALDBORG.GrappleDialog.Hold")
      })
    });
  } else {
    await createGrappleResultMessage(context, {
      actor: targetActor,
      resultLevel,
      text: game.i18n.format("AOV_SKJALDBORG.GrappleDialog.ImmobilizeFailed", {
        attacker: actorName(attackerActor),
        target: actorName(targetActor)
      })
    });
  }
}

async function rollThrowDistance() {
  const roll = await evaluateVisibleRoll("1d6");
  return d6TotalToD3(roll.total);
}

function tokenGridSize() {
  return canvas?.grid?.size ?? canvas?.scene?.grid?.size ?? 100;
}

/**
 * Build deterministic in-scene candidate destinations for a grapple throw.
 *
 * @param {TokenDocument|object|null} tokenDocument Token being thrown.
 * @param {number} distance Maximum throw distance in grid units.
 * @returns {object[]} Candidate destination descriptors.
 */
export function candidateThrowDestinations(tokenDocument, distance) {
  const gridSize = tokenGridSize();
  const x = numberOr(tokenDocument?.x, 0);
  const y = numberOr(tokenDocument?.y, 0);
  const maxDistance = Math.max(1, Math.floor(Number(distance) || 1));
  const sceneWidth = Number(canvas?.scene?.width ?? NaN);
  const sceneHeight = Number(canvas?.scene?.height ?? NaN);
  const tokenWidth = numberOr(tokenDocument?.width, 1) * gridSize;
  const tokenHeight = numberOr(tokenDocument?.height, 1) * gridSize;
  const choices = [];
  for (let dy = -maxDistance; dy <= maxDistance; dy += 1) {
    for (let dx = -maxDistance; dx <= maxDistance; dx += 1) {
      if (dx === 0 && dy === 0) continue;
      const gridDistance = Math.max(Math.abs(dx), Math.abs(dy));
      if (gridDistance < 1 || gridDistance > maxDistance) continue;
      const candidate = {
        key: `${dx},${dy}`,
        dx,
        dy,
        distance: gridDistance,
        x: x + (dx * gridSize),
        y: y + (dy * gridSize)
      };
      if (Number.isFinite(sceneWidth) && (candidate.x < 0 || candidate.x + tokenWidth > sceneWidth)) continue;
      if (Number.isFinite(sceneHeight) && (candidate.y < 0 || candidate.y + tokenHeight > sceneHeight)) continue;
      choices.push(candidate);
    }
  }
  return choices.sort((a, b) => a.distance - b.distance || a.y - b.y || a.x - b.x);
}

async function promptThrowDestinationDialog(targetToken, distance) {
  const choices = candidateThrowDestinations(targetToken, distance);
  const buttons = choices.slice(0, 24).map((choice, index) => ({
    action: `destination-${index}`,
    label: game.i18n.format("AOV_SKJALDBORG.GrappleDialog.Direction.GridOffset", { dx: choice.dx, dy: choice.dy }),
    callback: () => choice
  }));
  const result = await DialogV2.wait({
    classes: ["aov-skjaldborg", "dialog", "skj-grapple-throw-window"],
    window: { title: localize("AOV_SKJALDBORG.GrappleDialog.ThrowDestinationTitle") },
    position: { width: 420, height: "auto" },
    content: `<p>${foundry.utils.escapeHTML(game.i18n.format("AOV_SKJALDBORG.GrappleDialog.ThrowDestinationPrompt", { distance }))}</p>`,
    rejectClose: false,
    modal: true,
    buttons
  });
  return result ?? choices[0] ?? null;
}

async function promptThrowDestinationCanvas(targetToken, distance) {
  const pixi = globalThis.PIXI;
  const stage = canvas?.stage ?? canvas?.app?.stage;
  if (!pixi || !stage || !canvas?.ready || !targetToken) return promptThrowDestinationDialog(targetToken, distance);
  return new Promise(resolve => {
    const gridSize = tokenGridSize();
    const container = new pixi.Container();
    let resolved = false;
    let fallbackTimer = null;
    container.name = "aov-skjaldborg-grapple-throw-selector";
    container.zIndex = 999999;
    if (stage.sortableChildren !== true) stage.sortableChildren = true;
    const cleanup = result => {
      if (resolved) return;
      resolved = true;
      if (fallbackTimer) clearTimeout(fallbackTimer);
      globalThis.window?.removeEventListener?.("keydown", onKeyDown, true);
      try { container.destroy({ children: true }); } catch (_exception) { /* noop */ }
      resolve(result);
    };
    const onKeyDown = event => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      cleanup(null);
    };
    const choices = candidateThrowDestinations(targetToken, distance);
    for (const choice of choices) {
      const graphic = new pixi.Graphics();
      const width = numberOr(targetToken.width, 1) * gridSize;
      const height = numberOr(targetToken.height, 1) * gridSize;
      graphic.lineStyle(3, 0xffd166, 0.9);
      graphic.beginFill(0xffd166, 0.18);
      graphic.drawRoundedRect(choice.x, choice.y, width, height, 8);
      graphic.endFill();
      graphic.eventMode = "static";
      graphic.cursor = "pointer";
      graphic.on("pointertap", () => cleanup(choice));
      container.addChild(graphic);
    }
    try {
      stage.addChild(container);
      globalThis.window?.addEventListener?.("keydown", onKeyDown, true);
      ui.notifications.info(game.i18n.format("AOV_SKJALDBORG.GrappleDialog.ThrowDestinationCanvasHint", { distance }));
      fallbackTimer = setTimeout(() => {
        if (resolved) return;
        try { container.destroy({ children: true }); } catch (_exception) { /* noop */ }
        void promptThrowDestinationDialog(targetToken, distance).then(cleanup).catch(exception => {
          warn("Failed to open grapple throw destination fallback dialog.", exception);
          cleanup(null);
        });
      }, 30000);
    } catch (exception) {
      warn("Unable to open grapple throw destination canvas selector; falling back to dialog.", exception);
      void promptThrowDestinationDialog(targetToken, distance).then(cleanup).catch(() => cleanup(null));
    }
  });
}

async function applyLandingDamage(context, targetActor) {
  const dexTarget = abilityTotal(targetActor, "dex") * 5;
  const dexRoll = await evaluateVisibleRoll("1d100");
  const dexResultLevel = evaluateD100(dexTarget, Number(dexRoll.total));
  if (dexResultLevel >= 2) {
    await createGrappleResultMessage(context, {
      actor: targetActor,
      resultLevel: dexResultLevel,
      label: localize("AOV_SKJALDBORG.GrappleDialog.LandingRollLabel"),
      text: game.i18n.format("AOV_SKJALDBORG.GrappleDialog.LandingSucceeded", {
        target: actorName(targetActor),
        roll: dexRoll.total,
        result: resultLevelLabel(dexResultLevel)
      })
    });
    return { applied: false, resultLevel: dexResultLevel };
  }

  const hitRoll = await evaluateVisibleRoll("1d20");
  const damageRoll = await evaluateVisibleRoll("1d6");
  const location = locationForD20(targetActor, hitRoll.total);
  const locationData = locationPayload(targetActor, location?.id) ?? {};
  const armor = numberOr(locationData.armorPoints, 0);
  const grossDamage = numberOr(damageRoll.total, 0);
  const netDamage = Math.max(0, grossDamage - armor);
  let applied = false;
  try {
    if (netDamage > 0 && targetActor?.isOwner && targetActor.type === "character" && location?.id) {
      const wound = await AoVAdapter.createActorWound(targetActor, location.id);
      await AoVAdapter.updateActorWellbeingDamage(targetActor, wound.id, netDamage);
      applied = true;
    } else if (netDamage > 0 && targetActor?.isOwner && targetActor.type === "npc" && location?.id) {
      await AoVAdapter.addActorNpcDamage(targetActor, location.id, netDamage);
      applied = true;
    }
  } catch (exception) {
    warn("Unable to auto-apply grapple throw landing damage; posting result only.", exception);
  }

  await createGrappleResultMessage(context, {
    actor: targetActor,
    resultLevel: dexResultLevel,
    label: localize("AOV_SKJALDBORG.GrappleDialog.LandingRollLabel"),
    text: game.i18n.format(applied
      ? "AOV_SKJALDBORG.GrappleDialog.LandingFailedDamageApplied"
      : "AOV_SKJALDBORG.GrappleDialog.LandingFailedDamagePosted", {
        target: actorName(targetActor),
        roll: dexRoll.total,
        result: resultLevelLabel(dexResultLevel),
        hitRoll: hitRoll.total,
        location: locationData.grappledHitLocationName ?? localize("AOV_SKJALDBORG.GrappleDialog.UnknownLocation"),
        grossDamage,
        armor,
        netDamage
      })
  });
  return { applied, resultLevel: dexResultLevel, netDamage };
}

async function handleThrowResistanceClosed(_message, context, resultLevel) {
  const attackerActor = await safeFromUuid(context.attackerActorUuid);
  const targetActor = await safeFromUuid(context.targetActorUuid);
  const targetToken = await safeFromUuid(context.targetTokenUuid);
  if (!targetActor || !targetToken) return;

  if (resultLevel < 2) {
    await createGrappleResultMessage(context, {
      actor: targetActor,
      resultLevel,
      text: game.i18n.format("AOV_SKJALDBORG.GrappleDialog.ThrowFailedHoldMaintained", {
        attacker: actorName(attackerActor),
        target: actorName(targetActor)
      })
    });
    return;
  }

  const distance = await rollThrowDistance();
  const destination = await promptThrowDestinationCanvas(targetToken, distance);
  if (destination) {
    await targetToken.update({ x: destination.x, y: destination.y }, { animate: true, [MODULE_ID]: { reason: "grapple-throw", movementExecution: true } });
  }
  await removeGrappleEffects(context);
  await resolveOutOfReachEngagementPair(context);
  await createGrappleResultMessage(context, {
    actor: targetActor,
    resultLevel,
    text: game.i18n.format("AOV_SKJALDBORG.GrappleDialog.ThrowSucceeded", {
      attacker: actorName(attackerActor),
      target: actorName(targetActor),
      distance
    })
  });
  await applyLandingDamage(context, targetActor);
}

async function handleResistanceClosed(message, context) {
  const chatCards = message.getFlag("aov", "chatCard") ?? [];
  const resultLevel = Number(chatCards[0]?.resultLevel ?? message.getFlag("aov", "resultLevel") ?? 1);
  if (context.mode === "immobilize") await handleImmobilizeResistanceClosed(message, context, resultLevel);
  else if (context.mode === "throw") await handleThrowResistanceClosed(message, context, resultLevel);
}

async function markMessageResolved(message, context) {
  await message.setFlag(MODULE_ID, GRAPPLE_FLAG, { ...context, resolved: true });
}

async function handleGrappleChatUpdate(message) {
  if (!game.user?.isGM || !message?.id) return;
  const context = message.getFlag(MODULE_ID, GRAPPLE_FLAG);
  if (!context || context.resolved === true) return;
  if (message.getFlag("aov", "state") !== "closed") return;
  if (processingMessages.has(message.id)) return;
  processingMessages.add(message.id);
  try {
    await markMessageResolved(message, context);
    if (context.stage === "attack") await handleGrappleAttackClosed(message, context);
    else if (context.stage === "resistance") await handleResistanceClosed(message, context);
  } catch (exception) {
    error("Failed to resolve Skjaldborg grapple automation.", exception);
    ui.notifications.error(localize("AOV_SKJALDBORG.Warnings.ActionFailed"));
  } finally {
    processingMessages.delete(message.id);
  }
}

/**
 * Start the Grapple workflow from the actor hotbar or action ring.
 *
 * @param {object} request Grapple request.
 * @param {Actor|object} request.actor Attacking Actor.
 * @param {Token|TokenDocument|object} request.targetToken Target token.
 * @param {Item|object|null} request.weapon Weapon or unarmed item context.
 * @param {number} request.targetNumber Roll target number.
 * @param {number} request.situationalModifier Situational modifier.
 * @param {number} request.augmentModifier Augmentation modifier.
 * @param {{custom?: {reason: string, value: number}|null}} request.augmentations Selected augmentation metadata.
 * @param {string} [request.mode="grapple"] Grapple mode.
 * @param {string} [request.locationMode="roll"] Hit-location selection mode.
 * @param {string} [request.manualLocationId=""] Manual hit-location id.
 * @param {string} [request.batchId=""] Module batch id for multi-target submissions.
 * @param {number} [request.batchIndex=0] Zero-based index within the submitted target batch.
 * @param {number} [request.batchSize=1] Number of targets in the submitted batch.
 * @param {Event|null} [request.originEvent=null] Originating UI event.
 * @returns {Promise<ChatMessage|object|null>}
 */
export async function startGrappleAttack({ actor, targetToken, weapon, targetNumber, situationalModifier, augmentModifier, augmentations, mode = "grapple", locationMode = "roll", manualLocationId = "", batchId = "", batchIndex = 0, batchSize = 1, originEvent = null }) {
  if (!actor || !targetToken?.actor || !weapon) return null;
  const combat = game.combat ?? null;
  const attackerToken = actor.getActiveTokens?.()?.[0]?.document ?? actor.token ?? null;
  const attackerCombatant = combatantForToken(combat, attackerToken, actor);
  const targetCombatant = combatantForToken(combat, targetToken.document, targetToken.actor);
  const flatMod = (Number(situationalModifier) || 0) + (Number(augmentModifier) || 0);
  const sharedContext = {
    actorUuid: actor.uuid ?? null,
    attackerActorUuid: actor.uuid ?? null,
    targetActorUuid: targetToken.actor.uuid ?? null,
    attackerTokenUuid: attackerToken?.uuid ?? null,
    targetTokenUuid: targetToken.document?.uuid ?? null,
    weaponUuid: weapon.uuid ?? null,
    targetNumber,
    situationalModifier,
    augmentModifier,
    augmentations,
    mode,
    locationMode,
    manualLocationId,
    combatId: combat?.id ?? null,
    attackerCombatantId: attackerCombatant?.id ?? null,
    targetCombatantId: targetCombatant?.id ?? null,
    originEventType: originEvent?.type ?? null
  };
  if (mode === "immobilize") return createImmobilizeResistanceCard({ ...sharedContext, stage: "resistance" });
  if (mode === "throw") return createThrowResistanceCard({ ...sharedContext, stage: "resistance" });
  const modeKey = mode === "throw" ? "Throw" : (mode === "immobilize" ? "Immobilize" : "Grapple");
  const chatMsgData = {
    rollType: "WP",
    cardType: "CO",
    chatTemplate: AOV_TEMPLATES.ROLL_COMBAT,
    state: "open",
    wait: true,
    resultLevel: 0,
    rollResult: undefined,
    successLevelLabel: "",
    successLevelLabelVisible: false,
    chatCard: [buildCombatAttackCard({
      actor,
      tokenDocument: attackerToken,
      weapon,
      targetToken,
      targetNumber,
      flatMod,
      labelSuffix: localize(`AOV_SKJALDBORG.GrappleDialog.Modes.${modeKey}`)
    })]
  };
  const html = await renderAoVChat(chatMsgData.chatTemplate, chatMsgData);
  return createModuleChatMessage({
    user: game.user.id,
    style: CONST.CHAT_MESSAGE_STYLES.OTHER,
    content: html,
    speaker: { actor: actor.id, alias: game.i18n.localize("AOV.card.CO") },
    flags: {
      aov: {
        initiator: chatMsgData.chatCard[0].particId,
        initiatorType: chatMsgData.chatCard[0].particType,
        chatTemplate: chatMsgData.chatTemplate,
        state: chatMsgData.state,
        cardType: chatMsgData.cardType,
        rollType: chatMsgData.rollType,
        successLevel: chatMsgData.successLevel,
        chatCard: chatMsgData.chatCard,
        successLevelLabel: chatMsgData.successLevelLabel,
        successLevelLabelVisible: chatMsgData.successLevelLabelVisible
      },
      [MODULE_ID]: {
        combatCardBatch: {
          batchId: String(batchId ?? ""),
          batchIndex: Number(batchIndex) || 0,
          batchSize: Number(batchSize) || 1,
          createdAt: Date.now()
        },
        [GRAPPLE_FLAG]: {
          stage: "attack",
          resolved: false,
          ...sharedContext
        }
      }
    }
  }, { applyDefaultMode: false });
}

/**
 * Register Grapple chat automation hooks once.
 *
 * @returns {void}
 */
export function registerGrappleAutomationHooks(hooks = globalThis.Hooks) {
  if (hooksRegistered) return;
  hooksRegistered = true;
  hooks.on("updateChatMessage", message => {
    void handleGrappleChatUpdate(message).catch(warn);
  });
}

export const __test = {
  d6TotalToD3,
  isHooksRegistered: () => hooksRegistered
};
