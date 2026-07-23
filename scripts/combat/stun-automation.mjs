/**
 * Stun follow-up and recovery automation.
 *
 * Stun source combat cards suppress normal damage, create one AoV-style
 * resistance card, and apply only module-managed status effects on success.
 * Bookkeeping hooks then emit one recovery prompt per logical round and resolve
 * it idempotently from the prompt message flag.
 */
import { MODULE_ID, PHASES } from "../constants.mjs";
import { AoVAdapter } from "../adapter/aov-adapter.mjs";
import { AOV_TEMPLATES } from "../adapter/aov-contract.mjs";
import { createModuleChatMessage } from "../compat/chat-message.mjs";
import {
  effectHasStatus,
  effectIsActive,
  getStatusEffectConfig,
  moduleFlag,
  safeDeleteActiveEffect,
  upsertActorStatusEffect
} from "../compat/active-effects.mjs";
import { warn } from "../logger.mjs";
import { incrementCounter } from "../performance/performance-monitor.mjs";
import { getCombatState } from "./state.mjs";
import {
  abilityTotal,
  aovCards,
  attackCardResolved,
  attackCardSucceeded,
  buildResistanceChatCard,
  evaluateD100,
  evaluateVisibleRoll,
  inlineResultHtml,
  localize,
  numberOr,
  renderActorStackCard,
  renderAoVChat,
  resolveChatMessageElement,
  rerenderAoVMessage,
  resultIconHtml,
  safeFromUuid
} from "./automation-helpers.mjs";

const STUN_FLAG = "stun";
const STUN_STATUS_FLAG = "stunStatus";
const STUN_RECOVERY_FLAG = "stunRecovery";
const processingMessages = new Set();
let hooksRegistered = false;

function resistanceResolved(message) {
  return message?.getFlag?.("aov", "cardType") === "RE" && message?.getFlag?.("aov", "state") === "closed";
}

async function updateStunSource(message, data) {
  if (!message?.update) return;
  const update = {};
  for (const [key, value] of Object.entries(data)) {
    update[`flags.${MODULE_ID}.${STUN_FLAG}.${key}`] = value;
  }
  await message.update(update);
}

async function markStunResolved(message, data = {}) {
  await updateStunSource(message, {
    ...data,
    resolved: true,
    stage: data.stage ?? "resolved",
    resolvedAt: Date.now()
  });
}

async function sourceMessageForStun(stun) {
  return game.messages?.get?.(String(stun.sourceMessageId ?? "")) ?? null;
}

async function resolveContext(stun) {
  const attackerActor = await safeFromUuid(stun.attackerActorUuid);
  const targetActor = await safeFromUuid(stun.targetActorUuid);
  const attackerToken = await safeFromUuid(stun.attackerTokenUuid);
  const targetToken = await safeFromUuid(stun.targetTokenUuid);
  const weapon = await safeFromUuid(stun.weaponUuid) ?? attackerActor?.items?.get?.(String(stun.weaponId ?? "")) ?? null;
  const hitLocation = targetActor?.items?.get?.(String(stun.hitLocationId ?? "")) ?? null;
  return { attackerActor, targetActor, attackerToken, targetToken, weapon, hitLocation };
}

function locationArmor(actor, hitLocation) {
  return actor?.type === "npc"
    ? Math.max(0, numberOr(hitLocation?.system?.npcAP, 0))
    : Math.max(0, numberOr(hitLocation?.system?.map, 0));
}

function locationCurrentHp(actor, hitLocation) {
  const hpMax = Math.max(0, numberOr(hitLocation?.system?.hpMax, 0));
  if (actor?.type === "npc") {
    return Math.max(0, numberOr(hitLocation?.system?.currHp, hpMax - Math.max(0, numberOr(hitLocation?.system?.npcDmg, 0))));
  }
  return Math.max(0, numberOr(hitLocation?.system?.currHp, hpMax));
}

function normalizeFormula(formula) {
  return String(formula ?? "")
    .replace(/\s+/g, "")
    .replace(/\u2212/g, "-")
    .replace(/^([dD])/, "1$1");
}

