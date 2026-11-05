import { MODULE_ID } from "../constants.mjs";
import { createModuleChatMessage } from "../compat/chat-message.mjs";
import { requestGm, runClaimedChatAction, startDialogCombatWorkflowBatch } from "../socket.mjs";
import { startKnockbackAttack } from "./knockback-automation.mjs";
import { startGrappleAttack } from "./grapple-automation.mjs";
import { htmlEscape } from "../ui/dom-utils.mjs";
import { warn } from "../logger.mjs";
import { collectionArray, safeFromUuid } from "../utils/document-data.mjs";
import { resolveChatMessageElement } from "./automation-helpers.mjs";
import { enqueueDocumentWrite } from "./authoritative-write-queue.mjs";
import { isAuthoritativeGmClient } from "../utils/authority.mjs";
import { valuesMeaningfullyEqual } from "../utils/guarded-document-writes.mjs";
import { ACTION_CLAIMS_FLAG, CLAIM_VERSION, chatActionClaimKey, matchesChatActionClaimResult } from "./action-claim-evidence.mjs";

const TARGET_QUEUE_FLAG = "targetQueue";
const SPLIT_ATTACK_FLAG = "splitAttack";
const CLAIM_LEASE_MS = 60000;

let hooksRegistered = false;

function combatClaimContext() {
  const combat = game.combat;
  const state = combat?.getFlag?.(MODULE_ID, "combatState");
  return state?.enabled === true ? { combatId: combat.id, logicalRound: state.logicalRound, phase: state.phase } : null;
}

function assertClaimContext(context) {
  if (!context) return;
  const combat = game.combats?.get?.(context.combatId)
    ?? (game.combat?.id === context.combatId ? game.combat : null);
  const state = combat?.getFlag?.(MODULE_ID, "combatState");
  if (!state?.enabled || state.logicalRound !== context.logicalRound || state.phase !== context.phase) {
    throw new Error(localize("AOV_SKJALDBORG.Warnings.StaleDocument"));
  }
}

/**
 * Arbitrate a persisted one-use chat action on the selected GM. Only a claimed
 * reservation may expire. Once execution is authorized, absence of a result
 * is ambiguous and never permits an automatic retry.
 */
