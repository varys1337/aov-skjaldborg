import { AoVAdapter } from "./adapter/aov-adapter.mjs";
import {
  ACTION_CATEGORIES,
  DISENGAGEMENT_METHODS,
  INTENT_STATUS,
  MODULE_ID,
  MOVEMENT_DEBUG_CATEGORIES,
  MOVEMENT_DEBUG_LEVELS,
  MOVEMENT_PLAN_STATUS,
  PHASE_ORDER,
  RESOLUTION_STATUS,
  SOCKET_NAME
} from "./constants.mjs";
import { PhaseController } from "./combat/phase-controller.mjs";
import { defaultCombatantState, defaultRuneMagicState, getCombatState, getCombatantState, updateCombatantState } from "./combat/state.mjs";
import { debug, warn } from "./logger.mjs";
import {
  clearReadiedWeaponInHand,
  getReadiedWeaponIds,
  setCombatOptions,
  setReadiedWeaponInHand,
  setReadiedWeapons
} from "./combat/weapon-state.mjs";
import { cleanMovementPoint, normalizeMovementRoute } from "./combat/movement-route.mjs";
import { movementDebug } from "./combat/movement-debugger.mjs";
import { enqueueCombatantWrite } from "./combat/authoritative-write-queue.mjs";
import { startMovementPhase } from "./combat/movement-controller.mjs";
import { shouldExecuteMovementImmediately, shouldQueueResolutionImmediately } from "./combat/phase-structure.mjs";
import { refreshImmediateResolutionActions } from "./combat/resolution-queue.mjs";
import { performanceDiagnostics } from "./performance/performance-monitor.mjs";
import { createModuleChatMessage } from "./compat/chat-message.mjs";
import {
  captureExternalPlanningInitiativeChange,
  refreshPlanningInitiative
} from "./combat/planning-initiative.mjs";
import {
  declareDisengagement,
  resolveKnockbackDisengagement,
  validateIntentAgainstDisengagement
} from "./combat/disengagement.mjs";
import { activateEvadingForCombatant } from "./combat/evade-status.mjs";
import { reconcileReactionPenaltyEffect } from "./combat/reaction-penalty-effects.mjs";
import { cleanString, cleanStringArray } from "./utils/document-data.mjs";
import {
  cleanTargetRefs,
  CRAFT_RUNE_MODES,
  firstRuneMagicSkill,
  firstSeidurMagicSkill,
  RUNE_MAGIC_STATUSES,
  runeMagicConsumesPrepared,
  runeScriptDetails,
  seidurDetails,
  targetNames
} from "./combat/runic-magic-data.mjs";
import { appendMagicDetailsToMessage, createRunicResistanceCards } from "./combat/runic-magic-cards.mjs";

const SOCKET_REQUEST_TIMEOUT_MS = 10000;
const SOCKET_MESSAGE_REQUEST = "request";
const SOCKET_MESSAGE_RESPONSE = "response";
const SOCKET_SCHEMA_VERSION = 1;
const PROCESSED_REQUEST_TTL_MS = 60000;
const pendingSocketRequests = new Map();
const processedSocketRequests = new Map();
const userPromptQueues = new Map();
const CLIENT_SOCKET_ACTIONS = new Set(["promptDefenseRoll"]);

/**
 * Select the first active GM to receive a player request.
 *
 * @returns {User|null}
 */
function firstActiveGm() {
  return game.users.find(u => u.active && u.isGM) ?? null;
}

/**
 * Identify stale document write failures without relying on error subclasses
 * that would not survive socket serialization.
 *
 * @param {unknown} message Candidate message.
 * @returns {boolean}
 */
function isStaleDocumentMessage(message) {
  return String(message ?? "") === game.i18n.localize("AOV_SKJALDBORG.Warnings.StaleDocument");
}

/**
 * Build player-facing timeout feedback based on the GM originally selected for
 * the request.
 *
 * @param {string|null} gmId Expected GM User id.
 * @returns {string}
 */
function socketTimeoutMessage(gmId) {
  const currentGm = firstActiveGm();
  if (!currentGm) return game.i18n.localize("AOV_SKJALDBORG.Warnings.NoGm");
  if (gmId && currentGm.id !== gmId) return game.i18n.localize("AOV_SKJALDBORG.Warnings.GmChanged");
  return game.i18n.localize("AOV_SKJALDBORG.Warnings.SocketTimeout");
}

/**
 * Build timeout feedback for direct client prompts such as defender roll
 * dialogs routed to an actor-owning player.
 *
 * @param {string|null} userId Expected responding user id.
 * @returns {string}
 */
function socketUserTimeoutMessage(userId) {
  const user = game.users?.get?.(String(userId ?? "")) ?? null;
  if (!user) return game.i18n.localize("AOV_SKJALDBORG.Warnings.SocketUserMissing");
  if (!user.active) {
    return game.i18n.format("AOV_SKJALDBORG.Warnings.SocketUserInactive", { user: user.name ?? user.id });
  }
  return game.i18n.format("AOV_SKJALDBORG.Warnings.SocketUserTimeout", { user: user.name ?? user.id });
}

/**
 * Resolve a User id without ever treating an unknown remote sender as the GM.
 *
 * @param {unknown} userId Candidate User id.
 * @returns {User}
 */
function requestingUser(userId) {
  const id = String(userId ?? "");
  if (id && id === game.user?.id) return game.user;
  const user = game.users?.get?.(id) ?? game.users?.find?.(candidate => candidate.id === id) ?? null;
  if (!user) throw new Error(`Rejected ${MODULE_ID} socket request from an unknown User.`);
  return user;
}

/**
 * Require a GM-originated request for workflow-global mutations.
 *
 * @param {User} user Requesting User.
 * @returns {void}
 */
function assertGmRequest(user) {
  if (!user?.isGM) throw new Error(game.i18n.localize("AOV_SKJALDBORG.Warnings.GmOnly"));
}

/**
 * Emit a compact request acknowledgement back to the originating client.
 * Document instances are deliberately not serialized over the socket; callers
 * need completion/error semantics, while Foundry document hooks provide the
 * replicated state.
 *
 * @param {object} request Original socket request.
 * @param {{ok: boolean, error?: string}} response Response payload.
 * @returns {void}
 */
function emitSocketResponse(request, response) {
  if (!request?.requestId || !request?.from) return;
  game.socket.emit(SOCKET_NAME, {
    type: SOCKET_MESSAGE_RESPONSE,
    requestId: request.requestId,
    from: game.user.id,
    to: request.from,
    ...response
  });
}

/**
 * Return whether the GM has already processed a socket request.
 *
 * @param {object} message Socket request envelope.
 * @returns {boolean}
 */
function isDuplicateRequest(message) {
  const requestId = String(message?.requestId ?? "");
  const from = String(message?.from ?? "");
  if (!requestId || !from) return false;
  const now = Date.now();
  for (const [key, timestamp] of processedSocketRequests) {
    if ((now - Number(timestamp)) > PROCESSED_REQUEST_TTL_MS) processedSocketRequests.delete(key);
  }
  const key = `${from}:${requestId}`;
  if (processedSocketRequests.has(key)) return true;
  processedSocketRequests.set(key, now);
  return false;
}

/**
 * Resolve or reject a pending player-to-GM request.
 *
 * @param {object} message Socket response.
 * @returns {boolean} Whether a matching request was handled.
 */
export function handleSocketResponse(message) {
  const pending = pendingSocketRequests.get(message?.requestId);
  if (!pending) return false;
  if (message?.to && message.to !== game.user?.id) return false;
  if (pending.gmId && message?.from !== pending.gmId) return false;
  pendingSocketRequests.delete(message.requestId);
  globalThis.clearTimeout(pending.timeout);
  if (message.ok) pending.resolve(message.result ?? true);
  else {
    const errorMessage = cleanString(message.error, 1000) || game.i18n.localize("AOV_SKJALDBORG.Warnings.ActionFailed");
    if (isStaleDocumentMessage(errorMessage)) {
      ui.notifications.warn(errorMessage);
      debug("Rejected stale socket request.", {
        requestId: message.requestId,
        from: message.from,
        to: message.to
      });
    }
    pending.reject(new Error(errorMessage));
  }
  return true;
}

