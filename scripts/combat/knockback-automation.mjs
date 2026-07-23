/**
 * Knockback follow-up automation.
 *
 * Knockback starts from a module-authored AoV combat card and then advances
 * through resistance, fumble, recovery, and disengagement side effects. The GM
 * client owns document mutation while result messages and prompts remain
 * idempotent through module flags on the relevant ChatMessages.
 */
import { MODULE_ID } from "../constants.mjs";
import { AOV_TEMPLATES } from "../adapter/aov-contract.mjs";
import { createModuleChatMessage } from "../compat/chat-message.mjs";
import { effectHasStatus, upsertActorStatusEffect } from "../compat/active-effects.mjs";
import { warn, error } from "../logger.mjs";
import { normalizeDescriptor } from "../utils/document-data.mjs";
import { clearReadiedWeapon, getReadiedWeaponIds } from "./weapon-state.mjs";
import { resolveOutOfReachEngagementPair } from "./disengagement.mjs";
import {
  abilityTotal,
  actorImage,
  actorName,
  buildCombatAttackCard,
  buildResistanceChatCard,
  combatantForToken,
  d6TotalToD3,
  evaluateD100,
  evaluateVisibleRoll,
  inlineResultHtml,
  localize,
  numberOr,
  renderActorStackCard,
  renderAoVChat,
  resultIconHtml,
  resultLevelLabel,
  safeFromUuid
} from "./automation-helpers.mjs";

const KNOCKBACK_FLAG = "knockback";
const FUMBLES_TABLE_UUID = "Compendium.cha-aov-fvtt-en-core.core-tables.RollTable.41LVKqEdrg5Mm1wY";
const FUMBLES_CID = "rt..fumbles";
const PRONE_STATUS_ID = "prone";
const processingMessages = new Set();
const { DialogV2 } = foundry.applications.api;
let hooksRegistered = false;

function tokenCenter(tokenDocument) {
  const gridSize = canvas?.grid?.size ?? canvas?.scene?.grid?.size ?? 100;
  const width = numberOr(tokenDocument?.width, 1) * gridSize;
  const height = numberOr(tokenDocument?.height, 1) * gridSize;
  return {
    x: numberOr(tokenDocument?.x, 0) + (width / 2),
    y: numberOr(tokenDocument?.y, 0) + (height / 2)
  };
}

function awayStep(sourceToken, movedToken) {
  const source = tokenCenter(sourceToken);
  const moved = tokenCenter(movedToken);
  const dx = moved.x - source.x;
  const dy = moved.y - source.y;
  const absX = Math.abs(dx);
  const absY = Math.abs(dy);
  if (absX < 1 && absY < 1) return { x: 1, y: 0 };
  if (absX > absY * 1.5) return { x: Math.sign(dx) || 1, y: 0 };
  if (absY > absX * 1.5) return { x: 0, y: Math.sign(dy) || 1 };
  return { x: Math.sign(dx) || 1, y: Math.sign(dy) || 0 };
}

async function moveTokenAway({ movedTokenDocument, sourceTokenDocument, spaces }) {
  if (!movedTokenDocument || !sourceTokenDocument || !Number.isFinite(Number(spaces))) return null;
  const gridSize = canvas?.grid?.size ?? canvas?.scene?.grid?.size ?? 100;
  const step = awayStep(sourceTokenDocument, movedTokenDocument);
  const x = numberOr(movedTokenDocument.x, 0) + (step.x * spaces * gridSize);
  const y = numberOr(movedTokenDocument.y, 0) + (step.y * spaces * gridSize);
  return movedTokenDocument.update({ x, y }, { animate: true, [MODULE_ID]: { reason: "knockback", movementExecution: true } });
}

async function applyStatus(actor, statusId) {
  if (!actor || !statusId) return null;
  return upsertActorStatusEffect(actor, {
    statusId,
    img: "icons/svg/falling.svg",
    moduleFlags: { managedKnockbackStatus: true },
    predicate: effect => effectHasStatus(effect, statusId)
  });
}

