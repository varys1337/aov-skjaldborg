/**
 * Disarm follow-up automation.
 *
 * The attack dialog stores unresolved disarm metadata on the original AoV
 * combat card. The GM client observes the source card and any later damage or
 * resistance card, applies the selected RAW branch once, and records
 * resolution metadata on module flags so re-renders and repeated hooks cannot
 * damage or unequip an item twice.
 */
import { MODULE_ID } from "../constants.mjs";
import { AOV_TEMPLATES } from "../adapter/aov-contract.mjs";
import { createModuleChatMessage } from "../compat/chat-message.mjs";
import { warn } from "../logger.mjs";
import { incrementCounter } from "../performance/performance-monitor.mjs";
import { clearReadiedWeaponInHand, getReadiedWeaponIds } from "./weapon-state.mjs";
import {
  abilityTotal,
  aovCards,
  attackCard,
  attackCardResolved,
  attackCardSucceeded,
  buildResistanceChatCard,
  idTypeMatch,
  inlineResultHtml,
  localize,
  numberOr,
  recentFlaggedMessages,
  registerChatMessageAutomationHooks,
  renderActorStackCard,
  renderAoVChat,
  rerenderAoVMessage,
  resultIconHtml,
  safeFromUuid
} from "./automation-helpers.mjs";

const DISARM_FLAG = "disarm";
const DISARM_DAMAGE_FLAG = "disarmDamage";
const DISARM_MATCH_WINDOW_MS = 10 * 60 * 1000;
const processingMessages = new Set();
let hooksRegistered = false;

function matchesDamageCard(disarm, damageCard) {
  if (disarm?.resolved === true || !disarm?.targetWeaponId) return false;
  const targetMatches = idTypeMatch(disarm.targetParticipantId, disarm.targetParticipantType, damageCard.targetId, damageCard.targetType)
    || idTypeMatch(disarm.targetActorId, "actor", damageCard.targetId, damageCard.targetType)
    || idTypeMatch(disarm.targetTokenId, "token", damageCard.targetId, damageCard.targetType);
  if (!targetMatches) return false;

  const attackerMatches = idTypeMatch(disarm.attackerParticipantId, disarm.attackerParticipantType, damageCard.particId, damageCard.particType)
    || idTypeMatch(disarm.attackerActorId, "actor", damageCard.particId, damageCard.particType)
    || idTypeMatch(disarm.attackerTokenId, "token", damageCard.particId, damageCard.particType);
  if (!attackerMatches) return false;

  const weaponId = String(disarm.weaponId ?? "");
  const damageSkillId = String(damageCard.skillId ?? "");
  return !weaponId || !damageSkillId || weaponId === damageSkillId;
}

function findDamageCard(message) {
  const cards = aovCards(message);
  const index = cards.findIndex(card => card?.rollType === "DM" && Number(card.rollVal) > 0);
  return index >= 0 ? { card: cards[index], index } : null;
}

function findMatchingDisarmSource(damageMessage, damageCard) {
  const [match = null] = recentFlaggedMessages({
    excludeMessage: damageMessage,
    flag: DISARM_FLAG,
    windowMs: DISARM_MATCH_WINDOW_MS,
    predicate: entry => ["awaitingDamage", "attack"].includes(String(entry.flag?.stage ?? ""))
      && matchesDamageCard(entry.flag, damageCard)
  });
  return match ? { message: match.message, disarm: match.flag } : null;
}

function attackSpecialOrBetter(message) {
  return Number(attackCard(message)?.resultLevel ?? 1) >= 3;
}

async function resolveContext(disarm) {
  const attackerActor = await safeFromUuid(disarm.attackerActorUuid);
  const targetActor = await safeFromUuid(disarm.targetActorUuid);
  const attackerToken = await safeFromUuid(disarm.attackerTokenUuid);
  const targetToken = await safeFromUuid(disarm.targetTokenUuid);
  const attackerWeapon = await safeFromUuid(disarm.weaponUuid) ?? attackerActor?.items?.get?.(String(disarm.weaponId ?? "")) ?? null;
  const targetWeapon = await safeFromUuid(disarm.targetWeaponUuid) ?? targetActor?.items?.get?.(String(disarm.targetWeaponId ?? "")) ?? null;
  return { attackerActor, targetActor, attackerToken, targetToken, attackerWeapon, targetWeapon };
}