/**
 * Convert an optional numeric form value into a finite number or `null`.
 *
 * Empty, missing, non-finite, and non-positive values are intentionally stored
 * as `null` for rank-style inputs. That keeps flags explicit without turning an
 * unselected input into DEX rank 0.
 *
 * @param {unknown} value Candidate numeric value.
 * @returns {number|null}
 */
function cleanPositiveNumber(value) {
  if (value === "" || value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function cleanFiniteNumber(value) {
  if (value === "" || value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/**
 * Clamp a user-selected action category to the module's supported enum.
 *
 * @param {unknown} value Candidate action category.
 * @returns {string}
 */
function cleanActionCategory(value) {
  const category = cleanString(value, 40);
  if (!category) return ACTION_CATEGORIES.ATTACK;
  if (category === "flee") return ACTION_CATEGORIES.RETREAT;
  return Object.values(ACTION_CATEGORIES).includes(category) ? category : ACTION_CATEGORIES.OTHER;
}

/**
 * Clamp a user-submitted intent status to committed or held.
 *
 * Uncommitted is a derived default state, not a legal declaration write.
 *
 * @param {unknown} value Candidate status.
 * @returns {string}
 */
function cleanIntentStatus(value) {
  return value === INTENT_STATUS.HELD ? INTENT_STATUS.HELD : INTENT_STATUS.COMMITTED;
}

/**
 * Clamp a resolution queue status submitted over the socket.
 *
 * @param {unknown} value Candidate status.
 * @returns {string}
 */
function cleanResolutionStatus(value) {
  return Object.values(RESOLUTION_STATUS).includes(value) ? value : RESOLUTION_STATUS.RESOLVED;
}

function cleanDisengagementMethod(value) {
  const method = cleanString(value, 40);
  if (method === DISENGAGEMENT_METHODS.FLEE) return DISENGAGEMENT_METHODS.FLEE;
  if (method === DISENGAGEMENT_METHODS.KNOCKBACK) return DISENGAGEMENT_METHODS.KNOCKBACK;
  return DISENGAGEMENT_METHODS.RETREAT;
}

/**
 * Clamp a phase id submitted over the socket.
 *
 * @param {unknown} value Candidate phase id.
 * @returns {string|null}
 */
function cleanPhase(value) {
  if (value === "" || value === null || value === undefined) return null;
  if (!PHASE_ORDER.includes(value)) throw new Error(game.i18n.localize("AOV_SKJALDBORG.Warnings.InvalidPhase"));
  return value;
}

/**
 * Normalize a socket-submitted intent payload.
 *
 * @param {object} [payload={}] Raw socket payload.
 * @returns {import("./types.mjs").SkjaldborgIntent}
 */
export function sanitizeIntentPayload(payload = {}) {
  return {
    status: cleanIntentStatus(payload.status),
    actionCategory: cleanActionCategory(payload.actionCategory),
    publicText: cleanString(payload.publicText),
    privateText: cleanString(payload.privateText),
    modifiers: {
      drawWeapon: !!payload.modifiers?.drawWeapon,
      sheatheWeapon: !!payload.modifiers?.sheatheWeapon,
      surprised: !!payload.modifiers?.surprised,
      fullMove: !!payload.modifiers?.fullMove
    },
    delay: {
      enabled: !!payload.delay?.enabled,
      targetDex: cleanPositiveNumber(payload.delay?.targetDex),
      targetCombatantId: cleanString(payload.delay?.targetCombatantId, 100) || null,
      position: ["before", "after"].includes(payload.delay?.position) ? payload.delay.position : "",
      tiebreakerInt: cleanFiniteNumber(payload.delay?.tiebreakerInt)
    },
    waitInterrupt: {
      enabled: !!payload.waitInterrupt?.enabled,
      text: cleanString(payload.waitInterrupt?.text)
    },
    splitCount: Math.max(1, Math.min(4, Number.parseInt(payload.splitCount ?? 1, 10) || 1)),
    fixedRank: cleanPositiveNumber(payload.fixedRank),
    runeCarryover: !!payload.runeCarryover
  };
}

/**
 * Normalize a socket-submitted movement payload.
 *
 * @param {object} [payload={}] Raw socket payload.
 * @returns {import("./types.mjs").SkjaldborgMovementPlan}
 */
export function sanitizeMovementPayload(payload = {}) {
  movementDebug(MOVEMENT_DEBUG_CATEGORIES.SOCKET, "sanitize-movement-input", () => ({
    payload
  }), { level: MOVEMENT_DEBUG_LEVELS.TRACE });
  const { route, waypoints, destination: sanitizedDestination, source, truncated } = normalizeMovementRoute(payload);
  const origin = cleanMovementPoint(payload.origin);
  const measuredPath = origin ? [origin, ...waypoints] : waypoints;
  const measured = AoVAdapter.measureDistanceFromWaypoints(measuredPath);
  const manualDistance = Number(payload.distance);
  const status = Object.values(MOVEMENT_PLAN_STATUS).includes(payload.planStatus)
    ? payload.planStatus
    : (waypoints.length ? MOVEMENT_PLAN_STATUS.PLANNED : MOVEMENT_PLAN_STATUS.NONE);
  const sanitized = {
    mode: cleanString(payload.mode || "planned", 30),
    origin,
    destination: sanitizedDestination,
    route,
    waypoints,
    distance: Number.isFinite(manualDistance) ? Math.max(0, manualDistance) : measured,
    units: cleanString(payload.units || canvas.scene?.grid?.units || ""),
    manual: payload.manual !== false,
    planStatus: status,
    startedAt: null,
    completedAt: null,
    stoppedReason: "",
    routeRevision: Math.max(0, Number(payload.routeRevision) || 0),
    routeId: cleanString(payload.routeId, 160),
    captureSource: cleanString(payload.captureSource, 80),
    capturedAt: Math.max(0, Number(payload.capturedAt) || Date.now()),
    draft: payload.draft === true
  };
  movementDebug(MOVEMENT_DEBUG_CATEGORIES.SOCKET, "sanitize-movement-output", () => ({
    routeSource: source,
    waypointCount: sanitized.waypoints.length,
    destination: sanitized.destination,
    distance: sanitized.distance,
    truncated,
    planStatus: sanitized.planStatus,
    sanitized
  }), { level: MOVEMENT_DEBUG_LEVELS.VERBOSE });
  return sanitized;
}

/**
 * Throw when a user is not permitted to mutate a combatant's module state.
 *
 * @param {User} user Requesting user.
 * @param {Combatant|null} combatant Target combatant.
 * @returns {void}
 */
function assertCombatantAccess(user, combatant) {
  if (!AoVAdapter.canUserControlCombatant(user, combatant)) {
    throw new Error(game.i18n.localize("AOV_SKJALDBORG.Warnings.NotOwner"));
  }
}

/**
 * Throw when a Combat document is required but unavailable.
 *
 * @param {Combat|null} combat Target combat.
 * @returns {void}
 */
function assertCombat(combat) {
  if (!combat) throw new Error(game.i18n.localize("AOV_SKJALDBORG.Warnings.NoCombat"));
}

/**
 * Optionally reject stale Combat writes submitted from an older render.
 *
 * @param {object} payload Socket payload.
 * @param {Combat|null} combat Target combat.
 * @returns {void}
 */
function assertFreshCombat(payload, combat) {
  if (!payload.expectedCombatUpdatedAt || !combat) return;
  const current = combat.getFlag(MODULE_ID, "combatState")?.updatedAt;
  if (current && Number(payload.expectedCombatUpdatedAt) !== Number(current)) {
    throw new Error(game.i18n.localize("AOV_SKJALDBORG.Warnings.StaleDocument"));
  }
}

/**
 * Optionally reject stale Combatant writes submitted from an older render.
 *
 * @param {object} payload Socket payload.
 * @param {Combatant|null} combatant Target combatant.
 * @returns {void}
 */
function assertFreshCombatant(payload, combatant) {
  if (!payload.expectedCombatantUpdatedAt || !combatant) return;
  const current = combatant.getFlag(MODULE_ID, "combatantState")?.updatedAt;
  if (current && Number(payload.expectedCombatantUpdatedAt) !== Number(current)) {
    throw new Error(game.i18n.localize("AOV_SKJALDBORG.Warnings.StaleDocument"));
  }
}

function isFreshCombatant(payload, combatant) {
  if (!payload.expectedCombatantUpdatedAt || !combatant) return true;
  const current = combatant.getFlag(MODULE_ID, "combatantState")?.updatedAt;
  return !current || Number(payload.expectedCombatantUpdatedAt) === Number(current);
}

function normalizedIntentSignature(intent) {
  const clean = sanitizeIntentPayload(intent);
  return JSON.stringify({
    status: clean.status,
    actionCategory: clean.actionCategory,
    publicText: clean.publicText,
    privateText: clean.privateText,
    modifiers: clean.modifiers,
    delay: clean.delay,
    waitInterrupt: clean.waitInterrupt,
    splitCount: clean.splitCount,
    fixedRank: clean.fixedRank,
    runeCarryover: clean.runeCarryover
  });
}

export function intentsEquivalent(first, second) {
  return normalizedIntentSignature(first) === normalizedIntentSignature(second);
}

function staleIntentIsIdempotent(payload, combatant, intent) {
  if (isFreshCombatant(payload, combatant)) return false;
  return intentsEquivalent(getCombatantState(combatant).intent, intent);
}


/**
 * Normalize an initiative adjustment amount.
 *
 * @param {unknown} value Candidate amount to subtract.
 * @returns {number}
 */
function cleanInitiativeAdjustment(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) throw new Error("Initiative adjustment must be numeric.");
  return amount;
}

function cleanNonNegativeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, number) : 0;
}

function cleanHand(value) {
  return value === "left" ? "left" : "right";
}

/**
 * Sanitize multi-hand readied weapon state submitted over the GM socket.
 *
 * The unlimited flag is accepted only for NPC actors so player characters
 * cannot bypass the two-hand readiness limit by submitting a crafted payload.
 *
 * @param {unknown} value Candidate readied weapon payload.
 * @param {Actor|null} [actor=null] Owning actor used for NPC gating.
 * @returns {import("./types.mjs").SkjaldborgReadiedWeapons}
 */
function cleanReadiedWeaponsPayload(value = {}, actor = null) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    right: cleanString(source.right, 100) || null,
    left: cleanString(source.left, 100) || null,
    unlimited: actor?.type === "npc" && source.unlimited === true
  };
}