function isShieldLike(item) {
  const descriptors = [item?.name, item?.system?.weaponCat, item?.system?.weaponCatName, item?.system?.skillCID]
    .map(normalizeDescriptor)
    .filter(Boolean);
  return descriptors.some(value => value.includes("shield"));
}

async function dropHeldWeaponsAndShields(actor) {
  if (!actor) return [];
  const readiedIds = getReadiedWeaponIds(actor);
  const readiedWeaponIds = new Set([readiedIds.right, readiedIds.left].filter(Boolean).map(String));
  const updates = Array.from(actor.items ?? [])
    .filter(item => item?.type === "weapon")
    .filter(item => readiedWeaponIds.has(String(item.id)) || (Number(item.system?.equipStatus) === 1 && isShieldLike(item)))
    .map(item => ({ _id: item.id, "system.equipStatus": 2 }));

  if (readiedWeaponIds.size) await clearReadiedWeapon(actor);
  if (!updates.length) return [];
  return actor.updateEmbeddedDocuments("Item", updates, { [MODULE_ID]: { reason: "knockback-critical-drop" } });
}


async function createKnockbackResistanceCard(context) {
  const attackerActor = await safeFromUuid(context.attackerActorUuid);
  const targetActor = await safeFromUuid(context.targetActorUuid);
  const attackerToken = await safeFromUuid(context.attackerTokenUuid);
  const targetToken = await safeFromUuid(context.targetTokenUuid);
  if (!attackerActor || !targetActor) {
    ui.notifications.warn(localize("AOV_SKJALDBORG.KnockbackDialog.MissingResistanceActors"));
    return null;
  }

  const activeScore = abilityTotal(attackerActor, "str") + abilityTotal(attackerActor, "siz");
  const passiveScore = abilityTotal(targetActor, "siz") + abilityTotal(targetActor, "dex");
  const chatMsgData = {
    rollType: "CH",
    cardType: "RE",
    chatTemplate: AOV_TEMPLATES.ROLL_RESISTANCE,
    state: "open",
    wait: true,
    resultLevel: 0,
    rollResult: undefined,
    chatCard: [
      buildResistanceChatCard({
        actor: attackerActor,
        tokenDocument: attackerToken,
        label: localize("AOV_SKJALDBORG.KnockbackDialog.ActiveResistanceLabel"),
        rawScore: activeScore,
        active: true
      }),
      buildResistanceChatCard({
        actor: targetActor,
        tokenDocument: targetToken,
        label: localize("AOV_SKJALDBORG.KnockbackDialog.PassiveResistanceLabel"),
        rawScore: passiveScore,
        active: false
      })
    ]
  };
  const html = await renderAoVChat(chatMsgData.chatTemplate, chatMsgData);
  return ChatMessage.create({
    user: game.user.id,
    content: html,
    speaker: {
      actor: attackerActor.id,
      alias: game.i18n.localize("AOV.card.RE")
    },
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
        [KNOCKBACK_FLAG]: {
          ...context,
          stage: "resistance",
          resolved: false
        }
      }
    }
  });
}

function attackSucceeded(message) {
  const cards = message?.getFlag?.("aov", "chatCard") ?? [];
  const attacker = cards[0] ?? null;
  if (!attacker) return false;
  if (attacker.rollDamage === true) return true;
  return cards.length < 2 && Number(attacker.resultLevel) >= 2;
}

function attackFumbled(message) {
  const attacker = (message?.getFlag?.("aov", "chatCard") ?? [])[0] ?? null;
  return Number(attacker?.resultLevel) === 0 || attacker?.rollFumble === true;
}