async function updateDisarmSource(message, data) {
  if (!message?.update) return;
  const update = {};
  for (const [key, value] of Object.entries(data)) {
    update[`flags.${MODULE_ID}.${DISARM_FLAG}.${key}`] = value;
  }
  await message.update(update);
}

async function markDisarmResolved(message, data = {}) {
  await updateDisarmSource(message, {
    ...data,
    resolved: true,
    stage: data.stage ?? "resolved",
    resolvedAt: Date.now()
  });
}

async function unequipWeapon(actor, weapon, reason = "disarm") {
  if (!actor || !weapon) return false;
  const updates = [{ _id: weapon.id, "system.equipStatus": 2 }];
  await actor.updateEmbeddedDocuments("Item", updates, { [MODULE_ID]: { reason } });
  const readied = getReadiedWeaponIds(actor);
  if (String(readied.right ?? "") === String(weapon.id)) {
    await clearReadiedWeaponInHand(actor, "right");
  }
  if (String(readied.left ?? "") === String(weapon.id)) {
    await clearReadiedWeaponInHand(actor, "left");
  }
  return true;
}

async function createResultMessage(disarm, { actor, resultLevel = 2, text, rows = [] }) {
  const { attackerActor } = await resolveContext(disarm);
  const content = renderActorStackCard({
    actor,
    title: localize("AOV_SKJALDBORG.DisarmDialog.ResultTitle"),
    label: localize("AOV_SKJALDBORG.DisarmDialog.ResultTitle"),
    resultHtml: inlineResultHtml({ iconHtml: resultIconHtml(resultLevel), text }),
    resultClass: resultLevel >= 2
      ? "skj-knockback-chat-result--success is-compact"
      : "skj-knockback-chat-result--failure is-compact",
    showResultTitle: false,
    formClass: "aov-skjaldborg-disarm-chat",
    extraRows: rows
  });
  return createModuleChatMessage({
    user: game.user.id,
    speaker: { actor: attackerActor?.id ?? null, alias: localize("AOV_SKJALDBORG.DisarmDialog.ResultTitle") },
    content
  }, { applyDefaultMode: true });
}

async function createResistanceCard(sourceMessage, disarm, { stage, activeActor, activeToken, passiveActor, passiveToken, activeScore, passiveScore, activeLabel, passiveLabel }) {
  const chatMsgData = {
    rollType: "CH",
    cardType: "RE",
    chatTemplate: AOV_TEMPLATES.ROLL_RESISTANCE,
    state: "open",
    wait: true,
    resultLevel: 0,
    rollResult: undefined,
    chatCard: [
      buildResistanceChatCard({ actor: activeActor, tokenDocument: activeToken, label: activeLabel, rawScore: activeScore, active: true }),
      buildResistanceChatCard({ actor: passiveActor, tokenDocument: passiveToken, label: passiveLabel, rawScore: passiveScore, active: false })
    ]
  };
  const html = await renderAoVChat(chatMsgData.chatTemplate, chatMsgData);
  const message = await createModuleChatMessage({
    user: game.user.id,
    content: html,
    speaker: { actor: activeActor?.id ?? null, alias: game.i18n.localize("AOV.card.RE") },
    flags: {
      aov: {
        initiator: activeActor?.id ?? "",
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
        [DISARM_FLAG]: {
          ...disarm,
          sourceMessageId: sourceMessage.id,
          stage,
          resistanceMessageId: null,
          resolved: false
        }
      }
    }
  }, { applyDefaultMode: false });
  if (message) {
    await message.update({ [`flags.${MODULE_ID}.${DISARM_FLAG}.resistanceMessageId`]: message.id });
    await updateDisarmSource(sourceMessage, { stage, resistanceMessageId: message.id });
  }
  return message;
}

async function createEntangleResistance(sourceMessage, disarm) {
  const { attackerActor, targetActor, attackerToken, targetToken } = await resolveContext(disarm);
  if (!attackerActor || !targetActor) return null;
  return createResistanceCard(sourceMessage, disarm, {
    stage: "entangleResistance",
    activeActor: attackerActor,
    activeToken: attackerToken,
    passiveActor: targetActor,
    passiveToken: targetToken,
    activeScore: abilityTotal(attackerActor, "str"),
    passiveScore: abilityTotal(targetActor, "str"),
    activeLabel: localize("AOV_SKJALDBORG.DisarmDialog.EntangleActiveLabel"),
    passiveLabel: localize("AOV_SKJALDBORG.DisarmDialog.EntanglePassiveLabel")
  });
}

