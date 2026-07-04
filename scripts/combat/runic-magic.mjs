import { MODULE_ID } from "../constants.mjs";
import { RUNE_MAGIC_STATUSES } from "./runic-magic-data.mjs";
import { getCombatantState, updateCombatantState } from "./state.mjs";
import { createModuleChatMessage } from "../compat/chat-message.mjs";
import { cleanString, numberOr } from "../utils/document-data.mjs";
import { RUNIC_MAGIC_RESISTANCE_FLAG } from "./runic-magic-cards.mjs";
import { warn } from "../logger.mjs";

let hooksRegistered = false;
const processingMessages = new Set();

function firstActiveGm() {
  return game.users?.find?.(user => user.active && user.isGM) ?? null;
}

function itemActor(item) {
  return item?.parent?.documentName === "Actor" ? item.parent : (item?.actor ?? item?.parent ?? null);
}

function changedPath(changed, path) {
  return foundry.utils.hasProperty(changed ?? {}, path);
}

function damagingWoundChange(item, changed = {}, { created = false } = {}) {
  if (item?.type === "wound") {
    if (!created && !changedPath(changed, "system.damage")) return false;
    return numberOr(item.system?.damage, 0) > 0;
  }
  if (item?.type === "hitloc") {
    if (!created && !changedPath(changed, "system.npcDmg")) return false;
    return numberOr(item.system?.npcDmg, 0) > 0;
  }
  return false;
}

function combatantsForActor(actor) {
  const actorId = String(actor?.id ?? "");
  const baseActorId = String(actor?.baseActor?.id ?? actorId);
  const results = [];
  for (const combat of game.combats ?? []) {
    if (!combat?.started) continue;
    for (const combatant of combat.combatants ?? []) {
      const candidate = combatant.actor;
      const candidateId = String(candidate?.id ?? "");
      const candidateBaseId = String(candidate?.baseActor?.id ?? candidateId);
      if (candidate === actor || candidateId === actorId || candidateBaseId === baseActorId) {
        results.push(combatant);
      }
    }
  }
  return results;
}

async function postDisruptionCard(combatant, state) {
  const actor = combatant?.actor ?? null;
  return createModuleChatMessage({
    speaker: ChatMessage.getSpeaker({ actor, token: combatant?.token }),
    flavor: game.i18n.localize("AOV_SKJALDBORG.RunicMagic.ChatDisruptedTitle"),
    content: `<p>${game.i18n.format("AOV_SKJALDBORG.RunicMagic.ChatDisrupted", {
      actor: actor?.name ?? combatant?.name ?? "",
      script: cleanString(state?.itemName, 160)
    })}</p><p>${game.i18n.localize("AOV_SKJALDBORG.RunicMagic.ChatDisruptedRule")}</p>`
  }, { applyDefaultMode: false });
}

function resistanceClosed(message) {
  return message?.getFlag?.("aov", "cardType") === "RE" && message?.getFlag?.("aov", "state") === "closed";
}

async function handleRunicResistanceMessage(message) {
  if (!game.user?.isGM || firstActiveGm()?.id !== game.user.id) return;
  if (!resistanceClosed(message)) return;
  const data = message.getFlag?.(MODULE_ID, RUNIC_MAGIC_RESISTANCE_FLAG) ?? null;
  if (!data || data.resolved === true) return;

  await message.update({
    [`flags.${MODULE_ID}.${RUNIC_MAGIC_RESISTANCE_FLAG}.resolved`]: true,
    [`flags.${MODULE_ID}.${RUNIC_MAGIC_RESISTANCE_FLAG}.resolvedAt`]: Date.now()
  });
}

async function handleMessageUpdate(message) {
  const key = String(message?.id ?? "");
  if (!key || processingMessages.has(key)) return;
  processingMessages.add(key);
  try {
    await handleRunicResistanceMessage(message);
  } finally {
    processingMessages.delete(key);
  }
}

export async function disruptRuneMagicForActorDamage(item, changed = {}, options = {}) {
  if (!game.user?.isGM || firstActiveGm()?.id !== game.user.id) return [];
  if (!damagingWoundChange(item, changed, { created: options.created === true })) return [];
  const actor = itemActor(item);
  if (!actor) return [];

  const updates = [];
  for (const combatant of combatantsForActor(actor)) {
    const state = getCombatantState(combatant);
    if (state.runeMagic?.status !== RUNE_MAGIC_STATUSES.CARVING) continue;
    const message = await postDisruptionCard(combatant, state.runeMagic);
    updates.push(updateCombatantState(combatant, {
      runeMagic: {
        ...state.runeMagic,
        status: RUNE_MAGIC_STATUSES.DISRUPTED,
        eventMessageId: message?.id ?? state.runeMagic.eventMessageId ?? null,
        notes: game.i18n.localize("AOV_SKJALDBORG.RunicMagic.StateDisrupted"),
        updatedAt: Date.now()
      },
      intent: {
        ...state.intent,
        runeCarryover: false
      }
    }));
  }
  return Promise.all(updates);
}

export function registerRunicMagicHooks() {
  if (hooksRegistered) return;
  hooksRegistered = true;
  Hooks.on("createItem", (item) => {
    void disruptRuneMagicForActorDamage(item, {}, { created: true }).catch(exception => warn(exception));
  });
  Hooks.on("updateItem", (item, changed) => {
    void disruptRuneMagicForActorDamage(item, changed, { created: false }).catch(exception => warn(exception));
  });
  Hooks.on("updateChatMessage", message => {
    void handleMessageUpdate(message).catch(exception => warn(exception));
  });
}

export const __test = {
  damagingWoundChange,
  resistanceClosed
};
