import { MODULE_ID } from "../constants.mjs";
import { createModuleChatMessage } from "../compat/chat-message.mjs";
import { startDialogCombatWorkflow } from "../socket.mjs";
import { startKnockbackAttack } from "./knockback-automation.mjs";
import { startGrappleAttack } from "./grapple-automation.mjs";
import { htmlEscape } from "../ui/dom-utils.mjs";
import { warn } from "../logger.mjs";

const TARGET_QUEUE_FLAG = "targetQueue";
const SPLIT_ATTACK_FLAG = "splitAttack";

let hooksRegistered = false;

function collectionArray(source) {
  if (!source) return [];
  if (typeof source.values === "function") return Array.from(source.values());
  return Array.from(source ?? []);
}

async function safeFromUuid(uuid) {
  const value = String(uuid ?? "").trim();
  if (!value || typeof fromUuid !== "function") return null;
  try {
    return await fromUuid(value);
  } catch (_exception) {
    return null;
  }
}

async function tokenLikeFromUuid(uuid) {
  const resolved = await safeFromUuid(uuid);
  if (!resolved) return null;
  if (resolved.document && resolved.actor) return resolved;
  const placeable = collectionArray(canvas?.tokens?.placeables)
    .find(token => token?.document?.uuid === resolved.uuid);
  if (placeable) return placeable;
  if (resolved.actor) {
    return {
      document: resolved,
      actor: resolved.actor,
      id: resolved.id ?? "",
      name: resolved.name ?? "",
      uuid: resolved.uuid ?? ""
    };
  }
  return resolved;
}

async function deductQueuedAmmunition(ammunition) {
  const before = Math.max(0, Math.trunc(Number(ammunition?.system?.quantity) || 0));
  if (before <= 0) throw new Error(localize("AOV_SKJALDBORG.Warnings.AmmunitionDepleted"));
  const after = Math.max(0, before - 1);
  await ammunition.update({ "system.quantity": after });
  return { before, after };
}

function localize(key) {
  return game.i18n.localize(key);
}

/**
 * Resolve Foundry v14 chat render HTML.
 *
 * Foundry v14 passes an HTMLElement to renderChatMessageHTML; the array-like
 * branch is retained only as a defensive compatibility fallback.
 *
 * @param {HTMLElement|ArrayLike<HTMLElement>|null|undefined} html Rendered chat message HTML.
 * @returns {HTMLElement|null}
 */
function resolveChatMessageElement(html) {
  if (!html) return null;
  if (typeof html.querySelectorAll === "function") return html;
  const candidate = html[0];
  return candidate && typeof candidate.querySelectorAll === "function" ? candidate : null;
}

function renderTargetQueueContent(queue) {
  const workflowLabel = localize(`AOV_SKJALDBORG.TargetQueue.Workflows.${queue.workflow}`);
  const rows = (queue.entries ?? []).map((entry, index) => {
    const resolvedClass = entry.resolved ? " is-resolved" : "";
    const label = entry.targetName || localize("AOV_SKJALDBORG.Labels.Unknown");
    const status = entry.resolved
      ? localize("AOV_SKJALDBORG.TargetQueue.Resolved")
      : localize("AOV_SKJALDBORG.TargetQueue.Pending");
    return `
      <li class="skj-target-queue__row${resolvedClass}">
        <span>${htmlEscape(label)}</span>
        <button type="button" data-skj-target-queue-resolve="${index}" ${entry.resolved ? "disabled" : ""}>
          ${htmlEscape(entry.resolved ? status : localize("AOV_SKJALDBORG.TargetQueue.Resolve"))}
        </button>
      </li>
    `;
  }).join("");
  return `
    <div class="aov-skjaldborg-chat skj-target-queue">
      <h3>${htmlEscape(game.i18n.format("AOV_SKJALDBORG.TargetQueue.Title", { workflow: workflowLabel }))}</h3>
      <p>${htmlEscape(localize("AOV_SKJALDBORG.TargetQueue.Body"))}</p>
      <ol>${rows}</ol>
    </div>
  `;
}