async function createEntangleCounterResistance(sourceMessage, disarm) {
  const { attackerActor, targetActor, attackerToken, targetToken } = await resolveContext(disarm);
  if (!attackerActor || !targetActor) return null;
  return createResistanceCard(sourceMessage, disarm, {
    stage: "entangleCounter",
    activeActor: targetActor,
    activeToken: targetToken,
    passiveActor: attackerActor,
    passiveToken: attackerToken,
    activeScore: abilityTotal(targetActor, "str"),
    passiveScore: abilityTotal(attackerActor, "str"),
    activeLabel: localize("AOV_SKJALDBORG.DisarmDialog.EntangleCounterActiveLabel"),
    passiveLabel: localize("AOV_SKJALDBORG.DisarmDialog.EntangleCounterPassiveLabel")
  });
}

async function createFlatResistance(sourceMessage, disarm, damageTotal) {
  const { attackerActor, targetActor, attackerToken, targetToken } = await resolveContext(disarm);
  if (!attackerActor || !targetActor) return null;
  const targetStr = abilityTotal(targetActor, "str");
  const passiveScore = disarm.targetTwoHanded ? targetStr * 1.5 : targetStr;
  return createResistanceCard(sourceMessage, { ...disarm, damageTotal, targetStr, passiveScore }, {
    stage: "flatResistance",
    activeActor: attackerActor,
    activeToken: attackerToken,
    passiveActor: targetActor,
    passiveToken: targetToken,
    activeScore: damageTotal,
    passiveScore,
    activeLabel: localize("AOV_SKJALDBORG.DisarmDialog.FlatActiveLabel"),
    passiveLabel: disarm.targetTwoHanded
      ? localize("AOV_SKJALDBORG.DisarmDialog.FlatPassiveTwoHandedLabel")
      : localize("AOV_SKJALDBORG.DisarmDialog.FlatPassiveLabel")
  });
}

async function resolveStrikeWeapon(sourceMessage, disarm, damageMessage, damageCard, cardIndex) {
  const { targetActor, targetWeapon } = await resolveContext(disarm);
  if (!targetActor || !targetWeapon) {
    ui.notifications.warn(localize("AOV_SKJALDBORG.DisarmDialog.TargetWeaponUnavailable"));
    return false;
  }

  const damage = Math.max(0, numberOr(damageCard.rollVal, 0));
  const currentHp = Math.max(0, numberOr(targetWeapon.system?.currHP, 0));
  const weaponDamage = Math.max(0, damage - currentHp);
  if (weaponDamage > 0) {
    await targetWeapon.update({ "system.currHP": currentHp - weaponDamage }, { [MODULE_ID]: { reason: "disarm-strike-weapon" } });
  }

  const cards = foundry.utils.deepClone(aovCards(damageMessage));
  cards[cardIndex] = {
    ...cards[cardIndex],
    damageCF: false,
    targetLoc: game.i18n.format("AOV_SKJALDBORG.DisarmDialog.StrikeWeaponDamageCard", {
      weapon: targetWeapon.name,
      damage,
      weaponDamage
    }),
    targetLocID: targetWeapon.id
  };
  await damageMessage.update({
    "flags.aov.chatCard": cards,
    "flags.aov.state": "closed",
    [`flags.${MODULE_ID}.${DISARM_DAMAGE_FLAG}`]: {
      resolved: true,
      sourceMessageId: sourceMessage.id,
      mode: "strikeWeapon",
      resolvedAt: Date.now()
    }
  });
  await rerenderAoVMessage(damageMessage, { fallbackTemplate: null });
  await markDisarmResolved(sourceMessage, {
    damageMessageId: damageMessage.id,
    affectedWeaponId: targetWeapon.id,
    weaponDamage,
    stage: "resolved"
  });
  await createResultMessage(disarm, {
    actor: targetActor,
    resultLevel: weaponDamage > 0 ? 2 : 1,
    text: game.i18n.format(weaponDamage > 0
      ? "AOV_SKJALDBORG.DisarmDialog.StrikeWeaponDamaged"
      : "AOV_SKJALDBORG.DisarmDialog.StrikeWeaponNoDamage", {
        weapon: targetWeapon.name,
        damage,
        weaponDamage
      }),
    rows: [game.i18n.format("AOV_SKJALDBORG.DisarmDialog.TargetWeaponRow", { weapon: targetWeapon.name })]
  });
  return true;
}