/**
 * Sanitize Utility-dialog combat option flags submitted over the GM socket.
 *
 * @param {unknown} value Candidate options payload.
 * @returns {import("./types.mjs").SkjaldborgCombatOptions}
 */
function cleanCombatOptionsPayload(value = {}) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    twoWeaponFighting: {
      enabled: source.twoWeaponFighting?.enabled === true,
      primaryWeaponId: cleanString(source.twoWeaponFighting?.primaryWeaponId, 100),
      secondaryWeaponId: cleanString(source.twoWeaponFighting?.secondaryWeaponId, 100),
      primaryChance: cleanNonNegativeNumber(source.twoWeaponFighting?.primaryChance),
      secondaryChance: cleanNonNegativeNumber(source.twoWeaponFighting?.secondaryChance)
    },
    shieldCover: {
      shieldId: cleanString(source.shieldCover?.shieldId, 100),
      locationIds: cleanStringArray(source.shieldCover?.locationIds, 100)
    },
    shieldwall: {
      enabled: source.shieldwall?.enabled === true
    }
  };
}

/**
 * Post the compact draw/sheathe DEX-rank audit card.
 *
 * @param {Combatant} combatant Acting combatant.
 * @param {object} data Chat context.
 * @param {"draw"|"sheathe"} data.action Weapon action.
 * @param {string} data.weaponName Weapon display name.
 * @param {number} data.amount Applied DEX-rank adjustment.
 * @param {number} data.previousInitiative Initiative before adjustment.
 * @param {number} data.nextInitiative Initiative after adjustment.
 * @returns {Promise<ChatMessage|null>}
 */
async function postWeaponDexChat(combatant, { action, weaponName, amount, previousInitiative, nextInitiative }) {
  const actionKey = action === "sheathe" ? "AOV_SKJALDBORG.Weapons.Sheathe" : "AOV_SKJALDBORG.Weapons.Draw";
  return createModuleChatMessage({
    speaker: ChatMessage.getSpeaker({ actor: combatant?.actor, token: combatant?.token }),
    flavor: game.i18n.localize("AOV_SKJALDBORG.Chat.WeaponDexTitle"),
    content: `<p>${game.i18n.format("AOV_SKJALDBORG.Chat.WeaponDexChange", {
      actor: combatant?.name ?? "",
      action: game.i18n.localize(actionKey),
      weapon: weaponName || game.i18n.localize("AOV_SKJALDBORG.Weapons.None"),
      amount,
      previous: previousInitiative,
      next: nextInitiative
    })}</p>`
  }, { applyDefaultMode: false });
}

/**
 * Apply a module-managed draw or sheathe operation and optionally adjust the
 * represented Combatant's AoV initiative. The operation is GM-authoritative
 * and rolls back weapon state if the initiative update fails.
 *
 * @param {Combatant} combatant Target combatant.
 * @param {object} payload Sanitized request payload.
 * @returns {Promise<Combatant|Actor|null>} Updated document.
 */
export async function applyInitiativeAndWeaponAction(combatant, payload) {
  const actor = combatant?.actor;
  if (!actor) throw new Error(game.i18n.localize("AOV_SKJALDBORG.Warnings.ActorUnavailable"));

  const action = ["draw", "sheathe", "none"].includes(payload.weaponAction)
    ? payload.weaponAction
    : "none";
  const hand = cleanHand(payload.hand);
  const amount = cleanInitiativeAdjustment(payload.amount);
  const initiative = Number(combatant.initiative);
  const previousWeapons = getReadiedWeaponIds(actor);
  const targetWeapon = action === "draw"
    ? actor.items?.get?.(cleanString(payload.weaponId, 100))
    : actor.items?.get?.(previousWeapons[hand] ?? "");

  try {
    if (action === "draw") {
      await setReadiedWeaponInHand(actor, hand, cleanString(payload.weaponId, 100));
    } else if (action === "sheathe") {
      await clearReadiedWeaponInHand(actor, hand);
    }

    if (!Number.isFinite(initiative)) return actor;
    const nextInitiative = Number((initiative - amount).toFixed(2));
    const updated = await combatant.update({
      initiative: nextInitiative
    }, {
      [MODULE_ID]: { planningExternalHandled: true }
    });
    const ledger = await captureExternalPlanningInitiativeChange(combatant, { initiative: nextInitiative });
    if (ledger) await PhaseController.clearCurrentTurn(combatant.parent, "planning-initiative-update");
    if (action === "draw" || action === "sheathe") {
      await postWeaponDexChat(combatant, {
        action,
        weaponName: targetWeapon?.name ?? "",
        amount,
        previousInitiative: initiative,
        nextInitiative
      });
    }
    return updated;
  } catch (exception) {
    try {
      await setReadiedWeapons(actor, previousWeapons);
    } catch (rollbackError) {
      warn(rollbackError);
    }
    throw exception;
  }
}

function cleanDelayMode(value) {
  return value === "combatant" ? "combatant" : "dex";
}

function cleanDelayPosition(value) {
  return value === "after" ? "after" : "before";
}

function initiativeDexRank(value) {
  const initiative = Number(value);
  if (!Number.isFinite(initiative)) return null;
  return Math.max(0, Math.trunc(initiative));
}

function tiebreakerFromInitiative(initiative, dexRank) {
  const numeric = Number(initiative);
  if (!Number.isFinite(numeric)) return null;
  return Math.round((numeric - dexRank) * 100);
}

function relativeDelayInitiative(targetInitiative, position) {
  const target = Number(targetInitiative);
  if (!Number.isFinite(target)) return null;
  const dexRank = initiativeDexRank(target);
  const offset = position === "before" ? 0.01 : -0.01;
  return Number((target + offset).toFixed(2));
}