export function updateChatActionClaim(payload, user) {
  return enqueueDocumentWrite(`ChatMessage.${payload.sourceMessageId}`, async () => {
    if (!isAuthoritativeGmClient()) throw new Error(localize("AOV_SKJALDBORG.Warnings.GmChanged"));
    const message = game.messages?.get?.(payload.sourceMessageId);
    const flag = payload.kind === "target" ? TARGET_QUEUE_FLAG : SPLIT_ATTACK_FLAG;
    const source = message?.getFlag?.(MODULE_ID, flag);
    const row = payload.kind === "target" ? source?.entries?.[payload.index] : source;
    if (!row || typeof row !== "object" || Array.isArray(row)
      || (payload.kind === "target" && (!Number.isInteger(payload.index) || payload.index < 0))) {
      throw new Error(localize("AOV_SKJALDBORG.TargetQueue.MissingDocuments"));
    }
    const actorUuid = row.actorUuid ?? source.actorUuid;
    if (source.actorUuid && source.actorUuid !== actorUuid) throw new Error(localize("AOV_SKJALDBORG.Warnings.StaleDocument"));
    const actor = await safeFromUuid(actorUuid);
    const recipients = Array.from(message.whisper ?? [], recipient => String(recipient?.id ?? recipient));
    if (!actor || (!user?.isGM && (!actor.testUserPermission?.(user, "OWNER")
      || message.blind === true || (recipients.length && !recipients.includes(user.id))))) {
      throw new Error(localize("AOV_SKJALDBORG.Warnings.NotOwner"));
    }
    const slot = payload.kind === "target" ? `target-${payload.index}` : "split";
    const key = chatActionClaimKey(message, slot);
    const stored = message.getFlag(MODULE_ID, ACTION_CLAIMS_FLAG);
    if (stored && stored.version !== CLAIM_VERSION) throw new Error(localize("AOV_SKJALDBORG.Warnings.StaleDocument"));
    const claims = foundry.utils.deepClone(stored ?? { version: CLAIM_VERSION, context: combatClaimContext(), entries: {} });
    if (!claims.entries || typeof claims.entries !== "object" || Array.isArray(claims.entries)) {
      throw new Error(localize("AOV_SKJALDBORG.Warnings.StaleDocument"));
    }
    const current = claims.entries[slot];
    if (current && !["pending", "claimed", "executing", "committed"].includes(current.state)) {
      throw new Error(localize("AOV_SKJALDBORG.Warnings.StaleDocument"));
    }
    if (["claimed", "executing"].includes(current?.state) && (!current.attemptId || typeof current.attemptId !== "string"
      || typeof current.userId !== "string" || !Number.isFinite(current.claimedAt) || !current.subject || typeof current.subject !== "object")) {
      throw new Error(localize("AOV_SKJALDBORG.Warnings.StaleDocument"));
    }
    const subject = {
      actorUuid, weaponUuid: row.weaponUuid ?? null,
      targetTokenUuid: row.targetTokenUuid ?? null, targetActorUuid: row.targetActorUuid ?? null
    };
    const validateSubject = async () => {
      const weapon = await safeFromUuid(subject.weaponUuid);
      const target = subject.targetTokenUuid ? await safeFromUuid(subject.targetTokenUuid)
        : subject.targetActorUuid ? await safeFromUuid(subject.targetActorUuid) : null;
      if (!weapon || weapon.parent?.uuid !== actor.uuid
        || (subject.targetTokenUuid ? !target?.actor || (subject.targetActorUuid && target.actor.uuid !== subject.targetActorUuid) : subject.targetActorUuid && !target)) {
        throw new Error(localize("AOV_SKJALDBORG.TargetQueue.MissingDocuments"));
      }
      return weapon;
    };
    const requiresClaimAmmunition = async weapon => (source.workflow ?? source.sourceWorkflow) === "missile"
      && (await import("../apps/missile-roll-dialog.mjs")).requiresAmmunition(weapon);
    const validateAmmunition = async (uuid, count) => {
      const ammunition = await safeFromUuid(uuid);
      if (ammunition?.type !== "gear" || ammunition.parent?.uuid !== actor.uuid
        || !Number.isInteger(ammunition.system?.quantity) || !Number.isInteger(count)
        || count <= 0 || ammunition.system.quantity < count) {
        throw new Error(localize("AOV_SKJALDBORG.Warnings.AmmunitionDepleted"));
      }
      return ammunition;
    };
    const linkedIds = current?.attemptId
      ? collectionArray(game.messages).filter(candidate => matchesChatActionClaimResult(candidate, key, current.attemptId)).map(candidate => candidate.id).filter(Boolean)
      : [];
    const recordedIds = Array.isArray(current?.resultMessageIds) ? current.resultMessageIds.filter(id => typeof id === "string") : [];
    const save = async () => {
      if (!isAuthoritativeGmClient()) throw new Error(localize("AOV_SKJALDBORG.Warnings.GmChanged"));
      const update = { [`flags.${MODULE_ID}.${ACTION_CLAIMS_FLAG}`]: claims };
      if (claims.entries[slot]?.state === "committed") {
        const next = foundry.utils.deepClone(source);
        const target = payload.kind === "target" ? next.entries[payload.index] : next;
        target.resolved = true;
        target.resultMessageIds = claims.entries[slot].resultMessageIds;
        update[`flags.${MODULE_ID}.${flag}`] = next;
        update.content = payload.kind === "target" ? renderTargetQueueContent(next) : renderSplitContent(next);
      }
      if (!await message.update(update)) throw new Error(localize("AOV_SKJALDBORG.Warnings.ActionFailed"));
      if (!isAuthoritativeGmClient()) throw new Error(localize("AOV_SKJALDBORG.Warnings.GmChanged"));
    };
    if (current?.state === "committed" || linkedIds.length) {
      if (current.state !== "committed" || row.resolved !== true || linkedIds.some(id => !recordedIds.includes(id))) {
        claims.entries[slot] = { ...current, state: "committed", resultMessageIds: Array.from(new Set([...recordedIds, ...linkedIds])) };
        await save();
      }
      return { accepted: false, state: "committed", resultMessageIds: claims.entries[slot].resultMessageIds ?? [], key };
    }
    if (row.resolved === true) return { accepted: false, state: "committed", resultMessageIds: row.resultMessageIds ?? [], key };
    if (payload.stage === "reconcile") return { accepted: false, state: current?.state ?? "pending", key };
    if (payload.stage === "reserve") {
      if (current?.state === "executing") return { accepted: false, state: "executing", key };
      const claimant = game.users?.get?.(current?.userId);
      if (current?.state === "claimed" && claimant?.active !== false && Date.now() - current.claimedAt < CLAIM_LEASE_MS) {
        return { accepted: false, state: "claimed", key };
      }
      assertClaimContext(claims.context);
      const weapon = await validateSubject();
      if (payload.kind === "target" && await requiresClaimAmmunition(weapon)) await validateAmmunition(row.ammunitionUuid, 1);
      const attemptId = foundry.utils.randomID();
      claims.entries[slot] = { state: "claimed", attemptId, userId: user.id, claimedAt: Date.now(), subject };
      assertClaimContext(claims.context);
      await save();
      return { accepted: true, state: "claimed", key, attemptId, slot };
    }
    if (!current || current.attemptId !== payload.attemptId || (!user.isGM && current.userId !== user.id)) {
      throw new Error(localize("AOV_SKJALDBORG.Warnings.StaleDocument"));
    }
    if (payload.stage === "release" && current.state === "claimed") {
      claims.entries[slot] = { state: "pending" };
      await save();
      return { accepted: true, state: "pending", key };
    }
    if (payload.stage === "consume" && ["claimed", "executing"].includes(current.state) && current.ammunitionRequired) {
      if (current.ammunitionChange) return { accepted: true, state: "executing", key, ammunitionChange: current.ammunitionChange };
      if (current.ammunitionUuid === `ChatMessage.${payload.sourceMessageId}`) throw new Error(localize("AOV_SKJALDBORG.Warnings.StaleDocument"));
      return enqueueDocumentWrite(current.ammunitionUuid, async () => {
        assertClaimContext(claims.context);
        if (!valuesMeaningfullyEqual(current.subject, subject, { ignoredKeys: new Set() })) {
          throw new Error(localize("AOV_SKJALDBORG.Warnings.StaleDocument"));
        }
        await validateSubject();
        for (const uuid of current.targetTokenUuids ?? []) {
          if (!(await safeFromUuid(uuid))?.actor) throw new Error(localize("AOV_SKJALDBORG.TargetQueue.MissingDocuments"));
        }
        const count = current.ammunitionCount;
        const ammunition = await validateAmmunition(current.ammunitionUuid, count);
        const before = ammunition.system.quantity;
        const ammunitionChange = { before, after: before - count, count };
        // The resource receipt and permission to create the card become durable
        // together. A rejected batch leaves a releasable, unstarted claim.
        claims.entries[slot] = { ...current, state: "executing", ammunitionChange };
        if (!isAuthoritativeGmClient()) throw new Error(localize("AOV_SKJALDBORG.Warnings.GmChanged"));
        assertClaimContext(claims.context);
        if (typeof foundry.documents?.modifyBatch !== "function") throw new Error(localize("AOV_SKJALDBORG.Warnings.ActionFailed"));
        await foundry.documents.modifyBatch([
          { action: "update", documentName: "Item", parent: actor, pack: null, broadcast: true,
            updates: [{ _id: ammunition.id, "system.quantity": ammunitionChange.after }] },
          { action: "update", documentName: "ChatMessage", pack: null, broadcast: true,
            updates: [{ _id: message.id, [`flags.${MODULE_ID}.${ACTION_CLAIMS_FLAG}`]: claims }] }
        ]);
        const recorded = message.getFlag(MODULE_ID, ACTION_CLAIMS_FLAG)?.entries?.[slot]?.ammunitionChange;
        if (!recorded) throw new Error(localize("AOV_SKJALDBORG.Warnings.ActionFailed"));
        return { accepted: true, state: "executing", key, ammunitionChange: recorded };
      });
    }
    if (payload.stage !== "execute" || current.state !== "claimed") return { accepted: false, state: current.state, key };
    assertClaimContext(claims.context);
    if (!valuesMeaningfullyEqual(current.subject, subject, { ignoredKeys: new Set() })) {
      throw new Error(localize("AOV_SKJALDBORG.Warnings.StaleDocument"));
    }
    const weapon = await validateSubject();
    if (payload.weaponUuid !== weapon.uuid) {
      throw new Error(localize("AOV_SKJALDBORG.TargetQueue.MissingDocuments"));
    }
    const targetUuids = payload.targetTokenUuids ?? [];
    if (payload.kind === "split" && !targetUuids.length) throw new Error(localize("AOV_SKJALDBORG.TargetQueue.MissingDocuments"));
    if (payload.kind === "target" && subject.targetTokenUuid && (targetUuids.length !== 1 || targetUuids[0] !== subject.targetTokenUuid)) {
      throw new Error(localize("AOV_SKJALDBORG.TargetQueue.MissingDocuments"));
    }
    for (const uuid of targetUuids) if (!(await safeFromUuid(uuid))?.actor) throw new Error(localize("AOV_SKJALDBORG.TargetQueue.MissingDocuments"));
    const ammunitionRequired = await requiresClaimAmmunition(weapon);
    const ammunitionUuid = payload.kind === "target" ? row.ammunitionUuid : payload.ammunitionUuid;
    const ammunitionCount = Math.max(1, targetUuids.length);
    if (ammunitionRequired) await validateAmmunition(ammunitionUuid, ammunitionCount);
    const executionState = ammunitionRequired ? "claimed" : "executing";
    claims.entries[slot] = { ...current, state: executionState, ammunitionRequired, ammunitionUuid, ammunitionCount, targetTokenUuids: targetUuids };
    assertClaimContext(claims.context);
    await save();
    return { accepted: true, state: executionState, key, ammunitionRequired };
  });
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

function localize(key) {
  return game.i18n.localize(key);
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
        [TARGET_QUEUE_FLAG]: queue,
        [ACTION_CLAIMS_FLAG]: { version: CLAIM_VERSION, context: combatClaimContext(), entries: {} }
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
  const targetActor = targetToken?.actor ?? await safeFromUuid(entry.targetActorUuid) ?? null;
  const ammunition = await safeFromUuid(entry.ammunitionUuid);
  if (!actor || !weapon || !targetActor || (entry.targetTokenUuid && !targetToken)
    || (weapon.parent?.uuid && weapon.parent.uuid !== actor.uuid)) {
    ui.notifications.warn(localize("AOV_SKJALDBORG.TargetQueue.MissingDocuments"));
    return;
  }
  if (!game.user?.isGM && !actor.testUserPermission?.(game.user, "OWNER")) {
    throw new Error(localize("AOV_SKJALDBORG.Warnings.NotOwner"));
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
  }

  const actionSource = { sourceMessageId: message.id, kind: "target", index };
  if (queue.workflow === "knockback") {
    await runClaimedChatAction(actionSource, async claim => {
      if (!await claim.begin([payload])) return [];
      const result = await startKnockbackAttack({ ...payload, actionClaim: claim.reference });
      return [{ started: !!result?.id, attackMessageId: result?.id ?? null }];
    });
  } else if (queue.workflow === "grapple") {
    await runClaimedChatAction(actionSource, async claim => {
      if (!await claim.begin([payload])) return [];
      const result = await startGrappleAttack({ ...payload, actionClaim: claim.reference });
      return [{ started: !!result?.id, attackMessageId: result?.id ?? null }];
    });
  } else {
    // The batch facade prompts before the GM authorizes execution/spending.
    await startDialogCombatWorkflowBatch([payload], { actionSource });
  }
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
        [SPLIT_ATTACK_FLAG]: data,
        [ACTION_CLAIMS_FLAG]: { version: CLAIM_VERSION, context: combatClaimContext(), entries: {} }
      }
    }
  });
}