async function createFumblePrompt(context, reason = "resistance-fumble") {
  const attackerActor = await safeFromUuid(context.attackerActorUuid);
  const content = renderActorStackCard({
    actor: attackerActor,
    title: localize("AOV_SKJALDBORG.KnockbackDialog.FumblePromptTitle"),
    label: localize("AOV_SKJALDBORG.KnockbackDialog.FumblePromptLabel"),
    resultHtml: `<span>${foundry.utils.escapeHTML(localize("AOV_SKJALDBORG.KnockbackDialog.FumblePromptBody"))}</span>`,
    resultClass: "skj-knockback-chat-result--failure skj-knockback-fumble-result is-compact",
    showResultTitle: false
  }).replace("</form>", `
      <button class="resolve cardbutton skj-knockback-fumble-button" type="button" data-aov-skj-knockback-fumble-table>${foundry.utils.escapeHTML(localize("AOV_SKJALDBORG.KnockbackDialog.RollFumblesTable"))}</button>
    </form>`);

  return createModuleChatMessage({
    user: game.user.id,
    speaker: { actor: attackerActor?.id ?? null, alias: localize("AOV_SKJALDBORG.KnockbackDialog.FumblePromptTitle") },
    content,
    flags: {
      [MODULE_ID]: {
        [KNOCKBACK_FLAG]: {
          ...context,
          stage: "fumblePrompt",
          reason
        }
      }
    }
  }, { applyDefaultMode: true });
}

async function createKnockbackResultMessage(context, { actor, resultLevel, text }) {
  const attackerActor = await safeFromUuid(context.attackerActorUuid);
  const content = renderActorStackCard({
    actor,
    title: localize("AOV_SKJALDBORG.KnockbackDialog.ResultTitle"),
    label: localize("AOV_SKJALDBORG.KnockbackDialog.ResultTitle"),
    resultHtml: inlineResultHtml({ iconHtml: resultIconHtml(resultLevel), text }),
    resultClass: "skj-knockback-chat-result--outcome is-compact",
    showResultTitle: false
  });
  return createModuleChatMessage({
    user: game.user.id,
    speaker: { actor: attackerActor?.id ?? null, alias: localize("AOV_SKJALDBORG.KnockbackDialog.ResultTitle") },
    content
  }, { applyDefaultMode: true });
}

async function createRecoveryMessage(context, { resultLevel, rollTotal, text }) {
  const attackerActor = await safeFromUuid(context.attackerActorUuid);
  const resultLabel = resultLevelLabel(resultLevel);
  const content = renderActorStackCard({
    actor: attackerActor,
    title: localize("AOV_SKJALDBORG.KnockbackDialog.FailedRecoveryTitle"),
    label: localize("AOV_SKJALDBORG.KnockbackDialog.RecoveryLabel"),
    resultHtml: inlineResultHtml({
      iconHtml: resultIconHtml(resultLevel),
      text: `${resultLabel}: ${rollTotal}${text ? ` — ${text}` : ""}`
    }),
    resultClass: resultLevel >= 2
      ? "skj-knockback-chat-result--success is-compact"
      : "skj-knockback-chat-result--failure is-compact",
    showResultTitle: false
  });
  return createModuleChatMessage({
    user: game.user.id,
    speaker: { actor: attackerActor?.id ?? null, alias: localize("AOV_SKJALDBORG.KnockbackDialog.FailedRecoveryTitle") },
    content
  }, { applyDefaultMode: true });
}

function renderFailedRecoveryChoiceContent(actor, rollTotal) {
  return `
    <form class="aov-skjaldborg skj-knockback-choice-dialog">
      <section class="skj-knockback-choice-dialog__hero">
        <img src="${foundry.utils.escapeHTML(actorImage(actor))}" alt="" />
        <div>
          <strong>${foundry.utils.escapeHTML(actorName(actor))}</strong>
          <span>${foundry.utils.escapeHTML(game.i18n.format("AOV_SKJALDBORG.KnockbackDialog.RecoveryChoiceIntro", { roll: rollTotal }))}</span>
        </div>
      </section>
      <p>${foundry.utils.escapeHTML(localize("AOV_SKJALDBORG.KnockbackDialog.RecoveryChoicePrompt"))}</p>
    </form>`;
}