function minimumFormulaValue(formula) {
  let expression = normalizeFormula(formula);
  if (!expression || expression === "0" || expression === "+0") return { supported: true, total: 0 };
  if (!/^[+-]/.test(expression)) expression = `+${expression}`;

  let total = 0;
  let consumed = "";
  const terms = expression.matchAll(/([+-])([^+-]+)/g);
  for (const match of terms) {
    consumed += match[0];
    const sign = match[1] === "-" ? -1 : 1;
    const term = String(match[2] ?? "");
    const dice = term.match(/^(\d*)[dD](\d+)(?:\/(\d+))?$/);
    if (dice) {
      const count = Math.max(1, Number(dice[1] || 1));
      const sides = Math.max(1, Number(dice[2] || 1));
      const divisor = Math.max(1, Number(dice[3] || 1));
      const raw = sign > 0 ? count : -(count * sides);
      total += sign > 0 ? Math.ceil(raw / divisor) : Math.floor(raw / divisor);
      continue;
    }
    const flat = term.match(/^(\d+(?:\.\d+)?)(?:\/(\d+))?$/);
    if (flat) {
      const divisor = Math.max(1, Number(flat[2] || 1));
      total += sign * (Number(flat[1]) / divisor);
      continue;
    }
    return { supported: false, total: 0 };
  }
  return consumed === expression
    ? { supported: true, total: Math.ceil(total) }
    : { supported: false, total: 0 };
}

function weaponDamageBonusFormula(actor, weapon) {
  const base = normalizeFormula(actor?.system?.dmgBonus ?? "0");
  if (!base || base === "0" || base === "+0") return "0";
  const mode = String(weapon?.system?.damMod ?? "d").trim().toLowerCase();
  if (mode === "n") return "0";
  if (mode === "h") return `${base}/2`;
  return base;
}

function minimumStunDamage(actor, weapon) {
  const weaponFormula = minimumFormulaValue(weapon?.system?.damage ?? "");
  const bonusFormula = minimumFormulaValue(weaponDamageBonusFormula(actor, weapon));
  if (!weaponFormula.supported || !bonusFormula.supported) {
    return { supported: false, weapon: 0, bonus: 0, total: 0 };
  }
  const weaponTotal = Math.max(0, weaponFormula.total);
  const total = Math.max(0, weaponTotal + bonusFormula.total);
  return { supported: true, weapon: weaponTotal, bonus: bonusFormula.total, total };
}

async function suppressStunDamagePrompt(message) {
  const cards = foundry.utils.deepClone(aovCards(message));
  let changed = false;
  for (const card of cards) {
    if (card?.rollDamage === true) {
      card.rollDamage = false;
      changed = true;
    }
  }
  if (!changed) return false;
  await message.update({ "flags.aov.chatCard": cards });
  await rerenderAoVMessage(message, { fallbackTemplate: null });
  return true;
}

async function createResultMessage(stun, { actor, resultLevel = 2, text, rows = [] }) {
  const { attackerActor } = await resolveContext(stun);
  const content = renderActorStackCard({
    actor,
    title: localize("AOV_SKJALDBORG.StunDialog.ResultTitle"),
    label: localize("AOV_SKJALDBORG.StunDialog.ResultTitle"),
    resultHtml: inlineResultHtml({ iconHtml: resultIconHtml(resultLevel), text }),
    resultClass: resultLevel >= 2
      ? "skj-knockback-chat-result--success is-compact"
      : "skj-knockback-chat-result--failure is-compact",
    showResultTitle: false,
    formClass: "aov-skjaldborg-stun-chat",
    extraRows: rows
  });
  return createModuleChatMessage({
    user: game.user.id,
    speaker: { actor: attackerActor?.id ?? null, alias: localize("AOV_SKJALDBORG.StunDialog.ResultTitle") },
    content
  }, { applyDefaultMode: true });
}