/**
 * Apply the RAW Delay action to a combatant's state and tracker initiative.
 *
 * Direct DEX delay uses the existing AoV `DEX.INT` projection. Combatant delay
 * writes a minimal decimal offset around the target initiative so the declared
 * before/after relationship remains visible in Foundry's numeric tracker.
 *
 * @param {Combat} combat Active Combat document.
 * @param {Combatant} combatant Acting combatant.
 * @param {object} payload Sanitized socket payload.
 * @returns {Promise<import("./types.mjs").SkjaldborgCombatantState>}
 */
async function applyCombatantDelay(combat, combatant, payload) {
  const mode = cleanDelayMode(payload.mode);
  const actorInt = AoVAdapter.getInt(combatant?.actor);
  let targetDex = cleanPositiveNumber(payload.targetDex);
  let targetCombatantId = null;
  let position = "";
  let tiebreakerInt = actorInt;
  let initiative = null;

  if (mode === "combatant") {
    const target = AoVAdapter.getCombatantById(combat, cleanString(payload.targetCombatantId, 100));
    if (!target || target.id === combatant.id) throw new Error(game.i18n.localize("AOV_SKJALDBORG.Warnings.NoCombatant"));
    const targetInitiative = Number(target.initiative);
    const rank = initiativeDexRank(targetInitiative);
    if (rank === null || rank <= 0) throw new Error(game.i18n.localize("AOV_SKJALDBORG.Warnings.ActionFailed"));
    position = cleanDelayPosition(payload.position);
    initiative = relativeDelayInitiative(targetInitiative, position);
    targetDex = rank;
    targetCombatantId = target.id;
    tiebreakerInt = tiebreakerFromInitiative(initiative, rank) ?? actorInt;
  } else {
    targetDex = targetDex ?? 1;
    initiative = AoVAdapter.projectInitiative(targetDex, actorInt);
  }

  const state = getCombatantState(combatant);
  const intent = sanitizeIntentPayload({
    ...state.intent,
    status: state.intent?.status === INTENT_STATUS.HELD ? INTENT_STATUS.HELD : INTENT_STATUS.COMMITTED,
    actionCategory: ACTION_CATEGORIES.DELAY,
    delay: {
      enabled: true,
      targetDex,
      targetCombatantId,
      position,
      tiebreakerInt
    },
    waitInterrupt: {
      enabled: mode === "combatant",
      text: mode === "combatant"
        ? game.i18n.format("AOV_SKJALDBORG.Delay.WaitingFor", {
          combatant: AoVAdapter.getCombatantById(combat, targetCombatantId)?.name ?? ""
        })
        : ""
    }
  });

  const updated = await updateCombatantState(combatant, { intent });
  await combat.updateEmbeddedDocuments("Combatant", [{
    _id: combatant.id,
    initiative
  }], {
    turnEvents: false,
    combatTurn: combat.turn,
    [MODULE_ID]: { planningExternalHandled: true }
  });
  if (shouldQueueResolutionImmediately()) {
    await refreshImmediateResolutionActions(combat, combatant, { preserveStatus: true });
  }
  return updated;
}

/**
 * Persist Utility dialog readiness and combat option flags.
 *
 * @param {Combatant} combatant Acting combatant.
 * @param {object} payload Sanitized socket payload.
 * @returns {Promise<unknown>}
 */
