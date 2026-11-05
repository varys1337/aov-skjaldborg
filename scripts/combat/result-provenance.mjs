import { MODULE_ID } from "../constants.mjs";
import { collectionArray, numberOr } from "../utils/document-data.mjs";
import { incrementCounter } from "../performance/performance-monitor.mjs";
import { aovCards, recentFlaggedMessages } from "./automation-helpers.mjs";

export const COMBAT_PROVENANCE_FLAG = "combatProvenance";
export const COMBAT_PROVENANCE_VERSION = 1;

const MAX_CARDS = 32;
const IDENTITY_FIELDS = ["attackerActorUuid", "attackerTokenUuid", "targetActorUuid", "targetTokenUuid", "weaponUuid", "combatUuid", "actionKey", "attemptId"];
const validIndex = index => Number.isInteger(index) && index >= 0 && index < MAX_CARDS;
const flagData = (message, key) => message?.getFlag?.(MODULE_ID, key) ?? null;

/** A bounded, primitive snapshot saved with the attack, before any follow-up. */
export function attackProvenance(messageId, { actor, sourceToken, weapon, targetActor, targetToken, damageType = "", actionClaim = null }, combat = globalThis.game?.combat) {
  const state = combat?.getFlag?.(MODULE_ID, "combatState");
  const activeState = state?.enabled === true ? state : null;
  return {
    version: COMBAT_PROVENANCE_VERSION,
    cards: {
      0: {
        resolution: "exact", stage: "attack",
        sourceMessageUuid: `ChatMessage.${messageId}`, sourceCardIndex: 0,
        attackerActorUuid: actor?.uuid ?? null, attackerTokenUuid: sourceToken?.uuid ?? null,
        targetActorUuid: targetActor?.uuid ?? null, targetTokenUuid: targetToken?.uuid ?? null,
        weaponUuid: weapon?.uuid ?? null, damageType: String(damageType).slice(0, 40),
        combatUuid: combat?.uuid ?? null,
        logicalRound: combat ? Math.max(1, Math.trunc(numberOr(activeState?.logicalRound, Math.ceil(numberOr(combat.round, 0) / 2)))) : null,
        phase: typeof activeState?.phase === "string" ? activeState.phase.slice(0, 40) : null,
        ...(actionClaim?.version === 1 && typeof actionClaim.key === "string" && typeof actionClaim.attemptId === "string"
          ? { actionKey: actionClaim.key.slice(0, 300), attemptId: actionClaim.attemptId.slice(0, 100) } : {})
      }
    }
  };
}

/** Copy only an established source proof; the containing result supplies its UUID. */
export function resultProvenance(sourceMessage, { sourceCardIndex = 0, resultCardIndex = 0, stage = "damage" } = {}) {
  const stored = flagData(sourceMessage, COMBAT_PROVENANCE_FLAG);
  const source = stored?.cards?.[sourceCardIndex];
  if (stored?.version !== COMBAT_PROVENANCE_VERSION || !validIndex(sourceCardIndex) || !validIndex(resultCardIndex)
    || source?.stage !== "attack" || source.resolution !== "exact"
    || source.sourceMessageUuid !== sourceMessage?.uuid || source.sourceCardIndex !== sourceCardIndex) return null;
  return { version: COMBAT_PROVENANCE_VERSION, cards: {
    [resultCardIndex]: {
      resolution: "exact", stage, sourceMessageUuid: sourceMessage.uuid, sourceCardIndex,
      ...Object.fromEntries(IDENTITY_FIELDS.map(key => [key, typeof source[key] === "string" ? source[key].slice(0, 300) : null])),
      damageType: typeof source.damageType === "string" ? source.damageType.slice(0, 40) : "",
      logicalRound: Number.isFinite(source.logicalRound) ? source.logicalRound : null,
      phase: typeof source.phase === "string" ? source.phase.slice(0, 40) : null
    }
  } };
}

function resolvedUuid(uuid) {
  if (!uuid) return null;
  try {
    return globalThis.foundry?.utils?.fromUuidSync?.(uuid) ?? null;
  } catch (_error) {
    return null;
  }
}

function participantMatches(card, actorUuid, tokenUuid, { target = false } = {}) {
  const id = String(target ? card?.targetId ?? "" : card?.particId ?? "");
  const type = String(target ? card?.targetType ?? "" : card?.particType ?? "");
  const token = tokenUuid ? resolvedUuid(tokenUuid) : null;
  if (tokenUuid && (!token?.actor || token.uuid !== tokenUuid || token.actor.uuid !== actorUuid)) return false;
  if (type === "token") return !!token && token.id === id;
  if (type === "actor") return !!actorUuid && actorUuid === `Actor.${id}`;
  return false;
}

