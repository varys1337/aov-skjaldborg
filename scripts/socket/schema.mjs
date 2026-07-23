import { handlePromptDefenseRoll } from "./actions.mjs";
import {
  sanitizeCombatantWritePayload,
  sanitizeCombatWritePayload,
  sanitizeCommitDefensePayload,
  sanitizeCommitIntentPayload,
  sanitizeDisengagementPayload,
  sanitizeMovementWritePayload,
  sanitizePromptDefensePayload,
  sanitizeRunicMagicPayload
} from "./sanitizers.mjs";
import { cleanString } from "../utils/document-data.mjs";
import { SocketActionSchemaError } from "./errors.mjs";

export const SOCKET_AUTHORITY = Object.freeze({
  GM: "gm",
  ACTOR_OWNER_OR_GM: "actor-owner-or-gm",
  LOCAL_CLIENT: "local-client"
});
export const DEFAULT_SOCKET_ACTION_TIMEOUT_MS = 10000;

const runtimeBindings = new Map();
const DEFENSE_RESULT_FIELDS = Object.freeze([
  "accepted",
  "alreadyResolved",
  "cancelled",
  "combatAction",
  "coreDialogSource",
  "defenseMessageId",
  "defenseMode",
  "reason"
]);

function plainActionResult(action, result = {}) {
  const source = result && typeof result === "object" && !Array.isArray(result) ? result : {};
  return {
    accepted: source.accepted !== false,
    action,
    ...(source.duplicate === true ? { duplicate: true } : {}),
    ...(source.reason ? { reason: cleanString(source.reason, 120) } : {})
  };
}

function movementActionResult(action, result = {}) {
  const source = result && typeof result === "object" && !Array.isArray(result) ? result : {};
  const movement = source.movement && typeof source.movement === "object" ? source.movement : source;
  return {
    ...plainActionResult(action, source),
    ignoredReason: cleanString(source.ignoredReason, 80),
    routeId: cleanString(source.routeId ?? movement.routeId, 160),
    routeRevision: Math.max(0, Number(source.routeRevision ?? movement.routeRevision) || 0),
    planStatus: cleanString(source.planStatus ?? movement.planStatus, 40),
    draft: (source.draft ?? movement.draft) === true
  };
}

function defenseActionResult(action, result = {}) {
  const source = result && typeof result === "object" && !Array.isArray(result) ? result : {};
  const summary = plainActionResult(action, source);
  for (const field of DEFENSE_RESULT_FIELDS) {
    if (source[field] === undefined) continue;
    if (typeof source[field] === "string") summary[field] = cleanString(source[field], 200);
    else if (typeof source[field] === "boolean") summary[field] = source[field];
    else if (source[field] === null) summary[field] = null;
  }
  return summary;
}

function isDocumentLike(value) {
  return !!value
    && typeof value === "object"
    && (
      typeof value.documentName === "string"
      || typeof value.uuid === "string"
      || typeof value.update === "function"
      || typeof value.setFlag === "function"
    );
}

export function normalizeSocketActionResult(action, result) {
  const id = String(action ?? "");
  if (id === "recordMovement" || id === "clearMovement") return movementActionResult(id, result);
  if (id === "promptDefenseRoll" || id === "commitDefenseCard") return defenseActionResult(id, result);
  if (result === null || result === undefined) return plainActionResult(id);
  if (typeof result === "boolean") return { accepted: result, action: id };
  if (isDocumentLike(result)) {
    return plainActionResult(id, {
      accepted: true,
      reason: result.documentName ?? result.constructor?.name ?? ""
    });
  }
  if (Array.isArray(result)) return plainActionResult(id);
  if (typeof result !== "object") return plainActionResult(id);
  if (result.accepted !== undefined || result.reason !== undefined) return plainActionResult(id, result);
  return plainActionResult(id);
}

function runtimeFor(action) {
  const runtime = runtimeBindings.get(action);
  if (!runtime) {
    throw new SocketActionSchemaError(`Socket action "${action}" has no runtime binding.`, {
      action,
      code: "missing-runtime"
    });
  }
  return runtime;
}