function renderSplitContent(split) {
  const resolved = split.resolved === true;
  return `
    <div class="aov-skjaldborg-chat skj-split-attack-chat">
      <h3>${htmlEscape(localize("AOV_SKJALDBORG.SplitAttack.Title"))}</h3>
      <p>${htmlEscape(game.i18n.format("AOV_SKJALDBORG.SplitAttack.Body", {
        actor: split.actorName ?? "",
        dex: split.secondDexRank ?? 0
      }))}</p>
      <button type="button" data-skj-resolve-split-attack ${resolved ? "disabled" : ""}>
        ${htmlEscape(resolved ? localize("AOV_SKJALDBORG.TargetQueue.Resolved") : localize("AOV_SKJALDBORG.SplitAttack.Resolve"))}
      </button>
    </div>
  `;
}

function stripLivePayload(payload = {}) {
  const {
    app: _app,
    actor: _actor,
    targetToken: _targetToken,
    targetActor: _targetActor,
    weapon: _weapon,
    ammunition: _ammunition,
    originEvent: _originEvent,
    ...rest
  } = payload;
  return foundry.utils.deepClone(rest);
}

/**
 * Create a queue card for remaining targets after the first target starts.
 *
 * @param {object} config Queue configuration.
 * @returns {Promise<ChatMessage|null>}
 */
export async function createTargetQueueCard({ actor, workflow, entries }) {
  const pending = Array.isArray(entries) ? entries.filter(Boolean) : [];
  if (!pending.length) return null;
  const queue = {
    workflow,
    actorUuid: actor?.uuid ?? null,
    actorName: actor?.name ?? "",
    createdAt: Date.now(),
    entries: pending.map(entry => ({
      ...stripLivePayload(entry),
      workflow,
      targetName: entry.targetActor?.name ?? entry.targetToken?.name ?? entry.targetName ?? "",
      actorUuid: entry.actor?.uuid ?? entry.actorUuid ?? actor?.uuid ?? null,
      weaponUuid: entry.weapon?.uuid ?? entry.weaponUuid ?? null,
      ammunitionUuid: entry.ammunition?.uuid ?? entry.ammunitionUuid ?? null,
      targetTokenUuid: entry.targetToken?.document?.uuid ?? entry.targetTokenUuid ?? null,
      targetActorUuid: entry.targetActor?.uuid ?? entry.targetActorUuid ?? null,
      resolved: false
    }))
  };
  return createModuleChatMessage({
    speaker: ChatMessage.getSpeaker({ actor }),
    content: renderTargetQueueContent(queue),
    flags: {
      [MODULE_ID]: {
        [TARGET_QUEUE_FLAG]: queue
      }
    }
  });
}

async function resolveQueueEntry(message, index) {
  const queue = foundry.utils.deepClone(message.getFlag(MODULE_ID, TARGET_QUEUE_FLAG) ?? null);
  const entry = queue?.entries?.[index] ?? null;
  if (!entry || entry.resolved) return;

  const actor = await safeFromUuid(entry.actorUuid);
  const weapon = await safeFromUuid(entry.weaponUuid);
  const targetToken = await tokenLikeFromUuid(entry.targetTokenUuid);
  const targetActor = await safeFromUuid(entry.targetActorUuid) ?? targetToken?.actor ?? null;
  const ammunition = await safeFromUuid(entry.ammunitionUuid);
  if (!actor || !weapon || !targetActor) {
    ui.notifications.warn(localize("AOV_SKJALDBORG.TargetQueue.MissingDocuments"));
    return;
  }

  const payload = {
    ...entry,
    actor,
    actorUuid: actor.uuid,
    weapon,
    weaponUuid: weapon.uuid,
    targetToken,
    targetTokenUuid: targetToken?.uuid ?? entry.targetTokenUuid ?? null,
    targetActor,
    targetActorUuid: targetActor.uuid,
    ammunition: ammunition ?? null,
    ammunitionUuid: ammunition?.uuid ?? entry.ammunitionUuid ?? null
  };

  if (queue.workflow === "missile" && payload.ammunitionRequired === true) {
    if (!ammunition) {
      ui.notifications.warn(localize("AOV_SKJALDBORG.Warnings.AmmunitionRequired"));
      return;
    }
    payload.ammunitionChange = await deductQueuedAmmunition(ammunition);
  }

  let started = false;
  if (queue.workflow === "knockback") {
    await startKnockbackAttack(payload);
    started = true;
  } else if (queue.workflow === "grapple") {
    await startGrappleAttack(payload);
    started = true;
  } else {
    const result = await startDialogCombatWorkflow(payload);
    started = result?.started === true;
  }
  if (!started) return;

  queue.entries[index].resolved = true;
  await message.update({
    content: renderTargetQueueContent(queue),
    [`flags.${MODULE_ID}.${TARGET_QUEUE_FLAG}`]: queue
  });
}

