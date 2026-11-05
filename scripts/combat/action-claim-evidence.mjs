import { MODULE_ID } from "../constants.mjs";
import { collectionArray } from "../utils/document-data.mjs";

export const ACTION_CLAIMS_FLAG = "actionClaims";
export const CLAIM_VERSION = 1;

export function chatActionClaimKey(message, slot) {
  return `${message.uuid ?? `ChatMessage.${message.id}`}#${slot}`;
}

function readProof(message) {
  const proof = message?.getFlag?.(MODULE_ID, "actionClaim");
  return proof?.version === CLAIM_VERSION && typeof proof.key === "string" && typeof proof.attemptId === "string" ? proof : null;
}

export function matchesChatActionClaimResult(message, key, attemptId) {
  const proof = readProof(message);
  return !!proof && proof.key === key && proof.attemptId === attemptId;
}

/** Shared exact receipt index. Callers own visibility and search-scope policy. */
export function indexChatActionClaimResults(messages) {
  const index = new Map();
  for (const message of collectionArray(messages)) {
    const proof = readProof(message);
    if (!proof) continue;
    if (!index.has(proof.key)) index.set(proof.key, new Map());
    const attempts = index.get(proof.key);
    if (!attempts.has(proof.attemptId)) attempts.set(proof.attemptId, []);
    attempts.get(proof.attemptId).push(message);
  }
  return index;
}

export function chatActionClaimResults(index, key, attemptId) {
  return index.get(key)?.get(attemptId) ?? [];
}
