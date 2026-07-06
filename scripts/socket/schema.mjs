import { handleLegacySocketAction, handlePromptDefenseRoll } from "./actions.mjs";
import {
  sanitizeCombatantWritePayload,
  sanitizeCommitDefensePayload,
  sanitizeCommitIntentPayload,
  sanitizeDisengagementPayload,
  sanitizeMovementWritePayload,
  sanitizePromptDefensePayload,
  sanitizeRunicMagicPayload,
  sanitizeSocketPayload
} from "./sanitizers.mjs";

export const SOCKET_AUTHORITY = Object.freeze({
  GM: "gm",
  ACTOR_OWNER_OR_GM: "actor-owner-or-gm",
  LOCAL_CLIENT: "local-client"
});

const gmAction = (sanitize = sanitizeSocketPayload) => Object.freeze({
  authority: SOCKET_AUTHORITY.GM,
  sanitize,
  execute: handleLegacySocketAction
});

const ownerAction = (sanitize = sanitizeCombatantWritePayload) => Object.freeze({
  authority: SOCKET_AUTHORITY.ACTOR_OWNER_OR_GM,
  sanitize,
  execute: handleLegacySocketAction
});

export const SOCKET_ACTIONS = Object.freeze({
  initializeCombat: gmAction(),
  disableCombat: gmAction(),
  advancePhase: gmAction(),
  advanceTurn: ownerAction(),
  setActionStatus: gmAction(),
  submitIntent: ownerAction(sanitizeCommitIntentPayload),
  holdIntent: ownerAction(),
  clearIntent: ownerAction(),
  recordMovement: ownerAction(sanitizeMovementWritePayload),
  clearMovement: ownerAction(),
  adjustInitiative: ownerAction(),
  delayCombatant: ownerAction(),
  setUtilityOptions: ownerAction(),
  startRuneCarving: ownerAction(sanitizeRunicMagicPayload),
  markRunePrepared: ownerAction(sanitizeRunicMagicPayload),
  castRuneScript: ownerAction(sanitizeRunicMagicPayload),
  trackSeidurRitual: ownerAction(sanitizeRunicMagicPayload),
  clearRuneMagic: ownerAction(),
  disruptRuneMagic: gmAction(),
  activateEvade: ownerAction(),
  declareDisengagement: ownerAction(sanitizeDisengagementPayload),
  resolveKnockbackDisengagement: gmAction(),
  incrementReaction: ownerAction(),
  decrementReaction: ownerAction(),
  commitDefenseCard: ownerAction(sanitizeCommitDefensePayload),
  promptDefenseRoll: Object.freeze({
    authority: SOCKET_AUTHORITY.LOCAL_CLIENT,
    sanitize: sanitizePromptDefensePayload,
    execute: handlePromptDefenseRoll,
    clientAction: true,
    timeoutMs: 20000,
    log: "warn"
  })
});

export function getSocketActionSchema(action) {
  return SOCKET_ACTIONS[String(action ?? "")] ?? null;
}