async function createResistanceCard(sourceMessage, stun, { activeScore, passiveScore, rows = [] }) {
  const { attackerActor, targetActor, attackerToken, targetToken } = await resolveContext(stun);
  if (!attackerActor || !targetActor) {
    ui.notifications.warn(localize("AOV_SKJALDBORG.StunDialog.MissingActors"));
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
      buildResistanceChatCard({
        actor: attackerActor,
        tokenDocument: attackerToken,
        label: localize("AOV_SKJALDBORG.StunDialog.ResistanceActiveLabel"),
        rawScore: activeScore,
        active: true
      }),
      buildResistanceChatCard({
        actor: targetActor,
        tokenDocument: targetToken,
        label: localize("AOV_SKJALDBORG.StunDialog.ResistancePassiveLabel"),
        rawScore: passiveScore,
        active: false
      })
    ]
  };
  const html = await renderAoVChat(chatMsgData.chatTemplate, chatMsgData);
  const message = await createModuleChatMessage({
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
        [STUN_FLAG]: {
          ...stun,
          sourceMessageId: sourceMessage.id,
          resistanceRows: rows,
          resistanceMessageId: null,
          stage: "resistance",
          resolved: false
        }
      }
    }
  }, { applyDefaultMode: false });
  if (message) {
    await message.update({ [`flags.${MODULE_ID}.${STUN_FLAG}.resistanceMessageId`]: message.id });
    await updateStunSource(sourceMessage, { stage: "resistance", resistanceMessageId: message.id });
  }
  return message;
}

function coreStunStatusId() {
  return getStatusEffectConfig("stunned") ? "stunned" : "unconscious";
}

function isStunStatusEffect(effect) {
  return !!moduleFlag(effect, STUN_STATUS_FLAG) && effectIsActive(effect);
}

async function applyStunStatus(stun) {
  const { targetActor, targetToken, hitLocation } = await resolveContext(stun);
  if (!targetActor || !hitLocation) {
    ui.notifications.warn(localize("AOV_SKJALDBORG.StunDialog.MissingStatusTarget"));
    return null;
  }
  const statusId = coreStunStatusId();
  const data = {
    sourceMessageId: stun.sourceMessageId ?? null,
    resistanceMessageId: stun.resistanceMessageId ?? null,
    targetActorUuid: targetActor.uuid,
    targetTokenUuid: targetToken?.uuid ?? stun.targetTokenUuid ?? null,
    hitLocationId: hitLocation.id,
    hitLocationName: hitLocation.name,
    combatId: game.combat?.id ?? null,
    round: game.combat?.round ?? null,
    logicalRound: game.combat ? AoVAdapter.getSystemLogicalRound(game.combat) : null,
    lastPromptLogicalRound: null,
    statusId
  };
  return upsertActorStatusEffect(targetActor, {
    statusId,
    name: localize("AOV_SKJALDBORG.StunDialog.StatusName"),
    moduleFlags: { [STUN_STATUS_FLAG]: data },
    predicate: effect => moduleFlag(effect, STUN_STATUS_FLAG) !== undefined || effectHasStatus(effect, statusId),
    useToggle: false
  });
}

async function handleCombatMessage(message) {
  if (!game.user?.isGM || !attackCardResolved(message)) return;
  const stun = message.getFlag?.(MODULE_ID, STUN_FLAG) ?? null;
  if (!stun || stun.resolved === true || stun.stage !== "attack") return;

  if (!attackCardSucceeded(message)) {
    await markStunResolved(message, { stage: "failedAttack" });
    return;
  }

  const { attackerActor, targetActor, weapon, hitLocation } = await resolveContext(stun);
  if (!attackerActor || !targetActor || !weapon || hitLocation?.type !== "hitloc") {
    ui.notifications.warn(localize("AOV_SKJALDBORG.StunDialog.MissingActors"));
    await markStunResolved(message, { stage: "missingContext" });
    return;
  }

  const damage = minimumStunDamage(attackerActor, weapon);
  if (!damage.supported) {
    ui.notifications.warn(localize("AOV_SKJALDBORG.StunDialog.UnsupportedDamageFormula"));
    await markStunResolved(message, { stage: "unsupportedDamage" });
    return;
  }

  await suppressStunDamagePrompt(message);
  const armor = locationArmor(targetActor, hitLocation);
  const remaining = Math.max(0, damage.total - armor);
  const headHp = locationCurrentHp(targetActor, hitLocation);
  const rows = [
    game.i18n.format("AOV_SKJALDBORG.StunDialog.HeadLocationRow", { location: hitLocation.name }),
    game.i18n.format("AOV_SKJALDBORG.StunDialog.MinimumDamageRow", { damage: damage.total, armor, remaining })
  ];

  if (remaining <= 0) {
    await createResultMessage(stun, {
      actor: targetActor,
      resultLevel: 1,
      text: localize("AOV_SKJALDBORG.StunDialog.NoStunDamage"),
      rows
    });
    await markStunResolved(message, { stage: "noStunDamage", minimumDamage: damage.total, armor, remaining });
    return;
  }

  await createResistanceCard(message, {
    ...stun,
    minimumDamage: damage.total,
    armourAbsorb: armor,
    remainingDamage: remaining,
    headCurrentHp: headHp
  }, { activeScore: remaining, passiveScore: headHp, rows });
}

