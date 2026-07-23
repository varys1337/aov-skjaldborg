import { DAMAGE_EFFECT_SOURCE_FLAG, GRAPPLED_STATUS_ID, IMMOBILIZED_STATUS_ID, MODULE_ID, PHASES } from "../constants.mjs";
import { runtimeSettings } from "../runtime-settings.mjs";
import { warn } from "../logger.mjs";
import { effectHasStatus, effectIsActive, injuryThresholdSeverityFromEffects, moduleFlag } from "../compat/active-effects.mjs";
import { createModuleChatMessage } from "../compat/chat-message.mjs";
import { guardedModuleFlag, guardedUpdate } from "../utils/guarded-document-writes.mjs";
import { collectionArray, numberOr } from "../utils/document-data.mjs";
import {
  getItemCritFumbleChances,
  getWeaponCritFumbleChances
} from "../combat/automation-helpers.mjs";
import { combatantForTokenDocument } from "../combat/combatant-token-resolution.mjs";
import {
  proneAttackModifierContext,
  proneDamageContext,
  serializeProneAttackModifierContext,
  serializeProneDamageContext
} from "../combat/prone-automation.mjs";
import {
  AOV_IMPORTS,
  AOV_TEMPLATES,
  importAoVModule
} from "./aov-contract.mjs";

const CORE_ROLL_PROMPT_TIMEOUT_MS = 15000;
const defenseCardQueues = new Map();
const defenseCommitResults = new Map();
const DEFENSE_COMMIT_RESULT_TTL_MS = 60000;

/**
 * Read a total or raw AoV ability value.
 *
 * @param {Actor|null|undefined} actor Foundry Actor document.
 * @param {string} ability AoV ability key such as `dex` or `int`.
 * @returns {number}
 */
function totalAbility(actor, ability) {
  const data = actor?.system?.abilities?.[ability];
  return numberOr(data?.total ?? data?.value, 0);
}

/**
 * Extract the first numeric movement value from an NPC movement string.
 *
 * @param {unknown} value Candidate NPC movement string.
 * @returns {number|undefined}
 */
function parseMovementText(value) {
  if (value === undefined || value === null) return undefined;
  const match = String(value).match(/-?\d+(\.\d+)?/);
  return match ? Number(match[0]) : undefined;
}


/**
 * Whether an AoV weapon item is currently carried/equipped.
 *
 * @param {Item|null|undefined} item Candidate weapon item.
 * @returns {boolean}
 */
function isCarriedWeapon(item) {
  return item?.type === "weapon" && numberOr(item.system?.equipStatus, 0) === 1;
}

/**
 * Whether an AoV weapon item is intrinsic/natural rather than equipment.
 *
 * @param {Item|null|undefined} item Candidate weapon item.
 * @returns {boolean}
 */