function actionDescriptor(id, {
  authority,
  sanitize,
  execute = null,
  clientAction = false,
  timeoutMs = null,
  log = null
}) {
  return Object.freeze({
    id,
    authority,
    sanitize,
    clientAction,
    timeoutMs,
    log,
    resolve(context) {
      const resolver = runtimeFor(id).resolve;
      return typeof resolver === "function" ? resolver(context) : context;
    },
    authorize(context) {
      const authorize = runtimeFor(id).authorize;
      return typeof authorize === "function" ? authorize(context) : undefined;
    },
    execute(context) {
      const handler = execute ?? runtimeFor(id).execute;
      if (typeof handler !== "function") {
        throw new SocketActionSchemaError(`Socket action "${id}" has no handler.`, {
          action: id,
          code: "missing-handler"
        });
      }
      return handler(context);
    },
    normalize(result) {
      const normalize = runtimeFor(id).normalize;
      return typeof normalize === "function"
        ? normalize(result)
        : normalizeSocketActionResult(id, result);
    }
  });
}

const gmAction = (id, sanitize = sanitizeCombatWritePayload) => actionDescriptor(id, {
  authority: SOCKET_AUTHORITY.GM,
  sanitize,
  timeoutMs: DEFAULT_SOCKET_ACTION_TIMEOUT_MS
});

const ownerAction = (id, sanitize = sanitizeCombatantWritePayload) => actionDescriptor(id, {
  authority: SOCKET_AUTHORITY.ACTOR_OWNER_OR_GM,
  sanitize,
  timeoutMs: DEFAULT_SOCKET_ACTION_TIMEOUT_MS
});

export const SOCKET_ACTIONS = Object.freeze({
  initializeCombat: gmAction("initializeCombat"),
  disableCombat: gmAction("disableCombat"),
  advancePhase: gmAction("advancePhase"),
  advanceTurn: ownerAction("advanceTurn"),
  setActionStatus: gmAction("setActionStatus"),
  submitIntent: ownerAction("submitIntent", sanitizeCommitIntentPayload),
  holdIntent: ownerAction("holdIntent"),
  clearIntent: ownerAction("clearIntent"),
  recordMovement: ownerAction("recordMovement", sanitizeMovementWritePayload),
  clearMovement: ownerAction("clearMovement"),
  adjustInitiative: ownerAction("adjustInitiative"),
  delayCombatant: ownerAction("delayCombatant"),
  setUtilityOptions: ownerAction("setUtilityOptions"),
  startRuneCarving: ownerAction("startRuneCarving", sanitizeRunicMagicPayload),
  markRunePrepared: ownerAction("markRunePrepared", sanitizeRunicMagicPayload),
  castRuneScript: ownerAction("castRuneScript", sanitizeRunicMagicPayload),
  trackSeidurRitual: ownerAction("trackSeidurRitual", sanitizeRunicMagicPayload),
  clearRuneMagic: ownerAction("clearRuneMagic"),
  disruptRuneMagic: gmAction("disruptRuneMagic"),
  activateEvade: ownerAction("activateEvade"),
  declareDisengagement: ownerAction("declareDisengagement", sanitizeDisengagementPayload),
  resolveKnockbackDisengagement: gmAction("resolveKnockbackDisengagement"),
  incrementReaction: ownerAction("incrementReaction"),
  decrementReaction: ownerAction("decrementReaction"),
  commitDefenseCard: ownerAction("commitDefenseCard", sanitizeCommitDefensePayload),
  promptDefenseRoll: actionDescriptor("promptDefenseRoll", {
    authority: SOCKET_AUTHORITY.LOCAL_CLIENT,
    sanitize: sanitizePromptDefensePayload,
    execute: handlePromptDefenseRoll,
    clientAction: true,
    timeoutMs: 20000,
    log: "warn"
  })
});

export function bindSocketActionRuntime(action, runtime = {}) {
  const id = String(action ?? "");
  if (!SOCKET_ACTIONS[id]) {
    throw new SocketActionSchemaError(`Cannot bind unknown socket action "${id}".`, {
      action: id,
      code: "unknown-runtime"
    });
  }
  runtimeBindings.set(id, Object.freeze({ ...runtime }));
}

export function getSocketActionSchema(action) {
  return SOCKET_ACTIONS[String(action ?? "")] ?? null;
}