/** Validate the defender independently of ownership, which alone proves no target. */
export function defenseMatchesProvenance(message, actor, token, sourceCardIndex = 0) {
  if (sourceCardIndex !== 0 || !aovCards(message)[sourceCardIndex]) return false;
  const stored = flagData(message, COMBAT_PROVENANCE_FLAG);
  if (!stored) return true; // Historical cards retain their existing explicit-ID path.
  const source = stored.cards?.[sourceCardIndex];
  return stored.version === COMBAT_PROVENANCE_VERSION && source?.resolution === "exact" && source.stage === "attack"
    && source.sourceMessageUuid === message.uuid && source.sourceCardIndex === sourceCardIndex
    && !!source.targetActorUuid && source.targetActorUuid === actor?.uuid
    && (source.targetTokenUuid ? source.targetTokenUuid === token?.uuid && token?.actor?.uuid === actor?.uuid : !token);
}

function outcome(message, index, resolution, reason, extra = {}) {
  if (globalThis.game?.user?.isGM === true) incrementCounter(`combat.provenance.${resolution}`, 1, {
    messageUuid: message?.uuid ?? null, cardIndex: index, reason,
    sourceMessageUuid: extra.message?.uuid ?? null, sourceCardIndex: extra.sourceCardIndex ?? null
  });
  return { resolution, reason, ...extra };
}

/**
 * Resolve only declared message/card links. Prone's existing returned-result-ID
 * receipt is the sole pre-v1 cross-message proof established by the source audit.
 * A heuristic result flag (aimedBlowDamage, missileHitLocation, disarmDamage) is
 * deliberately never promoted to proof. This reader performs no document writes.
 */
export function resolveDamageProvenance(message, card, index = aovCards(message).indexOf(card)) {
  if (!validIndex(index) || aovCards(message)[index] !== card || card?.rollType !== "DM") {
    return outcome(message, index, "missing", "invalid-result-card");
  }
  const stored = flagData(message, COMBAT_PROVENANCE_FLAG);
  let proof = stored?.cards?.[index];
  if (stored && (stored.version !== COMBAT_PROVENANCE_VERSION || !proof)) {
    return outcome(message, index, "missing", "unsupported-or-missing-proof");
  }
  const prone = flagData(message, "proneDamageRules");
  if (!stored && prone) {
    if (aovCards(message).length !== 1 || !prone.sourceMessageId || !validIndex(prone.sourceCardIndex)) {
      return outcome(message, index, "missing", "invalid-prone-receipt");
    }
    proof = { resolution: "exact", stage: "damage", sourceMessageUuid: `ChatMessage.${prone.sourceMessageId}`, sourceCardIndex: prone.sourceCardIndex };
  }
  if (!proof) return outcome(message, index, "missing", "native-result-has-no-source");
  if (proof.resolution !== "exact" || proof.stage !== "damage" || !validIndex(proof.sourceCardIndex)) {
    return outcome(message, index, proof.resolution === "ambiguous" ? "ambiguous" : "missing", "unresolved-proof");
  }
  const match = /^ChatMessage\.([^.]+)$/.exec(String(proof.sourceMessageUuid ?? ""));
  const sourceMessage = match ? globalThis.game?.messages?.get?.(match[1]) : null;
  const sourceCard = aovCards(sourceMessage)[proof.sourceCardIndex];
  if (!sourceMessage || sourceMessage.uuid !== proof.sourceMessageUuid || !sourceCard) {
    return outcome(message, index, "missing", "source-deleted-or-unavailable");
  }
  if (prone && (proof.sourceMessageUuid !== `ChatMessage.${prone.sourceMessageId}` || proof.sourceCardIndex !== prone.sourceCardIndex)) {
    return outcome(message, index, "ambiguous", "conflicting-source-receipts");
  }
  for (const key of ["particId", "particType", "skillId", "targetId", "targetType"]) {
    if (!sourceCard[key] || sourceCard[key] !== card[key]) return outcome(message, index, "ambiguous", "source-card-mismatch");
  }
  const origin = flagData(sourceMessage, COMBAT_PROVENANCE_FLAG);
  if (stored && !origin) return outcome(message, index, "missing", "source-proof-unavailable");
  const root = origin?.cards?.[proof.sourceCardIndex];
  if (origin) {
    if (origin.version !== COMBAT_PROVENANCE_VERSION || root?.stage !== "attack" || root.resolution !== "exact"
      || root.sourceMessageUuid !== sourceMessage.uuid || root.sourceCardIndex !== proof.sourceCardIndex) {
      return outcome(message, index, "missing", "invalid-source-proof");
    }
    for (const key of [...IDENTITY_FIELDS, "damageType", "logicalRound", "phase"]) {
      if (stored && (proof[key] ?? null) !== (root[key] ?? null)) return outcome(message, index, "ambiguous", "source-identity-changed");
    }
    if (!participantMatches(card, root.attackerActorUuid, root.attackerTokenUuid)
      || !participantMatches(card, root.targetActorUuid, root.targetTokenUuid, { target: true })) {
      return outcome(message, index, "missing", "participant-deleted-or-mismatched");
    }
  }
  if (!origin && prone && ((prone.attackerActorUuid && !participantMatches(card, prone.attackerActorUuid, prone.attackerTokenUuid))
    || (prone.targetActorUuid && !participantMatches(card, prone.targetActorUuid, prone.targetTokenUuid, { target: true })))) {
    return outcome(message, index, "missing", "participant-deleted-or-mismatched");
  }
  return outcome(message, index, "exact", "saved-source-card", {
    message: sourceMessage, sourceCardIndex: proof.sourceCardIndex, proof: root ?? prone ?? proof
  });
}