function isNaturalWeapon(item) {
  const descriptor = String(item?.system?.weaponType ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
  return item?.type === "weapon" && (descriptor === "naturalwpn" || descriptor.includes("natural"));
}

function itemName(item) {
  return String(item?.name ?? item?.system?.name ?? "");
}

function actorImage(actor, token = null) {
  return actor?.img ?? "icons/svg/mystery-man.svg";
}

function skillTotal(actor, skill) {
  const prepared = Number(skill?.system?.total);
  if (Number.isFinite(prepared)) return prepared;
  const raw = ["base", "xp", "home", "pers", "effects"]
    .reduce((sum, field) => sum + numberOr(skill?.system?.[field], 0), 0);
  if (raw <= 0) return raw;
  return raw + numberOr(actor?.system?.[skill?.system?.category], 0);
}

function skillEncPenalty(actor, skill) {
  return ["agi", "man", "ste", "cbt"].includes(String(skill?.system?.category ?? ""))
    ? numberOr(actor?.system?.encPenalty, 0)
    : 0;
}

function randomBatchId() {
  return foundry.utils.randomID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

const CORE_COMBAT_CARD_WAIT_MS = 6000;
const CORE_COMBAT_CARD_WAIT_STEP_MS = 100;

/**
 * Sleep for a short asynchronous polling interval.
 *
 * @param {number} ms Milliseconds to wait.
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise(resolve => globalThis.setTimeout(resolve, ms));
}

function defenseCommitResultKey(messageId, requestId) {
  const attackMessageId = String(messageId ?? "").trim();
  const id = String(requestId ?? "").trim();
  return attackMessageId && id ? `${attackMessageId}:${id}` : "";
}

function pruneDefenseCommitResults() {
  const now = Date.now();
  for (const [key, entry] of defenseCommitResults) {
    if ((now - Number(entry?.storedAt ?? 0)) > DEFENSE_COMMIT_RESULT_TTL_MS) defenseCommitResults.delete(key);
  }
}

function queuedDefenseCardAppend(messageId, operation) {
  const key = String(messageId ?? "") || "no-message";
  const previous = defenseCardQueues.get(key) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(operation);
  defenseCardQueues.set(key, next);
  void next.finally(() => {
    if (defenseCardQueues.get(key) === next) defenseCardQueues.delete(key);
  }).catch(() => undefined);
  return next;
}

/**
 * Find an open unresolved core AoV combat card.
 *
 * @returns {ChatMessage|null}
 */
function findOpenCoreCombatCard() {
  const messages = collectionArray(ui?.chat?.collection ?? game?.messages);
  const openCards = messages.filter(message => (
    message?.getFlag?.("aov", "cardType") === "CO"
    && message?.getFlag?.("aov", "state") !== "closed"
  ));
  if (!openCards.length) return null;
  return openCards[openCards.length - 1] ?? null;
}

/**
 * Wait until a newly created core AoV combat card has replicated to this
 * client. This prevents a remotely prompted defender from accidentally
 * creating a second combat card because their chat collection has not yet
 * received the attacker's card.
 *
 * @param {string|null|undefined} messageId ChatMessage id to wait for.
 * @param {number} [timeoutMs=CORE_COMBAT_CARD_WAIT_MS] Maximum wait.
 * @returns {Promise<ChatMessage|null>} Open combat card, if found.
 */
async function waitForOpenCoreCombatCard(messageId, timeoutMs = CORE_COMBAT_CARD_WAIT_MS) {
  const targetId = String(messageId ?? "").trim();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const message = targetId ? (game.messages?.get?.(targetId) ?? null) : findOpenCoreCombatCard();
    if (
      message?.getFlag?.("aov", "cardType") === "CO"
      && message?.getFlag?.("aov", "state") !== "closed"
    ) {
      return message;
    }
    await sleep(CORE_COMBAT_CARD_WAIT_STEP_MS);
  }
  return targetId ? null : findOpenCoreCombatCard();
}

/**
 * Return the first active GM, preferring the current user when applicable.
 *
 * @returns {User|null}
 */
function activeGmUser() {
  if (game.user?.active && game.user?.isGM) return game.user;
  return game.users?.find?.(user => user.active && user.isGM) ?? null;
}

/**
 * Test whether a non-GM user owns a concrete token participant or its actor.
 * Token permission is checked first so unlinked token actors can be routed to
 * the user who actually controls that battlefield participant.
 *
 * @param {User|null|undefined} user Candidate user.
 * @param {Actor|null|undefined} actor Participant Actor.
 * @param {TokenDocument|null|undefined} token Participant TokenDocument.
 * @returns {boolean}
 */
function userOwnsParticipant(user, actor, token) {
  if (!user || user.isGM) return false;
  if (token?.testUserPermission?.(user, "OWNER")) return true;
  return actor?.testUserPermission?.(user, "OWNER") ?? false;
}

/**
 * Choose the active client that should be prompted for a defender reaction.
 * Active non-GM owners of the token/actor take priority; otherwise the active
 * GM keeps the current GM-controlled fallback behavior.
 *
 * @param {Actor|null|undefined} actor Defender actor.
 * @param {TokenDocument|null|undefined} token Defender token.
 * @returns {User|null}
 */
function defensePromptUser(actor, token) {
  const owners = collectionArray(game.users)
    .filter(user => user.active && !user.isGM)
    .filter(user => userOwnsParticipant(user, actor, token));
  return owners[0] ?? activeGmUser();
}

/**
 * Resolve a UUID without surfacing Foundry lookup errors to users.
 *
 * @param {unknown} uuid Candidate UUID.
 * @returns {Promise<Document|null>} Resolved document.
 */
async function resolveUuid(uuid) {
  const value = String(uuid ?? "").trim();
  if (!value || typeof fromUuid !== "function") return null;
  try {
    return await fromUuid(value);
  } catch (_exception) {
    return null;
  }
}

function actorGrappleLocationStates(actor) {
  const states = new Map();
  for (const effect of actor?.effects ?? []) {
    if (!effectIsActive(effect)) continue;
    const data = moduleFlag(effect, "grapple") ?? null;
    const locationId = String(data?.grappledHitLocationId ?? "");
    if (!locationId) continue;
    const statusIsImmobilized = effectHasStatus(effect, IMMOBILIZED_STATUS_ID) || data?.immobilized === true;
    const statusIsGrappled = statusIsImmobilized || effectHasStatus(effect, GRAPPLED_STATUS_ID);
    if (!statusIsGrappled) continue;
    const existing = states.get(locationId) ?? { grappled: false, immobilized: false, sources: [] };
    existing.grappled = true;
    existing.immobilized = existing.immobilized || statusIsImmobilized;
    const source = String(data.sourceActorName ?? data.sourceTokenName ?? "").trim();
    if (source && !existing.sources.includes(source)) existing.sources.push(source);
    states.set(locationId, existing);
  }
  return states;
}

let aovCheckApiPromise = null;
let aovRollOptionsApiPromise = null;
let aovCombatChatApiPromise = null;
let aovRollTypeApiPromise = null;
const warnedAoVAdapterFailures = new Set();

function warnAoVAdapterFailureOnce(key, message, exception = null) {
  if (warnedAoVAdapterFailures.has(key)) return;
  warnedAoVAdapterFailures.add(key);
  if (exception) warn(message, exception);
  else warn(message);
}

/**
 * Import one installed AoV system module using Foundry's route resolver.
 *
 * @param {string} path AoV module path relative to the Foundry data root.
 * @returns {Promise<object>}
 */
export function importAoVSystemModule(path) {
  return importAoVModule(path);
}

/**
 * Load the AoV system's awaited check API from the installed system package.
 *
 * The current AoV release does not expose checks through `game.aov`. The actor
 * sheet's AOVRollType wrapper starts AOVCheck asynchronously without returning
 * that Promise, which is unsuitable for an ApplicationV2 action that needs to
 * await the complete dialog workflow and catch failures. The adapter therefore
 * calls the same core AOVCheck trigger directly while keeping the system import
 * isolated here. `getRoute` preserves installations which use a route prefix.
 *
 * @returns {Promise<{AOVCheck: Function, RollType: Function, CardType: Function}>}
 */
async function getAoVCheckApi() {
  if (!aovCheckApiPromise) {
    const path = AOV_IMPORTS.CHECKS;
    aovCheckApiPromise = importAoVSystemModule(path)
      .then(module => {
        if (typeof module.AOVCheck?._trigger !== "function") {
          throw new Error("The Age of Vikings check workflow is unavailable.");
        }
        if (!module.RollType || !module.CardType) {
          throw new Error("The Age of Vikings roll constants are unavailable.");
        }
        return {
          AOVCheck: module.AOVCheck,
          RollType: module.RollType,
          CardType: module.CardType
        };
      })
      .catch(exception => {
        aovCheckApiPromise = null;
        throw exception;
      });
  }
  return aovCheckApiPromise;
}

async function getAoVCombatChatApi() {
  if (!aovCombatChatApiPromise) {
    const path = AOV_IMPORTS.COMBAT_CHAT;
    aovCombatChatApiPromise = importAoVSystemModule(path)
      .then(module => {
        if (typeof module.COCard?.resolveDam !== "function" || typeof module.COCard?.COHitLoc !== "function") {
          throw new Error("The Age of Vikings combat card workflow is unavailable.");
        }
        return { COCard: module.COCard };
      })
      .catch(exception => {
        aovCombatChatApiPromise = null;
        warnAoVAdapterFailureOnce("combat-chat-api", "Age of Vikings combat chat workflow integration is unavailable.", exception);
        throw exception;
      });
  }
  return aovCombatChatApiPromise;
}

/**
 * Load AoV's core roll-options dialog surface without using AOVCheck.RollDialog,
 * whose combat option list depends on global open-card discovery.
 *
 * @returns {Promise<{AOVDialog: typeof foundry.applications.api.DialogV2, AOVSelectLists: Function}>}
 */
async function getAoVRollOptionsApi() {
  if (!aovRollOptionsApiPromise) {
    const dialogPath = AOV_IMPORTS.DIALOG;
    const listsPath = AOV_IMPORTS.SELECT_LISTS;
    aovRollOptionsApiPromise = Promise.all([
      importAoVSystemModule(dialogPath),
      importAoVSystemModule(listsPath)
    ])
      .then(([dialogModule, listsModule]) => {
        if (typeof dialogModule.default?.input !== "function") {
          throw new Error("The Age of Vikings roll options dialog is unavailable.");
        }
        if (!listsModule.AOVSelectLists) {
          throw new Error("The Age of Vikings roll option lists are unavailable.");
        }
        return {
          AOVDialog: dialogModule.default,
          AOVSelectLists: listsModule.AOVSelectLists
        };
      })
      .catch(exception => {
        aovRollOptionsApiPromise = null;
        throw exception;
      });
  }
  return aovRollOptionsApiPromise;
}

async function getAoVRollTypeApi() {
  if (!aovRollTypeApiPromise) {
    const path = AOV_IMPORTS.ROLL_TYPES;
    aovRollTypeApiPromise = importAoVSystemModule(path)
      .then(module => {
        if (typeof module.AOVRollType?._onDetermineCheck !== "function") {
          throw new Error("The Age of Vikings statistic roll router is unavailable.");
        }
        return { AOVRollType: module.AOVRollType };
      })
      .catch(exception => {
        aovRollTypeApiPromise = null;
        warnAoVAdapterFailureOnce("roll-type-api", "Age of Vikings statistic roll integration is unavailable.", exception);
        throw exception;
      });
  }
  return aovRollTypeApiPromise;
}

/**
 * Preferred zero-based cells for the standard seven-location humanoid body map.
 *
 * AoV stores the same semantic locations on character and NPC Hit Location
 * Items, but NPC Items may retain the model default `gridPos` of 0. The d20
 * ranges therefore provide a stable fallback without depending on translated
 * Item names.
 *
 * @type {ReadonlyMap<string, number>}
 */
const STANDARD_HUMANOID_GRID_BY_RANGE = new Map([
  ["19:20", 1], // Head
  ["13:15", 3], // Right Arm
  ["12:12", 4], // Chest
  ["16:18", 5], // Left Arm
  ["9:11", 7], // Abdomen
  ["1:4", 9], // Right Leg
  ["5:8", 11] // Left Leg
]);

/**
 * Resolve a standard humanoid body-map position from a Hit Location's d20
 * range. Custom creatures simply return `null` and continue through the
 * configured-grid and free-cell fallbacks.
 *
 * @param {Item} location Owned AoV Hit Location Item.
 * @returns {number|null} Zero-based 3 × 4 grid position.
 */
function standardHumanoidGridPosition(location) {
  const low = Number(location?.system?.lowRoll);
  const high = Number(location?.system?.highRoll);
  if (!Number.isInteger(low) || !Number.isInteger(high)) return null;
  return STANDARD_HUMANOID_GRID_BY_RANGE.get(`${low}:${high}`) ?? null;
}

/**
 * Thin adapter over the current AoV document surface.
 *
 * Document reads go through Foundry documents, flags, public globals, and
 * stable CONFIG values. The only direct system-module integration is the
 * isolated check-workflow loader above, required because AoV does not expose
 * its roll dispatcher through `game.aov`.
 */
export class AoVAdapter {
  /**
   * Whether the world-level full combat setting is enabled.
   *
   * @returns {boolean}
   */
  static get enabledSetting() {
    return runtimeSettings.enabled === true;
  }

  /**
   * Confirm this module is running in an Age of Vikings world.
   *
   * @returns {boolean}
   */
  static isAoVWorld() {
    return game.system?.id === "aov";
  }

  /**
   * Public alias for callers that need a system-active check without depending
   * on the legacy method name.
   *
   * @returns {boolean}
   */
  static isAovSystemActive() {
    return this.isAoVWorld();
  }

  /**
   * Trigger AoV's core check workflow through the adapter boundary.
   *
   * String `rollType` and `cardType` values are resolved against AoV's current
   * constants before dispatch.
   *
   * @param {object} config AoV check request data.
   * @returns {Promise<string|undefined|false>}
   */
  static async triggerAovCheck(config = {}) {
    const { AOVCheck, RollType, CardType } = await getAoVCheckApi();
    const request = { ...config };
    if (typeof request.rollType === "string" && RollType[request.rollType]) request.rollType = RollType[request.rollType];
    if (typeof request.cardType === "string" && CardType[request.cardType]) request.cardType = CardType[request.cardType];
    return AOVCheck._trigger(request);
  }

  /**
   * Normalize an AoV check request using the current system implementation.
   *
   * @param {object} config Raw AoV check request data.
   * @returns {Promise<object>}
   */
  static async normalizeAovCheckRequest(config = {}) {
    const { AOVCheck, RollType, CardType } = await getAoVCheckApi();
    if (typeof AOVCheck.normaliseRequest !== "function") {
      const error = new Error("The Age of Vikings check request normalizer is unavailable.");
      warnAoVAdapterFailureOnce("check-normalise-request", error.message, error);
      throw error;
    }
    return AOVCheck.normaliseRequest({
      ...config,
      rollType: typeof config.rollType === "string" && RollType[config.rollType] ? RollType[config.rollType] : config.rollType,
      cardType: typeof config.cardType === "string" && CardType[config.cardType] ? CardType[config.cardType] : config.cardType
    });
  }

  /**
   * Start an AoV check from an already-normalized request.
   *
   * @param {object} config Normalized AoV check request.
   * @returns {Promise<string|undefined|false>}
   */
  static async startAovCheck(config = {}) {
    const { AOVCheck } = await getAoVCheckApi();
    if (typeof AOVCheck.startCheck !== "function") {
      const error = new Error("The Age of Vikings check starter is unavailable.");
      warnAoVAdapterFailureOnce("check-start-check", error.message, error);
      throw error;
    }
    return AOVCheck.startCheck(config);
  }

  /**
   * Render AoV combat chat content from existing AoV flags.
   *
   * @param {object} aovFlags AoV chat flags.
   * @returns {Promise<string>}
   */
  static async createAovCombatCard(aovFlags = {}) {
    const { AOVCheck } = await getAoVCheckApi();
    if (typeof AOVCheck.startChat === "function") return AOVCheck.startChat(aovFlags);
    return foundry.applications.handlebars.renderTemplate(
      aovFlags.chatTemplate ?? AOV_TEMPLATES.ROLL_COMBAT,
      aovFlags
    );
  }

  /**
   * Resolve an AoV damage card through AoV's current combat-chat handler.
   *
   * @param {object} config AoV combat-chat damage resolve config.
   * @returns {Promise<unknown>}
   */
  static async resolveAovDamage(config = {}) {
    const { COCard } = await getAoVCombatChatApi();
    return COCard.resolveDam(config);
  }

  /**
   * Resolve AoV hit-location selection through AoV's combat-chat handler.
   *
   * @param {object} config AoV combat-chat hit-location config.
   * @returns {Promise<unknown>}
   */
  static async resolveAovHitLocation(config = {}) {
    const { COCard } = await getAoVCombatChatApi();
    return COCard.COHitLoc(config);
  }

  /**
   * Read AoV chat-card flags without exposing a mutable fallback object.
   *
   * @param {ChatMessage|null|undefined} message Candidate message.
   * @returns {{rollType: string, cardType: string, state: string, chatTemplate: string, chatCard: object[]}}
   */
  static getAovChatCardFlags(message) {
    const flags = message?.flags?.aov ?? {};
    return {
      rollType: String(message?.getFlag?.("aov", "rollType") ?? flags.rollType ?? ""),
      cardType: String(message?.getFlag?.("aov", "cardType") ?? flags.cardType ?? ""),
      state: String(message?.getFlag?.("aov", "state") ?? flags.state ?? ""),
      chatTemplate: String(flags.chatTemplate ?? ""),
      chatCard: Array.isArray(message?.getFlag?.("aov", "chatCard"))
        ? message.getFlag("aov", "chatCard")
        : (Array.isArray(flags.chatCard) ? flags.chatCard : [])
    };
  }

  /**
   * Normalize the AoV weapon data commonly needed by Skjaldborg rules.
   *
   * @param {Item|object|null|undefined} item Candidate weapon Item.
   * @returns {object|null}
   */
  static readAovWeaponDamageData(item) {
    if (!item || item.type !== "weapon") return null;
    return {
      id: String(item.id ?? item._id ?? ""),
      uuid: item.uuid ?? null,
      name: itemName(item),
      damage: String(item.system?.damage ?? ""),
      damageType: String(item.system?.damageType ?? item.system?.damType ?? ""),
      weaponType: String(item.system?.weaponType ?? ""),
      weaponCategory: String(item.system?.weaponCat ?? item.system?.weaponCatName ?? ""),
      currentHp: numberOr(item.system?.currHP, 0),
      maximumHp: numberOr(item.system?.maxHP ?? item.system?.hp, 0)
    };
  }

  /**
   * Normalize one actor's AoV hit-location Items.
   *
   * @param {Actor|object|null|undefined} actor Candidate Actor.
   * @returns {object[]}
   */
  static readAovHitLocationData(actor) {
    return collectionArray(actor?.items)
      .filter(item => item?.type === "hitloc")
      .map(item => ({
        id: String(item.id ?? item._id ?? ""),
        uuid: item.uuid ?? null,
        name: itemName(item),
        locType: String(item.system?.locType ?? ""),
        lowRoll: numberOr(item.system?.lowRoll, 0),
        highRoll: numberOr(item.system?.highRoll, 0),
        map: numberOr(item.system?.map, 0),
        npcAP: numberOr(item.system?.npcAP, 0),
        npcDamage: numberOr(item.system?.npcDmg, 0),
        gridPos: numberOr(item.system?.gridPos, 0)
      }));
  }

  /**
   * Execute AoV's current actor statistic roll router.
   *
   * @param {Actor} actor Actor document.
   * @param {{property: string, characteristic?: string}} detail AoV roll detail.
   * @param {Event|null} [event=null] Originating interaction event.
   * @returns {Promise<unknown>}
   */
  static async executeAovActorStatCheck(actor, detail, event = null) {
    const { AOVRollType } = await getAoVRollTypeApi();
    return AOVRollType._onDetermineCheck(event ?? {}, detail, actor);
  }

  /**
   * Derive the current AoV system phase from its existing two-stage round model.
   *
   * @param {Combat|null|undefined} combat Foundry Combat document.
   * @returns {"intent"|"resolution"}
   */
  static getSystemPhase(combat) {
    const round = Number(combat?.round ?? 0);
    if (round <= 0) return PHASES.INTENT;
    return (round % 2 === 1) ? PHASES.INTENT : PHASES.RESOLUTION;
  }

  /**
   * Convert the AoV system's raw staged round into a logical combat round.
   *
   * @param {Combat|null|undefined} combat Foundry Combat document.
   * @returns {number}
   */
  static getSystemLogicalRound(combat) {
    const round = Number(combat?.round ?? 0);
    return Math.max(1, Math.ceil(Math.max(round, 1) / 2));
  }

  /**
   * Read actor DEX.
   *
   * @param {Actor|null|undefined} actor Foundry Actor document.
   * @returns {number}
   */
  static getDex(actor) {
    return totalAbility(actor, "dex");
  }

  /**
   * Read actor INT.
   *
   * @param {Actor|null|undefined} actor Foundry Actor document.
   * @returns {number}
   */
  static getInt(actor) {
    return totalAbility(actor, "int");
  }

  /**
   * Read actor movement allowance from derived AoV data with NPC fallbacks.
   *
   * @param {Actor|null|undefined} actor Foundry Actor document.
   * @returns {number}
   */
  static getMov(actor) {
    const system = actor?.system;
    if (!system) return 0;
    if (Number.isFinite(Number(system.moveRate))) return Number(system.moveRate);
    const move = system.move;
    if (move) {
      const base = numberOr(move.base, 0);
      const bonus = numberOr(move.bonus, 0);
      const penalty = numberOr(move.penalty, 0);
      return Math.max(0, base + bonus + penalty);
    }
    const parsed = parseMovementText(system.movement);
    return parsed ?? 0;
  }

  /**
   * Read current actor hit points.
   *
   * @param {Actor|null|undefined} actor Foundry Actor document.
   * @returns {number}
   */
  static getHp(actor) {
    return this.prepareActorHitPoints(actor).value;
  }

  /**
   * Resolve the authoritative AoV Hit Point state from the same embedded
   * document sources used by the system Actor preparation workflow.
   *
   * Character HP is `system.hp.max` minus the damage on all owned Wound Items.
   * NPC HP is `system.hp.max` minus `system.npcDmg` on all owned Hit Location
   * Items. Recomputing here avoids a transient stale `system.hp.value` on the
   * synthetic Token Actor when an embedded damage document has just changed,
   * while remaining identical to the value rendered by the AoV actor sheet.
   *
   * @param {Actor|null|undefined} actor Age of Vikings Actor document.
   * @returns {{value: number, maximum: number, damage: number}}
   */
  static prepareActorHitPoints(actor) {
    const hp = actor?.system?.hp ?? {};
    const maximum = Math.max(0, numberOr(hp.max, 0));
    if (!actor || !["character", "npc"].includes(actor.type)) {
      const value = numberOr(hp.value, maximum);
      return { value, maximum, damage: Math.max(0, maximum - value) };
    }

    const items = Array.from(actor.items ?? []);
    const damage = actor.type === "character"
      ? items
        .filter(item => item.type === "wound")
        .reduce((total, item) => total + Math.max(0, numberOr(item.system?.damage, 0)), 0)
      : items
        .filter(item => item.type === "hitloc")
        .reduce((total, item) => total + Math.max(0, numberOr(item.system?.npcDmg, 0)), 0);

    return {
      value: maximum - damage,
      maximum,
      damage
    };
  }

  /**
   * Resolve the authoritative AoV Magic Point state from the actor's current
   * prepared Rune Script and Seiðr Spell Items.
   *
   * AoV derives `system.mp.availMax` during actor preparation. Item update hooks
   * can fire before consumers see that derived value refreshed, so the hotbar
   * recomputes it through the system Actor class' own cost functions. Exact
   * local fallbacks preserve compatibility with older AoV builds where those
   * static helpers are unavailable.
   *
   * @param {Actor|null|undefined} actor Age of Vikings Actor document.
   * @returns {Promise<{value: number, total: number, available: number, locked: number}>}
   */
  static async prepareActorMagicPoints(actor) {
    const mp = actor?.system?.mp ?? {};
    const total = Math.max(0, numberOr(mp.max, 0));
    let locked = 0;
    const actorClass = actor?.constructor;

    for (const item of Array.from(actor?.items ?? [])) {
      if (!item.system?.prepared) continue;

      if (item.type === "runescript") {
        let cost;
        if (typeof actorClass?.runeMPCost === "function") {
          cost = numberOr((await actorClass.runeMPCost(item))?.cost, 0);
        } else {
          const selectedRunes = Object.values(item.system?.runes ?? {})
            .filter(rune => !["", "none"].includes(String(rune ?? ""))).length;
          cost = selectedRunes * 2;
        }
        locked += Math.max(0, cost);
      } else if (item.type === "seidur") {
        let mpLocked;
        if (typeof actorClass?.seidurMPCost === "function") {
          mpLocked = numberOr((await actorClass.seidurMPCost(item))?.mpLocked, 0);
        } else {
          mpLocked = Math.max(
            numberOr(item.system?.dimension, 0),
            numberOr(item.system?.distance, 0),
            numberOr(item.system?.duration, 0)
          );
        }
        locked += Math.max(0, mpLocked);
      }
    }

    const available = Math.max(0, total - locked);
    return {
      value: Math.max(0, numberOr(mp.value, 0)),
      total,
      available,
      locked
    };
  }

  /**
   * Toggle an owned Rune Script or Seiðr Spell between prepared and unprepared.
   *
   * @param {Actor} actor Owning character Actor.
   * @param {string} itemId Owned Item id.
   * @returns {Promise<Item>}
   */
  /**
   * @param {boolean} prepared Desired prepared state.
   */
  static async setActorMagicPrepared(actor, itemId, prepared) {
    if (!actor?.isOwner) throw new Error("The current user does not own this actor.");
    const item = actor.items?.get(itemId);
    if (!item || !["runescript", "seidur"].includes(item.type)) {
      throw new Error("The selected magic Item cannot be prepared.");
    }
    if (item.system?.prepared !== prepared) await item.update({ "system.prepared": prepared === true });
    return item;
  }

  /**
   * Set an owned Rune Script or SeiГ°r Spell preparation state.
   *
   * @param {Actor} actor Owning character Actor.
   * @param {string} itemId Owned Item id.
   * @returns {Promise<Item>}
   */
  static async toggleActorMagicPrepared(actor, itemId) {
    const item = actor?.items?.get?.(itemId);
    return this.setActorMagicPrepared(actor, itemId, !item?.system?.prepared);
  }

  /**
   * Run an AoV weapon attack or damage check through the same system router
   * used by the core actor sheet.
   *
   * @param {Actor} actor Owning actor.
   * @param {string} weaponId Owned weapon Item id.
   * @param {Event|null} event Originating interaction event.
   * @param {"combat"|"damage"} property AoV check property.
   * @returns {Promise<unknown>}
   */
  static async rollActorWeapon(actor, weaponId, event, property = "combat") {
    if (!actor?.isOwner) throw new Error("The current user does not own this actor.");
    const weapon = actor.items?.get(weaponId);
    if (!weapon || weapon.type !== "weapon") throw new Error("The selected weapon is unavailable.");
    if (!['combat', 'damage'].includes(property)) throw new Error(`Unsupported weapon roll: ${property}`);

    const { AOVCheck, RollType, CardType } = await getAoVCheckApi();
    const modifierEvent = event ?? {};
    const isDamage = property === "damage";
    const actorToken = this.resolveActorTokenDocument(actor, null);
    const existingCombatCard = !isDamage ? findOpenCoreCombatCard() : null;
    const targetToken = Array.from(game.user?.targets ?? [])[0]?.document ?? null;
    const targetActor = targetToken?.actor ?? null;
    const proneRules = !isDamage && !existingCombatCard
      ? proneAttackModifierContext({ attackerActor: actor, attackerToken: actorToken, targetActor, targetToken })
      : null;
    const proneDamageRules = !isDamage && !existingCombatCard
      ? proneDamageContext({ attackerActor: actor, attackerToken: actorToken, targetActor, targetToken, weapon })
      : null;

    const messageId = await AOVCheck._trigger({
      rollType: isDamage ? RollType.DAMAGE : RollType.WEAPON,
      cardType: isDamage ? CardType.UNOPPOSED : CardType.COMBAT,
      shiftKey: Boolean(modifierEvent.shiftKey),
      actor,
      token: actorToken ?? actor.token ?? null,
      characteristic: false,
      skillId: weapon.id,
      itemId: weapon.id,
      flatMod: numberOr(proneRules?.total, 0),
      origID: game.user?.id ?? game.user?._id
    });

    if (!isDamage && !existingCombatCard && messageId) {
      await this.#attachProneAttackModifierFlag(messageId, {
        actorUuid: actor?.uuid ?? null,
        sourceTokenUuid: actorToken?.uuid ?? null,
        weaponUuid: weapon?.uuid ?? null,
        targetActorUuid: targetActor?.uuid ?? null,
        targetTokenUuid: targetToken?.uuid ?? null,
        proneRules: serializeProneAttackModifierContext(proneRules),
        proneDamageRules: serializeProneDamageContext(proneDamageRules)
      }, { actor, sourceToken: actorToken, weapon, targetActor, targetToken });
    }

    return messageId;
  }

  static #actorSkillByIdOrCid(actor, skillIdOrCid) {
    const requested = String(skillIdOrCid ?? "").trim();
    if (!requested) return null;
    const direct = actor?.items?.get?.(requested);
    if (direct?.type === "skill") return direct;
    const normalized = requested
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase();
    return collectionArray(actor?.items).find(item => {
      if (item?.type !== "skill") return false;
      const cid = String(item.flags?.aov?.cidFlag?.id ?? "").toLowerCase();
      const name = String(item.name ?? "")
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase();
      return cid === normalized || name === normalized;
    }) ?? null;
  }

  static #cardTypeValue(CardType, cardType) {
    switch (String(cardType ?? "").toLowerCase()) {
      case "combat": return CardType.COMBAT;
      case "opposed": return CardType.OPPOSED;
      case "resistance": return CardType.RESISTANCE;
      case "fixed": return CardType.FIXED;
      case "augment": return CardType.AUGMENT;
      case "unopposed":
      default: return CardType.UNOPPOSED;
    }
  }

  static #rollResult(messageId) {
    const message = game.messages?.get?.(String(messageId ?? "")) ?? null;
    const flags = message?.flags?.aov ?? {};
    const cards = Array.isArray(flags.chatCard) ? flags.chatCard : [];
    const primary = cards[0] ?? {};
    const resultLevel = Number(primary.resultLevel ?? flags.resultLevel);
    const successLevel = Number(primary.successLevel ?? flags.successLevel);
    return {
      messageId: message?.id ?? (messageId ? String(messageId) : null),
      resultLevel: Number.isFinite(resultLevel) ? resultLevel : null,
      successLevel: Number.isFinite(successLevel) ? successLevel : null,
      message
    };
  }

  /**
   * Run an AoV skill check through the core system router.
   *
   * @param {Actor} actor Owning actor.
   * @param {string} skillIdOrCid Owned skill id or AoV CID.
   * @param {Event|null} event Originating interaction event.
   * @param {{cardType?: string, flatMod?: number, shiftKey?: boolean}} [options={}] Roll options.
   * @returns {Promise<{messageId: string|null, resultLevel: number|null, successLevel: number|null, message: ChatMessage|null}>}
   */
  static async rollActorSkill(actor, skillIdOrCid, event = null, options = {}) {
    if (!actor?.isOwner && !game.user?.isGM) throw new Error("The current user does not own this actor.");
    const skill = this.#actorSkillByIdOrCid(actor, skillIdOrCid);
    if (!skill) throw new Error("The selected skill is unavailable.");

    const { AOVCheck, RollType, CardType } = await getAoVCheckApi();
    const messageId = await AOVCheck._trigger({
      rollType: RollType.SKILL,
      cardType: this.#cardTypeValue(CardType, options.cardType),
      shiftKey: options.shiftKey ?? Boolean(event?.shiftKey),
      actor,
      token: this.resolveActorTokenDocument(actor, null),
      characteristic: false,
      skillId: skill.id,
      itemId: skill.id,
      flatMod: numberOr(options.flatMod, 0),
      origID: game.user?.id ?? game.user?._id
    });
    return this.#rollResult(messageId);
  }

  /**
   * Run an AoV characteristic check through the core system router.
   *
   * @param {Actor} actor Owning actor.
   * @param {string} characteristic AoV ability key.
   * @param {Event|null} event Originating interaction event.
   * @param {{cardType?: string, flatMod?: number, shiftKey?: boolean}} [options={}] Roll options.
   * @returns {Promise<{messageId: string|null, resultLevel: number|null, successLevel: number|null, message: ChatMessage|null}>}
   */
  static async rollActorCharacteristic(actor, characteristic, event = null, options = {}) {
    if (!actor?.isOwner && !game.user?.isGM) throw new Error("The current user does not own this actor.");
    const ability = String(characteristic ?? "").trim().toLowerCase();
    if (!actor?.system?.abilities?.[ability]) throw new Error("The selected characteristic is unavailable.");

    const { AOVCheck, RollType, CardType } = await getAoVCheckApi();
    const messageId = await AOVCheck._trigger({
      rollType: RollType.CHARACTERISTIC,
      cardType: this.#cardTypeValue(CardType, options.cardType),
      shiftKey: options.shiftKey ?? Boolean(event?.shiftKey),
      actor,
      token: this.resolveActorTokenDocument(actor, null),
      characteristic: ability,
      skillId: false,
      itemId: false,
      flatMod: numberOr(options.flatMod, 0),
      origID: game.user?.id ?? game.user?._id
    });
    return this.#rollResult(messageId);
  }


  /**
   * Resolve the best TokenDocument to pass into the core AoV check workflow.
   * Passing the token document is important for unlinked combatants because the
   * AoV system distinguishes token participants from base Actor participants.
   *
   * @param {Actor|null|undefined} actor Actor represented by the token.
   * @param {Token|TokenDocument|null|undefined} [preferredToken=null] Token already selected by the HUD workflow.
   * @returns {TokenDocument|null}
   */
  static resolveActorTokenDocument(actor, preferredToken = null) {
    const preferredDocument = preferredToken?.document ?? preferredToken ?? null;
    if (preferredDocument?.uuid && preferredDocument?.actor) return preferredDocument;
    if (actor?.token?.uuid) return actor.token;

    const controlled = canvas?.tokens?.controlled?.find(token => token?.actor === actor || token?.actor?.id === actor?.id) ?? null;
    if (controlled?.document?.uuid) return controlled.document;

    const activeTokens = actor?.getActiveTokens?.(true, true) ?? actor?.getActiveTokens?.() ?? [];
    const active = activeTokens.find(token => token?.document?.uuid) ?? activeTokens[0] ?? null;
    return active?.document ?? null;
  }

  /**
   * Select the user who should receive the defender's core AoV roll dialog.
   * Active non-GM owners of the exact token/actor are preferred; if no such
   * player is active, the active GM handles the dialog as the fallback.
   *
   * @param {Actor|null|undefined} actor Defender Actor.
   * @param {TokenDocument|null|undefined} [token=null] Defender TokenDocument.
   * @returns {User|null}
   */
  static getDefensePromptUser(actor, token = null) {
    return defensePromptUser(actor, token);
  }

  /**
   * Test whether the current user may locally prompt a defense roll for the
   * supplied participant.
   *
   * @param {Actor|null|undefined} actor Defender Actor.
   * @param {TokenDocument|null|undefined} [token=null] Defender TokenDocument.
   * @returns {boolean}
   */
  static currentUserCanDefend(actor, token = null) {
    if (game.user?.isGM) return true;
    return userOwnsParticipant(game.user, actor, token);
  }

  static userCanDefend(user, actor, token = null) {
    if (user?.isGM) return true;
    return userOwnsParticipant(user, actor, token);
  }

  /**
   * Resolve participant documents from a socket-safe defense workflow payload.
   * Token UUID is authoritative for unlinked actors; actor UUID is only a
   * fallback when a token was not available.
   *
   * @param {object} payload Defense workflow payload.
   * @returns {Promise<{actor: Actor|null, token: TokenDocument|null}>}
   */
  static async resolveDefenseParticipant(payload = {}) {
    const suppliedToken = payload.targetToken?.document ?? payload.targetToken ?? payload.token?.document ?? payload.token ?? null;
    let token = suppliedToken?.uuid && suppliedToken?.actor ? suppliedToken : null;
    if (!token) {
      const resolvedToken = await resolveUuid(payload.tokenUuid ?? payload.targetTokenUuid);
      token = resolvedToken?.actor ? resolvedToken : null;
    }

    const suppliedActor = payload.targetActor ?? payload.actor ?? null;
    let actor = suppliedActor ?? token?.actor ?? null;
    if (!actor) {
      const resolvedActor = await resolveUuid(payload.actorUuid ?? payload.targetActorUuid);
      actor = resolvedActor?.items ? resolvedActor : null;
    }

    if (!token && actor) token = this.resolveActorTokenDocument(actor, null);
    return { actor, token };
  }

  /**
   * Build a socket-safe defender prompt payload. Do not serialize Foundry
   * Documents across the socket; use UUIDs and re-resolve locally on the target
   * user's client.
   *
   * @param {{targetActor: Actor, targetToken: TokenDocument|null, attackMessageId: string|null, incomingWeaponType?: string}} request Request data.
   * @returns {object}
   */
  static buildDefenseWorkflowPayload(request) {
    const token = request.targetToken?.document ?? request.targetToken ?? null;
    const actor = request.targetActor ?? token?.actor ?? null;
    return {
      attackMessageId: request.attackMessageId ?? null,
      tokenUuid: token?.uuid ?? "",
      actorUuid: token?.actor?.uuid ?? actor?.uuid ?? "",
      incomingWeaponType: String(request.incomingWeaponType ?? "").slice(0, 80)
    };
  }

  /**
   * Find the defender's preferred parrying weapon for the core AoV combat card.
   *
   * @param {Actor|null|undefined} actor Defender Actor.
   * @returns {Item|null}
   */
  static getDefenseWeapon(actor) {
    if (!actor?.items) return null;
    const readiedId = String(actor.getFlag?.(MODULE_ID, "readiedWeaponId") ?? "");
    const readied = readiedId ? actor.items.get(readiedId) : null;
    if (readied?.type === "weapon") return readied;

    const weapons = collectionArray(actor.items).filter(item => item?.type === "weapon");
    return weapons.find(item => isCarriedWeapon(item))
      ?? weapons.find(item => isNaturalWeapon(item))
      ?? weapons[0]
      ?? null;
  }

  /**
   * Find the AoV Dodge skill on an actor for an unarmed defensive fallback.
   *
   * @param {Actor|null|undefined} actor Defender Actor.
   * @returns {Item|null}
   */
  static getDodgeSkill(actor) {
    const skills = collectionArray(actor?.items).filter(item => item?.type === "skill");
    return skills.find(item => item.flags?.aov?.cidFlag?.id === "i.skill.dodge")
      ?? skills.find(item => String(item.name ?? "").trim().toLowerCase() === "dodge")
      ?? null;
  }

  static #participantCardData(actor, token = null) {
    const participant = this.#aovParticipantReference(actor, token);
    return {
      particId: participant.id ?? "",
      particType: participant.type ?? "actor",
      particName: token?.name ?? actor?.name ?? "",
      particImg: actorImage(actor, token),
      actorType: actor?.type ?? ""
    };
  }

  static #combatCardEntry({
    actor,
    token = null,
    item,
    label = null,
    rollType = "WP",
    targetScore,
    rawScore,
    flatMod = 0,
    encPenalty = 0,
    combatAction = "attack",
    targetId = "",
    targetType = "",
    targetWpnId = ""
  }) {
    const { critChance, fumbleChance } = item?.type === "weapon"
      ? getWeaponCritFumbleChances(actor, item)
      : getItemCritFumbleChances(item);
    return {
      rollType,
      ...this.#participantCardData(actor, token),
      targetId,
      targetType,
      targetLoc: "",
      targetWpnId,
      characteristic: false,
      label: label ?? itemName(item),
      critChance,
      fumbleChance,
      targetScore: numberOr(targetScore, 0),
      rawScore: numberOr(rawScore, 0),
      difficulty: "simple",
      diffLabel: game.i18n.localize("AOV.rolls.simple"),
      rollFormula: "1D100",
      flatMod: numberOr(flatMod, 0),
      encPenalty: numberOr(encPenalty, 0),
      mqPenalty: 0,
      targetAdj: 0,
      rollResult: undefined,
      rollVal: undefined,
      roll: undefined,
      weaponAbsorb: 0,
      armourAbsorb: 0,
      oppRes: 0,
      damTypeLabel: "",
      damBonus: 0,
      successLevel: "99",
      successLevelLabel: "",
      augAdj: 0,
      diceRolled: "",
      skillId: item?.id ?? false,
      combatAction,
      combatActionLabel: game.i18n.localize(`AOV.Combat.action.${combatAction}`),
      wpnBlock: false,
      wpnDam: 1,
      armourBlock: false,
      damageCF: false,
      resultLevel: 0,
      resultLabel: "",
      userID: game.user?.id ?? "",
      origID: game.user?.id ?? ""
    };
  }

  static __testCombatCardEntry(options = {}) {
    return this.#combatCardEntry(options);
  }

  static __testAttackFlatModifier(payload = {}, weapon = null) {
    return this.#attackFlatModifier(payload, weapon);
  }

  static async #aovSelectList(name, ...args) {
    const { AOVSelectLists } = await getAoVRollOptionsApi();
    const fn = AOVSelectLists?.[name];
    return typeof fn === "function" ? (await fn.call(AOVSelectLists, ...args)) : {};
  }

  static #coreActionOptions(source, actionOptions = null) {
    const options = actionOptions && typeof actionOptions === "object" ? actionOptions : {};
    if (Object.keys(options).length) return options;
    return source === "defense" ? { none: game.i18n.localize("AOV.Combat.action.none") } : { attack: game.i18n.localize("AOV.Combat.action.attack") };
  }

  static #timeoutActionOption(source, options, defaultAction) {
    if (source === "defense" && Object.hasOwn(options, "none")) return "none";
    if (source === "attack" && Object.hasOwn(options, "attack")) return "attack";
    return defaultAction;
  }

  static async #promptCoreRollOptions({
    source,
    actionOptions,
    combatAction = "",
    flatMod = 0,
    label = ""
  }) {
    const { AOVDialog } = await getAoVRollOptionsApi();
    const options = this.#coreActionOptions(source, actionOptions);
    const defaultAction = Object.hasOwn(options, combatAction)
      ? combatAction
      : (Object.keys(options)[0] ?? "");
    const data = {
      cardType: "CO",
      cardLabel: game.i18n.localize("AOV.card.CO"),
      label,
      rollType: "WP",
      flatMod: numberOr(flatMod, 0),
      damBonus: 0,
      damType: "",
      dmgLevels: await this.#aovSelectList("dmgLevels"),
      askFixed: false,
      askDiff: false,
      askSuccess: false,
      askDamType: false,
      askDamBonus: false,
      askBonus: true,
      askDodge: false,
      askAction: true,
      actionOptions: options,
      combatAction: defaultAction,
      diffOptions: await this.#aovSelectList("difficultyOptions"),
      ctOptions: await this.#aovSelectList("cutThrust"),
      successLevel: "99"
    };
    const html = await foundry.applications.handlebars.renderTemplate(AOV_TEMPLATES.ROLL_OPTIONS, data);
    let promptTimedOut = false;
    const prompt = AOVDialog.input({
      window: { title: game.i18n.localize("AOV.card.rollMods") },
      content: html,
      ok: { label: game.i18n.localize("AOV.rollDice") }
    }).then(result => ({ type: "input", result })).catch(error => ({ type: "error", error }));
    const timeout = new Promise(resolve => {
      globalThis.setTimeout(() => resolve({ type: "timeout", result: null }), CORE_ROLL_PROMPT_TIMEOUT_MS);
    });
    const promptResult = await Promise.race([prompt, timeout]);
    if (promptResult.type === "error") throw promptResult.error;
    if (promptResult.type === "timeout") promptTimedOut = true;
    const result = promptResult.result;
    if (promptTimedOut) {
      const actionOption = this.#timeoutActionOption(source, options, defaultAction);
      return {
        cancelled: false,
        actionOption,
        checkBonus: 0,
        raw: null,
        timedOut: true
      };
    }
    if (!result) {
      return {
        cancelled: true,
        actionOption: defaultAction,
        checkBonus: numberOr(flatMod, 0),
        raw: null
      };
    }
    const actionOption = Object.hasOwn(options, String(result.actionOption ?? ""))
      ? String(result.actionOption)
      : defaultAction;
    return {
      cancelled: false,
      actionOption,
      checkBonus: numberOr(result.checkBonus, 0),
      raw: result
    };
  }

  static async #attackActionOptions() {
    return this.#aovSelectList("attackOptions");
  }

  static async #defenseActionOptions(actor, { incomingWeaponType = "" } = {}) {
    const options = { ...(await this.#aovSelectList("defendOptions", incomingWeaponType)) };
    if (!this.getDefenseWeapon(actor)) delete options.parry;
    if (!this.getDodgeSkill(actor)) delete options.dodge;
    if (!Object.hasOwn(options, "none")) options.none = game.i18n.localize("AOV.Combat.action.none");
    return options;
  }

  static #nativeAimedModifier(action, payload) {
    if (payload.aimedBlow?.enabled === true) return 0;
    if (action === "aimedLimb") return -20;
    if (action === "aimedTorso") return -40;
    return 0;
  }

  static #attackCombatAction(payload) {
    if (payload.aimedBlow?.enabled === true) return "attack";
    const action = String(payload.coreOptions?.actionOption ?? payload.combatAction ?? "attack");
    return ["aimedLimb", "aimedTorso", "attack"].includes(action) ? action : "attack";
  }

  static async #withCoreAttackOptions(payload = {}) {
    const coreOptions = await this.#promptCoreRollOptions({
      source: "attack",
      actionOptions: await this.#attackActionOptions(),
      combatAction: this.#attackCombatAction(payload),
      flatMod: 0,
      label: itemName(payload.weapon)
    });
    if (coreOptions.cancelled) return null;
    const combatAction = payload.aimedBlow?.enabled === true ? "attack" : coreOptions.actionOption;
    return {
      ...payload,
      coreOptions,
      coreDialogSource: "attack",
      combatAction
    };
  }

  static async #renderCombatMessage(aovFlags) {
    return foundry.applications.handlebars.renderTemplate(
      aovFlags.chatTemplate ?? AOV_TEMPLATES.ROLL_COMBAT,
      aovFlags
    );
  }

  static async #createCombatMessage({ actor, chatCard, batchId = "", batchIndex = 0, batchSize = 1 }) {
    const aovFlags = {
      rollType: "WP",
      cardType: "CO",
      chatTemplate: AOV_TEMPLATES.ROLL_COMBAT,
      state: "open",
      wait: true,
      resultLevel: 0,
      rollResult: undefined,
      successLevelLabel: "",
      successLevelLabelVisible: false,
      initiator: chatCard.particId,
      initiatorType: chatCard.particType,
      chatCard: [chatCard]
    };
    const content = await this.#renderCombatMessage(aovFlags);
    const message = await createModuleChatMessage({
      user: game.user.id,
      style: CONST.CHAT_MESSAGE_STYLES.OTHER,
      content,
      speaker: {
        actor: actor?.id ?? null,
        alias: game.i18n.localize("AOV.card.CO")
      },
      flags: {
        aov: aovFlags,
        [MODULE_ID]: {
          combatCardBatch: {
            batchId,
            batchIndex,
            batchSize,
            createdAt: Date.now()
          }
        }
      }
    }, { applyDefaultMode: false });
    return message ?? null;
  }

  static async #appendDefenseCard(messageId, card, { requestId = "" } = {}) {
    return queuedDefenseCardAppend(messageId, async () => {
      pruneDefenseCommitResults();
      const commitKey = defenseCommitResultKey(messageId, requestId);
      const cached = commitKey ? defenseCommitResults.get(commitKey) : null;
      if (cached?.result) return { ...cached.result, duplicate: true };

      const message = game.messages?.get?.(String(messageId ?? "")) ?? null;
      if (!message?.update) return null;
      const aovFlags = foundry.utils.deepClone(message.flags?.aov ?? {});
      const chatCards = Array.isArray(aovFlags.chatCard) ? aovFlags.chatCard : [];
      if (String(aovFlags.cardType ?? "") !== "CO" || String(aovFlags.state ?? "") === "closed") return null;
      if (chatCards.length >= 2) {
        const result = {
          accepted: false,
          messageId: message.id,
          alreadyDefended: true,
          alreadyResolved: true,
          reason: "already-resolved"
        };
        if (commitKey) defenseCommitResults.set(commitKey, { result, storedAt: Date.now() });
        return result;
      }
      const nextFlags = {
        ...aovFlags,
        chatCard: [...chatCards, card]
      };
      const content = await this.#renderCombatMessage(nextFlags);
      await guardedUpdate(message, {
        content,
        "flags.aov.chatCard": nextFlags.chatCard
      }, { category: "chat.defenseCardAppend" });
      const result = {
        accepted: true,
        messageId: message.id,
        alreadyDefended: false,
        alreadyResolved: false
      };
      if (commitKey) defenseCommitResults.set(commitKey, { result, storedAt: Date.now() });
      return result;
    });
  }

  static #attackFlatModifier(payload, weapon) {
    const combatAction = this.#attackCombatAction(payload);
    const aimedModifier = payload.aimedBlow?.enabled ? numberOr(payload.aimedBlow?.penalty, 0) : 0;
    const disarmModifier = payload.disarm?.enabled ? numberOr(payload.disarm?.penalty, 0) : 0;
    const stunModifier = payload.stun?.enabled ? numberOr(payload.stun?.penalty, 0) : 0;
    const coreModifier = numberOr(payload.coreOptions?.checkBonus, 0) + this.#nativeAimedModifier(combatAction, payload);
    const isMissileWorkflow = String(payload.workflowType ?? "") === "missile";
    if (isMissileWorkflow && Number.isFinite(Number(payload.targetNumber))) {
      return numberOr(payload.targetNumber, 0) - numberOr(payload.baseChance ?? weapon?.system?.total, 0) + coreModifier;
    }
    return numberOr(payload.situationalModifier, 0)
      + aimedModifier
      + disarmModifier
      + stunModifier
      + numberOr(payload.augmentModifier, 0)
      + numberOr(payload.proneModifier, 0)
      + coreModifier;
  }

  static async #createDialogCombatAttack(payload = {}, { batchId = "", batchIndex = 0, batchSize = 1 } = {}) {
    const actor = payload.actor ?? null;
    const weapon = payload.weapon ?? null;
    if (!actor || !weapon) throw new Error("The attack workflow is missing an actor or weapon.");
    const sourceToken = this.resolveActorTokenDocument(actor, payload.sourceToken ?? payload.token ?? null);
    const targetActor = payload.targetActor ?? payload.targetToken?.actor ?? null;
    const targetToken = this.resolveActorTokenDocument(targetActor, payload.targetToken ?? null);
    const flatMod = this.#attackFlatModifier(payload, weapon);
    const encPenalty = numberOr(actor?.system?.encPenalty, 0);
    const baseChance = numberOr(payload.baseChance ?? weapon?.system?.total, 0);
    const targetNumber = baseChance + flatMod;
    const card = this.#combatCardEntry({
      actor,
      token: sourceToken,
      item: weapon,
      rollType: "WP",
      rawScore: baseChance,
      targetScore: targetNumber + encPenalty,
      flatMod,
      encPenalty,
      combatAction: this.#attackCombatAction(payload)
    });
    const message = await this.#createCombatMessage({ actor, chatCard: card, batchId, batchIndex, batchSize });
    const attackMessageId = message?.id ?? null;
    if (!attackMessageId) return null;
    await this.#attachAimedBlowFlag(attackMessageId, payload, { actor, sourceToken, weapon, targetActor, targetToken });
    await this.#attachDisarmFlag(attackMessageId, payload, { actor, sourceToken, weapon, targetActor, targetToken });
    await this.#attachStunFlag(attackMessageId, payload, { actor, sourceToken, weapon, targetActor, targetToken });
    await this.#attachMissileFlags(attackMessageId, payload, { actor, sourceToken, weapon, targetActor, targetToken });
    await this.#attachDamageEffectSourceFlag(attackMessageId, payload, { actor, sourceToken, weapon, targetActor, targetToken });
    await this.#attachProneAttackModifierFlag(attackMessageId, payload, { actor, sourceToken, weapon, targetActor, targetToken });
    return { actor, weapon, sourceToken, targetActor, targetToken, attackMessageId };
  }

  static #actorFromCombatCard(card) {
    const type = String(card?.particType ?? "");
    const id = String(card?.particId ?? "");
    if (!id) return null;
    if (type === "actor") return game.actors?.get?.(id) ?? null;
    if (type === "token") {
      return game.actors?.tokens?.[id]
        ?? canvas?.tokens?.placeables?.find?.(token => token?.document?.id === id)?.actor
        ?? canvas?.scene?.tokens?.get?.(id)?.actor
        ?? null;
    }
    return null;
  }

  static #incomingWeaponType(message) {
    const card = message?.getFlag?.("aov", "chatCard")?.[0] ?? null;
    const actor = this.#actorFromCombatCard(card);
    const item = actor?.items?.get?.(String(card?.skillId ?? "")) ?? null;
    return String(item?.system?.weaponType ?? "");
  }

  static async #appendNoDefenseCard({ attackMessageId, actor, token, coreOptions, requestId = "" }) {
    const card = this.#combatCardEntry({
      actor,
      token,
      item: null,
      label: game.i18n.localize("AOV.Combat.action.none"),
      rollType: "SK",
      rawScore: 0,
      targetScore: 0,
      flatMod: 0,
      encPenalty: 0,
      combatAction: "none"
    });
    const update = await this.#appendDefenseCard(attackMessageId, card, { requestId });
    if (!update) throw new Error(game.i18n.localize("AOV_SKJALDBORG.Warnings.DefenseCombatCardUnavailable"));
    if (update.alreadyResolved) {
      ui.notifications.warn(game.i18n.localize("AOV_SKJALDBORG.Warnings.DefenseAlreadyResolved"));
      return {
        accepted: false,
        alreadyResolved: true,
        reason: "already-resolved",
        defenseMode: "none",
        defenseMessageId: update.messageId ?? attackMessageId ?? null,
        coreOptions,
        combatAction: "none",
        coreDialogSource: "defense",
        cancelled: false
      };
    }
    return {
      accepted: true,
      defenseMode: "none",
      defenseMessageId: update.messageId ?? attackMessageId ?? null,
      coreOptions,
      combatAction: "none",
      coreDialogSource: "defense",
      cancelled: false
    };
  }

  static async #addDefenseToAttackMessage({ attackMessageId, actor, token, item, mode, coreOptions, requestId = "" }) {
    const isDodge = mode === "dodge";
    const rawScore = isDodge ? skillTotal(actor, item) : numberOr(item?.system?.total, 0);
    const encPenalty = isDodge ? skillEncPenalty(actor, item) : numberOr(actor?.system?.encPenalty, 0);
    const parryBonus = isDodge ? 0 : numberOr(actor?.system?.parryBonus, 0);
    const flatMod = numberOr(coreOptions?.checkBonus, 0) + parryBonus;
    const card = this.#combatCardEntry({
      actor,
      token,
      item,
      rollType: isDodge ? "SK" : "WP",
      rawScore,
      targetScore: rawScore + flatMod + encPenalty,
      flatMod,
      encPenalty,
      combatAction: mode
    });
    const update = await this.#appendDefenseCard(attackMessageId, card, { requestId });
    if (!update) throw new Error(game.i18n.localize("AOV_SKJALDBORG.Warnings.DefenseCombatCardUnavailable"));
    if (update.alreadyResolved) {
      ui.notifications.warn(game.i18n.localize("AOV_SKJALDBORG.Warnings.DefenseAlreadyResolved"));
      return {
        accepted: false,
        alreadyResolved: true,
        reason: "already-resolved",
        defenseMode: isDodge ? "dodge" : "weapon",
        defenseMessageId: update.messageId ?? attackMessageId ?? null,
        coreOptions,
        combatAction: mode,
        coreDialogSource: "defense",
        cancelled: false
      };
    }
    return {
      accepted: true,
      defenseMode: isDodge ? "dodge" : "weapon",
      defenseMessageId: update?.messageId ?? attackMessageId ?? null,
      coreOptions,
      combatAction: mode,
      coreDialogSource: "defense",
      cancelled: false
    };
  }

  static #defenseCommitPayload({ attackMessageId, actor, token, actionOption, coreOptions, item = null }) {
    const tokenDocument = token?.document ?? token ?? null;
    return {
      attackMessageId: String(attackMessageId ?? "") || null,
      tokenUuid: tokenDocument?.uuid ?? "",
      actorUuid: tokenDocument?.actor?.uuid ?? actor?.uuid ?? "",
      actionOption: ["parry", "dodge", "none"].includes(String(actionOption ?? "")) ? String(actionOption) : "none",
      checkBonus: numberOr(coreOptions?.checkBonus, 0),
      itemId: item?.id ?? null
    };
  }

  static async #commitDefenseChoice({ attackMessageId, actor, token, actionOption, checkBonus = 0, itemId = null, requestId = "" }) {
    const coreOptions = {
      cancelled: false,
      actionOption: ["parry", "dodge", "none"].includes(String(actionOption ?? "")) ? String(actionOption) : "none",
      checkBonus: numberOr(checkBonus, 0),
      raw: null
    };

    if (coreOptions.actionOption === "none") {
      return this.#appendNoDefenseCard({
        attackMessageId,
        actor,
        token,
        coreOptions,
        requestId
      });
    }

    if (coreOptions.actionOption === "dodge") {
      const dodgeSkill = this.getDodgeSkill(actor);
      if (dodgeSkill && (!itemId || String(dodgeSkill.id) === String(itemId))) {
        return this.#addDefenseToAttackMessage({
          attackMessageId,
          actor,
          token,
          item: dodgeSkill,
          mode: "dodge",
          coreOptions,
          requestId
        });
      }
    }

    if (coreOptions.actionOption === "parry") {
      const defenseWeapon = this.getDefenseWeapon(actor);
      if (defenseWeapon && (!itemId || String(defenseWeapon.id) === String(itemId))) {
        return this.#addDefenseToAttackMessage({
          attackMessageId,
          actor,
          token,
          item: defenseWeapon,
          mode: "parry",
          coreOptions,
          requestId
        });
      }
    }

    ui.notifications.warn(game.i18n.format("AOV_SKJALDBORG.Warnings.NoDefenderDefense", {
      actor: actor?.name ?? game.i18n.localize("AOV_SKJALDBORG.Labels.Unknown")
    }));
    return this.#appendNoDefenseCard({
      attackMessageId,
      actor,
      token,
      coreOptions: {
        ...coreOptions,
        actionOption: "none"
      },
      requestId
    });
  }

  static async commitDefenseCard(payload = {}, options = {}) {
    const { actor, token } = await this.resolveDefenseParticipant(payload);
    if (!actor) throw new Error(game.i18n.localize("AOV_SKJALDBORG.Warnings.DefenseActorUnavailable"));
    const user = options.user ?? game.user;
    if (!this.userCanDefend(user, actor, token)) {
      throw new Error(game.i18n.localize("AOV_SKJALDBORG.Warnings.DefenseActorNotOwned"));
    }

    const combatCard = await waitForOpenCoreCombatCard(payload.attackMessageId);
    if (!combatCard) {
      throw new Error(game.i18n.localize("AOV_SKJALDBORG.Warnings.DefenseCombatCardUnavailable"));
    }

    return this.#commitDefenseChoice({
      attackMessageId: combatCard.id,
      actor,
      token,
      actionOption: payload.actionOption,
      checkBonus: payload.checkBonus,
      itemId: payload.itemId,
      requestId: options.requestId
    });
  }

  /**
   * Start the core AoV opposed combat workflow from a Skjaldborg Attack or
   * Missile dialog payload. The attacker's core dialog runs on the initiating
   * client. The defender's core dialog is then routed to the active owning
   * player for the defender token/actor, falling back to the active GM when no
   * active player owner exists.
   *
   * @param {object} payload AttackRollDialog or MissileRollDialog submit payload.
   * @param {{promptDefender?: Function}} [options={}] Optional remote prompt callback.
   * @returns {Promise<{started: boolean, attackMessageId: string|null, defenseMode: string|null, defenseMessageId: string|null, defenseUserId?: string|null, defenseRouted?: boolean, cardCreated?: boolean}>}
   */
  static async rollDialogCombatWorkflow(payload = {}, options = {}) {
    const batchId = String(payload.batchId ?? "") || randomBatchId();
    const promptedPayload = await this.#withCoreAttackOptions(payload);
    if (!promptedPayload) {
      return {
        started: false,
        attackMessageId: null,
        defenseMode: null,
        defenseMessageId: null,
        coreOptions: { cancelled: true },
        coreDialogSource: "attack",
        cardCreated: false
      };
    }
    const created = await this.#createDialogCombatAttack(promptedPayload, {
      batchId,
      batchIndex: numberOr(promptedPayload.batchIndex, 0),
      batchSize: numberOr(promptedPayload.batchSize, 1)
    });
    if (!created) {
      return {
        started: false,
        attackMessageId: null,
        defenseMode: null,
        defenseMessageId: null,
        coreOptions: promptedPayload.coreOptions,
        combatAction: promptedPayload.combatAction,
        coreDialogSource: "attack",
        cardCreated: false
      };
    }
    const { targetActor, targetToken, attackMessageId, weapon } = created;

    if (!targetActor) {
      return {
        started: true,
        attackMessageId,
        defenseMode: null,
        defenseMessageId: null,
        coreOptions: promptedPayload.coreOptions,
        combatAction: promptedPayload.combatAction,
        coreDialogSource: "attack",
        cardCreated: true
      };
    }

    const defenseUser = this.getDefensePromptUser(targetActor, targetToken);
    if (!defenseUser) {
      ui.notifications.warn(game.i18n.localize("AOV_SKJALDBORG.Warnings.NoDefensePromptUser"));
      return { started: true, attackMessageId, defenseMode: null, defenseMessageId: null, defenseUserId: null, coreOptions: promptedPayload.coreOptions, combatAction: promptedPayload.combatAction, coreDialogSource: "attack", cardCreated: true };
    }

    const defensePayload = this.buildDefenseWorkflowPayload({
      targetActor,
      targetToken,
      attackMessageId,
      incomingWeaponType: weapon?.system?.weaponType
    });
    if (defenseUser.id !== game.user?.id) {
      if (typeof options.promptDefender !== "function") {
        ui.notifications.warn(game.i18n.localize("AOV_SKJALDBORG.Warnings.NoDefensePromptRoute"));
        return { started: true, attackMessageId, defenseMode: null, defenseMessageId: null, defenseUserId: defenseUser.id, coreOptions: promptedPayload.coreOptions, combatAction: promptedPayload.combatAction, coreDialogSource: "attack", cardCreated: true };
      }
      const defenseResult = await options.promptDefender(defenseUser, defensePayload);
      return {
        started: true,
        attackMessageId,
        defenseMode: defenseResult?.defenseMode ?? null,
        defenseMessageId: defenseResult?.defenseMessageId ?? null,
        defenseUserId: defenseUser.id,
        coreOptions: promptedPayload.coreOptions,
        combatAction: promptedPayload.combatAction,
        coreDialogSource: "attack",
        defenseCoreOptions: defenseResult?.coreOptions ?? null,
        defenseCombatAction: defenseResult?.combatAction ?? null,
        defenseAccepted: defenseResult?.accepted !== false,
        alreadyResolved: defenseResult?.alreadyResolved === true,
        defenseRouted: true,
        cardCreated: true
      };
    }

    const defenseResult = await this.rollDialogDefenseWorkflow({
      ...defensePayload,
      targetActor,
      targetToken
    });
    return {
      started: true,
      attackMessageId,
      defenseMode: defenseResult?.defenseMode ?? null,
      defenseMessageId: defenseResult?.defenseMessageId ?? null,
      defenseUserId: defenseUser.id,
      coreOptions: promptedPayload.coreOptions,
      combatAction: promptedPayload.combatAction,
      coreDialogSource: "attack",
      defenseCoreOptions: defenseResult?.coreOptions ?? null,
      defenseCombatAction: defenseResult?.combatAction ?? null,
      defenseAccepted: defenseResult?.accepted !== false,
      alreadyResolved: defenseResult?.alreadyResolved === true,
      defenseRouted: false,
      cardCreated: true
    };
  }

  static async rollDialogCombatWorkflowBatch(payloads = [], options = {}) {
    const entries = Array.isArray(payloads) ? payloads.filter(Boolean) : [];
    if (!entries.length) return [];
    const batchId = randomBatchId();
    const promptedPayloads = [];
    for (const entry of entries) {
      const prompted = await this.#withCoreAttackOptions(entry);
      if (!prompted) {
        return entries.map(() => ({
          started: false,
          attackMessageId: null,
          defenseMessageId: null,
          defenseUserId: null,
          defenseRouted: false,
          coreOptions: { cancelled: true },
          coreDialogSource: "attack",
          cardCreated: false
        }));
      }
      promptedPayloads.push(prompted);
    }
    if (typeof options.beforeCreate === "function") {
      const beforeCreateResult = await options.beforeCreate(promptedPayloads);
      if (beforeCreateResult === false) {
        return entries.map(() => ({
          started: false,
          attackMessageId: null,
          defenseMessageId: null,
          defenseUserId: null,
          defenseRouted: false,
          coreOptions: { cancelled: true },
          coreDialogSource: "attack",
          cardCreated: false
        }));
      }
    }
    const created = [];
    for (let index = 0; index < promptedPayloads.length; index += 1) {
      const payload = {
        ...promptedPayloads[index],
        batchId,
        batchIndex: index,
        batchSize: promptedPayloads.length
      };
      const attack = await this.#createDialogCombatAttack(payload, {
        batchId,
        batchIndex: index,
        batchSize: promptedPayloads.length
      });
      if (!attack) {
        created.push({ payload, attack: null, result: { started: false, attackMessageId: null, defenseMessageId: null, defenseUserId: null, defenseRouted: false, coreOptions: payload.coreOptions ?? null, combatAction: payload.combatAction ?? null, coreDialogSource: "attack", cardCreated: false } });
      } else {
        created.push({ payload, attack, result: { started: true, attackMessageId: attack.attackMessageId, defenseMessageId: null, defenseUserId: null, defenseRouted: false, coreOptions: payload.coreOptions ?? null, combatAction: payload.combatAction ?? null, coreDialogSource: "attack", cardCreated: true } });
      }
    }

    const byUser = new Map();
    for (const entry of created) {
      const targetActor = entry.attack?.targetActor ?? null;
      if (!targetActor) continue;
      const defenseUser = this.getDefensePromptUser(targetActor, entry.attack?.targetToken ?? null);
      entry.result.defenseUserId = defenseUser?.id ?? null;
      if (!defenseUser) {
        ui.notifications.warn(game.i18n.localize("AOV_SKJALDBORG.Warnings.NoDefensePromptUser"));
        continue;
      }
      if (!byUser.has(defenseUser.id)) byUser.set(defenseUser.id, { user: defenseUser, entries: [] });
      byUser.get(defenseUser.id).entries.push(entry);
    }

    await Promise.all(Array.from(byUser.values(), async group => {
      for (const entry of group.entries) {
        const defensePayload = this.buildDefenseWorkflowPayload({
          targetActor: entry.attack.targetActor,
          targetToken: entry.attack.targetToken,
          attackMessageId: entry.attack.attackMessageId,
          incomingWeaponType: entry.attack.weapon?.system?.weaponType
        });
        try {
          let defenseResult = null;
          if (group.user.id !== game.user?.id) {
            if (typeof options.promptDefender === "function") {
              defenseResult = await options.promptDefender(group.user, defensePayload);
            } else {
              ui.notifications.warn(game.i18n.localize("AOV_SKJALDBORG.Warnings.NoDefensePromptRoute"));
            }
          } else {
            defenseResult = await this.rollDialogDefenseWorkflow({
              ...defensePayload,
              targetActor: entry.attack.targetActor,
              targetToken: entry.attack.targetToken
            });
          }
          entry.result.defenseMode = defenseResult?.defenseMode ?? null;
          entry.result.defenseMessageId = defenseResult?.defenseMessageId ?? null;
          entry.result.defenseCoreOptions = defenseResult?.coreOptions ?? null;
          entry.result.defenseCombatAction = defenseResult?.combatAction ?? null;
          entry.result.defenseAccepted = defenseResult?.accepted !== false;
          entry.result.alreadyResolved = defenseResult?.alreadyResolved === true;
          entry.result.defenseRouted = group.user.id !== game.user?.id;
        } catch (exception) {
          ui.notifications.warn(exception?.message ?? game.i18n.localize("AOV_SKJALDBORG.Warnings.ActionFailed"));
        }
      }
    }));

    return created.map(entry => entry.result);
  }

  /**
   * Persist the Prone/grounded RAW chance modifier that was already folded into
   * the core AoV combat card target number. The flag is diagnostic only; the
   * chat card value remains authoritative for the opposed roll.
   *
   * @param {string} messageId Core AoV combat ChatMessage id.
   * @param {object} payload Attack dialog payload.
   * @param {{actor: Actor|null, sourceToken: TokenDocument|null, weapon: Item|null, targetActor: Actor|null, targetToken: TokenDocument|null}} context Resolved documents.
   * @returns {Promise<void>}
   */
  static async #attachProneAttackModifierFlag(messageId, payload, context) {
    const message = game.messages?.get?.(messageId) ?? null;
    if (!message?.setFlag) return;
    const aimed = payload.aimedBlow?.enabled === true;
    const rules = serializeProneAttackModifierContext(
      payload.proneRules
        ?? proneAttackModifierContext({
          attackerActor: context.actor,
          attackerToken: context.sourceToken,
          targetActor: context.targetActor,
          targetToken: context.targetToken
        })
    );
    const damageRules = serializeProneDamageContext(
      payload.proneDamageRules
        ?? proneDamageContext({
          attackerActor: context.actor,
          attackerToken: context.sourceToken,
          targetActor: context.targetActor,
          targetToken: context.targetToken,
          weapon: context.weapon,
          aimed
        })
    );
    const hasChanceRule = !!(
      rules?.total
      || rules?.attackerProne
      || rules?.targetProne
      || rules?.targetImmobilized
      || rules?.modifiers?.length
    );
    const hasDownstreamRule = damageRules?.suppressDamageModifier === true || damageRules?.oneDieHitLocation === true;
    if (!hasChanceRule && !hasDownstreamRule) return;

    const attackerParticipant = this.#aovParticipantReference(context.actor, context.sourceToken);
    const targetParticipant = this.#aovParticipantReference(context.targetActor, context.targetToken);
    await guardedModuleFlag(message, "proneAttackModifier", {
      ...(rules ?? {
        total: 0,
        attackerPenalty: 0,
        targetBonus: 0,
        attackerProne: false,
        targetProne: false,
        targetImmobilized: false,
        modifiers: []
      }),
      damageRules,
      resolved: true,
      createdAt: Date.now(),
      sourceMessageId: messageId,
      attackerActorUuid: context.actor?.uuid ?? payload.actorUuid ?? null,
      attackerActorId: context.actor?.id ?? null,
      attackerTokenUuid: context.sourceToken?.uuid ?? payload.sourceTokenUuid ?? null,
      attackerTokenId: context.sourceToken?.id ?? null,
      attackerParticipantId: attackerParticipant.id,
      attackerParticipantType: attackerParticipant.type,
      weaponUuid: context.weapon?.uuid ?? payload.weaponUuid ?? null,
      weaponId: context.weapon?.id ?? null,
      weaponName: context.weapon?.name ?? "",
      targetActorUuid: context.targetActor?.uuid ?? payload.targetActorUuid ?? null,
      targetActorId: context.targetActor?.id ?? null,
      targetTokenUuid: context.targetToken?.uuid ?? payload.targetTokenUuid ?? null,
      targetTokenId: context.targetToken?.id ?? null,
      targetParticipantId: targetParticipant.id,
      targetParticipantType: targetParticipant.type
    }, { category: "chat.proneAttackModifier" });
  }

  /**
   * Persist a module-owned aimed-blow selection on the core AoV combat card.
   *
   * @param {string} messageId Core AoV combat ChatMessage id.
   * @param {object} payload Attack dialog payload.
   * @param {{actor: Actor|null, sourceToken: TokenDocument|null, weapon: Item|null, targetActor: Actor|null, targetToken: TokenDocument|null}} context Resolved documents.
   * @returns {Promise<void>}
   */
  static async #attachAimedBlowFlag(messageId, payload, context) {
    if (payload.aimedBlow?.enabled !== true) return;
    const message = game.messages?.get?.(messageId) ?? null;
    if (!message?.setFlag) return;

    const attackerParticipant = this.#aovParticipantReference(context.actor, context.sourceToken);
    const targetParticipant = this.#aovParticipantReference(context.targetActor, context.targetToken);

    await guardedModuleFlag(message, "aimedBlow", {
      resolved: false,
      createdAt: Date.now(),
      sourceMessageId: messageId,
      attackerActorUuid: context.actor?.uuid ?? payload.actorUuid ?? null,
      attackerActorId: context.actor?.id ?? null,
      attackerTokenUuid: context.sourceToken?.uuid ?? payload.sourceTokenUuid ?? null,
      attackerTokenId: context.sourceToken?.id ?? null,
      attackerParticipantId: attackerParticipant.id,
      attackerParticipantType: attackerParticipant.type,
      weaponUuid: context.weapon?.uuid ?? payload.weaponUuid ?? null,
      weaponId: context.weapon?.id ?? null,
      targetActorUuid: context.targetActor?.uuid ?? payload.targetActorUuid ?? null,
      targetActorId: context.targetActor?.id ?? null,
      targetTokenUuid: context.targetToken?.uuid ?? payload.targetTokenUuid ?? null,
      targetTokenId: context.targetToken?.id ?? null,
      targetParticipantId: targetParticipant.id,
      targetParticipantType: targetParticipant.type,
      targetKind: String(payload.aimedBlow.targetKind ?? "hitLocation"),
      hitLocationId: String(payload.aimedBlow.hitLocationId ?? ""),
      hitLocationName: String(payload.aimedBlow.hitLocationName ?? ""),
      hitLocationRange: String(payload.aimedBlow.rollLabel ?? ""),
      rollLabel: String(payload.aimedBlow.rollLabel ?? ""),
      targetWeaponUuid: payload.aimedBlow.targetWeaponUuid ?? null,
      targetWeaponId: String(payload.aimedBlow.targetWeaponId ?? ""),
      targetWeaponName: String(payload.aimedBlow.targetWeaponName ?? ""),
      targetWeaponCurrentHp: numberOr(payload.aimedBlow.targetWeaponCurrentHp, 0),
      targetWeaponMaximumHp: numberOr(payload.aimedBlow.targetWeaponMaximumHp, 0),
      penalty: numberOr(payload.aimedBlow.penalty, 0)
    }, { category: "chat.aimedBlow" });
  }

  /**
   * Persist a module-owned Disarm selection on the core AoV combat card.
   *
   * @param {string} messageId Core AoV combat ChatMessage id.
   * @param {object} payload Attack dialog payload.
   * @param {{actor: Actor|null, sourceToken: TokenDocument|null, weapon: Item|null, targetActor: Actor|null, targetToken: TokenDocument|null}} context Resolved documents.
   * @returns {Promise<void>}
   */
  static async #attachDisarmFlag(messageId, payload, context) {
    if (payload.disarm?.enabled !== true) return;
    const message = game.messages?.get?.(messageId) ?? null;
    if (!message?.setFlag) return;

    const attackerParticipant = this.#aovParticipantReference(context.actor, context.sourceToken);
    const targetParticipant = this.#aovParticipantReference(context.targetActor, context.targetToken);
    const targetWeapon = context.targetActor?.items?.get?.(String(payload.disarm.targetWeaponId ?? "")) ?? null;

    await guardedModuleFlag(message, "disarm", {
      resolved: false,
      stage: "attack",
      createdAt: Date.now(),
      sourceMessageId: messageId,
      attackerActorUuid: context.actor?.uuid ?? payload.actorUuid ?? null,
      attackerActorId: context.actor?.id ?? null,
      attackerTokenUuid: context.sourceToken?.uuid ?? payload.sourceTokenUuid ?? null,
      attackerTokenId: context.sourceToken?.id ?? null,
      attackerParticipantId: attackerParticipant.id,
      attackerParticipantType: attackerParticipant.type,
      weaponUuid: context.weapon?.uuid ?? payload.weaponUuid ?? null,
      weaponId: context.weapon?.id ?? null,
      weaponName: context.weapon?.name ?? "",
      targetActorUuid: context.targetActor?.uuid ?? payload.targetActorUuid ?? null,
      targetActorId: context.targetActor?.id ?? null,
      targetTokenUuid: context.targetToken?.uuid ?? payload.targetTokenUuid ?? null,
      targetTokenId: context.targetToken?.id ?? null,
      targetParticipantId: targetParticipant.id,
      targetParticipantType: targetParticipant.type,
      targetWeaponUuid: targetWeapon?.uuid ?? payload.disarm.targetWeaponUuid ?? null,
      targetWeaponId: String(payload.disarm.targetWeaponId ?? ""),
      targetWeaponName: targetWeapon?.name ?? String(payload.disarm.targetWeaponName ?? ""),
      targetWeaponCurrentHp: numberOr(targetWeapon?.system?.currHP, 0),
      targetWeaponMaximumHp: numberOr(targetWeapon?.system?.maxHP, 0),
      mode: String(payload.disarm.mode ?? "strikeWeapon"),
      targetTwoHanded: payload.disarm.targetTwoHanded === true,
      penalty: numberOr(payload.disarm.penalty, 0)
    }, { category: "chat.disarm" });
  }

  /**
   * Persist a module-owned Stun selection on the core AoV combat card.
   *
   * @param {string} messageId Core AoV combat ChatMessage id.
   * @param {object} payload Attack dialog payload.
   * @param {{actor: Actor|null, sourceToken: TokenDocument|null, weapon: Item|null, targetActor: Actor|null, targetToken: TokenDocument|null}} context Resolved documents.
   * @returns {Promise<void>}
   */
  static async #attachStunFlag(messageId, payload, context) {
    if (payload.stun?.enabled !== true) return;
    const message = game.messages?.get?.(messageId) ?? null;
    if (!message?.setFlag) return;

    const attackerParticipant = this.#aovParticipantReference(context.actor, context.sourceToken);
    const targetParticipant = this.#aovParticipantReference(context.targetActor, context.targetToken);

    await guardedModuleFlag(message, "stun", {
      resolved: false,
      stage: "attack",
      createdAt: Date.now(),
      sourceMessageId: messageId,
      attackerActorUuid: context.actor?.uuid ?? payload.actorUuid ?? null,
      attackerActorId: context.actor?.id ?? null,
      attackerTokenUuid: context.sourceToken?.uuid ?? payload.sourceTokenUuid ?? null,
      attackerTokenId: context.sourceToken?.id ?? null,
      attackerParticipantId: attackerParticipant.id,
      attackerParticipantType: attackerParticipant.type,
      weaponUuid: context.weapon?.uuid ?? payload.weaponUuid ?? null,
      weaponId: context.weapon?.id ?? null,
      weaponName: context.weapon?.name ?? "",
      weaponDamageFormula: String(context.weapon?.system?.damage ?? payload.damage ?? ""),
      weaponDamageBonusFormula: String(context.actor?.system?.dmgBonus ?? ""),
      weaponDamageModifierMode: String(context.weapon?.system?.damMod ?? ""),
      targetActorUuid: context.targetActor?.uuid ?? payload.targetActorUuid ?? null,
      targetActorId: context.targetActor?.id ?? null,
      targetTokenUuid: context.targetToken?.uuid ?? payload.targetTokenUuid ?? null,
      targetTokenId: context.targetToken?.id ?? null,
      targetParticipantId: targetParticipant.id,
      targetParticipantType: targetParticipant.type,
      hitLocationId: String(payload.stun.hitLocationId ?? ""),
      hitLocationName: String(payload.stun.hitLocationName ?? ""),
      hitLocationRange: String(payload.stun.rollLabel ?? ""),
      rollLabel: String(payload.stun.rollLabel ?? ""),
      penalty: numberOr(payload.stun.penalty, 0)
    }, { category: "chat.stun" });
  }

  /**
   * Persist module-owned missile metadata on the core AoV combat card.
   *
   * @param {string} messageId Core AoV combat ChatMessage id.
   * @param {object} payload Missile dialog payload.
   * @param {{actor: Actor|null, sourceToken: TokenDocument|null, weapon: Item|null, targetActor: Actor|null, targetToken: TokenDocument|null}} context Resolved documents.
   * @returns {Promise<void>}
   */
  static async #attachMissileFlags(messageId, payload, context) {
    if (String(payload.workflowType ?? "") !== "missile") return;
    const message = game.messages?.get?.(messageId) ?? null;
    if (!message?.setFlag) return;

    const attackerParticipant = this.#aovParticipantReference(context.actor, context.sourceToken);
    const targetParticipant = this.#aovParticipantReference(context.targetActor, context.targetToken);
    const common = {
      createdAt: Date.now(),
      sourceMessageId: messageId,
      attackerActorUuid: context.actor?.uuid ?? payload.actorUuid ?? null,
      attackerActorId: context.actor?.id ?? null,
      attackerTokenUuid: context.sourceToken?.uuid ?? payload.sourceTokenUuid ?? null,
      attackerTokenId: context.sourceToken?.id ?? null,
      attackerParticipantId: attackerParticipant.id,
      attackerParticipantType: attackerParticipant.type,
      weaponUuid: context.weapon?.uuid ?? payload.weaponUuid ?? null,
      weaponId: context.weapon?.id ?? null,
      weaponName: context.weapon?.name ?? "",
      ammunitionUuid: payload.ammunitionUuid ?? payload.ammunition?.uuid ?? null,
      ammunitionId: payload.ammunition?.id ?? null,
      targetActorUuid: context.targetActor?.uuid ?? payload.targetActorUuid ?? null,
      targetActorId: context.targetActor?.id ?? null,
      targetTokenUuid: context.targetToken?.uuid ?? payload.targetTokenUuid ?? null,
      targetTokenId: context.targetToken?.id ?? null,
      targetParticipantId: targetParticipant.id,
      targetParticipantType: targetParticipant.type,
      baseChance: numberOr(payload.baseChance, 0),
      targetNumber: numberOr(payload.targetNumber, 0),
      aimedTargetKind: String(payload.aimedBlow?.targetKind ?? "hitLocation"),
      aimedLocationId: String(payload.aimedBlow?.hitLocationId ?? ""),
      aimedLocationName: String(payload.aimedBlow?.hitLocationName ?? ""),
      aimedLocationRange: String(payload.aimedBlow?.rollLabel ?? ""),
      aimedTargetWeaponId: String(payload.aimedBlow?.targetWeaponId ?? ""),
      aimedTargetWeaponName: String(payload.aimedBlow?.targetWeaponName ?? ""),
      aimedTargetWeaponUuid: payload.aimedBlow?.targetWeaponUuid ?? null
    };

    await guardedModuleFlag(message, "missileShot", {
      ...common,
      resolved: false,
      range: payload.missileRange?.enabled === true ? foundry.utils.deepClone(payload.missileRange) : null,
      intoMelee: payload.missileIntoMelee?.enabled === true ? foundry.utils.deepClone(payload.missileIntoMelee) : null
    }, { category: "chat.missileShot" });

    if (payload.missileIntoMelee?.enabled === true) {
      await guardedModuleFlag(message, "missileIntoMelee", {
        ...common,
        resolved: false,
        combatantCount: Math.max(2, Math.trunc(numberOr(payload.missileIntoMelee.combatantCount, 2))),
        normalChance: numberOr(payload.missileIntoMelee.normalChance, payload.baseChance),
        adjustedChance: numberOr(payload.missileIntoMelee.adjustedChance, payload.targetNumber)
      }, { category: "chat.missileIntoMelee" });
    }
  }

  /**
   * Persist the exact per-dialog damage type for downstream damage effect
   * tracking. AoV damage cards do not retain the submitted CT mode, so this
   * flag lets the tracker distinguish thrusting impales from selected slashes.
   *
   * @param {string} messageId Core AoV combat ChatMessage id.
   * @param {object} payload Attack or Missile dialog payload.
   * @param {{actor: Actor|null, sourceToken: TokenDocument|null, weapon: Item|null, targetActor: Actor|null, targetToken: TokenDocument|null}} context Resolved documents.
   * @returns {Promise<void>}
   */
  static async #attachDamageEffectSourceFlag(messageId, payload, context) {
    const message = game.messages?.get?.(messageId) ?? null;
    if (!message?.setFlag) return;

    const attackerParticipant = this.#aovParticipantReference(context.actor, context.sourceToken);
    const targetParticipant = this.#aovParticipantReference(context.targetActor, context.targetToken);
    const damageType = String(
      payload.damageType?.key
        ?? payload.damageProfile?.core?.damageType
        ?? payload.damageSelection?.effective?.key
        ?? context.weapon?.system?.damType
        ?? ""
    ).trim().toLowerCase();

    await guardedModuleFlag(message, DAMAGE_EFFECT_SOURCE_FLAG, {
      resolved: false,
      createdAt: Date.now(),
      sourceMessageId: messageId,
      attackerActorUuid: context.actor?.uuid ?? payload.actorUuid ?? null,
      attackerActorId: context.actor?.id ?? null,
      attackerTokenUuid: context.sourceToken?.uuid ?? payload.sourceTokenUuid ?? null,
      attackerTokenId: context.sourceToken?.id ?? null,
      attackerParticipantId: attackerParticipant.id,
      attackerParticipantType: attackerParticipant.type,
      weaponUuid: context.weapon?.uuid ?? payload.weaponUuid ?? null,
      weaponId: context.weapon?.id ?? null,
      weaponName: context.weapon?.name ?? "",
      damageType,
      targetActorUuid: context.targetActor?.uuid ?? payload.targetActorUuid ?? null,
      targetActorId: context.targetActor?.id ?? null,
      targetTokenUuid: context.targetToken?.uuid ?? payload.targetTokenUuid ?? null,
      targetTokenId: context.targetToken?.id ?? null,
      targetParticipantId: targetParticipant.id,
      targetParticipantType: targetParticipant.type
    }, { category: "chat.damageEffectSource" });
  }

  /**
   * Reproduce AoV's participant id/type distinction for actor versus token
   * combat cards without importing the system helper into the adapter surface.
   *
   * @param {Actor|null|undefined} actor Participant Actor.
   * @param {TokenDocument|null|undefined} token Participant TokenDocument.
   * @returns {{id: string|null, type: "actor"|"token"|null}}
   */
  static #aovParticipantReference(actor, token) {
    if (token?.id && game.actors?.tokens?.[token.id]) {
      return { id: token.id, type: "token" };
    }
    if (actor?.id) return { id: actor.id, type: "actor" };
    return { id: null, type: null };
  }

  /**
   * Prompt and add the defender's response to the exact AoV combat card. This
   * method intentionally runs on the defender-controlling client so a single
   * defender prompt appears for that user.
   *
   * @param {object} payload Socket-safe defense workflow payload.
   * @param {{commitDefenseCard?: Function}} [options={}] Optional GM-authoritative card commit callback.
   * @returns {Promise<{defenseMode: string|null, defenseMessageId: string|null}>}
   */
  static async rollDialogDefenseWorkflow(payload = {}, options = {}) {
    const { actor, token } = await this.resolveDefenseParticipant(payload);
    if (!actor) throw new Error(game.i18n.localize("AOV_SKJALDBORG.Warnings.DefenseActorUnavailable"));
    if (!this.currentUserCanDefend(actor, token)) {
      throw new Error(game.i18n.localize("AOV_SKJALDBORG.Warnings.DefenseActorNotOwned"));
    }

    const remoteCommit = !game.user?.isGM && typeof options.commitDefenseCard === "function";
    let combatCard = null;
    let incomingWeaponType = String(payload.incomingWeaponType ?? "");
    if (!remoteCommit || !incomingWeaponType) {
      combatCard = await waitForOpenCoreCombatCard(payload.attackMessageId);
    }
    if (!remoteCommit && !combatCard) {
      throw new Error(game.i18n.localize("AOV_SKJALDBORG.Warnings.DefenseCombatCardUnavailable"));
    }
    if (!incomingWeaponType) incomingWeaponType = this.#incomingWeaponType(combatCard);

    const defenseWeapon = this.getDefenseWeapon(actor);
    const dodgeSkill = this.getDodgeSkill(actor);
    const actionOptions = await this.#defenseActionOptions(actor, { incomingWeaponType });
    const defaultAction = Object.hasOwn(actionOptions, "parry")
      ? "parry"
      : (Object.hasOwn(actionOptions, "dodge") ? "dodge" : "none");
    const coreOptions = await this.#promptCoreRollOptions({
      source: "defense",
      actionOptions,
      combatAction: defaultAction,
      flatMod: 0,
      label: actor?.name ?? ""
    });
    if (coreOptions.cancelled) {
      ui.notifications.warn(game.i18n.localize("AOV_SKJALDBORG.Warnings.DefensePromptCancelled"));
      return {
        defenseMode: null,
        defenseMessageId: null,
        coreOptions,
        combatAction: coreOptions.actionOption ?? null,
        coreDialogSource: "defense",
        cancelled: true
      };
    }

    const selectedItem = coreOptions.actionOption === "dodge"
      ? dodgeSkill
      : (coreOptions.actionOption === "parry" ? defenseWeapon : null);
    const commitPayload = this.#defenseCommitPayload({
      attackMessageId: combatCard?.id ?? payload.attackMessageId,
      actor,
      token,
      actionOption: selectedItem || coreOptions.actionOption === "none" ? coreOptions.actionOption : "none",
      coreOptions: selectedItem || coreOptions.actionOption === "none"
        ? coreOptions
        : { ...coreOptions, actionOption: "none" },
      item: selectedItem
    });
    if (!selectedItem && coreOptions.actionOption !== "none") {
      ui.notifications.warn(game.i18n.format("AOV_SKJALDBORG.Warnings.NoDefenderDefense", {
        actor: actor.name ?? game.i18n.localize("AOV_SKJALDBORG.Labels.Unknown")
      }));
    }

    if (!game.user?.isGM) {
      if (typeof options.commitDefenseCard !== "function") {
        throw new Error(game.i18n.localize("AOV_SKJALDBORG.Warnings.NoDefensePromptRoute"));
      }
      return options.commitDefenseCard(commitPayload);
    }

    return this.commitDefenseCard(commitPayload);
  }

  /**
   * Trigger a core AoV weapon roll as a combat-card participant.
   *
   * @param {{actor: Actor, token: TokenDocument|null, weapon: Item, flatMod: number, combatAction: string}} request Roll request.
   * @returns {Promise<string|undefined|false>}
   */
  static async #triggerCoreCombatWeaponRoll(request) {
    const { AOVCheck, RollType, CardType } = await getAoVCheckApi();
    return AOVCheck._trigger({
      rollType: RollType.WEAPON,
      cardType: CardType.COMBAT,
      shiftKey: false,
      actor: request.actor,
      token: request.token ?? null,
      characteristic: false,
      skillId: request.weapon.id,
      itemId: request.weapon.id,
      flatMod: numberOr(request.flatMod, 0),
      combatAction: request.combatAction,
      origID: game.user?.id ?? game.user?._id
    });
  }

  /**
   * Trigger a core AoV Dodge fallback roll as a combat-card participant.
   *
   * @param {{actor: Actor, token: TokenDocument|null, skill: Item, flatMod: number, combatAction: string}} request Roll request.
   * @returns {Promise<string|undefined|false>}
   */
  static async #triggerCoreCombatSkillRoll(request) {
    const { AOVCheck, RollType, CardType } = await getAoVCheckApi();
    return AOVCheck._trigger({
      rollType: RollType.SKILL,
      cardType: CardType.COMBAT,
      shiftKey: false,
      actor: request.actor,
      token: request.token ?? null,
      characteristic: false,
      skillId: request.skill.id,
      itemId: request.skill.id,
      flatMod: numberOr(request.flatMod, 0),
      combatAction: request.combatAction,
      origID: game.user?.id ?? game.user?._id
    });
  }

  /**
   * Prepare the public Age of Vikings wellbeing model used by the actor hotbar.
   *
   * Character damage is represented by owned Wound Items. NPC damage is stored
   * directly on owned Hit Location Items. This adapter normalizes both models
   * without importing either actor-sheet implementation.
   *
   * @param {Actor|null|undefined} actor Age of Vikings Actor document.
   * @returns {object} Serializable hit-location and active-wound view data.
   */
  static prepareActorWellbeing(actor) {
    const supported = !!actor && ["character", "npc"].includes(actor.type);
    if (!supported) {
      return {
        supported: false,
        canEdit: false,
        canCreateWounds: false,
        useBodyMap: false,
        hasHitLocations: false,
        hasActiveWounds: false,
        hitLocations: [],
        locationList: [],
        activeWounds: []
      };
    }

    const items = Array.from(actor.items ?? []);
    const allLocations = items.filter(item => item.type === "hitloc");
    const visibleLocations = allLocations.filter(item => item.system?.locType !== "general");
    const characterWounds = actor.type === "character"
      ? items.filter(item => item.type === "wound")
      : [];
    const locationById = new Map(allLocations.map(item => [item.id, item]));
    const damageByLocation = new Map();
    const grappleLocationStates = actorGrappleLocationStates(actor);

    for (const wound of characterWounds) {
      const locationId = String(wound.system?.hitLocId ?? "");
      damageByLocation.set(
        locationId,
        numberOr(damageByLocation.get(locationId), 0) + Math.max(0, numberOr(wound.system?.damage, 0))
      );
    }

    const describeLocation = (item, gridPosition = null) => {
      const lowRoll = numberOr(item.system?.lowRoll, 0);
      const highRoll = numberOr(item.system?.highRoll, lowRoll);
      const rollLabel = lowRoll === highRoll ? String(lowRoll) : `${lowRoll}-${highRoll}`;
      const damage = actor.type === "npc"
        ? Math.max(0, numberOr(item.system?.npcDmg, 0))
        : Math.max(0, numberOr(damageByLocation.get(item.id), 0));
      const hpMax = Math.max(0, numberOr(item.system?.hpMax, 0));
      const hpCurrent = numberOr(item.system?.currHp, hpMax - damage);
      const ap = actor.type === "npc"
        ? numberOr(item.system?.npcAP, 0)
        : numberOr(item.system?.map, 0);
      const injurySeverity = injuryThresholdSeverityFromEffects(item.effects);
      const position = Number.isInteger(gridPosition) ? gridPosition : null;
      const grappleState = grappleLocationStates.get(item.id) ?? null;
      const grappled = !!grappleState?.grappled;
      const immobilized = !!grappleState?.immobilized;
      const grappleSource = Array.isArray(grappleState?.sources) ? grappleState.sources.join(", ") : "";
      const grappleTooltipKey = immobilized
        ? "AOV_SKJALDBORG.ActorHotbar.HitLocationImmobilizedTooltip"
        : "AOV_SKJALDBORG.ActorHotbar.HitLocationGrappledTooltip";
      return {
        id: item.id,
        name: item.name,
        rollLabel,
        ap,
        hpCurrent,
        hpMax,
        damage,
        wounded: damage > 0,
        critical: hpMax > 0 && hpCurrent <= 0,
        injurySeverity,
        injurySeverityClass: injurySeverity ? `aov-skjaldborg-hitloc-injury-${injurySeverity}` : "",
        grappled,
        immobilized,
        grappleSource,
        grappleTooltip: grappled
          ? game.i18n.format(grappleTooltipKey, { location: item.name, source: grappleSource || game.i18n.localize("AOV_SKJALDBORG.ActorHotbar.UnknownGrappler") })
          : "",
        gridPosition: position,
        gridStyle: position === null
          ? ""
          : `grid-column: ${(position % 3) + 1}; grid-row: ${Math.floor(position / 3) + 1};`
      };
    };

    // AoV v14 exposes gridPos to users as cells 1..12. Some NPC Hit Location
    // Items still carry the model default 0, while historical actors may hold
    // explicit zero-based values. Prefer configured positions when they are
    // meaningful, infer the standard humanoid arrangement from d20 ranges when
    // they are not, and only then fill remaining cells deterministically.
    const rawGridPositions = visibleLocations
      .map(location => Number(location.system?.gridPos))
      .filter(Number.isInteger);
    let zeroBasedEvidence = 0;
    let oneBasedEvidence = 0;
    for (const location of visibleLocations) {
      const rawPosition = Number(location.system?.gridPos);
      const standardPosition = standardHumanoidGridPosition(location);
      if (!Number.isInteger(rawPosition) || standardPosition === null) continue;
      if (rawPosition === standardPosition) zeroBasedEvidence += 1;
      if ((rawPosition - 1) === standardPosition) oneBasedEvidence += 1;
    }
    const gridPositionBase = rawGridPositions.includes(0)
      && !rawGridPositions.includes(12)
      && zeroBasedEvidence > oneBasedEvidence
      ? 0
      : 1;
    const normalizeGridPosition = location => {
      const rawPosition = Number(location.system?.gridPos);
      if (!Number.isInteger(rawPosition)) return null;
      if (gridPositionBase === 0) return rawPosition >= 0 && rawPosition <= 11 ? rawPosition : null;
      return rawPosition >= 1 && rawPosition <= 12 ? rawPosition - 1 : null;
    };

    const bodySlots = Array.from({ length: 12 }, () => null);
    const unresolved = [];
    const orderedForBody = [...visibleLocations].sort((a, b) => {
      const low = numberOr(a.system?.lowRoll, 0) - numberOr(b.system?.lowRoll, 0);
      if (low) return low;
      return String(a.name).localeCompare(String(b.name), game.i18n.lang);
    });

    // Respect explicit, non-colliding grid configuration first. This preserves
    // custom creature layouts and character-sheet arrangements.
    for (const location of orderedForBody) {
      const position = normalizeGridPosition(location);
      if (Number.isInteger(position) && !bodySlots[position]) bodySlots[position] = location;
      else unresolved.push(location);
    }

    // NPCs commonly retain gridPos=0 on every location. Their standard d20
    // ranges are enough to reproduce the character-sheet body-map layout.
    const deferred = [];
    for (const location of unresolved) {
      const position = standardHumanoidGridPosition(location);
      if (Number.isInteger(position) && !bodySlots[position]) bodySlots[position] = location;
      else deferred.push(location);
    }

    // Non-humanoid and partially configured locations remain usable rather than
    // disappearing: place them in the first free body-map cells in roll order.
    for (const location of deferred) {
      const position = bodySlots.findIndex(slot => !slot);
      if (position < 0) break;
      bodySlots[position] = location;
    }

    const hitLocations = bodySlots
      .map((item, position) => item ? describeLocation(item, position) : null)
      .filter(Boolean);
    const locationList = [...visibleLocations]
      .sort((a, b) => {
        const low = numberOr(a.system?.lowRoll, 0) - numberOr(b.system?.lowRoll, 0);
        if (low) return low;
        return String(a.name).localeCompare(String(b.name), game.i18n.lang);
      })
      .map(item => describeLocation(item));

    const activeWounds = actor.type === "character"
      ? characterWounds
        .map(item => {
          const location = locationById.get(item.system?.hitLocId) ?? null;
          return {
            id: item.id,
            name: item.name,
            locationName: location?.name ?? game.i18n.localize("AOV_SKJALDBORG.ActorHotbar.UnassignedLocation"),
            locationOrder: numberOr(location?.system?.lowRoll, 999),
            damage: Math.max(0, numberOr(item.system?.damage, 0)),
            treated: !!item.system?.treated,
            sourceType: "wound",
            isWound: true,
            canTreat: !!actor.isOwner,
            canDelete: !!actor.isOwner
          };
        })
        .filter(wound => wound.damage > 0)
        .sort((a, b) => a.locationOrder - b.locationOrder || String(a.name).localeCompare(String(b.name), game.i18n.lang))
      : allLocations
        .map(item => ({
          id: item.id,
          name: item.name,
          locationName: item.name,
          locationOrder: numberOr(item.system?.lowRoll, 999),
          damage: Math.max(0, numberOr(item.system?.npcDmg, 0)),
          treated: false,
          sourceType: "hitloc",
          isWound: false,
          canTreat: false,
          canDelete: !!actor.isOwner
        }))
        .filter(wound => wound.damage > 0)
        .sort((a, b) => a.locationOrder - b.locationOrder || String(a.name).localeCompare(String(b.name), game.i18n.lang));

    return {
      supported: true,
      actorType: actor.type,
      canEdit: !!actor.isOwner,
      canCreateWounds: !!actor.isOwner && (actor.type === "character" || visibleLocations.length > 0),
      useBodyMap: visibleLocations.length > 0 && visibleLocations.length <= 12,
      hasHitLocations: visibleLocations.length > 0,
      hasActiveWounds: activeWounds.length > 0,
      hitLocations,
      locationList,
      activeWounds
    };
  }

  /**
   * Create an owned Wound Item, optionally assigned to one hit location.
   *
   * @param {Actor} actor Character Actor document.
   * @param {string|null} [hitLocationId=null] Owned Hit Location Item id.
   * @returns {Promise<Item>} Created wound.
   */
  static async createActorWound(actor, hitLocationId = null) {
    if (!actor?.isOwner) throw new Error("The current user does not own this actor.");
    if (actor.type !== "character") throw new Error("Wound Items are only supported for character actors.");
    if (hitLocationId) {
      const location = actor.items?.get(hitLocationId);
      if (!location || location.type !== "hitloc") throw new Error("The selected hit location is unavailable.");
    }

    const itemClass = globalThis.getDocumentClass?.("Item") ?? globalThis.CONFIG?.Item?.documentClass;
    const localizedName = game.i18n.localize("TYPES.Item.wound");
    const name = itemClass?.defaultName?.({ type: "wound", parent: actor })
      ?? (localizedName === "TYPES.Item.wound" ? "Wound" : localizedName);
    const [wound] = await actor.createEmbeddedDocuments("Item", [{
      name,
      type: "wound",
      system: {
        ...(hitLocationId ? { hitLocId: hitLocationId } : {})
      }
    }]);
    if (!wound) throw new Error("Age of Vikings did not create the wound Item.");

    await this.#assignActorItemCid(wound);
    await wound.sheet?.render?.({ force: true });
    return wound;
  }

  /**
   * Persist character Wound damage or NPC Hit Location damage.
   *
   * @param {Actor} actor Actor document.
   * @param {string} itemId Owned Item id.
   * @param {unknown} value Submitted damage value.
   * @returns {Promise<Document[]>} Updated owned Item collection.
   */
  static async updateActorWellbeingDamage(actor, itemId, value) {
    if (!actor?.isOwner) throw new Error("The current user does not own this actor.");
    const item = actor.items?.get(itemId);
    if (!item) throw new Error("The wound or hit location is unavailable.");
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) throw new Error("Damage must be numeric.");
    const damage = Math.max(0, Math.round(numeric));

    let field;
    if (item.type === "wound" && actor.type === "character") field = "system.damage";
    else if (item.type === "hitloc" && actor.type === "npc") field = "system.npcDmg";
    else throw new Error("This Item does not provide editable wellbeing damage.");

    return actor.updateEmbeddedDocuments("Item", [{ _id: item.id, [field]: damage }]);
  }

  /**
   * Add damage to one NPC Hit Location. This is the NPC-system equivalent of
   * creating a character Wound Item and preserves AoV's native `npcDmg` model.
   *
   * @param {Actor} actor NPC Actor document.
   * @param {string} hitLocationId Owned Hit Location Item id.
   * @param {unknown} value Damage to add.
   * @returns {Promise<Document[]>} Updated owned Hit Location collection.
   */
  static async addActorNpcDamage(actor, hitLocationId, value) {
    if (!actor?.isOwner) throw new Error("The current user does not own this actor.");
    if (actor.type !== "npc") throw new Error("NPC damage can only be added to NPC actors.");
    const location = actor.items?.get(hitLocationId);
    if (!location || location.type !== "hitloc" || location.system?.locType === "general") {
      throw new Error("The selected NPC hit location is unavailable.");
    }
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) throw new Error("Damage must be numeric.");
    const addedDamage = Math.max(1, Math.round(numeric));
    const currentDamage = Math.max(0, numberOr(location.system?.npcDmg, 0));
    return actor.updateEmbeddedDocuments("Item", [{
      _id: location.id,
      "system.npcDmg": currentDamage + addedDamage
    }]);
  }

  /**
   * Toggle the treated state of one character Wound Item.
   *
   * @param {Actor} actor Character Actor document.
   * @param {string} woundId Owned Wound Item id.
   * @returns {Promise<Document[]>} Updated owned Item collection.
   */
  static async toggleActorWoundTreated(actor, woundId) {
    if (!actor?.isOwner) throw new Error("The current user does not own this actor.");
    const wound = actor.items?.get(woundId);
    if (!wound || wound.type !== "wound") throw new Error("The wound is unavailable.");
    return actor.updateEmbeddedDocuments("Item", [{
      _id: wound.id,
      "system.treated": !wound.system?.treated
    }]);
  }

  /**
   * Remove one active wound from the normalized HUD model. Character Wound
   * Items are deleted; NPC wounds are cleared by resetting the owning Hit
   * Location's native `npcDmg` value without deleting that location.
   *
   * @param {Actor} actor Character or NPC Actor document.
   * @param {string} woundId Owned Wound or Hit Location Item id.
   * @returns {Promise<Document[]>} Updated or deleted owned Item collection.
   */
  static async deleteActorWound(actor, woundId) {
    if (!actor?.isOwner) throw new Error("The current user does not own this actor.");
    const wound = actor.items?.get(woundId);
    if (!wound) throw new Error("The wound is unavailable.");
    if (actor.type === "character" && wound.type === "wound") {
      return actor.deleteEmbeddedDocuments("Item", [wound.id]);
    }
    if (actor.type === "npc" && wound.type === "hitloc") {
      return actor.updateEmbeddedDocuments("Item", [{ _id: wound.id, "system.npcDmg": 0 }]);
    }
    throw new Error("This Item does not provide removable wound data.");
  }

  /**
   * Mirror the AoV actor-sheet CID initialization for newly created Items.
   *
   * @param {Item} item Newly created actor-owned Item.
   * @returns {Promise<void>}
   */
  static async #assignActorItemCid(item) {
    let cidEnabled = false;
    try {
      cidEnabled = !!game.settings.get("aov", "actorItemCID");
    } catch (_exception) {
      return;
    }
    if (!cidEnabled || typeof game.aov?.cid?.guessId !== "function") return;
    const key = await game.aov.cid.guessId(item);
    await item.update({
      "flags.aov.cidFlag.id": key,
      "flags.aov.cidFlag.lang": game.i18n.lang,
      "flags.aov.cidFlag.priority": 0
    });
  }

  /**
   * Persist an editable actor resource from the selected-actor hotbar.
   *
   * Age of Vikings derives character HP from owned Wound Items and NPC HP
   * from owned Hit Location damage. Directly updating `system.hp.value` would
   * therefore be overwritten during actor preparation. This method reconciles
   * those authoritative embedded Items instead. MP is an actor data field and
   * is updated directly.
   *
   * @param {Actor} actor Owned Age of Vikings Actor.
   * @param {"hp"|"mp"} resource Resource identifier.
   * @param {unknown} value Submitted current value.
   * @returns {Promise<Actor|Document[]|null>} Completed document operation.
   */
  static async updateActorResource(actor, resource, value) {
    if (!actor?.isOwner) throw new Error("The current user does not own this actor.");
    if (!['character', 'npc'].includes(actor.type)) throw new Error("Unsupported actor type.");

    if (resource === "mp") {
      const magicPoints = await this.prepareActorMagicPoints(actor);
      const target = this.#clampResourceValue(value, magicPoints.available);
      return actor.update({ "system.mp.value": target });
    }

    if (resource !== "hp") throw new Error(`Unsupported resource: ${resource}`);
    const maximum = Math.max(0, numberOr(actor.system?.hp?.max, 0));
    const target = this.#clampResourceValue(value, maximum);
    if (actor.type === "character") return this.#updateCharacterHp(actor, target);
    return this.#updateNpcHp(actor, target);
  }

  /** @returns {number} */
  static #clampResourceValue(value, maximum) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) throw new Error("Resource value must be numeric.");
    return Math.min(maximum, Math.max(0, Math.round(numeric)));
  }

  /**
   * Reconcile character HP through owned Wound Items.
   *
   * @param {Actor} actor Character actor.
   * @param {number} target Desired HP value.
   * @returns {Promise<Actor|Document[]|null>} Completed document operation.
   */
  static async #updateCharacterHp(actor, target) {
    const current = this.prepareActorHitPoints(actor).value;
    if (target === current) return actor;

    const wounds = Array.from(actor.items ?? [])
      .filter(item => item.type === "wound" && numberOr(item.system?.damage, 0) > 0);

    if (target > current) {
      let remaining = target - current;
      const updates = [];
      const deletions = [];
      const ordered = [...wounds].sort((a, b) => {
        const damage = numberOr(a.system?.damage, 0) - numberOr(b.system?.damage, 0);
        return damage || String(a.id).localeCompare(String(b.id));
      });

      for (const wound of ordered) {
        if (remaining <= 0) break;
        const damage = numberOr(wound.system?.damage, 0);
        const healed = Math.min(damage, remaining);
        const nextDamage = damage - healed;
        remaining -= healed;
        if (nextDamage <= 0) deletions.push(wound.id);
        else updates.push({ _id: wound.id, "system.damage": nextDamage });
      }

      if (updates.length) await actor.updateEmbeddedDocuments("Item", updates);
      if (deletions.length) return actor.deleteEmbeddedDocuments("Item", deletions);
      return actor;
    }

    const addedDamage = current - target;
    const locations = Array.from(actor.items ?? [])
      .filter(item => item.type === "hitloc")
      .sort((a, b) => numberOr(a.sort, 0) - numberOr(b.sort, 0) || a.name.localeCompare(b.name, game.i18n.lang));
    const generalLocation = locations.find(item => item.system?.locType === "general") ?? null;
    const existing = generalLocation
      ? wounds.find(wound => wound.system?.hitLocId === generalLocation.id) ?? null
      : [...wounds].sort((a, b) => String(a.id).localeCompare(String(b.id)))[0] ?? null;
    if (existing) {
      const damage = numberOr(existing.system?.damage, 0) + addedDamage;
      return actor.updateEmbeddedDocuments("Item", [{ _id: existing.id, "system.damage": damage }]);
    }

    const targetLocation = generalLocation ?? locations[0] ?? null;
    if (!targetLocation) throw new Error("This actor has no hit location for a wound.");
    const localizedName = game.i18n.localize("TYPES.Item.wound");
    const name = localizedName === "TYPES.Item.wound" ? "Wound" : localizedName;
    return actor.createEmbeddedDocuments("Item", [{
      name,
      type: "wound",
      system: {
        damage: addedDamage,
        hitLocId: targetLocation.id
      }
    }]);
  }

  /**
   * Reconcile NPC HP through `system.npcDmg` on owned Hit Location Items.
   *
   * @param {Actor} actor NPC actor.
   * @param {number} target Desired HP value.
   * @returns {Promise<Actor|Document[]|null>} Completed document operation.
   */
  static async #updateNpcHp(actor, target) {
    const current = this.prepareActorHitPoints(actor).value;
    if (target === current) return actor;

    const locations = Array.from(actor.items ?? [])
      .filter(item => item.type === "hitloc")
      .sort((a, b) => numberOr(a.sort, 0) - numberOr(b.sort, 0) || a.name.localeCompare(b.name, game.i18n.lang));
    if (!locations.length) throw new Error("This actor has no hit location for damage.");

    if (target > current) {
      let remaining = target - current;
      const updates = [];
      const damaged = locations
        .filter(item => numberOr(item.system?.npcDmg, 0) > 0)
        .sort((a, b) => numberOr(b.system?.npcDmg, 0) - numberOr(a.system?.npcDmg, 0) || String(a.id).localeCompare(String(b.id)));
      for (const location of damaged) {
        if (remaining <= 0) break;
        const damage = numberOr(location.system?.npcDmg, 0);
        const healed = Math.min(damage, remaining);
        remaining -= healed;
        updates.push({ _id: location.id, "system.npcDmg": damage - healed });
      }
      if (!updates.length) return actor;
      return actor.updateEmbeddedDocuments("Item", updates);
    }

    const addedDamage = current - target;
    const location = locations.find(item => item.system?.locType === "general") ?? locations[0];
    return actor.updateEmbeddedDocuments("Item", [{
      _id: location.id,
      "system.npcDmg": numberOr(location.system?.npcDmg, 0) + addedDamage
    }]);
  }

  /**
   * Determine whether a combatant should be considered able to act.
   *
   * @param {Combatant|null|undefined} combatant Foundry Combatant document.
   * @returns {boolean}
   */
  static isCombatantCapable(combatant) {
    if (!combatant) return false;
    if (combatant.defeated || combatant.isDefeated) return false;
    const actor = combatant.actor;
    if (!actor) return false;
    const hp = this.getHp(actor);
    return hp > 0;
  }

  /**
   * Determine whether a user may submit module state for a combatant.
   *
   * @param {User|null|undefined} user Foundry User document.
   * @param {Combatant|null|undefined} combatant Foundry Combatant document.
   * @returns {boolean}
   */
  static canUserControlCombatant(user, combatant) {
    if (!user || !combatant) return false;
    if (user.isGM) return true;
    const token = combatant.token?.document ?? combatant.token ?? null;
    if (token?.testUserPermission?.(user, "OWNER")) return true;
    return combatant.actor?.testUserPermission?.(user, "OWNER") ?? false;
  }

  /**
   * Project AoV DEX and INT into the current AoV decimal initiative convention.
   *
   * @param {number} dex Final DEX rank.
   * @param {number} int INT tiebreaker.
   * @returns {number}
   */
  static projectInitiative(dex, int) {
    const safeDex = numberOr(dex, 0);
    const safeInt = Math.max(0, numberOr(int, 0));
    return Number((safeDex + (safeInt / 100)).toFixed(2));
  }

  /**
   * Resolve a combatant id within a combat.
   *
   * @param {Combat|null|undefined} combat Foundry Combat document.
   * @param {string} combatantId Combatant id.
   * @returns {Combatant|null}
   */
  static getCombatantById(combat, combatantId) {
    return combat?.combatants?.get(combatantId) ?? null;
  }

  /**
   * Resolve the combatant represented by a canvas token.
   *
   * @param {Combat|null|undefined} combat Foundry Combat document.
   * @param {Token|null|undefined} token Canvas token bound to the core Token HUD.
   * @returns {Combatant|null}
   */
  static getCombatantForToken(combat, token) {
    return combatantForTokenDocument(combat, token?.document ?? token) ?? null;
  }

  /**
   * Resolve a Combat by id, falling back to the active combat.
   *
   * @param {string|null|undefined} combatId Combat id.
   * @returns {Combat|null}
   */
  static getCombatById(combatId) {
    return game.combats?.get(combatId) ?? game.combat ?? null;
  }

  /**
   * Find the most relevant combatant for the current user selection.
   *
   * @param {Combat|null|undefined} [combat=game.combat] Combat document.
   * @returns {Combatant|null}
   */
  static getControlledCombatant(combat = game.combat) {
    if (!combat) return null;
    const controlled = canvas.tokens?.controlled ?? [];
    for (const token of controlled) {
      const combatant = combat.combatants.find(c => c.tokenId === token.id || c.token?.id === token.id);
      if (combatant) return combatant;
    }
    return combat.combatant ?? combat.turns?.find(c => this.canUserControlCombatant(game.user, c)) ?? null;
  }

  /**
   * Measure a waypoint list using scene grid scale.
   *
   * @deprecated Compatibility bridge retained until every movement call site is
   * migrated to v14 TokenDocument movement summaries.
   *
   * @param {{x: number, y: number}[]} waypoints Canvas-space points.
   * @returns {number}
   */
  static measureDistanceFromWaypoints(waypoints) {
    if (!Array.isArray(waypoints) || waypoints.length < 2) return 0;
    let total = 0;
    for (let i = 1; i < waypoints.length; i += 1) {
      const a = waypoints[i - 1];
      const b = waypoints[i];
      const dx = numberOr(b.x) - numberOr(a.x);
      const dy = numberOr(b.y) - numberOr(a.y);
      const pixels = Math.hypot(dx, dy);
      const gridSize = numberOr(canvas.scene?.grid?.size ?? canvas.grid?.size, 100) || 100;
      const gridDistance = numberOr(canvas.scene?.grid?.distance, 5) || 5;
      total += (pixels / gridSize) * gridDistance;
    }
    return Number(total.toFixed(2));
  }
}

export const __test = {
  combatCardEntry: options => AoVAdapter.__testCombatCardEntry(options),
  attackFlatModifier: (payload, weapon = null) => AoVAdapter.__testAttackFlatModifier(payload, weapon)
};
