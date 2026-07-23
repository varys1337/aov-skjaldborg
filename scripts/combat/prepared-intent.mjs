import { ACTION_CATEGORIES, INTENT_STATUS, MODULE_ID } from "../constants.mjs";
import { defaultCombatantState, getCombatState, getCombatantState, updateCombatantState } from "./state.mjs";
import { RenderCoordinator } from "../ui/render-coordinator.mjs";
import { refreshPlanningInitiative } from "./planning-initiative.mjs";
import { refreshImmediateResolutionActions } from "./resolution-queue.mjs";
import { shouldQueueResolutionImmediately } from "./phase-structure.mjs";
import { error } from "../logger.mjs";
import { isAuthoritativeGmClient } from "../utils/authority.mjs";

export const PREPARED_INTENT_FLAG = "preparedIntent";
const PREPARED_INTENT_VERSION = 1;
const MAX_PUBLIC_TEXT_LENGTH = 500;
let hooksRegistered = false;

/**
 * Normalize a current or legacy intent category.
 *
 * Flee existed as a separate action category in older Skjaldborg builds. The
 * revised action surface folds that declaration into Retreat while retaining
 * compatibility with already-persisted actor and combatant flags.
 *
 * @param {unknown} value Candidate category.
 * @returns {string}
 */
export function normalizeIntentCategory(value) {
  const category = String(value ?? "").trim().toLowerCase();
  if (category === "flee") return ACTION_CATEGORIES.RETREAT;
  return Object.values(ACTION_CATEGORIES).includes(category)
    ? category
    : ACTION_CATEGORIES.OTHER;
}

/**
 * Sanitize public intent text stored outside a Combat document.
 *
 * @param {unknown} value Candidate text.
 * @returns {string}
 */
export function sanitizePreparedIntentText(value) {
  return String(value ?? "").slice(0, MAX_PUBLIC_TEXT_LENGTH).trim();
}

/**
 * Read an actor-level declaration which may be prepared before Combat exists.
 *
 * @param {Actor|null|undefined} actor Actor document.
 * @returns {{version: number, actionCategory: string, publicText: string, updatedAt: number}|null}
 */
export function getActorPreparedIntent(actor) {
  const raw = actor?.getFlag?.(MODULE_ID, PREPARED_INTENT_FLAG);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  return {
    version: PREPARED_INTENT_VERSION,
    actionCategory: normalizeIntentCategory(raw.actionCategory),
    publicText: sanitizePreparedIntentText(raw.publicText),
    updatedAt: Number(raw.updatedAt) || 0
  };
}

/**
 * Persist an actor-level declaration before or during Combat.
 *
 * Actor flags are used deliberately: they remain available when no Combat or
 * Combatant document exists, and Foundry persists them through Document#setFlag.
 *
 * @param {Actor} actor Actor document.
 * @param {string} actionCategory Intent category.
 * @param {string} [publicText=""] Public declaration text.
 * @returns {Promise<object|null>}
 */
export async function setActorPreparedIntent(actor, actionCategory, publicText = "") {
  if (!actor?.isOwner) return null;
  const category = normalizeIntentCategory(actionCategory);
  const prepared = {
    version: PREPARED_INTENT_VERSION,
    actionCategory: category,
    publicText: category === ACTION_CATEGORIES.OTHER
      ? sanitizePreparedIntentText(publicText)
      : "",
    updatedAt: Date.now()
  };
  await actor.setFlag(MODULE_ID, PREPARED_INTENT_FLAG, prepared);
  return prepared;
}

/**
 * Remove a staged actor declaration after it has been transferred to Combat.
 *
 * @param {Actor|null|undefined} actor Actor document.
 * @returns {Promise<unknown|null>}
 */
export async function clearActorPreparedIntent(actor) {
  if (!actor) return null;
  return actor.unsetFlag(MODULE_ID, PREPARED_INTENT_FLAG);
}

/**
 * Convert an actor-level declaration into the complete Combatant intent schema.
 *
 * @param {object} prepared Prepared actor intent.
 * @returns {import("../types.mjs").SkjaldborgIntent}
 */
export function preparedIntentToCombatantIntent(prepared) {
  const intent = foundry.utils.deepClone(defaultCombatantState().intent);
  intent.status = INTENT_STATUS.COMMITTED;
  intent.actionCategory = normalizeIntentCategory(prepared?.actionCategory);
  intent.publicText = intent.actionCategory === ACTION_CATEGORIES.OTHER
    ? sanitizePreparedIntentText(prepared?.publicText)
    : "";
  return intent;
}

/**
 * Apply a prepared actor declaration to an uncommitted Combatant.
 *
 * @param {Combatant|null|undefined} combatant Target Combatant.
 * @param {{force?: boolean, clearPrepared?: boolean}} [options={}] Synchronization options.
 * @returns {Promise<object|null>}
 */
export async function applyPreparedIntentToCombatant(combatant, { force = false, clearPrepared = true } = {}) {
  const combat = combatant?.parent ?? null;
  const actor = combatant?.actor ?? null;
  if (!combat || !actor) return null;

  const prepared = getActorPreparedIntent(actor);
  if (!prepared) return null;

  const current = getCombatantState(combatant);
  if (!force && current.intent?.status !== INTENT_STATUS.UNCOMMITTED) return null;

  const updated = await updateCombatantState(combatant, {
    intent: preparedIntentToCombatantIntent(prepared)
  });
  await refreshPlanningInitiative(combat, combatant);
  if (shouldQueueResolutionImmediately()) {
    await refreshImmediateResolutionActions(combat, combatant);
  }
  if (clearPrepared) await clearActorPreparedIntent(actor);
  return updated;
}

/**
 * Apply all prepared actor declarations when a Combat becomes active.
 *
 * @param {Combat|null|undefined} combat Combat document.
 * @returns {Promise<object[]>}
 */
export async function synchronizePreparedIntents(combat) {
  if (!combat?.started || !getCombatState(combat).enabled) return [];
  const updates = [];
  const actorsToClear = new Set();
  for (const combatant of combat.combatants ?? []) {
    const update = await applyPreparedIntentToCombatant(combatant, { clearPrepared: false });
    if (!update) continue;
    updates.push(update);
    if (combatant.actor) actorsToClear.add(combatant.actor);
  }
  await Promise.all(Array.from(actorsToClear, actor => clearActorPreparedIntent(actor)));
  if (updates.length) RenderCoordinator.invalidateCombatTracker("prepared-intent-refresh");
  return updates;
}

/**
 * Register synchronization hooks for Combat activation and late combatants.
 *
 * The documented combatStart hook runs before the core start update completes,
 * so synchronization is deferred one task to ensure Combat#started is true.
 *
 * @returns {void}
 */
export function registerPreparedIntentHooks(hooks = globalThis.Hooks) {
  if (hooksRegistered) return;
  hooksRegistered = true;

  hooks.on("combatStart", combat => {
    if (!isAuthoritativeGmClient()) return;
    globalThis.setTimeout(() => {
      void synchronizePreparedIntents(combat).catch(cause => {
        error("Failed to synchronize prepared intents when combat started.", cause);
      });
    }, 0);
  });

  hooks.on("createCombatant", combatant => {
    if (!isAuthoritativeGmClient() || !combatant?.parent?.started) return;
    void applyPreparedIntentToCombatant(combatant).catch(cause => {
      error("Failed to synchronize a prepared intent for a new combatant.", cause);
    });
  });

  if (isAuthoritativeGmClient() && game.combat?.started) {
    void synchronizePreparedIntents(game.combat).catch(cause => {
      error("Failed to synchronize prepared intents for the active combat.", cause);
    });
  }
}