async function handleResistanceMessage(message) {
  if (!game.user?.isGM || !resistanceResolved(message)) return;
  const stun = message.getFlag?.(MODULE_ID, STUN_FLAG) ?? null;
  if (!stun || stun.resolved === true || stun.stage !== "resistance") return;

  const sourceMessage = await sourceMessageForStun(stun);
  const { targetActor } = await resolveContext(stun);
  const resultLevel = Number(aovCards(message)[0]?.resultLevel ?? 1);
  if (resultLevel >= 2) {
    await applyStunStatus({ ...stun, resistanceMessageId: message.id });
    await createResultMessage(stun, {
      actor: targetActor,
      resultLevel,
      text: game.i18n.format("AOV_SKJALDBORG.StunDialog.StunApplied", { target: targetActor?.name ?? "" }),
      rows: stun.resistanceRows ?? []
    });
    if (sourceMessage) await markStunResolved(sourceMessage, { stage: "resolved", resistanceMessageId: message.id });
  } else {
    await createResultMessage(stun, {
      actor: targetActor,
      resultLevel,
      text: game.i18n.format("AOV_SKJALDBORG.StunDialog.StunResisted", { target: targetActor?.name ?? "" }),
      rows: stun.resistanceRows ?? []
    });
    if (sourceMessage) await markStunResolved(sourceMessage, { stage: "failedResistance", resistanceMessageId: message.id });
  }
  await message.update({ [`flags.${MODULE_ID}.${STUN_FLAG}.resolved`]: true });
}

async function handleMessageUpdate(message) {
  const key = String(message?.id ?? "");
  if (!key || processingMessages.has(key)) return;
  incrementCounter("automation.stun.message", 1, {
    cardType: message.getFlag?.("aov", "cardType") ?? null,
    state: message.getFlag?.("aov", "state") ?? null
  });
  processingMessages.add(key);
  try {
    await handleCombatMessage(message);
    await handleResistanceMessage(message);
  } finally {
    processingMessages.delete(key);
  }
}

function actorForCombatant(combatant) {
  return combatant?.actor ?? combatant?.token?.actor ?? null;
}

function stunEffectsForActor(actor) {
  return Array.from(actor?.effects ?? []).filter(isStunStatusEffect);
}

async function updateEffectStunData(effect, data) {
  if (!effect?.update) return;
  const update = {};
  for (const [key, value] of Object.entries(data)) {
    update[`flags.${MODULE_ID}.${STUN_STATUS_FLAG}.${key}`] = value;
  }
  await effect.update(update);
}

async function createRecoveryPrompt(actor, effect, data, logicalRound) {
  const content = renderActorStackCard({
    actor,
    title: localize("AOV_SKJALDBORG.StunDialog.RecoveryTitle"),
    label: localize("AOV_SKJALDBORG.StunDialog.RecoveryLabel"),
    resultHtml: `${inlineResultHtml({
      iconHtml: resultIconHtml(1),
      text: game.i18n.format("AOV_SKJALDBORG.StunDialog.RecoveryPrompt", { target: actor?.name ?? "" })
    })}<button type="button" class="resolve cardbutton" data-aov-skj-stun-recovery>${foundry.utils.escapeHTML(localize("AOV_SKJALDBORG.StunDialog.RecoverButton"))}</button>`,
    resultClass: "skj-knockback-chat-result--failure is-compact",
    showResultTitle: false,
    formClass: "aov-skjaldborg-stun-chat",
    extraRows: [game.i18n.format("AOV_SKJALDBORG.StunDialog.HeadLocationRow", { location: data.hitLocationName ?? "" })]
  });
  const message = await createModuleChatMessage({
    user: game.user.id,
    speaker: { actor: actor?.id ?? null, alias: localize("AOV_SKJALDBORG.StunDialog.RecoveryTitle") },
    content,
    flags: {
      [MODULE_ID]: {
        [STUN_RECOVERY_FLAG]: {
          resolved: false,
          actorUuid: actor?.uuid ?? data.targetActorUuid ?? null,
          effectId: effect?.id ?? null,
          hitLocationId: data.hitLocationId ?? "",
          hitLocationName: data.hitLocationName ?? "",
          combatId: game.combat?.id ?? data.combatId ?? null,
          logicalRound,
          createdAt: Date.now()
        }
      }
    }
  }, { applyDefaultMode: true });
  if (message) await updateEffectStunData(effect, { lastPromptLogicalRound: logicalRound, lastPromptMessageId: message.id });
  return message;
}

