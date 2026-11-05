import { MODULE_ID } from "../constants.mjs";
import { cleanString, collectionArray } from "../utils/document-data.mjs";
import { firstActiveGm } from "../utils/authority.mjs";
import { valuesMeaningfullyEqual } from "../utils/guarded-document-writes.mjs";
import { moduleFlag as readFlag } from "../compat/active-effects.mjs";
import { ACTION_CLAIMS_FLAG, CLAIM_VERSION, chatActionClaimKey, chatActionClaimResults, indexChatActionClaimResults, matchesChatActionClaimResult } from "./action-claim-evidence.mjs";
import { COMBAT_PROVENANCE_FLAG, COMBAT_PROVENANCE_VERSION } from "./result-provenance.mjs";

// B01 remains partial. This console has no claim-write or workflow entry point.
export const RECOVERY_READ_ONLY = true;
export const RECOVERY_LIMITS = Object.freeze({ messages: 1000, rows: 500, pageSize: 25, claims: 32, results: 32, exportBytes: 1048576 });
const record = value => value !== null && typeof value === "object" && !Array.isArray(value);
const text = value => typeof value === "string" ? cleanString(value, 300) : "";
const integer = value => Number.isSafeInteger(value) && value >= 0;
const STATES = new Set(["pending", "claimed", "executing", "committed"]);

export function assertRecoveryGm() {
  if (globalThis.game?.user?.isGM !== true) throw new Error(game.i18n.localize("AOV_SKJALDBORG.Warnings.GmOnly"));
}

/** Respect both the message envelope and its content visibility. */
export function canReadRecoveryMessage(message) {
  return globalThis.game?.user?.isGM === true && message?.visible === true && message?.isContentVisible === true;
}

export function normalizeRecoveryFilters(filters = {}) {
  const pageNumber = value => integer(value) ? Math.min(value, 1000000) : 0;
  return {
    scope: filters.scope === "all" ? "all" : "current",
    sourceMessageId: text(filters.sourceMessageId).replace(/^ChatMessage\./, "").slice(0, 100),
    slot: text(filters.slot).slice(0, 100),
    includeCommitted: filters.includeCommitted === true,
    page: pageNumber(filters.page), historyPage: pageNumber(filters.historyPage)
  };
}

function documentReader() {
  const cache = new Map();
  return uuid => {
    if (!uuid) return null;
    if (!cache.has(uuid)) {
      try { cache.set(uuid, foundry.utils.fromUuidSync(uuid) ?? null); }
      catch (_error) { cache.set(uuid, null); }
    }
    return cache.get(uuid);
  };
}

function resultSummary(message, key, attemptId, subject, targetTokenUuids) {
  const exact = matchesChatActionClaimResult(message, key, attemptId);
  const provenance = readFlag(message, COMBAT_PROVENANCE_FLAG);
  const root = provenance?.cards?.[0];
  const batch = readFlag(message, "combatCardBatch");
  const attackProof = exact && provenance?.version === COMBAT_PROVENANCE_VERSION
    && root?.resolution === "exact" && root.stage === "attack" && root.sourceCardIndex === 0
    && root.sourceMessageUuid === message.uuid && root.actionKey === key && root.attemptId === attemptId
    && root.attackerActorUuid === subject?.actorUuid && root.weaponUuid === subject?.weaponUuid
    && (!subject?.targetTokenUuid || root.targetTokenUuid === subject.targetTokenUuid)
    && (!subject?.targetActorUuid || root.targetActorUuid === subject.targetActorUuid)
    && (!targetTokenUuids.length || targetTokenUuids.includes(root.targetTokenUuid))
    && !!message.getFlag?.("aov", "chatCard")?.[0];
  return {
    messageId: text(message.id), messageUuid: text(message.uuid), available: true,
    claimProof: exact, attackProof, sourceCardIndex: attackProof ? 0 : null,
    batchIndex: integer(batch?.batchIndex) ? batch.batchIndex : null,
    batchSize: integer(batch?.batchSize) ? batch.batchSize : null,
    batchId: text(batch?.batchId),
    targetTokenUuid: text(root?.targetTokenUuid),
    cardType: text(message.getFlag?.("aov", "cardType")), cardState: text(message.getFlag?.("aov", "state"))
  };
}