/**
 * Create a split-attack follow-up prompt.
 *
 * @param {object} split Split attack data.
 * @returns {Promise<ChatMessage|null>}
 */
export async function createSplitAttackPrompt(split) {
  if (!split?.actorUuid || !split?.weaponUuid) return null;
  const { actor, ...serializableSplit } = split;
  const data = {
    ...foundry.utils.deepClone(serializableSplit),
    resolved: false,
    createdAt: Date.now()
  };
  return createModuleChatMessage({
    speaker: ChatMessage.getSpeaker({ actor: actor ?? null }),
    content: renderSplitContent(data),
    flags: {
      [MODULE_ID]: {
        [SPLIT_ATTACK_FLAG]: data
      }
    }
  });
}

async function resolveSplitAttack(message) {
  const split = foundry.utils.deepClone(message.getFlag(MODULE_ID, SPLIT_ATTACK_FLAG) ?? null);
  if (!split || split.resolved) return;
  const actor = await safeFromUuid(split.actorUuid);
  if (!actor) {
    ui.notifications.warn(localize("AOV_SKJALDBORG.TargetQueue.MissingDocuments"));
    return;
  }
  const forcedSplitAttack = {
    baseChance: Number(split.secondChance) || 0,
    sourceMessageId: message.id,
    sourceWorkflow: split.sourceWorkflow
  };
  if (split.sourceWorkflow === "missile") {
    const { MissileRollDialog } = await import("../apps/missile-roll-dialog.mjs");
    const dialog = await MissileRollDialog.show({ actor, forcedSplitAttack });
    if (!dialog) return;
  } else {
    const { AttackRollDialog } = await import("../apps/attack-roll-dialog.mjs");
    const dialog = await AttackRollDialog.show({ actor, forcedSplitAttack });
    if (!dialog) return;
  }
  split.resolved = true;
  await message.update({
    content: renderSplitContent(split),
    [`flags.${MODULE_ID}.${SPLIT_ATTACK_FLAG}`]: split
  });
}

function bindTargetQueueControls(message, html) {
  const element = resolveChatMessageElement(html);
  if (!element) return;
  const queue = message.getFlag?.(MODULE_ID, TARGET_QUEUE_FLAG);
  if (queue) {
    for (const button of element.querySelectorAll("[data-skj-target-queue-resolve]")) {
      if (button.dataset.skjTargetQueueBound === "true") continue;
      button.dataset.skjTargetQueueBound = "true";
      button.addEventListener("click", event => {
        event.preventDefault();
        const index = Number(button.dataset.skjTargetQueueResolve);
        void resolveQueueEntry(message, index).catch(cause => {
          warn(cause);
          ui.notifications.error(localize("AOV_SKJALDBORG.Warnings.ActionFailed"));
        });
      });
    }
  }
  const split = message.getFlag?.(MODULE_ID, SPLIT_ATTACK_FLAG);
  if (split) {
    for (const button of element.querySelectorAll("[data-skj-resolve-split-attack]")) {
      if (button.dataset.skjSplitAttackBound === "true") continue;
      button.dataset.skjSplitAttackBound = "true";
      button.addEventListener("click", event => {
        event.preventDefault();
        void resolveSplitAttack(message).catch(cause => {
          warn(cause);
          ui.notifications.error(localize("AOV_SKJALDBORG.Warnings.ActionFailed"));
        });
      });
    }
  }
}

export function registerDialogTargetQueueHooks() {
  if (hooksRegistered) return;
  hooksRegistered = true;
  Hooks.on("renderChatMessageHTML", bindTargetQueueControls);
}
