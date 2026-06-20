import {
  MODULE_ID,
  MODULE_VERSION,
  MOVEMENT_DEBUG_CATEGORIES,
  MOVEMENT_DEBUG_DEFAULT_CATEGORIES,
  MOVEMENT_DEBUG_LEVELS
} from "../constants.mjs";

const PREFIX = `${MODULE_ID} | movement-debug`;
const LEVEL_WEIGHT = Object.freeze({
  [MOVEMENT_DEBUG_LEVELS.SUMMARY]: 1,
  [MOVEMENT_DEBUG_LEVELS.VERBOSE]: 2,
  [MOVEMENT_DEBUG_LEVELS.TRACE]: 3
});
const MAX_DEBUG_EVENTS = 2000;
const debugEvents = [];

/**
 * Read a module setting defensively.
 *
 * @param {string} key Setting key.
 * @param {unknown} fallback Fallback value.
 * @returns {unknown}
 */
function setting(key, fallback) {
  try {
    return game.settings?.get?.(MODULE_ID, key) ?? fallback;
  }
  catch (_err) {
    return fallback;
  }
}

/**
 * Normalize movement-debug category settings.
 *
 * @returns {Record<string, boolean>}
 */
export function movementDebugCategories() {
  if (setting("debug", false) === true) {
    return Object.fromEntries(Object.keys(MOVEMENT_DEBUG_DEFAULT_CATEGORIES).map(category => [category, true]));
  }
  const configured = setting("movementDebugCategories", MOVEMENT_DEBUG_DEFAULT_CATEGORIES);
  return {
    ...MOVEMENT_DEBUG_DEFAULT_CATEGORIES,
    ...(configured && typeof configured === "object" && !Array.isArray(configured) ? configured : {})
  };
}

/**
 * Return whether a diagnostic category is enabled.
 *
 * @param {string} category Category id.
 * @param {string} [minimumLevel="summary"] Minimum required verbosity.
 * @returns {boolean}
 */
export function movementDebugEnabled(category, minimumLevel = MOVEMENT_DEBUG_LEVELS.SUMMARY) {
  const masterDebug = setting("debug", false) === true;
  if (!masterDebug && setting("movementDebugEnabled", false) !== true) return false;
  const categories = movementDebugCategories();
  if (categories[category] !== true) return false;
  const configuredLevel = masterDebug
    ? MOVEMENT_DEBUG_LEVELS.TRACE
    : setting("movementDebugLevel", MOVEMENT_DEBUG_LEVELS.SUMMARY);
  return (LEVEL_WEIGHT[configuredLevel] ?? 1) >= (LEVEL_WEIGHT[minimumLevel] ?? 1);
}

/**
 * Build a new correlated movement debug run id.
 *
 * @param {Combat|object|null} combat Combat document.
 * @returns {string}
 */
export function newMovementDebugRunId(combat = game.combat) {
  const runId = [
    "move",
    String(combat?.id ?? "no-combat"),
    String(combat?.round ?? 0),
    String(Date.now())
  ].join(":");
  void game.settings?.set?.(MODULE_ID, "movementDebugLastRunId", runId);
  return runId;
}

/**
 * Read the current movement debug run id.
 *
 * @returns {string|null}
 */
function currentRunId() {
  return setting("movementDebugLastRunId", null);
}

/**
 * Resolve a token source object without depending on Foundry placeables.
 *
 * @param {Combatant|object|null} combatant Combatant document.
 * @returns {object|null}
 */
function tokenSnapshot(combatant) {
  const token = combatant?.token?.object?.document
    ?? combatant?.token?.document
    ?? combatant?.token
    ?? canvas?.scene?.tokens?.get?.(combatant?.tokenId)
    ?? null;
  if (!token) return null;
  return {
    id: token.id ?? token._id ?? combatant?.tokenId ?? null,
    x: Number(token._source?.x ?? token.x),
    y: Number(token._source?.y ?? token.y),
    width: Number(token.width ?? token._source?.width ?? 1),
    height: Number(token.height ?? token._source?.height ?? 1),
    disposition: token.disposition ?? token._source?.disposition ?? null
  };
}