async function promptFailedRecoveryChoice(actor, rollTotal) {
  const result = await DialogV2.wait({
    classes: ["aov-skjaldborg", "dialog", "skj-knockback-choice-window"],
    window: {
      title: localize("AOV_SKJALDBORG.KnockbackDialog.RecoveryChoiceTitle"),
      contentClasses: ["aov-skjaldborg", "skj-knockback-choice-content"]
    },
    position: { width: 390, height: "auto" },
    content: renderFailedRecoveryChoiceContent(actor, rollTotal),
    rejectClose: false,
    modal: true,
    buttons: [
      {
        action: "prone",
        icon: '<i class="fa-solid fa-person-falling"></i>',
        label: localize("AOV_SKJALDBORG.KnockbackDialog.ChooseProne"),
        callback: () => "prone"
      },
      {
        action: "bounce",
        icon: '<i class="fa-solid fa-person-running"></i>',
        label: localize("AOV_SKJALDBORG.KnockbackDialog.ChooseBounce"),
        callback: () => "bounce"
      }
    ]
  });
  return result === "bounce" ? "bounce" : "prone";
}

function configuredFumblesTableReference() {
  try {
    return String(game.settings.get(MODULE_ID, "knockbackFumbleTableReference") ?? "").trim();
  } catch (_exception) {
    return "";
  }
}

async function resolveTableReference(reference) {
  const value = String(reference ?? "").trim();
  if (!value) return null;

  if (value.startsWith("rt.") && typeof game.aov?.cid?.fromCID === "function") {
    try {
      const result = await game.aov.cid.fromCID(value, "en");
      if (result) return Array.isArray(result) ? result[0] : result;
    } catch (_exception) {
      // Try the other resolution paths below.
    }
  }

  if (value.startsWith("rt.") && typeof game.aov?.cid?.fromCIDBest === "function") {
    try {
      const result = await game.aov.cid.fromCIDBest({ cid: value });
      if (Array.isArray(result) && result[0]) return result[0];
      if (result) return result;
    } catch (_exception) {
      // Try the other resolution paths below.
    }
  }

  if (value.startsWith("Compendium.") || value.startsWith("RollTable.")) {
    const document = await safeFromUuid(value);
    if (document) return document;
  }

  const worldTable = game.tables?.get?.(value)
    ?? Array.from(game.tables ?? []).find(table => table?.name === value)
    ?? null;
  if (worldTable) return worldTable;

  return safeFromUuid(value);
}

async function resolveFumblesTable() {
  const configured = configuredFumblesTableReference();
  const configuredTable = await resolveTableReference(configured);
  if (configuredTable) return configuredTable;

  const cidTable = await resolveTableReference(FUMBLES_CID);
  if (cidTable) return cidTable;

  return resolveTableReference(FUMBLES_TABLE_UUID);
}

async function rollFumblesTable() {
  const table = await resolveFumblesTable();
  if (!table || typeof table.draw !== "function") {
    ui.notifications.warn(game.i18n.format("AOV.ErrorMsg.noTable", { tableCID: FUMBLES_CID }));
    return null;
  }
  return table.draw({ displayChat: true });
}

async function rollDistance(_context = {}) {
  // Dice So Nice does not consistently render virtual d3 terms. Roll a visible d6
  // and convert it to an even-probability 1D3 result: 1-2 => 1, 3-4 => 2, 5-6 => 3.
  const roll = await evaluateVisibleRoll("1d6");
  return d6TotalToD3(roll.total);
}

async function handleSuccessfulResistance(message, context, resultLevel) {
  const attackerActor = await safeFromUuid(context.attackerActorUuid);
  const targetActor = await safeFromUuid(context.targetActorUuid);
  const attackerToken = await safeFromUuid(context.attackerTokenUuid);
  const targetToken = await safeFromUuid(context.targetTokenUuid);
  const distance = await rollDistance(context);
  await moveTokenAway({ movedTokenDocument: targetToken, sourceTokenDocument: attackerToken, spaces: distance });

  const combat = context.combatId ? game.combats?.get?.(context.combatId) ?? game.combat : game.combat;
  await resolveOutOfReachEngagementPair(context);

  const additions = [];
  if (resultLevel >= 3) {
    await applyStatus(targetActor, PRONE_STATUS_ID);
    additions.push(localize("AOV_SKJALDBORG.KnockbackDialog.FallsProneAddition"));
  }
  if (resultLevel >= 4) {
    await dropHeldWeaponsAndShields(targetActor);
    additions.push(localize("AOV_SKJALDBORG.KnockbackDialog.DropsWeaponsAddition"));
  }
  const text = game.i18n.format("AOV_SKJALDBORG.KnockbackDialog.TargetKnockedBackCompact", {
    target: actorName(targetActor),
    distance,
    additions: additions.length ? ` ${additions.join(" ")}` : ""
  });
  await createKnockbackResultMessage(context, { actor: targetActor, resultLevel, text });
  Hooks.callAll("aovSkjaldborgKnockbackResolved", {
    message,
    resultLevel,
    attackerActor,
    targetActor,
    attackerToken,
    targetToken,
    distance,
    attackerCombatantId: context.attackerCombatantId,
    targetCombatantId: context.targetCombatantId,
    combat,
    onlyIfOutOfReach: true
  });
}