async function resolveFlatDamage(sourceMessage, disarm, damageMessage, damageCard, cardIndex) {
  const damage = Math.max(0, numberOr(damageCard.rollVal, 0));
  const cards = foundry.utils.deepClone(aovCards(damageMessage));
  cards[cardIndex] = {
    ...cards[cardIndex],
    damageCF: false,
    targetLoc: game.i18n.format("AOV_SKJALDBORG.DisarmDialog.FlatDamageCard", { damage }),
    targetLocID: String(disarm.targetWeaponId ?? "")
  };
  await damageMessage.update({
    "flags.aov.chatCard": cards,
    "flags.aov.state": "closed",
    [`flags.${MODULE_ID}.${DISARM_DAMAGE_FLAG}`]: {
      resolved: true,
      sourceMessageId: sourceMessage.id,
      mode: "hitFlat",
      damage,
      resolvedAt: Date.now()
    }
  });
  await rerenderAoVMessage(damageMessage, { fallbackTemplate: null });
  await createFlatResistance(sourceMessage, disarm, damage);
  return true;
}

async function handleDamageMessage(message) {
  if (!game.user?.isGM || message?.getFlag?.(MODULE_ID, DISARM_DAMAGE_FLAG)?.resolved === true) return;
  const located = findDamageCard(message);
  if (!located) return;
  const source = findMatchingDisarmSource(message, located.card);
  if (!source) return;
  if (source.disarm.mode === "strikeWeapon") await resolveStrikeWeapon(source.message, source.disarm, message, located.card, located.index);
  else if (source.disarm.mode === "hitFlat") await resolveFlatDamage(source.message, source.disarm, message, located.card, located.index);
}

async function handleCombatMessage(message) {
  if (!game.user?.isGM || !attackCardResolved(message)) return;
  const disarm = message.getFlag?.(MODULE_ID, DISARM_FLAG) ?? null;
  if (!disarm || disarm.resolved === true || disarm.stage !== "attack") return;

  if (!attackCardSucceeded(message)) {
    await markDisarmResolved(message, { stage: "failedAttack" });
    return;
  }

  if (disarm.mode === "entangle") {
    if (!attackSpecialOrBetter(message)) {
      await markDisarmResolved(message, { stage: "entangleNoSpecial" });
      await createResultMessage(disarm, {
        actor: await safeFromUuid(disarm.attackerActorUuid),
        resultLevel: 1,
        text: localize("AOV_SKJALDBORG.DisarmDialog.EntangleRequiresSpecial")
      });
      return;
    }
    await createEntangleResistance(message, disarm);
    return;
  }

  await updateDisarmSource(message, { stage: "awaitingDamage" });
}

async function sourceMessageForResistance(disarm) {
  return game.messages?.get?.(String(disarm.sourceMessageId ?? "")) ?? null;
}

async function handleFlatResistanceClosed(message, disarm, resultLevel) {
  const sourceMessage = await sourceMessageForResistance(disarm);
  const { targetActor, targetWeapon } = await resolveContext(disarm);
  if (!sourceMessage || !targetActor || !targetWeapon) return;
  if (resultLevel >= 2) {
    await unequipWeapon(targetActor, targetWeapon, "disarm-hit-flat");
    const targetStr = numberOr(disarm.targetStr, abilityTotal(targetActor, "str"));
    const damage = numberOr(disarm.damageTotal, 0);
    const distance = Math.max(0, damage - targetStr);
    await createResultMessage(disarm, {
      actor: targetActor,
      resultLevel,
      text: distance > 0
        ? game.i18n.format("AOV_SKJALDBORG.DisarmDialog.FlatSuccessDistance", { weapon: targetWeapon.name, distance })
        : game.i18n.format("AOV_SKJALDBORG.DisarmDialog.FlatSuccessFeet", { weapon: targetWeapon.name }),
      rows: [game.i18n.format("AOV_SKJALDBORG.DisarmDialog.TargetWeaponRow", { weapon: targetWeapon.name })]
    });
    await markDisarmResolved(sourceMessage, { affectedWeaponId: targetWeapon.id, stage: "resolved" });
  } else {
    await createResultMessage(disarm, {
      actor: targetActor,
      resultLevel,
      text: game.i18n.format("AOV_SKJALDBORG.DisarmDialog.FlatFailed", { weapon: targetWeapon.name })
    });
    await markDisarmResolved(sourceMessage, { stage: "failedResistance" });
  }
}