/**
 * Build a current movement-state snapshot for console inspection.
 *
 * @param {Combat|object|null} [combat=game.combat] Active combat.
 * @returns {object}
 */
export function movementDebugSnapshot(combat = game.combat) {
  const combatants = Array.from(combat?.combatants ?? []).map(entry => Array.isArray(entry) ? entry[1] : entry);
  return {
    timestamp: new Date().toISOString(),
    runId: currentRunId(),
    environment: {
      moduleId: MODULE_ID,
      moduleVersion: MODULE_VERSION,
      foundryVersion: game.version ?? game.release?.version ?? null,
      foundryBuild: game.release?.build ?? null,
      systemId: game.system?.id ?? null,
      systemVersion: game.system?.version ?? null,
      userId: game.user?.id ?? null,
      isGM: game.user?.isGM === true,
      sceneId: canvas?.scene?.id ?? null
    },
    settings: {
      enabled: setting("debug", false) === true,
      level: setting("debug", false) === true
        ? MOVEMENT_DEBUG_LEVELS.TRACE
        : setting("movementDebugLevel", MOVEMENT_DEBUG_LEVELS.SUMMARY),
      categories: movementDebugCategories(),
      movementTickDelayMs: setting("movementTickDelayMs", null)
    },
    combat: combat ? {
      id: combat.id ?? null,
      round: combat.round ?? null,
      turn: combat.turn ?? null,
      started: combat.started === true,
      state: combat.getFlag?.(MODULE_ID, "combatState") ?? combat.flags?.[MODULE_ID]?.combatState ?? null
    } : null,
    combatants: combatants.map(combatant => {
      const state = combatant?.getFlag?.(MODULE_ID, "combatantState")
        ?? combatant?.flags?.[MODULE_ID]?.combatantState
        ?? {};
      return {
        id: combatant?.id ?? null,
        name: combatant?.name ?? combatant?.actor?.name ?? null,
        tokenId: combatant?.tokenId ?? null,
        actorId: combatant?.actorId ?? combatant?.actor?.id ?? null,
        initiative: combatant?.initiative ?? null,
        token: tokenSnapshot(combatant),
        movement: state.movement ?? null,
        engagement: state.engagement ?? null,
        intent: state.intent ?? null,
        dexLedger: state.dexLedger ?? null
      };
    })
  };
}

/**
 * Safely evaluate a diagnostic payload.
 *
 * @param {unknown|Function} dataFactoryOrData Payload or factory.
 * @returns {unknown}
 */
function resolveData(dataFactoryOrData) {
  return typeof dataFactoryOrData === "function" ? dataFactoryOrData() : dataFactoryOrData;
}

/**
 * Clone diagnostic payloads into bounded JSON-safe data.
 *
 * The browser's saved console log collapses object arguments to an ellipsis.
 * This clone is also serialized into the textual console message so every
 * route, waypoint, movement section, and bank revision survives log export.
 *
 * @param {unknown} value Diagnostic value.
 * @param {object} [options={}] Clone limits.
 * @param {number} [options.maxDepth=8] Maximum object nesting depth.
 * @param {number} [options.maxArray=250] Maximum retained array entries.
 * @param {number} [options.maxKeys=200] Maximum retained object keys.
 * @returns {unknown}
 */