function inspectRow(message, slot, claims, resultIndex, resolveDocument, now) {
  const reasons = new Set();
  const targetIndex = /^target-(0|[1-9]\d*)$/.exec(slot);
  const kind = slot === "split" ? "split" : targetIndex ? "target" : "unknown";
  const source = readFlag(message, kind === "split" ? "splitAttack" : "targetQueue");
  const row = kind === "split" ? source : targetIndex ? source?.entries?.[Number(targetIndex[1])] : null;
  const claim = claims?.entries?.[slot];
  const state = STATES.has(claim?.state) ? claim.state : "unknown";
  if (claims?.version !== CLAIM_VERSION || !record(claims?.entries) || !record(claim) || kind === "unknown" || !record(row)) reasons.add("Malformed");
  if (claims?.context !== null && claims?.context !== undefined && (!record(claims.context)
    || !text(claims.context.combatId) || !integer(claims.context.logicalRound) || !text(claims.context.phase))) reasons.add("Malformed");
  if (record(claim) && ((Object.hasOwn(claim, "resultMessageIds") && !Array.isArray(claim.resultMessageIds))
    || (Object.hasOwn(claim, "targetTokenUuids") && !Array.isArray(claim.targetTokenUuids)))) reasons.add("Malformed");
  if (!STATES.has(claim?.state)) reasons.add("Malformed");
  const expectedSubject = {
    actorUuid: row?.actorUuid ?? source?.actorUuid ?? null, weaponUuid: row?.weaponUuid ?? null,
    targetTokenUuid: row?.targetTokenUuid ?? null, targetActorUuid: row?.targetActorUuid ?? null
  };
  const subject = Object.fromEntries(Object.entries(expectedSubject).map(([key, value]) => [key, text(claim?.subject?.[key] ?? value)]));
  if (["claimed", "executing"].includes(state) && (!text(claim?.attemptId) || !text(claim?.userId)
    || !Number.isFinite(claim?.claimedAt) || !record(claim?.subject))) reasons.add("Malformed");
  if (record(claim?.subject) && !valuesMeaningfullyEqual(claim.subject, expectedSubject, { ignoredKeys: new Set() })) reasons.add("SubjectChanged");
  if (source?.actorUuid && source.actorUuid !== expectedSubject.actorUuid) reasons.add("SubjectChanged");
  const key = chatActionClaimKey(message, slot), attemptId = text(claim?.attemptId);
  const admitted = Array.isArray(claim?.targetTokenUuids) ? claim.targetTokenUuids.slice(0, RECOVERY_LIMITS.results).map(text) : [];
  if (admitted.some(uuid => !uuid) || new Set(admitted).size !== admitted.length) reasons.add("Malformed");
  if (Array.isArray(claim?.targetTokenUuids) && claim.targetTokenUuids.length > RECOVERY_LIMITS.results) reasons.add("LimitReached");
  const expectedCount = kind === "target" ? 1 : admitted.length || null;
  const recorded = Array.isArray(claim?.resultMessageIds) ? claim.resultMessageIds.slice(0, RECOVERY_LIMITS.results).map(text) : [];
  if (Array.isArray(claim?.resultMessageIds) && claim.resultMessageIds.length > RECOVERY_LIMITS.results) reasons.add("LimitReached");
  const linked = chatActionClaimResults(resultIndex, key, attemptId);
  if (linked.length > RECOVERY_LIMITS.results) reasons.add("LimitReached");
  const results = new Map();
  for (const result of linked.slice(0, RECOVERY_LIMITS.results)) results.set(result.id, resultSummary(result, key, attemptId, subject, admitted));
  for (const id of recorded) {
    if (results.has(id)) continue;
    const result = game.messages?.get?.(id);
    if (canReadRecoveryMessage(result)) results.set(id, resultSummary(result, key, attemptId, subject, admitted));
    else results.set(id, { messageId: id, available: false, claimProof: false, attackProof: false });
  }
  const resultList = Array.from(results.values()).slice(0, RECOVERY_LIMITS.results);
  const exactResults = resultList.filter(result => result.claimProof);
  if (resultList.some(result => !result.available)) reasons.add("ResultUnavailable");
  if (resultList.some(result => result.available && !result.claimProof)) reasons.add("ResultMismatch");
  if (exactResults.some(result => !result.attackProof)) reasons.add("AttackProofIncomplete");
  if (state === "committed" && !exactResults.length) reasons.add("ResultUnavailable");
  if (expectedCount && exactResults.length > expectedCount) reasons.add("ResultMismatch");
  if (kind === "split" && exactResults.length) {
    const indices = exactResults.map(result => result.batchIndex);
    if (indices.some(index => index === null) || new Set(indices).size !== indices.length
      || exactResults.some(result => result.batchSize !== expectedCount || result.batchIndex >= expectedCount)
      || exactResults.some(result => !result.batchId) || new Set(exactResults.map(result => result.batchId)).size !== 1) reasons.add("BatchMismatch");
  }
  const receiptPresent = record(claim) && Object.hasOwn(claim, "ammunitionChange");
  const change = claim?.ammunitionChange;
  const receiptValid = receiptPresent && record(change) && [change.before, change.after, change.count].every(integer)
    && change.count > 0 && change.before - change.after === change.count;
  if (receiptPresent && !receiptValid) reasons.add("ReceiptMalformed");
  if (receiptPresent && ["claimed", "pending"].includes(state)) reasons.add("ReceiptMalformed");
  const actor = resolveDocument(subject.actorUuid), weapon = resolveDocument(subject.weaponUuid);
  if (!actor || !weapon || weapon.parent?.uuid !== subject.actorUuid) reasons.add("SubjectUnavailable");
  for (const uuid of Array.from(new Set([subject.targetTokenUuid, ...admitted])).filter(Boolean)) {
    const target = resolveDocument(uuid);
    if (!target?.actor || (subject.targetActorUuid && target.actor.uuid !== subject.targetActorUuid)) reasons.add("TargetUnavailable");
  }
  if (!subject.targetTokenUuid && subject.targetActorUuid && !resolveDocument(subject.targetActorUuid)) reasons.add("TargetUnavailable");
  const ammunitionUuid = text(claim?.ammunitionUuid ?? row?.ammunitionUuid);
  const ammunition = ammunitionUuid ? resolveDocument(ammunitionUuid) : null;
  const ammunitionReadable = ammunition?.testUserPermission?.(game.user, "OBSERVER") === true;
  if (ammunitionUuid && (!ammunition || !ammunitionReadable)) reasons.add("AmmunitionUnavailable");
  const context = record(claims?.context) ? claims.context : null;
  const combat = context?.combatId ? game.combats?.get?.(context.combatId) : null;
  const combatState = combat?.getFlag?.(MODULE_ID, "combatState");
  if (context && !combat) reasons.add("CombatUnavailable");
  if (context && (game.combat?.id !== context.combatId || combatState?.logicalRound !== context.logicalRound || combatState?.phase !== context.phase)) reasons.add("ContextChanged");
  let evidenceClass = "Malformed";
  const malformed = ["Malformed", "SubjectChanged", "ReceiptMalformed", "ResultMismatch", "ResultUnavailable", "BatchMismatch"].some(reason => reasons.has(reason));
  if (!malformed) {
    if (expectedCount && exactResults.length > 0 && exactResults.length < expectedCount) evidenceClass = "PartialSplit";
    else if (state === "committed" && row?.resolved === true) evidenceClass = "Committed";
    else if (exactResults.length) evidenceClass = "ResultFound";
    else if (state === "claimed" && !receiptPresent) evidenceClass = "Reserved";
    else if (state === "executing" && receiptPresent) evidenceClass = "ExecutingSpent";
    else if (state === "executing") evidenceClass = "Executing";
    else evidenceClass = "Pending";
  }
  return {
    sourceMessageId: text(message.id), sourceMessageUuid: text(message.uuid), sourceAvailable: true,
    slot: text(slot), key: text(key), kind, state, evidenceClass,
    workflow: text(source?.workflow ?? source?.sourceWorkflow), attemptId,
    sourceUpdateAllowed: message.canUserModify?.(game.user, "update") === true,
    claimantId: text(claim?.userId), claimantName: text(game.users?.get?.(claim?.userId)?.name),
    claimantActive: game.users?.get?.(claim?.userId)?.active === true,
    ageSeconds: Number.isFinite(claim?.claimedAt) ? Math.max(0, Math.floor((now - claim.claimedAt) / 1000)) : null,
    ...subject, attackerTokenUuid: text(row?.sourceTokenUuid), admittedTargetTokenUuids: admitted,
    ammunitionUuid, ammunitionQuantity: ammunitionReadable && integer(ammunition.system?.quantity) ? ammunition.system.quantity : null,
    receipt: receiptValid ? { before: change.before, after: change.after, count: change.count } : null,
    expectedCount, exactResultCount: exactResults.length, results: resultList,
    context: context ? { combatId: text(context.combatId), logicalRound: integer(context.logicalRound) ? context.logicalRound : null, phase: text(context.phase) } : null,
    reasons: Array.from(reasons), canRelease: false, canReconcile: false
  };
}