async function handleUnsuccessfulAttempt(context, reason = "failed-resistance") {
  const attackerActor = await safeFromUuid(context.attackerActorUuid);
  const attackerToken = await safeFromUuid(context.attackerTokenUuid);
  const targetToken = await safeFromUuid(context.targetTokenUuid);
  const dexTarget = abilityTotal(attackerActor, "dex") * 5;
  const dexRoll = await evaluateVisibleRoll("1d100");
  const dexResultLevel = evaluateD100(dexTarget, Number(dexRoll.total));

  if (dexResultLevel >= 2) {
    await createRecoveryMessage(context, {
      resultLevel: dexResultLevel,
      rollTotal: dexRoll.total,
      text: game.i18n.format("AOV_SKJALDBORG.KnockbackDialog.AttackerKeepsFootingCompact", {
        actor: actorName(attackerActor)
      })
    });
    if (reason === "resistance-fumble") await createFumblePrompt(context, reason);
    return;
  }

  const choice = await promptFailedRecoveryChoice(attackerActor, dexRoll.total);
  let text = "";
  if (choice === "bounce") {
    const distance = await rollDistance(context);
    await moveTokenAway({ movedTokenDocument: attackerToken, sourceTokenDocument: targetToken, spaces: distance });
    await resolveOutOfReachEngagementPair(context);
    text = game.i18n.format("AOV_SKJALDBORG.KnockbackDialog.AttackerChoosesBounceCompact", {
      actor: actorName(attackerActor),
      distance
    });
  } else {
    await applyStatus(attackerActor, PRONE_STATUS_ID);
    text = game.i18n.format("AOV_SKJALDBORG.KnockbackDialog.AttackerChoosesProneCompact", { actor: actorName(attackerActor) });
  }
  await createRecoveryMessage(context, {
    resultLevel: dexResultLevel,
    rollTotal: dexRoll.total,
    text
  });
  await createFumblePrompt(context, reason === "resistance-fumble" ? reason : "failed-dex-recovery");
}

async function handleAttackCardClosed(message, context) {
  if (attackSucceeded(message)) {
    await createKnockbackResistanceCard(context);
  }
}

async function handleResistanceCardClosed(message, context) {
  const chatCards = message.getFlag("aov", "chatCard") ?? [];
  const resultLevel = Number(chatCards[0]?.resultLevel ?? message.getFlag("aov", "resultLevel") ?? 1);
  if (resultLevel >= 2) {
    await handleSuccessfulResistance(message, context, resultLevel);
  } else {
    await handleUnsuccessfulAttempt(context, resultLevel === 0 ? "resistance-fumble" : "failed-resistance");
  }
}

async function markMessageResolved(message, context) {
  await message.setFlag(MODULE_ID, KNOCKBACK_FLAG, { ...context, resolved: true });
}

