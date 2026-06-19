import { AoVAdapter } from "./adapter/aov-adapter.mjs";
import {
  ACTION_CATEGORIES,
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
import { getCombatState, getCombatantState, updateCombatantState } from "./combat/state.mjs";
import { debug, warn } from "./logger.mjs";
import { clearReadiedWeapon, getReadiedWeaponId, setReadiedWeapon } from "./combat/weapon-state.mjs";
import { cleanMovementPoint, normalizeMovementRoute } from "./combat/movement-route.mjs";
import { movementDebug } from "./combat/movement-debugger.mjs";
import { enqueueCombatantWrite } from "./combat/authoritative-write-queue.mjs";
import { startMovementPhase } from "./combat/movement-controller.mjs";
import { shouldExecuteMovementImmediately, shouldQueueResolutionImmediately } from "./combat/phase-structure.mjs";
import { refreshImmediateResolutionActions } from "./combat/resolution-queue.mjs";

const SOCKET_REQUEST_TIMEOUT_MS = 10000;
const SOCKET_MESSAGE_REQUEST = "request";
const SOCKET_MESSAGE_RESPONSE = "response";
const pendingSocketRequests = new Map();

/**
 * Select the first active GM to receive a player request.
 *
 * @returns {User|null}
 */
function firstActiveGm() {
  return game.users.find(u => u.active && u.isGM) ?? null;
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
  if (!user?.isGM) throw new Error(game.i18n.localize("AOV_SKJADLBORG.Warnings.GmOnly"));
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
  if (message.ok) pending.resolve(true);
  else pending.reject(new Error(cleanString(message.error, 1000) || game.i18n.localize("AOV_SKJADLBORG.Warnings.ActionFailed")));
  return true;
}

/**
 * Sanitize and clamp a user-submitted string.
 *
 * @param {unknown} value Candidate value.
 * @param {number} [max=500] Maximum retained length.
 * @returns {string}
 */
function cleanString(value, max = 500) {
  return String(value ?? "").slice(0, max).trim();
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

/**
 * Clamp a user-selected action category to the module's supported enum.
 *
 * @param {unknown} value Candidate action category.
 * @returns {string}
 */
function cleanActionCategory(value) {
  const category = cleanString(value, 40);
  if (!category) return ACTION_CATEGORIES.ATTACK;
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

/**
 * Clamp a phase id submitted over the socket.
 *
 * @param {unknown} value Candidate phase id.
 * @returns {string|null}
 */
function cleanPhase(value) {
  if (value === "" || value === null || value === undefined) return null;
  if (!PHASE_ORDER.includes(value)) throw new Error(game.i18n.localize("AOV_SKJADLBORG.Warnings.InvalidPhase"));
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
      targetDex: cleanPositiveNumber(payload.delay?.targetDex)
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
    throw new Error(game.i18n.localize("AOV_SKJADLBORG.Warnings.NotOwner"));
  }
}

/**
 * Throw when a Combat document is required but unavailable.
 *
 * @param {Combat|null} combat Target combat.
 * @returns {void}
 */
function assertCombat(combat) {
  if (!combat) throw new Error(game.i18n.localize("AOV_SKJADLBORG.Warnings.NoCombat"));
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
    throw new Error(game.i18n.localize("AOV_SKJADLBORG.Warnings.StaleDocument"));
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
    throw new Error(game.i18n.localize("AOV_SKJADLBORG.Warnings.StaleDocument"));
  }
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
  if (!actor) throw new Error(game.i18n.localize("AOV_SKJADLBORG.Warnings.ActorUnavailable"));

  const action = ["draw", "sheathe", "none"].includes(payload.weaponAction)
    ? payload.weaponAction
    : "none";
  const amount = cleanInitiativeAdjustment(payload.amount);
  const initiative = Number(combatant.initiative);
  const previousWeaponId = getReadiedWeaponId(actor);

  try {
    if (action === "draw") {
      await setReadiedWeapon(actor, cleanString(payload.weaponId, 100));
    } else if (action === "sheathe") {
      await clearReadiedWeapon(actor);
    }

    if (!Number.isFinite(initiative)) return actor;
    return await combatant.update({
      initiative: Number((initiative - amount).toFixed(2))
    });
  } catch (exception) {
    try {
      if (previousWeaponId) await setReadiedWeapon(actor, previousWeaponId);
      else await clearReadiedWeapon(actor);
    } catch (rollbackError) {
      warn(rollbackError);
    }
    throw exception;
  }
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
    if (!game.user.isGM) return;

    void handleSocketRequest(message).then(() => {
      emitSocketResponse(message, { ok: true });
    }).catch(err => {
      warn(err);
      emitSocketResponse(message, { ok: false, error: err?.message ?? String(err) });
      ui.notifications.error(err.message);
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
  const message = {
    type: SOCKET_MESSAGE_REQUEST,
    action,
    payload,
    from: game.user.id,
    to: firstActiveGm()?.id,
    requestId: foundry.utils.randomID()
  };

  if (game.user.isGM) return handleSocketRequest(message);
  if (!message.to) {
    ui.notifications.warn(game.i18n.localize("AOV_SKJADLBORG.Warnings.NoGm"));
    return null;
  }
  return new Promise((resolve, reject) => {
    const timeout = globalThis.setTimeout(() => {
      pendingSocketRequests.delete(message.requestId);
      reject(new Error(game.i18n.localize("AOV_SKJADLBORG.Warnings.SocketTimeout")));
    }, SOCKET_REQUEST_TIMEOUT_MS);
    pendingSocketRequests.set(message.requestId, { resolve, reject, timeout, gmId: message.to });
    try {
      game.socket.emit(SOCKET_NAME, message);
    } catch (exception) {
      pendingSocketRequests.delete(message.requestId);
      globalThis.clearTimeout(timeout);
      reject(exception);
    }
  });
}

/**
 * Handle a socket request on the authoritative GM client.
 *
 * @param {{action: string, payload?: object, from?: string, to?: string, requestId?: string}} message Socket message.
 * @returns {Promise<unknown>}
 */
export async function handleSocketRequest(message) {
  debug("socket request", message);
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
        assertFreshCombatant(payload, combatant);
        const updated = await updateCombatantState(combatant, { intent: sanitizeIntentPayload(payload.intent) });
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
        if (shouldQueueResolutionImmediately()) {
          await refreshImmediateResolutionActions(combat, combatant, { preserveStatus: true });
        }
        return updated;
      }, { movement: true });
    case "adjustInitiative":
      assertCombatantAccess(user, combatant);
      return applyInitiativeAndWeaponAction(combatant, payload);
    case "incrementReaction": {
      assertCombatantAccess(user, combatant);
      return enqueueCombatantWrite(combat?.id, combatant?.id, async () => {
        assertFreshCombatant(payload, combatant);
        const state = getCombatantState(combatant);
        return updateCombatantState(combatant, { reactionCount: Math.max(0, Number(state.reactionCount ?? 0) + 1) });
      });
    }
    case "decrementReaction": {
      assertCombatantAccess(user, combatant);
      return enqueueCombatantWrite(combat?.id, combatant?.id, async () => {
        assertFreshCombatant(payload, combatant);
        const state = getCombatantState(combatant);
        return updateCombatantState(combatant, { reactionCount: Math.max(0, Number(state.reactionCount ?? 0) - 1) });
      });
    }
    default:
      throw new Error(`Unknown ${MODULE_ID} socket action "${message.action}"`);
  }
}
