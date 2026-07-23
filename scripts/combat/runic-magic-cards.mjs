import { MODULE_ID } from "../constants.mjs";
import { AoVAdapter } from "../adapter/aov-adapter.mjs";
import { AOV_TEMPLATES } from "../adapter/aov-contract.mjs";
import { cleanString, numberOr } from "../utils/document-data.mjs";
import { cleanTargetRefs, runeMagicNarrativeKey } from "./runic-magic-data.mjs";
import {
  abilityTotal,
  buildResistanceChatCard,
  renderAoVChat,
  safeFromUuid
} from "./automation-helpers.mjs";
import { warn } from "../logger.mjs";

export const RUNIC_MAGIC_RESISTANCE_FLAG = "runicMagicResistance";

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function rawDescription(item) {
  if (typeof item?.system?.description === "string") return item.system.description;
  if (typeof item?.system?.description?.value === "string") return item.system.description.value;
  return "";
}

function rawShortDescription(item) {
  return cleanString(item?.system?.shortDesc, 5000);
}

async function enrichDescription(item) {
  const description = rawDescription(item);
  if (description.trim()) {
    try {
      const TextEditor = foundry.applications?.ux?.TextEditor?.implementation ?? globalThis.TextEditor;
      if (typeof TextEditor?.enrichHTML === "function") {
        return TextEditor.enrichHTML(description, {
          documents: true,
          embeds: true,
          links: true,
          relativeTo: item,
          rollData: item?.getRollData?.() ?? item?.parent?.getRollData?.() ?? {},
          rolls: true,
          secrets: Boolean(item?.isOwner)
        });
      }
    } catch (exception) {
      warn("Failed to enrich Runic Magic item description.", exception);
    }
    return description;
  }

  const fallback = rawShortDescription(item);
  return fallback ? `<p>${escapeHtml(fallback)}</p>` : "";
}

export function magicResultNarrativeKey(itemType, resultLevel) {
  const level = Number(resultLevel);
  if (!Number.isFinite(level)) return "";
  if (itemType === "seidur") {
    if (level >= 4) return "AOV_SKJALDBORG.RunicMagic.SeidurResults.Critical";
    if (level === 3) return "AOV_SKJALDBORG.RunicMagic.SeidurResults.Special";
    if (level === 2) return "AOV_SKJALDBORG.RunicMagic.SeidurResults.Success";
    if (level === 1) return "AOV_SKJALDBORG.RunicMagic.SeidurResults.Failure";
    return "AOV_SKJALDBORG.RunicMagic.SeidurResults.Fumble";
  }
  return runeMagicNarrativeKey(resultLevel);
}

function resultTitleKey(itemType) {
  return itemType === "seidur"
    ? "AOV_SKJALDBORG.RunicMagic.SeidurResultNarrative"
    : "AOV_SKJALDBORG.RunicMagic.ResultNarrative";
}

export async function magicDetailHtml(item, { resultLevel = null, itemType = item?.type ?? "runescript" } = {}) {
  const description = await enrichDescription(item);
  const narrativeKey = magicResultNarrativeKey(itemType, resultLevel);
  const narrative = narrativeKey ? game.i18n.localize(narrativeKey) : "";
  const title = game.i18n.localize(resultTitleKey(itemType));
  const itemName = cleanString(item?.name, 200) || game.i18n.localize("AOV_SKJALDBORG.Warnings.ItemUnavailable");
  const narrativeRow = narrative
    ? `<div class="skj-runic-magic-detail-row skj-runic-magic-narrative"><strong>${escapeHtml(title)}</strong>: ${escapeHtml(narrative)}</div>`
    : "";
  const descriptionRow = description
    ? `<div class="skj-runic-magic-detail-row skj-runic-magic-description">${description}</div>`
    : "";

  return `
    <form class="aov aov-skjaldborg-chat skj-runic-magic-result" data-runic-magic-details="${escapeHtml(item?.uuid ?? item?.id ?? itemName)}">
      <div class="dice-roll" data-action="expandRoll">
        <div class="actor-roll">
          <div class="roll-details">
            <div class="header roll-truncate">
              <div class="name truncate"><span class="tag">${escapeHtml(itemName)}</span></div>
            </div>
          </div>
        </div>
        <div class="actor-roll dice-tooltip skj-runic-magic-detail-body">
          ${narrativeRow}
          ${descriptionRow}
        </div>
      </div>
    </form>`;
}

export async function appendMagicDetailsToMessage(resultOrMessage, item, options = {}) {
  const message = resultOrMessage?.message ?? resultOrMessage ?? null;
  if (!message?.id || typeof message.update !== "function") return message ?? null;
  const content = String(message.content ?? "");
  if (content.includes("data-runic-magic-details=")) return message;
  const detail = await magicDetailHtml(item, options);
  await message.update({
    content: `${content}${detail}`
  }).catch(exception => warn(exception));
  return message;
}