async function createRecoveryPrompts(combat, { logicalRound = null } = {}) {
  if (!game.user?.isGM || !combat) return 0;
  const round = Number.isFinite(Number(logicalRound))
    ? Number(logicalRound)
    : AoVAdapter.getSystemLogicalRound(combat);
  let created = 0;
  const seenActors = new Set();
  for (const combatant of combat.combatants ?? []) {
    const actor = actorForCombatant(combatant);
    const actorKey = String(actor?.uuid ?? actor?.id ?? "");
    if (!actor || seenActors.has(actorKey)) continue;
    seenActors.add(actorKey);
    for (const effect of stunEffectsForActor(actor)) {
      const data = moduleFlag(effect, STUN_STATUS_FLAG) ?? null;
      if (!data) continue;
      if (data.combatId && combat.id && data.combatId !== combat.id) continue;
      if (Number(data.lastPromptLogicalRound) === round) continue;
      await createRecoveryPrompt(actor, effect, data, round);
      created += 1;
    }
  }
  return created;
}

async function applyRecoveryDamage(actor, hitLocationId) {
  const location = actor?.items?.get?.(String(hitLocationId ?? ""));
  if (!actor || location?.type !== "hitloc") throw new Error(localize("AOV_SKJALDBORG.StunDialog.MissingStatusTarget"));
  if (actor.type === "npc") {
    const current = Math.max(0, numberOr(location.system?.npcDmg, 0));
    await actor.updateEmbeddedDocuments("Item", [{ _id: location.id, "system.npcDmg": current + 1 }], { [MODULE_ID]: { reason: "stun-recovery" } });
    return;
  }
  const itemClass = globalThis.getDocumentClass?.("Item") ?? globalThis.CONFIG?.Item?.documentClass;
  const localizedName = game.i18n.localize("TYPES.Item.wound");
  const name = itemClass?.defaultName?.({ type: "wound", parent: actor })
    ?? (localizedName === "TYPES.Item.wound" ? "Wound" : localizedName);
  await actor.createEmbeddedDocuments("Item", [{
    name,
    type: "wound",
    system: {
      hitLocId: location.id,
      damage: 1
    }
  }], { [MODULE_ID]: { reason: "stun-recovery" } });
}