function jsonSafe(value, { maxDepth = 8, maxArray = 250, maxKeys = 200 } = {}) {
  const ancestors = new WeakSet();

  const clone = (candidate, depth) => {
    if (candidate === null || candidate === undefined) return candidate ?? null;
    if (typeof candidate === "string" || typeof candidate === "boolean") return candidate;
    if (typeof candidate === "number") return Number.isFinite(candidate) ? candidate : String(candidate);
    if (typeof candidate === "bigint") return candidate.toString();
    if (typeof candidate === "function") return `[Function ${candidate.name || "anonymous"}]`;
    if (typeof candidate !== "object") return String(candidate);
    if (candidate instanceof Error) {
      return {
        name: candidate.name,
        message: candidate.message,
        stack: candidate.stack ?? null
      };
    }
    if (depth >= maxDepth) {
      return `[MaxDepth:${candidate?.constructor?.name ?? "Object"}]`;
    }
    if (ancestors.has(candidate)) return `[Circular:${candidate?.constructor?.name ?? "Object"}]`;
    ancestors.add(candidate);

    let result;
    if (Array.isArray(candidate)) {
      result = candidate.slice(0, maxArray).map(entry => clone(entry, depth + 1));
      if (candidate.length > maxArray) result.push(`[Truncated ${candidate.length - maxArray} entries]`);
    }
    else if (candidate instanceof Map) {
      result = Object.fromEntries(Array.from(candidate.entries()).slice(0, maxKeys).map(([key, entry]) => [String(key), clone(entry, depth + 1)]));
      if (candidate.size > maxKeys) result.__truncatedEntries = candidate.size - maxKeys;
    }
    else if (candidate instanceof Set) {
      result = Array.from(candidate.values()).slice(0, maxArray).map(entry => clone(entry, depth + 1));
      if (candidate.size > maxArray) result.push(`[Truncated ${candidate.size - maxArray} entries]`);
    }
    else {
      result = {};
      const constructorName = candidate?.constructor?.name;
      if (constructorName && constructorName !== "Object") result.__type = constructorName;
      const entries = Object.entries(candidate).slice(0, maxKeys);
      for (const [key, entry] of entries) {
        try {
          result[key] = clone(entry, depth + 1);
        }
        catch (error) {
          result[key] = `[Unreadable:${String(error?.message ?? error)}]`;
        }
      }
      const keyCount = Object.keys(candidate).length;
      if (keyCount > maxKeys) result.__truncatedKeys = keyCount - maxKeys;
    }

    ancestors.delete(candidate);
    return result;
  };

  try {
    return clone(value, 0);
  }
  catch (error) {
    return { serializationError: String(error?.stack ?? error?.message ?? error) };
  }
}

/**
 * Serialize a diagnostic entry for plain-text browser log export.
 *
 * @param {object} entry JSON-safe diagnostic entry.
 * @returns {string}
 */
function diagnosticJson(entry) {
  try {
    return JSON.stringify(entry);
  }
  catch (error) {
    return JSON.stringify({ serializationError: String(error?.message ?? error) });
  }
}

/**
 * Remember a diagnostic entry for later one-click export.
 *
 * @param {object} entry Diagnostic entry.
 * @param {string} severity Entry severity.
 * @returns {void}
 */
function rememberDebugEvent(entry, severity) {
  debugEvents.push({ severity, ...entry });
  while (debugEvents.length > MAX_DEBUG_EVENTS) debugEvents.shift();
}

/**
 * Emit a structured movement diagnostic.
 *
 * @param {string} category Category id.
 * @param {string} event Event label.
 * @param {unknown|Function} dataFactoryOrData Payload or lazy payload factory.
 * @param {object} [meta={}] Metadata.
 * @returns {void}
 */
export function movementDebug(category, event, dataFactoryOrData = {}, meta = {}) {
  if (!movementDebugEnabled(category, meta.level ?? MOVEMENT_DEBUG_LEVELS.SUMMARY)) return;
  const payload = resolveData(dataFactoryOrData);
  const entry = {
    timestamp: new Date().toISOString(),
    runId: meta.runId ?? currentRunId(),
    tick: meta.tick ?? null,
    combatId: meta.combatId ?? game.combat?.id ?? null,
    combatantId: meta.combatantId ?? null,
    tokenId: meta.tokenId ?? null,
    phase: meta.phase ?? null,
    category,
    event,
    ...payload && typeof payload === "object" && !Array.isArray(payload) ? payload : { value: payload }
  };
  const safeEntry = jsonSafe(entry);
  rememberDebugEvent(safeEntry, "debug");
  console.debug(`${PREFIX} | ${category}:${event} | ${diagnosticJson(safeEntry)}`, safeEntry);
}