async function applyUtilityOptions(combatant, payload) {
  const actor = combatant?.actor;
  if (!actor) throw new Error(game.i18n.localize("AOV_SKJALDBORG.Warnings.ActorUnavailable"));
  await setReadiedWeapons(actor, cleanReadiedWeaponsPayload(payload.readiedWeapons, actor));
  return setCombatOptions(actor, cleanCombatOptionsPayload(payload.combatOptions));
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function logicalRound(combat) {
  return getCombatState(combat).logicalRound ?? AoVAdapter.getSystemLogicalRound(combat);
}

function cleanRunicPayload(payload = {}) {
  return {
    magicMode: cleanString(payload.magicMode, 40),
    itemId: cleanString(payload.itemId, 100),
    itemType: cleanString(payload.itemType, 40),
    dexPenalty: Math.max(1, Math.round(Number(payload.dexPenalty) || 1)),
    flatMod: Math.round(Number(payload.flatMod) || 0),
    customModifierReason: cleanString(payload.customModifierReason, 120),
    craftEnabled: payload.craftEnabled === true,
    craftMode: cleanString(payload.craftMode, 40),
    craftSkillId: cleanString(payload.craftSkillId, 100),
    customCraftTarget: Math.max(1, Math.round(Number(payload.customCraftTarget) || 0)),
    prepared: payload.prepared === true,
    alreadyCarved: payload.alreadyCarved === true,
    resistance: payload.resistance === true,
    casterTokenUuid: cleanString(payload.casterTokenUuid, 200),
    targetRefs: cleanTargetRefs(payload.targetRefs)
  };
}

function targetSummary(refs) {
  const names = targetNames(refs);
  return names.length ? names.join(", ") : game.i18n.localize("AOV_SKJALDBORG.RunicMagic.NoTargets");
}

async function runicMagicChat(combatant, titleKey, bodyLines, flags = {}) {
  const actor = combatant?.actor ?? null;
  const content = bodyLines
    .filter(Boolean)
    .map(line => `<p>${line}</p>`)
    .join("");
  return createModuleChatMessage({
    speaker: ChatMessage.getSpeaker({ actor, token: combatant?.token }),
    flavor: game.i18n.localize(titleKey),
    content,
    flags: {
      [MODULE_ID]: {
        runicMagic: flags
      }
    }
  }, { applyDefaultMode: false });
}

async function setMagicPrepared(item, prepared) {
  if (!item || !["runescript", "seidur"].includes(item.type)) return null;
  if (item.system?.prepared !== prepared) await item.update({ "system.prepared": prepared === true });
  return item;
}

function craftSucceeded(result) {
  if (result?.resultLevel === null || result?.resultLevel === undefined) return false;
  return Number(result.resultLevel) >= 2;
}

function runeMagicIntentPatch(combatant, dexPenalty = 0) {
  const state = getCombatantState(combatant);
  const baseDex = AoVAdapter.getDex(combatant?.actor);
  const finalDex = Math.max(1, baseDex - Math.max(0, Number(dexPenalty) || 0));
  return sanitizeIntentPayload({
    ...state.intent,
    status: INTENT_STATUS.COMMITTED,
    actionCategory: ACTION_CATEGORIES.MAGIC,
    fixedRank: finalDex,
    runeCarryover: false
  });
}

async function startRuneCarving(combat, combatant, payload) {
  const actor = combatant?.actor;
  if (!actor) throw new Error(game.i18n.localize("AOV_SKJALDBORG.Warnings.ActorUnavailable"));
  const clean = cleanRunicPayload(payload);
  const item = actor.items?.get?.(clean.itemId);
  if (!item || item.type !== "runescript") throw new Error(game.i18n.localize("AOV_SKJALDBORG.Warnings.ItemUnavailable"));
  const details = runeScriptDetails(item);
  const round = logicalRound(combat);

  const message = await runicMagicChat(combatant, "AOV_SKJALDBORG.RunicMagic.ChatCarvingTitle", [
    game.i18n.format("AOV_SKJALDBORG.RunicMagic.ChatCarving", {
      actor: escapeHtml(actor.name),
      script: escapeHtml(item.name),
      runes: details.runeCount,
      dex: clean.dexPenalty
    }),
    game.i18n.format("AOV_SKJALDBORG.RunicMagic.ChatTargets", { targets: escapeHtml(targetSummary(clean.targetRefs)) }),
    clean.craftEnabled && clean.craftMode === CRAFT_RUNE_MODES.CUSTOM
      ? game.i18n.format("AOV_SKJALDBORG.RunicMagic.ChatCustomCraft", { target: clean.customCraftTarget })
      : "",
    game.i18n.localize("AOV_SKJALDBORG.RunicMagic.ChatCarvingRule")
  ], { status: RUNE_MAGIC_STATUSES.CARVING, itemUuid: item.uuid });

  let craftResult = null;
  if (clean.craftEnabled && clean.craftMode !== CRAFT_RUNE_MODES.CUSTOM && clean.craftSkillId) {
    craftResult = await AoVAdapter.rollActorSkill(actor, clean.craftSkillId, null, { cardType: "unopposed", flatMod: clean.flatMod });
  }
  const success = !clean.craftEnabled || clean.craftMode === CRAFT_RUNE_MODES.CUSTOM || craftSucceeded(craftResult);
  const runeMagic = {
    ...defaultRuneMagicState(),
    status: success ? RUNE_MAGIC_STATUSES.CARVING : RUNE_MAGIC_STATUSES.FAILED,
    itemUuid: item.uuid ?? null,
    itemId: item.id,
    itemType: item.type,
    itemName: item.name ?? "",
    runeCount: details.runeCount,
    mpCost: details.mpCost,
    maxEffects: details.maxEffects,
    dexPenalty: clean.dexPenalty,
    startedRound: round,
    readyRound: success ? round + 1 : null,
    targetRefs: clean.targetRefs,
    resistance: clean.resistance,
    craftSkillId: clean.craftSkillId || null,
    craftMode: clean.craftMode || null,
    customCraftTarget: clean.craftMode === CRAFT_RUNE_MODES.CUSTOM ? clean.customCraftTarget : null,
    flatMod: clean.flatMod,
    customModifierReason: clean.customModifierReason || "",
    craftMessageId: craftResult?.messageId ?? null,
    eventMessageId: message?.id ?? null,
    notes: success
      ? game.i18n.format("AOV_SKJALDBORG.RunicMagic.StateCarving", { round: round + 1 })
      : game.i18n.localize("AOV_SKJALDBORG.RunicMagic.StateFailed"),
    updatedAt: Date.now()
  };
  const state = getCombatantState(combatant);
  const intent = sanitizeIntentPayload({
    ...state.intent,
    status: INTENT_STATUS.COMMITTED,
    actionCategory: ACTION_CATEGORIES.MAGIC,
    runeCarryover: success,
    publicText: game.i18n.format("AOV_SKJALDBORG.RunicMagic.IntentCarving", { script: item.name ?? "" })
  });
  const updated = await updateCombatantState(combatant, { runeMagic, intent });
  await refreshPlanningInitiative(combat, combatant);
  if (shouldQueueResolutionImmediately()) await refreshImmediateResolutionActions(combat, combatant, { preserveStatus: true });
  return updated;
}

async function castRuneScript(combat, combatant, payload) {
  const actor = combatant?.actor;
  if (!actor) throw new Error(game.i18n.localize("AOV_SKJALDBORG.Warnings.ActorUnavailable"));
  const clean = cleanRunicPayload(payload);
  const item = actor.items?.get?.(clean.itemId);
  if (!item || item.type !== "runescript") throw new Error(game.i18n.localize("AOV_SKJALDBORG.Warnings.ItemUnavailable"));
  const details = runeScriptDetails(item);
  const runeSkill = firstRuneMagicSkill(actor);
  if (!runeSkill) throw new Error(game.i18n.localize("AOV_SKJALDBORG.RunicMagic.RuneMagicSkillMissing"));
  if (clean.prepared && item.system?.prepared !== true) await setMagicPrepared(item, true);

  let castResult = null;
  let resistanceMessages = [];
  castResult = await AoVAdapter.rollActorSkill(actor, runeSkill.id, null, { cardType: "unopposed", flatMod: clean.flatMod });
  await appendMagicDetailsToMessage(castResult, item, { itemType: "runescript", resultLevel: castResult?.resultLevel });
  const manifests = runeMagicConsumesPrepared(castResult?.resultLevel);
  if (clean.resistance && clean.targetRefs.length && manifests) {
    resistanceMessages = await createRunicResistanceCards({
      actor,
      casterToken: combatant?.token ?? null,
      casterTokenUuid: clean.casterTokenUuid,
      targetRefs: clean.targetRefs,
      item,
      combatId: combat?.id ?? "",
      combatantId: combatant?.id ?? ""
    });
  }
  const consumed = item.system?.prepared === true && manifests;
  if (consumed) await setMagicPrepared(item, false);
  const failedSinging = Number(castResult?.resultLevel) === 1;
  const round = logicalRound(combat);
  const resistanceMessageIds = resistanceMessages.map(message => message.id).filter(Boolean);

  const runeMagic = {
    ...defaultRuneMagicState(),
    status: failedSinging ? RUNE_MAGIC_STATUSES.READY : RUNE_MAGIC_STATUSES.RESOLVED,
    itemUuid: item.uuid ?? null,
    itemId: item.id,
    itemType: item.type,
    itemName: item.name ?? "",
    runeCount: details.runeCount,
    mpCost: details.mpCost,
    maxEffects: details.maxEffects,
    dexPenalty: clean.dexPenalty,
    startedRound: getCombatantState(combatant).runeMagic?.startedRound ?? null,
    readyRound: failedSinging ? round + 1 : round,
    targetRefs: clean.targetRefs,
    resistance: clean.resistance,
    flatMod: clean.flatMod,
    customModifierReason: clean.customModifierReason || "",
    castMessageId: castResult?.messageId ?? null,
    eventMessageId: castResult?.messageId ?? null,
    resistanceMessageIds,
    notes: failedSinging
      ? game.i18n.localize("AOV_SKJALDBORG.RunicMagic.Results.Failure")
      : game.i18n.localize("AOV_SKJALDBORG.RunicMagic.StateResolved"),
    updatedAt: Date.now()
  };
  const intent = runeMagicIntentPatch(combatant, clean.dexPenalty);
  const updated = await updateCombatantState(combatant, { runeMagic, intent });
  await refreshPlanningInitiative(combat, combatant);
  if (shouldQueueResolutionImmediately()) await refreshImmediateResolutionActions(combat, combatant, { preserveStatus: true });
  return updated;
}

async function trackSeidurRitual(combat, combatant, payload) {
  const actor = combatant?.actor;
  if (!actor) throw new Error(game.i18n.localize("AOV_SKJALDBORG.Warnings.ActorUnavailable"));
  const clean = cleanRunicPayload(payload);
  const item = actor.items?.get?.(clean.itemId);
  if (!item || item.type !== "seidur") throw new Error(game.i18n.localize("AOV_SKJALDBORG.Warnings.ItemUnavailable"));
  const details = seidurDetails(item);
  const message = await runicMagicChat(combatant, "AOV_SKJALDBORG.RunicMagic.ChatSeidurTitle", [
    game.i18n.format("AOV_SKJALDBORG.RunicMagic.ChatSeidur", {
      actor: escapeHtml(actor.name),
      spell: escapeHtml(item.name),
      realm: escapeHtml(details.realm || game.i18n.localize("AOV_SKJALDBORG.Chat.None")),
      mp: details.mpCost,
      locked: details.mpLocked,
      time: details.castTime
    })
  ], { status: RUNE_MAGIC_STATUSES.RITUAL, itemUuid: item.uuid });
  const seidurSkill = firstSeidurMagicSkill(actor);
  const seidurResult = seidurSkill
    ? await AoVAdapter.rollActorSkill(actor, seidurSkill.id, null, { cardType: "unopposed", flatMod: clean.flatMod })
    : null;
  if (seidurResult) {
    await appendMagicDetailsToMessage(seidurResult, item, { itemType: "seidur", resultLevel: seidurResult?.resultLevel });
  }
  const runeMagic = {
    ...defaultRuneMagicState(),
    status: RUNE_MAGIC_STATUSES.RITUAL,
    itemUuid: item.uuid ?? null,
    itemId: item.id,
    itemType: item.type,
    itemName: item.name ?? "",
    mpCost: details.mpCost,
    flatMod: clean.flatMod,
    customModifierReason: clean.customModifierReason || "",
    targetRefs: clean.targetRefs,
    castMessageId: seidurResult?.messageId ?? null,
    eventMessageId: message?.id ?? null,
    notes: game.i18n.format("AOV_SKJALDBORG.RunicMagic.ChatSeidur", {
      actor: actor.name ?? "",
      spell: item.name ?? "",
      realm: details.realm || game.i18n.localize("AOV_SKJALDBORG.Chat.None"),
      mp: details.mpCost,
      locked: details.mpLocked,
      time: details.castTime
    }),
    updatedAt: Date.now()
  };
  return updateCombatantState(combatant, { runeMagic });
}

async function markRunePrepared(combat, combatant, payload) {
  const actor = combatant?.actor;
  if (!actor) throw new Error(game.i18n.localize("AOV_SKJALDBORG.Warnings.ActorUnavailable"));
  const clean = cleanRunicPayload(payload);
  const item = actor.items?.get?.(clean.itemId);
  if (!item || item.type !== "runescript") throw new Error(game.i18n.localize("AOV_SKJALDBORG.Warnings.ItemUnavailable"));
  const details = runeScriptDetails(item);
  const round = logicalRound(combat);
  const runeMagic = {
    ...defaultRuneMagicState(),
    status: RUNE_MAGIC_STATUSES.READY,
    itemUuid: item.uuid ?? null,
    itemId: item.id,
    itemType: item.type,
    itemName: item.name ?? "",
    runeCount: details.runeCount,
    mpCost: details.mpCost,
    maxEffects: details.maxEffects,
    dexPenalty: clean.dexPenalty,
    startedRound: round,
    readyRound: round,
    targetRefs: clean.targetRefs,
    resistance: clean.resistance,
    eventMessageId: null,
    notes: game.i18n.format("AOV_SKJALDBORG.RunicMagic.StateReady", { script: item.name ?? "" }),
    updatedAt: Date.now()
  };
  return updateCombatantState(combatant, { runeMagic });
}

async function disruptRuneMagic(combatant, reason = "") {
  const state = getCombatantState(combatant);
  const current = state.runeMagic ?? {};
  if (current.status !== RUNE_MAGIC_STATUSES.CARVING) return state;
  const message = await runicMagicChat(combatant, "AOV_SKJALDBORG.RunicMagic.ChatDisruptedTitle", [
    game.i18n.format("AOV_SKJALDBORG.RunicMagic.ChatDisrupted", {
      actor: escapeHtml(combatant?.actor?.name ?? combatant?.name ?? ""),
      script: escapeHtml(current.itemName ?? "")
    }),
    reason ? escapeHtml(reason) : game.i18n.localize("AOV_SKJALDBORG.RunicMagic.ChatDisruptedRule")
  ], { status: RUNE_MAGIC_STATUSES.DISRUPTED, itemUuid: current.itemUuid ?? null });
  return updateCombatantState(combatant, {
    runeMagic: {
      ...current,
      status: RUNE_MAGIC_STATUSES.DISRUPTED,
      eventMessageId: message?.id ?? current.eventMessageId ?? null,
      notes: game.i18n.localize("AOV_SKJALDBORG.RunicMagic.StateDisrupted"),
      updatedAt: Date.now()
    },
    intent: {
      ...state.intent,
      runeCarryover: false
    }
  });
}

async function clearRuneMagic(combatant) {
  return updateCombatantState(combatant, { runeMagic: defaultRuneMagicState() });
}

/**
 * Register the module socket listener.
 *
 * Only GM clients process write requests. Player clients emit requests and rely
 * on the GM to validate ownership and perform document updates.
 *
 * @returns {void}
 */
export function registerSocket() {
  game.socket.on(SOCKET_NAME, message => {
    if (message?.to && message.to !== game.user.id) return;
    if (message?.type === SOCKET_MESSAGE_RESPONSE) {
      handleSocketResponse(message);
      return;
    }
    if (message?.type && message.type !== SOCKET_MESSAGE_REQUEST) return;

    if (CLIENT_SOCKET_ACTIONS.has(message?.action)) {
      void handleClientSocketRequest(message).then(result => {
        emitSocketResponse(message, { ok: true, result });
      }).catch(err => {
        const errorMessage = err?.message ?? String(err);
        warn(err);
        ui.notifications.error(errorMessage);
        emitSocketResponse(message, { ok: false, error: errorMessage });
      });
      return;
    }

    if (!game.user.isGM) return;

    void handleSocketRequest(message).then(() => {
      emitSocketResponse(message, { ok: true });
    }).catch(err => {
      const errorMessage = err?.message ?? String(err);
      if (isStaleDocumentMessage(errorMessage)) {
        debug("Rejected stale socket request on GM.", {
          action: message?.action,
          requestId: message?.requestId,
          from: message?.from
        });
      } else {
        warn(err);
        ui.notifications.error(errorMessage);
      }
      emitSocketResponse(message, { ok: false, error: errorMessage });
    });
  });
}

/**
 * Submit a request to the active GM or handle it directly when already GM.
 *
 * @param {string} action Socket action id.
 * @param {object} [payload={}] Request payload.
 * @returns {Promise<unknown|null>}
 */
export async function requestGm(action, payload = {}) {
  const measureId = performanceDiagnostics.markStart(`socket.${action}`);
  const message = {
    type: SOCKET_MESSAGE_REQUEST,
    schemaVersion: SOCKET_SCHEMA_VERSION,
    action,
    payload,
    from: game.user.id,
    to: firstActiveGm()?.id,
    requestId: foundry.utils.randomID(),
    sentAt: Date.now()
  };

  if (game.user.isGM) {
    try {
      return await handleSocketRequest(message);
    } finally {
      performanceDiagnostics.markEnd(measureId, { action, localGm: true });
    }
  }
  if (!message.to) {
    ui.notifications.warn(game.i18n.localize("AOV_SKJALDBORG.Warnings.NoGm"));
    performanceDiagnostics.markEnd(measureId, { action, noGm: true });
    return null;
  }
  return new Promise((resolve, reject) => {
    const timeout = globalThis.setTimeout(() => {
      pendingSocketRequests.delete(message.requestId);
      const errorMessage = socketTimeoutMessage(message.to);
      ui.notifications.warn(errorMessage);
      performanceDiagnostics.markEnd(measureId, { action, timedOut: true });
      reject(new Error(errorMessage));
    }, SOCKET_REQUEST_TIMEOUT_MS);
    pendingSocketRequests.set(message.requestId, {
      resolve: result => {
        performanceDiagnostics.markEnd(measureId, { action, ok: true });
        resolve(result);
      },
      reject: error => {
        performanceDiagnostics.markEnd(measureId, { action, ok: false });
        reject(error);
      },
      timeout,
      gmId: message.to
    });
    try {
      game.socket.emit(SOCKET_NAME, message);
    } catch (exception) {
      pendingSocketRequests.delete(message.requestId);
      globalThis.clearTimeout(timeout);
      performanceDiagnostics.markEnd(measureId, { action, emitFailed: true });
      reject(exception);
    }
  });
}

/**
 * Submit a direct request to a specific active user. This is used for client-side
 * UI prompts that must appear on the actor owner's screen instead of on the GM
 * or the initiating client.
 *
 * @param {string} action Client socket action id.
 * @param {object} [payload={}] Request payload.
 * @param {string} userId Target User id.
 * @returns {Promise<unknown|null>}
 */
export async function requestUser(action, payload = {}, userId) {
  const targetUser = game.users?.get?.(String(userId ?? "")) ?? null;
  if (!targetUser) {
    ui.notifications.warn(game.i18n.localize("AOV_SKJALDBORG.Warnings.SocketUserMissing"));
    return null;
  }
  if (!targetUser.active) {
    ui.notifications.warn(game.i18n.format("AOV_SKJALDBORG.Warnings.SocketUserInactive", { user: targetUser.name ?? targetUser.id }));
    return null;
  }

  const measureId = performanceDiagnostics.markStart(`socket.user.${action}`);
  const message = {
    type: SOCKET_MESSAGE_REQUEST,
    schemaVersion: SOCKET_SCHEMA_VERSION,
    action,
    payload,
    from: game.user.id,
    to: targetUser.id,
    requestId: foundry.utils.randomID(),
    sentAt: Date.now()
  };

  if (targetUser.id === game.user.id) {
    try {
      return await handleClientSocketRequest(message);
    } finally {
      performanceDiagnostics.markEnd(measureId, { action, localUser: true });
    }
  }

  return new Promise((resolve, reject) => {
    const timeout = globalThis.setTimeout(() => {
      pendingSocketRequests.delete(message.requestId);
      const errorMessage = socketUserTimeoutMessage(message.to);
      ui.notifications.warn(errorMessage);
      performanceDiagnostics.markEnd(measureId, { action, timedOut: true });
      reject(new Error(errorMessage));
    }, SOCKET_REQUEST_TIMEOUT_MS);
    pendingSocketRequests.set(message.requestId, {
      resolve: result => {
        performanceDiagnostics.markEnd(measureId, { action, ok: true });
        resolve(result);
      },
      reject: error => {
        performanceDiagnostics.markEnd(measureId, { action, ok: false });
        reject(error);
      },
      timeout,
      gmId: message.to
    });
    try {
      game.socket.emit(SOCKET_NAME, message);
    } catch (exception) {
      pendingSocketRequests.delete(message.requestId);
      globalThis.clearTimeout(timeout);
      performanceDiagnostics.markEnd(measureId, { action, emitFailed: true });
      reject(exception);
    }
  });
}

function enqueueUserPrompt(userId, task) {
  const key = String(userId ?? "");
  const previous = userPromptQueues.get(key) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(task)
    .finally(() => {
      if (userPromptQueues.get(key) === next) userPromptQueues.delete(key);
    });
  userPromptQueues.set(key, next);
  return next;
}

function requestUserQueued(action, payload = {}, userId) {
  return enqueueUserPrompt(userId, () => requestUser(action, payload, userId));
}

/**
 * Start an Attack/Missile core combat workflow and route the defender prompt to
 * the active owner of the defender token/actor when necessary.
 *
 * @param {object} payload AttackRollDialog or MissileRollDialog submit payload.
 * @returns {Promise<unknown>}
 */
export async function startDialogCombatWorkflow(payload = {}) {
  return AoVAdapter.rollDialogCombatWorkflow(payload, {
    promptDefender: (user, defensePayload) => requestUserQueued("promptDefenseRoll", defensePayload, user.id)
  });
}

export async function startDialogCombatWorkflowBatch(payloads = [], options = {}) {
  return AoVAdapter.rollDialogCombatWorkflowBatch(payloads, {
    beforeCreate: options.beforeCreate,
    promptDefender: (user, defensePayload) => requestUserQueued("promptDefenseRoll", defensePayload, user.id)
  });
}

/**
 * Handle a direct client-side socket request on the addressed user's client.
 * These actions are intentionally limited to user-interface prompts, not
 * authoritative combat state mutations.
 *
 * @param {{action: string, payload?: object, from?: string, to?: string, requestId?: string}} message Socket message.
 * @returns {Promise<unknown>}
 */
export async function handleClientSocketRequest(message) {
  debug("client socket request", message);
  if (message?.type && message.type !== SOCKET_MESSAGE_REQUEST) {
    throw new Error(`Invalid ${MODULE_ID} socket message type.`);
  }
  if (message?.schemaVersion && Number(message.schemaVersion) !== SOCKET_SCHEMA_VERSION) {
    throw new Error(`Unsupported ${MODULE_ID} socket schema version.`);
  }
  if (!message?.requestId) throw new Error(`Rejected ${MODULE_ID} socket request without a request id.`);
  if (isDuplicateRequest(message)) return { duplicate: true };
  requestingUser(message?.from);

  switch (message.action) {
    case "promptDefenseRoll":
      return AoVAdapter.rollDialogDefenseWorkflow(message.payload ?? {});
    default:
      throw new Error(`Unknown ${MODULE_ID} client socket action "${message.action}"`);
  }
}

/**
 * Handle a socket request on the authoritative GM client.
 *
 * @param {{action: string, payload?: object, from?: string, to?: string, requestId?: string}} message Socket message.
 * @returns {Promise<unknown>}
 */
export async function handleSocketRequest(message) {
  debug("socket request", message);
  if (message?.type && message.type !== SOCKET_MESSAGE_REQUEST) {
    throw new Error(`Invalid ${MODULE_ID} socket message type.`);
  }
  if (message?.schemaVersion && Number(message.schemaVersion) !== SOCKET_SCHEMA_VERSION) {
    throw new Error(`Unsupported ${MODULE_ID} socket schema version.`);
  }
  if (!message?.requestId) throw new Error(`Rejected ${MODULE_ID} socket request without a request id.`);
  if (isDuplicateRequest(message)) return { duplicate: true };
  const user = requestingUser(message?.from);
  const payload = message?.payload ?? {};
  const combat = AoVAdapter.getCombatById(payload.combatId);
  const combatant = payload.combatantId ? AoVAdapter.getCombatantById(combat, payload.combatantId) : null;

  switch (message.action) {
    case "initializeCombat":
      assertGmRequest(user);
      assertCombat(combat);
      return PhaseController.initialize(combat);
    case "disableCombat":
      assertGmRequest(user);
      assertCombat(combat);
      return PhaseController.disable(combat);
    case "advancePhase":
      assertGmRequest(user);
      assertCombat(combat);
      assertFreshCombat(payload, combat);
      return PhaseController.advance(combat, cleanPhase(payload.phase));
    case "advanceTurn":
      assertCombat(combat);
      if (!user.isGM) assertCombatantAccess(user, combat.combatant);
      return PhaseController.advanceTurn(combat);
    case "setActionStatus":
      assertGmRequest(user);
      assertCombat(combat);
      assertFreshCombat(payload, combat);
      return PhaseController.setActionStatus(combat, payload.actionId, cleanResolutionStatus(payload.status));
    case "submitIntent":
      assertCombatantAccess(user, combatant);
      return enqueueCombatantWrite(combat?.id, combatant?.id, async () => {
        const intent = sanitizeIntentPayload(payload.intent);
        if (!isFreshCombatant(payload, combatant)) {
          if (staleIntentIsIdempotent(payload, combatant, intent)) {
            performanceDiagnostics.count("intent.commit.staleIdenticalNoop", 1, {
              combatId: combat?.id ?? null,
              combatantId: combatant?.id ?? null,
              actionCategory: intent.actionCategory
            });
            return getCombatantState(combatant);
          }
          assertFreshCombatant(payload, combatant);
        }
        validateIntentAgainstDisengagement(combatant, intent);
        const updated = await updateCombatantState(combatant, { intent });
        await refreshPlanningInitiative(combat, combatant);
        if (shouldQueueResolutionImmediately()) {
          await refreshImmediateResolutionActions(combat, combatant);
        }
        return updated;
      });
    case "holdIntent":
      assertCombatantAccess(user, combatant);
      return enqueueCombatantWrite(combat?.id, combatant?.id, async () => {
        assertFreshCombatant(payload, combatant);
        const updated = await updateCombatantState(combatant, {
          intent: { ...getCombatantState(combatant).intent, status: "held" }
        });
        await refreshPlanningInitiative(combat, combatant);
        if (shouldQueueResolutionImmediately()) {
          await refreshImmediateResolutionActions(combat, combatant);
        }
        return updated;
      });
    case "clearIntent":
      assertCombatantAccess(user, combatant);
      return enqueueCombatantWrite(combat?.id, combatant?.id, async () => {
        assertFreshCombatant(payload, combatant);
        const updated = await updateCombatantState(combatant, {
          intent: foundry.utils.deepClone(defaultCombatantState().intent)
        });
        await refreshPlanningInitiative(combat, combatant);
        if (shouldQueueResolutionImmediately()) {
          await refreshImmediateResolutionActions(combat, combatant);
        }
        return updated;
      });
    case "recordMovement": {
      assertCombatantAccess(user, combatant);
      const incoming = sanitizeMovementPayload(payload.movement);
      const result = await enqueueCombatantWrite(combat?.id, combatant?.id, async () => {
        const current = getCombatantState(combatant).movement;
        const incomingRevision = Number(incoming.routeRevision) || 0;
        const currentRevision = Number(current?.routeRevision) || 0;

        // Re-read after prior writes complete. Without serialization, a draft
        // and final player route can both validate against the same old state
        // and the slower draft update may overwrite the final plan.
        if (incomingRevision > 0) {
          if (incomingRevision < currentRevision) {
            movementDebug(MOVEMENT_DEBUG_CATEGORIES.SOCKET, "record-movement-stale-revision-ignored", () => ({
              combatantId: combatant?.id ?? null,
              incomingRevision,
              currentRevision,
              incoming,
              current
            }), {
              combatId: combat?.id ?? null,
              combatantId: combatant?.id ?? null,
              level: MOVEMENT_DEBUG_LEVELS.VERBOSE
            });
            return current;
          }
          if (
            incomingRevision === currentRevision
            && Number(incoming.capturedAt) < Number(current?.capturedAt ?? 0)
          ) {
            movementDebug(MOVEMENT_DEBUG_CATEGORIES.SOCKET, "record-movement-older-equal-revision-ignored", () => ({
              combatantId: combatant?.id ?? null,
              incomingRevision,
              incomingCapturedAt: incoming.capturedAt,
              currentCapturedAt: current?.capturedAt ?? null,
              incoming,
              current
            }), {
              combatId: combat?.id ?? null,
              combatantId: combatant?.id ?? null,
              level: MOVEMENT_DEBUG_LEVELS.VERBOSE
            });
            return current;
          }
        }
        else assertFreshCombatant(payload, combatant);

        movementDebug(MOVEMENT_DEBUG_CATEGORIES.SOCKET, "record-movement-write", () => ({
          combatantId: combatant?.id ?? null,
          incomingRevision,
          currentRevision,
          routeId: incoming.routeId,
          captureSource: incoming.captureSource,
          draft: incoming.draft,
          previousMovement: current,
          incomingMovement: incoming
        }), {
          combatId: combat?.id ?? null,
          combatantId: combatant?.id ?? null,
          level: MOVEMENT_DEBUG_LEVELS.TRACE
        });
        const updated = await updateCombatantState(combatant, { movement: incoming });
        movementDebug(MOVEMENT_DEBUG_CATEGORIES.SOCKET, "record-movement-write-complete", () => ({
          combatantId: combatant?.id ?? null,
          routeId: incoming.routeId,
          routeRevision: incoming.routeRevision,
          persistedMovement: getCombatantState(combatant).movement
        }), {
          combatId: combat?.id ?? null,
          combatantId: combatant?.id ?? null,
          level: MOVEMENT_DEBUG_LEVELS.TRACE
        });
        return updated;
      }, { movement: true });

      const persisted = getCombatantState(combatant).movement;
      const combatPhase = getCombatState(combat).phase;
      const sameRevision = Number(persisted?.routeRevision ?? 0) === Number(incoming.routeRevision ?? 0);
      if (incoming.draft !== true && sameRevision) {
        await refreshPlanningInitiative(combat, combatant);
      }
      if (
        incoming.draft !== true
        && sameRevision
        && persisted?.planStatus === MOVEMENT_PLAN_STATUS.PLANNED
        && shouldExecuteMovementImmediately(combatPhase)
      ) {
        await startMovementPhase(combat, { positionAtLast: false });
        if (shouldQueueResolutionImmediately()) {
          await refreshImmediateResolutionActions(combat, combatant, { preserveStatus: true });
        }
      }
      return result;
    }
    case "clearMovement":
      assertCombatantAccess(user, combatant);
      return enqueueCombatantWrite(combat?.id, combatant?.id, async () => {
        assertFreshCombatant(payload, combatant);
        const updated = await updateCombatantState(combatant, {
          movement: {
            mode: "none",
            origin: null,
            destination: null,
            route: [],
            waypoints: [],
            distance: 0,
            units: "",
            manual: true,
            planStatus: MOVEMENT_PLAN_STATUS.NONE,
            startedAt: null,
            completedAt: null,
            stoppedReason: "",
            routeRevision: Date.now(),
            routeId: "",
            captureSource: "manual-clear",
            capturedAt: Date.now(),
            draft: false
          }
        });
        await refreshPlanningInitiative(combat, combatant);
        if (shouldQueueResolutionImmediately()) {
          await refreshImmediateResolutionActions(combat, combatant, { preserveStatus: true });
        }
        return updated;
      }, { movement: true });
    case "adjustInitiative":
      assertCombatantAccess(user, combatant);
      return applyInitiativeAndWeaponAction(combatant, payload);
    case "delayCombatant":
      assertCombatantAccess(user, combatant);
      assertCombat(combat);
      return enqueueCombatantWrite(combat?.id, combatant?.id, async () => {
        assertFreshCombatant(payload, combatant);
        return applyCombatantDelay(combat, combatant, payload);
      });
    case "setUtilityOptions":
      assertCombatantAccess(user, combatant);
      return enqueueCombatantWrite(combat?.id, combatant?.id, async () => {
        assertFreshCombatant(payload, combatant);
        return applyUtilityOptions(combatant, payload);
      });
    case "startRuneCarving":
      assertCombatantAccess(user, combatant);
      assertCombat(combat);
      return enqueueCombatantWrite(combat?.id, combatant?.id, async () => {
        assertFreshCombatant(payload, combatant);
        return startRuneCarving(combat, combatant, payload);
      });
    case "markRunePrepared":
      assertCombatantAccess(user, combatant);
      assertCombat(combat);
      return enqueueCombatantWrite(combat?.id, combatant?.id, async () => {
        assertFreshCombatant(payload, combatant);
        return markRunePrepared(combat, combatant, payload);
      });
    case "castRuneScript":
      assertCombatantAccess(user, combatant);
      assertCombat(combat);
      return enqueueCombatantWrite(combat?.id, combatant?.id, async () => {
        assertFreshCombatant(payload, combatant);
        return castRuneScript(combat, combatant, payload);
      });
    case "trackSeidurRitual":
      assertCombatantAccess(user, combatant);
      assertCombat(combat);
      return enqueueCombatantWrite(combat?.id, combatant?.id, async () => {
        assertFreshCombatant(payload, combatant);
        return trackSeidurRitual(combat, combatant, payload);
      });
    case "clearRuneMagic":
      assertCombatantAccess(user, combatant);
      return enqueueCombatantWrite(combat?.id, combatant?.id, async () => {
        assertFreshCombatant(payload, combatant);
        return clearRuneMagic(combatant);
      });
    case "disruptRuneMagic":
      assertGmRequest(user);
      assertCombat(combat);
      return enqueueCombatantWrite(combat?.id, combatant?.id, async () => disruptRuneMagic(combatant, cleanString(payload.reason, 300)));
    case "activateEvade":
      assertCombatantAccess(user, combatant);
      assertCombat(combat);
      return enqueueCombatantWrite(combat?.id, combatant?.id, async () => {
        assertFreshCombatant(payload, combatant);
        return activateEvadingForCombatant(combat, combatant);
      });
    case "declareDisengagement":
      assertCombatantAccess(user, combatant);
      assertCombat(combat);
      return enqueueCombatantWrite(combat?.id, combatant?.id, async () => {
        assertFreshCombatant(payload, combatant);
        return declareDisengagement(combat, combatant, {
          method: cleanDisengagementMethod(payload.method),
          partnerIds: cleanStringArray(payload.partnerIds, 100),
          opportunityAttackerId: cleanString(payload.opportunityAttackerId, 100) || null,
          opportunityAttackerIds: cleanStringArray(payload.opportunityAttackerIds, 100),
          opportunityMode: cleanString(payload.opportunityMode, 20)
        });
      });
    case "resolveKnockbackDisengagement":
      assertGmRequest(user);
      assertCombat(combat);
      return resolveKnockbackDisengagement(
        combat,
        cleanString(payload.attackerCombatantId, 100),
        cleanString(payload.targetCombatantId, 100),
        { clearAll: payload.clearAll === true, onlyIfOutOfReach: payload.onlyIfOutOfReach === true }
      );
    case "incrementReaction": {
      assertCombatantAccess(user, combatant);
      return enqueueCombatantWrite(combat?.id, combatant?.id, async () => {
        assertFreshCombatant(payload, combatant);
        const state = getCombatantState(combatant);
        const reactionCount = Math.max(0, Number(state.reactionCount ?? 0) + 1);
        const next = await updateCombatantState(combatant, { reactionCount });
        await reconcileReactionPenaltyEffect(combat, combatant, reactionCount);
        return next;
      });
    }
    case "decrementReaction": {
      assertCombatantAccess(user, combatant);
      return enqueueCombatantWrite(combat?.id, combatant?.id, async () => {
        assertFreshCombatant(payload, combatant);
        const state = getCombatantState(combatant);
        const reactionCount = Math.max(0, Number(state.reactionCount ?? 0) - 1);
        const next = await updateCombatantState(combatant, { reactionCount });
        await reconcileReactionPenaltyEffect(combat, combatant, reactionCount);
        return next;
      });
    }
    default:
      throw new Error(`Unknown ${MODULE_ID} socket action "${message.action}"`);
  }
}