/**
 * One compatibility policy for all source consumers. New sources never enter
 * recent-message attribution. Multiple historical candidates fail closed too.
 * Exact links remain authoritative even after the source flag is resolved.
 */
export function findCombatDamageSource(message, card, { flag, matches, windowMs = 600000 } = {}) {
  const index = aovCards(message).indexOf(card);
  const link = resolveDamageProvenance(message, card, index);
  if (link.resolution === "exact") {
    const source = flagData(link.message, flag);
    if (link.sourceCardIndex !== 0 || !source || !matches({ ...source, resolved: false }, card)) return { ...link, flag: null };
    for (const key of ["attackerActorUuid", "attackerTokenUuid", "targetActorUuid", "targetTokenUuid", "weaponUuid"]) {
      if (link.proof?.[key] && source[key] !== link.proof[key]) return outcome(message, index, "ambiguous", "source-metadata-conflict");
    }
    if ((source.sourceMessageId && source.sourceMessageId !== link.message.id)
      || (source.damageType && link.proof?.damageType && source.damageType !== link.proof.damageType)) {
      return outcome(message, index, "ambiguous", "source-metadata-conflict");
    }
    return { ...link, flag: source };
  }
  // An explicit but broken/conflicting link must never fall through to legacy.
  if (flagData(message, COMBAT_PROVENANCE_FLAG) || flagData(message, "proneDamageRules")) return link;
  const modernCandidates = collectionArray(globalThis.game?.messages).some(candidate => {
    const source = flagData(candidate, flag);
    const stored = flagData(candidate, COMBAT_PROVENANCE_FLAG);
    if (!stored) return false;
    if (source && matches({ ...source, resolved: false }, card)) return true;
    const origin = aovCards(candidate)[0];
    const root = stored.cards?.[0];
    // A post-creation feature-flag write may have failed. Its absence cannot
    // make this new attack eligible for attribution to a historical neighbor.
    return root?.stage === "attack" && origin?.particId === card.particId && origin.particType === card.particType
      && origin.skillId === card.skillId && (card.targetType === "actor"
        ? root.targetActorUuid === `Actor.${card.targetId}`
        : card.targetType === "token" && root.targetTokenUuid?.endsWith(`.Token.${card.targetId}`));
  });
  if (modernCandidates) return outcome(message, index, "missing", "unlinked-modern-source");
  // An ordinary AoV result has no Skjaldborg origin. Compatibility matching is
  // limited to results already carrying historical module metadata; opening a
  // native Actor-sheet attack must not adopt a neighboring legacy action.
  const tracking = flagData(message, "damageEffectTracking");
  const legacyTracking = Object.values(tracking?.cards ?? {}).some(entry => entry && entry.sourceResolution === undefined
    && ["pending", "resolved", "skipped"].includes(entry.status));
  const legacyResult = legacyTracking || [flag, "aimedBlowDamage", "missileHitLocation", "disarmDamage"]
    .some(key => { const data = flagData(message, key); return data && data.sourceResolution === undefined; });
  if (!legacyResult) return link;
  const direct = flagData(message, flag);
  const candidates = recentFlaggedMessages({ excludeMessage: message, flag, windowMs,
    predicate: entry => !flagData(entry.message, COMBAT_PROVENANCE_FLAG) && matches(entry.flag, card) });
  if (direct && matches(direct, card)) candidates.push({ message, flag: direct });
  if (candidates.length !== 1) return outcome(message, index, candidates.length ? "ambiguous" : "missing", candidates.length ? "multiple-legacy-sources" : "no-legacy-source");
  return outcome(message, index, "legacy", "unique-historical-candidate", { ...candidates[0], sourceCardIndex: 0 });
}