async function resolveRunicTarget(ref) {
  const clean = cleanTargetRefs([ref])[0] ?? null;
  if (!clean) return null;
  const token = clean.tokenUuid ? await safeFromUuid(clean.tokenUuid) : null;
  const actor = token?.actor ?? (clean.actorUuid ? await safeFromUuid(clean.actorUuid) : null);
  if (!actor) return { ...clean, token, actor: null };
  return { ...clean, token, actor };
}

function activePowCard({ actor, tokenDocument }) {
  const rawScore = abilityTotal(actor, "pow");
  return buildResistanceChatCard({
    actor,
    tokenDocument,
    label: game.i18n.localize("AOV_SKJALDBORG.RunicMagic.ResistanceActiveLabel"),
    rawScore,
    targetScore: rawScore * 5,
    flatMod: 0,
    characteristic: "pow",
    active: true
  });
}

function passivePowCard({ actor, tokenDocument }) {
  const rawScore = abilityTotal(actor, "pow");
  const flatMod = numberOr(actor?.system?.powResist, 0);
  return buildResistanceChatCard({
    actor,
    tokenDocument,
    label: game.i18n.localize("AOV_SKJALDBORG.RunicMagic.ResistancePassiveLabel"),
    rawScore,
    targetScore: rawScore * 5 + flatMod,
    flatMod,
    characteristic: "pow",
    active: false
  });
}

export function buildRunicResistanceChatData({ actor, casterToken, targetActor, targetToken }) {
  return {
    rollType: "CH",
    cardType: "RE",
    chatTemplate: AOV_TEMPLATES.ROLL_RESISTANCE,
    state: "open",
    wait: true,
    resultLevel: 0,
    rollResult: undefined,
    chatCard: [
      activePowCard({ actor, tokenDocument: casterToken }),
      passivePowCard({ actor: targetActor, tokenDocument: targetToken })
    ]
  };
}

export async function createRunicResistanceCard({
  actor,
  casterToken = null,
  targetActor,
  targetToken = null,
  item,
  combatId = "",
  combatantId = "",
  castingBatchId = foundry.utils.randomID?.() ?? String(Date.now()),
  targetRef = {}
} = {}) {
  const chatMsgData = buildRunicResistanceChatData({ actor, casterToken, targetActor, targetToken });
  const html = await renderAoVChat(chatMsgData.chatTemplate, chatMsgData);
  const speaker = ChatMessage.getSpeaker({ actor, token: casterToken?.object ?? casterToken });
  return ChatMessage.create({
    user: game.user.id,
    content: html,
    speaker: {
      ...speaker,
      alias: game.i18n.localize("AOV.card.RE")
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
        successLevelLabel: ""
      },
      [MODULE_ID]: {
        [RUNIC_MAGIC_RESISTANCE_FLAG]: {
          castingBatchId,
          combatId: cleanString(combatId, 100),
          combatantId: cleanString(combatantId, 100),
          casterActorUuid: actor?.uuid ?? null,
          casterTokenUuid: casterToken?.uuid ?? null,
          itemUuid: item?.uuid ?? null,
          itemId: item?.id ?? null,
          targetActorUuid: targetActor?.uuid ?? targetRef?.actorUuid ?? null,
          targetTokenUuid: targetToken?.uuid ?? targetRef?.tokenUuid ?? null,
          targetName: targetActor?.name ?? targetRef?.name ?? "",
          createdAt: Date.now(),
          resolved: false
        }
      }
    }
  });
}

export async function createRunicResistanceCards({
  actor,
  casterToken = null,
  casterTokenUuid = "",
  targetRefs = [],
  item,
  combatId = "",
  combatantId = "",
  castingBatchId = foundry.utils.randomID?.() ?? String(Date.now())
} = {}) {
  const token = casterToken
    ?? (casterTokenUuid ? await safeFromUuid(casterTokenUuid) : null)
    ?? AoVAdapter.resolveActorTokenDocument(actor, null);
  const messages = [];
  for (const ref of cleanTargetRefs(targetRefs)) {
    const target = await resolveRunicTarget(ref);
    if (!target?.actor) {
      ui.notifications?.warn?.(game.i18n.format("AOV_SKJALDBORG.RunicMagic.TargetUnavailable", { target: ref.name ?? "" }));
      continue;
    }
    const message = await createRunicResistanceCard({
      actor,
      casterToken: token,
      targetActor: target.actor,
      targetToken: target.token,
      item,
      combatId,
      combatantId,
      castingBatchId,
      targetRef: ref
    });
    if (message) messages.push(message);
  }
  return messages;
}

export const __test = {
  buildRunicResistanceChatData,
  magicDetailHtml,
  magicResultNarrativeKey
};