async function resolveSplitAttack(message) {
  const split = foundry.utils.deepClone(message.getFlag(MODULE_ID, SPLIT_ATTACK_FLAG) ?? null);
  if (!split || split.resolved) return;
  if (await completeSplitAttack(message.id)) return;
  const actor = await safeFromUuid(split.actorUuid);
  if (!actor) {
    ui.notifications.warn(localize("AOV_SKJALDBORG.TargetQueue.MissingDocuments"));
    return;
  }
  if (!game.user?.isGM && !actor.testUserPermission?.(game.user, "OWNER")) {
    throw new Error(localize("AOV_SKJALDBORG.Warnings.NotOwner"));
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
  // show() only opens the AppV2 dialog. The source prompt is completed when
  // the adapter has actually persisted an attack card, never on dialog open.
}

/**
 * Reconcile a split prompt from exact, persisted follow-up card identities.
 * The reciprocal link is present at card creation, so a failed prompt refresh
 * can be recovered after reload without guessing from recent chat timestamps.
 * New prompts additionally arbitrate simultaneous submissions on the GM.
 *
 * @param {string} sourceMessageId Split prompt ChatMessage id.
 * @param {object} [options={}] Optional submission validation.
 * @param {string|null} [options.actorUuid=null] Require an existing prompt for this Actor when submitting.
 * @returns {Promise<boolean>} Whether at least one attack card committed.
 */
export async function completeSplitAttack(sourceMessageId, { actorUuid = null } = {}) {
  const message = game.messages?.get?.(sourceMessageId) ?? null;
  const split = message?.getFlag?.(MODULE_ID, SPLIT_ATTACK_FLAG) ?? null;
  if (actorUuid && (!split || split.actorUuid !== actorUuid)) {
    throw new Error(localize("AOV_SKJALDBORG.TargetQueue.MissingDocuments"));
  }
  if (!split) return false;
  if (message.getFlag(MODULE_ID, ACTION_CLAIMS_FLAG)?.version === CLAIM_VERSION) {
    const result = await requestGm("chatActionClaim", { sourceMessageId, kind: "split", stage: "reconcile" });
    if (!result) throw new Error(localize("AOV_SKJALDBORG.Warnings.NoGm"));
    return result.state === "committed";
  }
  const linkedIds = collectionArray(game.messages).filter(candidate => {
    const batch = candidate.getFlag?.(MODULE_ID, "combatCardBatch");
    return batch?.sourceMessageId === message.id && batch?.actorUuid === split.actorUuid;
  }).map(candidate => candidate.id).filter(Boolean);
  const resultMessageIds = Array.from(new Set([
    ...(Array.isArray(split.resultMessageIds) ? split.resultMessageIds.filter(id => typeof id === "string") : []),
    ...linkedIds
  ]));
  if (!resultMessageIds.length) return split.resolved === true;
  if (split.resolved === true && JSON.stringify(split.resultMessageIds) === JSON.stringify(resultMessageIds)) return true;
  const completed = { ...foundry.utils.deepClone(split), resolved: true, resultMessageIds };
  await message.update({
    content: renderSplitContent(completed),
    [`flags.${MODULE_ID}.${SPLIT_ATTACK_FLAG}`]: completed
  });
  return true;
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

export function registerDialogTargetQueueHooks(hooks = globalThis.Hooks) {
  if (hooksRegistered) return;
  hooksRegistered = true;
  hooks.on("renderChatMessageHTML", bindTargetQueueControls);
}

export const __test = { resolveQueueEntry, resolveSplitAttack };