async function handleKnockbackChatUpdate(message) {
  if (!game.user?.isGM || !message?.id) return;
  const context = message.getFlag(MODULE_ID, KNOCKBACK_FLAG);
  if (!context || context.resolved === true) return;
  if (message.getFlag("aov", "state") !== "closed") return;
  if (processingMessages.has(message.id)) return;
  processingMessages.add(message.id);
  try {
    await markMessageResolved(message, context);
    if (context.stage === "attack") await handleAttackCardClosed(message, context);
    else if (context.stage === "resistance") await handleResistanceCardClosed(message, context);
  } catch (exception) {
    error("Failed to resolve Skjaldborg knockback automation.", exception);
    ui.notifications.error(localize("AOV_SKJALDBORG.Warnings.ActionFailed"));
  } finally {
    processingMessages.delete(message.id);
  }
}

function htmlElementFromRender(html) {
  if (html instanceof HTMLElement) return html;
  if (html?.[0] instanceof HTMLElement) return html[0];
  return null;
}

function bindFumblePrompt(message, html) {
  const element = htmlElementFromRender(html);
  const button = element?.querySelector?.("[data-aov-skj-knockback-fumble-table]");
  if (!button || button.dataset.skjKnockbackBound === "true") return;
  button.dataset.skjKnockbackBound = "true";
  button.addEventListener("click", event => {
    event.preventDefault();
    void rollFumblesTable().catch(exception => {
      error("Failed to roll the AoV Fumbles table for knockback.", exception);
      ui.notifications.error(localize("AOV_SKJALDBORG.Warnings.ActionFailed"));
    });
  });
}

/**
 * Start the Knockback workflow from the actor hotbar or action ring.
 *
 * @param {object} request Knockback request.
 * @param {Actor|object} request.actor Attacking Actor.
 * @param {Token|TokenDocument|object} request.targetToken Target token.
 * @param {Item|object|null} request.weapon Weapon or unarmed item context.
 * @param {number} request.targetNumber Roll target number.
 * @param {number} request.situationalModifier Situational modifier.
 * @param {number} request.augmentModifier Augmentation modifier.
 * @param {{custom?: {reason: string, value: number}|null}} request.augmentations Selected augmentation metadata.
 * @param {string} [request.batchId=""] Module batch id for multi-target submissions.
 * @param {number} [request.batchIndex=0] Zero-based index within the submitted target batch.
 * @param {number} [request.batchSize=1] Number of targets in the submitted batch.
 * @param {Event|null} [request.originEvent=null] Originating UI event.
 * @returns {Promise<ChatMessage|object|null>}
 */
export async function startKnockbackAttack({ actor, targetToken, weapon, targetNumber, situationalModifier, augmentModifier, augmentations, batchId = "", batchIndex = 0, batchSize = 1, originEvent = null }) {
  if (!actor || !targetToken?.actor || !weapon) return null;
  const combat = game.combat ?? null;
  const attackerToken = actor.getActiveTokens?.()?.[0]?.document ?? actor.token ?? null;
  const attackerCombatant = combatantForToken(combat, attackerToken, actor);
  const targetCombatant = combatantForToken(combat, targetToken.document, targetToken.actor);
  const flatMod = (Number(situationalModifier) || 0) + (Number(augmentModifier) || 0);
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
      flatMod
    })]
  };
  const html = await renderAoVChat(chatMsgData.chatTemplate, chatMsgData);
  return ChatMessage.create({
    user: game.user.id,
    style: CONST.CHAT_MESSAGE_STYLES.OTHER,
    content: html,
    speaker: {
      actor: actor.id,
      alias: game.i18n.localize("AOV.card.CO")
    },
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
        [KNOCKBACK_FLAG]: {
          stage: "attack",
          resolved: false,
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
          combatId: combat?.id ?? null,
          attackerCombatantId: attackerCombatant?.id ?? null,
          targetCombatantId: targetCombatant?.id ?? null
        }
      }
    }
  });
}

/**
 * Register Knockback chat automation hooks once.
 *
 * @returns {void}
 */
export function registerKnockbackAutomationHooks(hooks = globalThis.Hooks) {
  if (hooksRegistered) return;
  hooksRegistered = true;
  hooks.on("updateChatMessage", message => {
    void handleKnockbackChatUpdate(message).catch(warn);
  });
  hooks.on("renderChatMessageHTML", bindFumblePrompt);
}

export const __test = {
  d6TotalToD3,
  isHooksRegistered: () => hooksRegistered
};