/**
 * Emit a structured movement diagnostic warning.
 *
 * @param {string} category Category id.
 * @param {string} event Event label.
 * @param {unknown|Function} dataFactoryOrData Payload or lazy payload factory.
 * @param {object} [meta={}] Metadata.
 * @returns {void}
 */
export function movementDebugWarn(category, event, dataFactoryOrData = {}, meta = {}) {
  if (!movementDebugEnabled(category, meta.level ?? MOVEMENT_DEBUG_LEVELS.SUMMARY)) return;
  const payload = resolveData(dataFactoryOrData);
  const entry = {
    timestamp: new Date().toISOString(),
    runId: meta.runId ?? currentRunId(),
    tick: meta.tick ?? null,
    combatId: meta.combatId ?? game.combat?.id ?? null,
    combatantId: meta.combatantId ?? null,
    tokenId: meta.tokenId ?? null,
    phase: meta.phase ?? null,
    category,
    event,
    ...payload && typeof payload === "object" && !Array.isArray(payload) ? payload : { value: payload }
  };
  const safeEntry = jsonSafe(entry);
  rememberDebugEvent(safeEntry, "warn");
  console.warn(`${PREFIX} | ${category}:${event} | ${diagnosticJson(safeEntry)}`, safeEntry);
}

/**
 * Build a JSON-safe export of recently emitted movement diagnostics.
 *
 * @param {Combat|object|null} [combat=game.combat] Active combat.
 * @returns {object}
 */
export function movementDebugExport(combat = game.combat) {
  return {
    exportedAt: new Date().toISOString(),
    runId: currentRunId(),
    snapshot: movementDebugSnapshot(combat),
    events: jsonSafe(debugEvents)
  };
}

/**
 * Log and copy the current movement debug export when clipboard access exists.
 *
 * @param {Combat|object|null} [combat=game.combat] Active combat.
 * @returns {Promise<object>}
 */
export async function logMovementDebugExport(combat = game.combat) {
  const exported = movementDebugExport(combat);
  const text = JSON.stringify(exported, null, 2);
  console.groupCollapsed(`${PREFIX} | export`, exported.snapshot.combat);
  console.debug(text);
  console.groupEnd();
  try {
    await globalThis.navigator?.clipboard?.writeText?.(text);
    globalThis.ui?.notifications?.info?.(game.i18n.localize("AOV_SKJALDBORG.Settings.MovementDebugMenu.ExportCopied"));
  }
  catch (_err) {
    globalThis.ui?.notifications?.info?.(game.i18n.localize("AOV_SKJALDBORG.Settings.MovementDebugMenu.ExportLogged"));
  }
  return exported;
}

/**
 * Print a grouped current-state snapshot.
 *
 * @param {Combat|object|null} [combat=game.combat] Active combat.
 * @returns {object}
 */
export function logMovementDebugSnapshot(combat = game.combat) {
  const snapshot = movementDebugSnapshot(combat);
  console.groupCollapsed(`${PREFIX} | snapshot`, snapshot.combat);
  console.debug("settings", snapshot.settings);
  console.debug("combat", snapshot.combat);
  console.table(snapshot.combatants.map(combatant => ({
    id: combatant.id,
    name: combatant.name,
    tokenId: combatant.tokenId,
    tokenX: combatant.token?.x,
    tokenY: combatant.token?.y,
    movement: combatant.movement?.planStatus,
    waypoints: combatant.movement?.waypoints?.length ?? 0,
    engaged: combatant.engagement?.engaged === true,
    partners: combatant.engagement?.partnerIds?.join?.(",") ?? ""
  })));
  console.debug("combatants", snapshot.combatants);
  console.groupEnd();
  return snapshot;
}

export { MOVEMENT_DEBUG_CATEGORIES, MOVEMENT_DEBUG_DEFAULT_CATEGORIES, MOVEMENT_DEBUG_LEVELS };