/** On-demand bounded snapshot; no writes, sockets, timers, dice or repair service. */
export function inspectCombatActionRecovery(filters = {}) {
  assertRecoveryGm();
  const query = normalizeRecoveryFilters(filters);
  const loaded = collectionArray(game.messages);
  const windows = Math.max(1, Math.ceil(loaded.length / RECOVERY_LIMITS.messages));
  const historyPage = Math.min(query.historyPage, windows - 1);
  const end = loaded.length - historyPage * RECOVERY_LIMITS.messages;
  const window = loaded.slice(Math.max(0, end - RECOVERY_LIMITS.messages), end).filter(canReadRecoveryMessage);
  const focused = query.sourceMessageId ? game.messages?.get?.(query.sourceMessageId) : null;
  const candidates = query.sourceMessageId ? (canReadRecoveryMessage(focused) ? [focused] : []) : window;
  const index = indexChatActionClaimResults(window);
  const rows = [], now = Date.now(), resolveDocument = documentReader();
  let limited = false;
  for (const message of candidates) {
    const claims = readFlag(message, ACTION_CLAIMS_FLAG);
    if (claims === undefined || claims === null) {
      if (!readFlag(message, "targetQueue") && !readFlag(message, "splitAttack")) continue;
    }
    const context = claims?.context;
    if (!query.sourceMessageId && query.scope === "current" && (game.combat ? context?.combatId !== game.combat.id : context?.combatId)) continue;
    let slots = record(claims?.entries) ? Object.keys(claims.entries).slice(0, RECOVERY_LIMITS.claims) : [readFlag(message, "splitAttack") ? "split" : "invalid"];
    if (!slots.length && claims?.version !== CLAIM_VERSION) slots = ["invalid"];
    if (record(claims?.entries) && Object.keys(claims.entries).length > RECOVERY_LIMITS.claims) limited = true;
    for (const slot of slots) {
      if (query.slot && query.slot !== slot) continue;
      if (rows.length >= RECOVERY_LIMITS.rows) { limited = true; break; }
      const evidence = inspectRow(message, slot, claims, index, resolveDocument, now);
      if (!query.includeCommitted && ["Pending", "Committed"].includes(evidence.evidenceClass)) continue;
      rows.push(evidence);
    }
    if (rows.length >= RECOVERY_LIMITS.rows) break;
  }
  // A surviving claim receipt can expose a missing source, but cannot establish
  // the missing source's authoritative attempt, subject or completion state.
  for (const [key, attempts] of index) {
    const parsed = /^ChatMessage\.([^.]+)#(split|target-\d+)$/.exec(key);
    if (!parsed || game.messages?.get?.(parsed[1]) || (query.sourceMessageId && parsed[1] !== query.sourceMessageId) || (query.slot && parsed[2] !== query.slot)) continue;
    if (!query.sourceMessageId && query.scope !== "all") continue;
    for (const [attemptId, messages] of attempts) {
      if (rows.length >= RECOVERY_LIMITS.rows) { limited = true; break; }
      rows.push({ sourceMessageId: text(parsed[1]), sourceMessageUuid: `ChatMessage.${text(parsed[1])}`, sourceAvailable: false,
        slot: text(parsed[2]), key: text(key), attemptId: text(attemptId), kind: parsed[2] === "split" ? "split" : "target",
        state: "unknown", evidenceClass: "Malformed", reasons: ["SourceUnavailable"],
        results: messages.slice(0, RECOVERY_LIMITS.results).map(message => resultSummary(message, key, attemptId, null, [])),
        canRelease: false, canReconcile: false });
    }
    if (rows.length >= RECOVERY_LIMITS.rows) break;
  }
  const pages = Math.max(1, Math.ceil(rows.length / RECOVERY_LIMITS.pageSize)), page = Math.min(query.page, pages - 1);
  return {
    readOnly: RECOVERY_READ_ONLY, authorityId: text(firstActiveGm()?.id), currentCombatId: text(game.combat?.id),
    observedAt: now,
    filters: { ...query, page, historyPage }, page, pages, historyPage, historyPages: windows,
    totalRows: rows.length, loadedMessageCount: loaded.length, inspectedMessageCount: window.length,
    limited, searchIncomplete: loaded.length > RECOVERY_LIMITS.messages,
    focusUnavailable: !!query.sourceMessageId && !canReadRecoveryMessage(focused),
    rows: rows.slice(page * RECOVERY_LIMITS.pageSize, (page + 1) * RECOVERY_LIMITS.pageSize)
  };
}

/** Export the current page's allowlisted primitives, never arbitrary flag JSON. */
export function recoveryDiagnosticSummary(filters = {}) {
  const snapshot = inspectCombatActionRecovery(filters);
  const rows = snapshot.rows.map(({ claimantName, ...row }) => row);
  const summary = { version: 1, readOnly: true, prerequisite: "B01-incomplete", scope: snapshot.filters,
    observedAt: snapshot.observedAt,
    authorityId: snapshot.authorityId, currentCombatId: snapshot.currentCombatId,
    loadedMessageCount: snapshot.loadedMessageCount, inspectedMessageCount: snapshot.inspectedMessageCount,
    searchIncomplete: snapshot.searchIncomplete, limited: snapshot.limited, rows };
  const data = JSON.stringify(summary, null, 2);
  if (new TextEncoder().encode(data).byteLength > RECOVERY_LIMITS.exportBytes) throw new Error(game.i18n.localize("AOV_SKJALDBORG.Recovery.ExportLimit"));
  return data;
}