async function resolveRecoveryPrompt(message) {
  const recovery = message?.getFlag?.(MODULE_ID, STUN_RECOVERY_FLAG) ?? null;
  if (!recovery || recovery.resolved === true) {
    ui.notifications.warn(localize("AOV_SKJALDBORG.StunDialog.RecoveryAlreadyResolved"));
    return;
  }
  const actor = await safeFromUuid(recovery.actorUuid);
  if (!actor) {
    ui.notifications.warn(localize("AOV_SKJALDBORG.StunDialog.MissingStatusTarget"));
    return;
  }
  const roll = await evaluateVisibleRoll("1D100", "Dice So Nice roll display failed for Skjaldborg Stun recovery.");
  const targetScore = abilityTotal(actor, "con") * 5;
  const resultLevel = evaluateD100(targetScore, roll.total);
  const success = resultLevel >= 2;
  await applyRecoveryDamage(actor, recovery.hitLocationId);
  const effect = Array.from(actor.effects ?? []).find(candidate => String(candidate?.id ?? "") === String(recovery.effectId ?? ""))
    ?? stunEffectsForActor(actor)[0]
    ?? null;
  if (success) await safeDeleteActiveEffect(effect, { reason: "stun-recovery" });

  const text = game.i18n.format(success
    ? "AOV_SKJALDBORG.StunDialog.RecoverySuccess"
    : "AOV_SKJALDBORG.StunDialog.RecoveryFailure", {
      target: actor.name
    });
  const content = renderActorStackCard({
    actor,
    title: localize("AOV_SKJALDBORG.StunDialog.RecoveryTitle"),
    label: localize("AOV_SKJALDBORG.StunDialog.RecoveryLabel"),
    resultHtml: inlineResultHtml({ iconHtml: resultIconHtml(resultLevel), text }),
    resultClass: success
      ? "skj-knockback-chat-result--success is-compact"
      : "skj-knockback-chat-result--failure is-compact",
    showResultTitle: false,
    formClass: "aov-skjaldborg-stun-chat",
    extraRows: [
      `${localize("AOV_SKJALDBORG.StunDialog.RecoveryLabel")}: ${targetScore}% (${Math.ceil(Number(roll.total) || 0)})`,
      game.i18n.format("AOV_SKJALDBORG.StunDialog.HeadLocationRow", { location: recovery.hitLocationName ?? "" })
    ]
  });
  await message.update({
    content,
    [`flags.${MODULE_ID}.${STUN_RECOVERY_FLAG}.resolved`]: true,
    [`flags.${MODULE_ID}.${STUN_RECOVERY_FLAG}.resolvedAt`]: Date.now(),
    [`flags.${MODULE_ID}.${STUN_RECOVERY_FLAG}.rollTotal`]: Math.ceil(Number(roll.total) || 0),
    [`flags.${MODULE_ID}.${STUN_RECOVERY_FLAG}.targetScore`]: targetScore,
    [`flags.${MODULE_ID}.${STUN_RECOVERY_FLAG}.resultLevel`]: resultLevel,
    [`flags.${MODULE_ID}.${STUN_RECOVERY_FLAG}.success`]: success
  });
}

function bindRecoveryPrompt(message, html) {
  const recovery = message?.getFlag?.(MODULE_ID, STUN_RECOVERY_FLAG) ?? null;
  if (!recovery || recovery.resolved === true) return;
  const element = resolveChatMessageElement(html);
  const button = element?.querySelector?.("button[data-aov-skj-stun-recovery]");
  if (!button) return;
  button.addEventListener("click", event => {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    void resolveRecoveryPrompt(message).catch(exception => {
      warn(exception);
      ui.notifications.error(game.i18n.localize("AOV_SKJALDBORG.Warnings.ActionFailed"));
    });
  }, { capture: true });
}

function maybeBookkeepingPrompt(combat) {
  const state = getCombatState(combat);
  if (state.phase !== PHASES.BOOKKEEPING) return;
  void createRecoveryPrompts(combat, { logicalRound: state.logicalRound }).catch(exception => warn(exception));
}

/**
 * Register Stun source-card, recovery-prompt, and bookkeeping hooks once.
 *
 * @returns {void}
 */
export function registerStunAutomationHooks(hooks = globalThis.Hooks) {
  if (hooksRegistered) return;
  hooksRegistered = true;
  hooks.on("createChatMessage", message => {
    void handleMessageUpdate(message).catch(exception => warn(exception));
  });
  hooks.on("updateChatMessage", message => {
    void handleMessageUpdate(message).catch(exception => warn(exception));
  });
  hooks.on("renderChatMessageHTML", bindRecoveryPrompt);
  hooks.on("updateCombat", (combat, changed = {}) => {
    if (!Object.prototype.hasOwnProperty.call(changed ?? {}, `flags.${MODULE_ID}`)
      && !Object.prototype.hasOwnProperty.call(changed ?? {}, "flags")
      && !Object.prototype.hasOwnProperty.call(changed ?? {}, "round")) return;
    maybeBookkeepingPrompt(combat);
  });
  hooks.on("aovSkjaldborgImmediateBookkeeping", (combat, _ledger, options = {}) => {
    const round = Number(options?.logicalRound ?? getCombatState(combat).logicalRound);
    void createRecoveryPrompts(combat, { logicalRound: round }).catch(exception => warn(exception));
  });
}

export const __test = {
  minimumFormulaValue,
  minimumStunDamage,
  isHooksRegistered: () => hooksRegistered
};