async function handleEntangleResistanceClosed(message, disarm, resultLevel) {
  const sourceMessage = await sourceMessageForResistance(disarm);
  const { targetActor, targetWeapon } = await resolveContext(disarm);
  if (!sourceMessage || !targetActor || !targetWeapon) return;
  if (resultLevel >= 2) {
    await unequipWeapon(targetActor, targetWeapon, "disarm-entangle");
    await createResultMessage(disarm, {
      actor: targetActor,
      resultLevel,
      text: game.i18n.format("AOV_SKJALDBORG.DisarmDialog.EntangleSuccess", { weapon: targetWeapon.name }),
      rows: [game.i18n.format("AOV_SKJALDBORG.DisarmDialog.TargetWeaponRow", { weapon: targetWeapon.name })]
    });
    await markDisarmResolved(sourceMessage, { affectedWeaponId: targetWeapon.id, stage: "resolved" });
  } else {
    await createEntangleCounterResistance(sourceMessage, disarm);
  }
}

async function handleEntangleCounterClosed(message, disarm, resultLevel) {
  const sourceMessage = await sourceMessageForResistance(disarm);
  const { attackerActor, attackerWeapon, targetActor } = await resolveContext(disarm);
  if (!sourceMessage || !attackerActor || !attackerWeapon) return;
  if (resultLevel >= 2) {
    await unequipWeapon(attackerActor, attackerWeapon, "disarm-entangle-counter");
    await createResultMessage(disarm, {
      actor: targetActor ?? attackerActor,
      resultLevel,
      text: game.i18n.format("AOV_SKJALDBORG.DisarmDialog.EntangleCounterSuccess", { weapon: attackerWeapon.name }),
      rows: [game.i18n.format("AOV_SKJALDBORG.DisarmDialog.AttackerWeaponRow", { weapon: attackerWeapon.name })]
    });
    await markDisarmResolved(sourceMessage, { affectedWeaponId: attackerWeapon.id, stage: "resolved" });
  } else {
    await createResultMessage(disarm, {
      actor: targetActor ?? attackerActor,
      resultLevel,
      text: localize("AOV_SKJALDBORG.DisarmDialog.EntangleCounterFailed")
    });
    await markDisarmResolved(sourceMessage, { stage: "failedCounter" });
  }
}

async function handleResistanceMessage(message) {
  if (!game.user?.isGM || message?.getFlag?.("aov", "cardType") !== "RE" || message?.getFlag?.("aov", "state") !== "closed") return;
  const disarm = message.getFlag?.(MODULE_ID, DISARM_FLAG) ?? null;
  if (!disarm || disarm.resolved === true) return;
  const resultLevel = Number(aovCards(message)[0]?.resultLevel ?? 1);
  if (disarm.stage === "flatResistance") await handleFlatResistanceClosed(message, disarm, resultLevel);
  else if (disarm.stage === "entangleResistance") await handleEntangleResistanceClosed(message, disarm, resultLevel);
  else if (disarm.stage === "entangleCounter") await handleEntangleCounterClosed(message, disarm, resultLevel);
  await message.update({ [`flags.${MODULE_ID}.${DISARM_FLAG}.resolved`]: true });
}

async function handleMessageUpdate(message) {
  const key = String(message?.id ?? "");
  if (!key || processingMessages.has(key)) return;
  incrementCounter("automation.disarm.message", 1, {
    cardType: message.getFlag?.("aov", "cardType") ?? null,
    state: message.getFlag?.("aov", "state") ?? null
  });
  processingMessages.add(key);
  try {
    await handleCombatMessage(message);
    await handleDamageMessage(message);
    await handleResistanceMessage(message);
  } finally {
    processingMessages.delete(key);
  }
}

/**
 * Register Disarm automation hooks once on the local client.
 *
 * @returns {void}
 */
export function registerDisarmAutomationHooks(hooks = globalThis.Hooks) {
  if (hooksRegistered) return;
  hooksRegistered = true;
  registerChatMessageAutomationHooks(handleMessageUpdate, { hooks });
}

export const __test = {
  isHooksRegistered: () => hooksRegistered
};
