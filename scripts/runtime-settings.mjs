import {
  ENGAGEMENT_VISUAL_MODE_DEFAULT,
  MOVEMENT_DEBUG_DEFAULT_CATEGORIES,
  MOVEMENT_DEBUG_LEVELS,
  MOVEMENT_PLAN_VISIBILITY_DEFAULT,
  MODULE_ID,
  ROUNDING_POLICIES
} from "./constants.mjs";

const DEFAULTS = Object.freeze({
  adaptiveCheckpointBatching: false,
  adaptiveCheckpointMaxBatchSize: 1,
  debug: false,
  dynamicPlanningInitiative: false,
  enabled: false,
  engagementVisualMode: ENGAGEMENT_VISUAL_MODE_DEFAULT,
  evadeFightingDefensively: false,
  autoIncrementReactions: false,
  movementDebugCategories: MOVEMENT_DEBUG_DEFAULT_CATEGORIES,
  movementDebugEnabled: false,
  movementDebugLevel: MOVEMENT_DEBUG_LEVELS.SUMMARY,
  movementDebugLastRunId: "",
  movementPlanVisibility: MOVEMENT_PLAN_VISIBILITY_DEFAULT,
  movementRounding: ROUNDING_POLICIES.CEIL,
  movementTickDelayMs: 250,
  performanceDiagnostics: false,
  requireAllCommit: false
});

const runtimeSettingsData = globalThis.foundry?.utils?.deepClone?.(DEFAULTS) ?? JSON.parse(JSON.stringify(DEFAULTS));
const registeredKeys = new Set(Object.keys(DEFAULTS));

function safeReadSetting(key, fallback = DEFAULTS[key]) {
  try {
    return game.settings?.get?.(MODULE_ID, key) ?? fallback;
  }
  catch (_exception) {
    return fallback;
  }
}

function normalizeSettingValue(key, value) {
  if (key === "movementDebugCategories") {
    return {
      ...MOVEMENT_DEBUG_DEFAULT_CATEGORIES,
      ...(value && typeof value === "object" && !Array.isArray(value) ? value : {})
    };
  }
  if (key === "movementDebugLevel") {
    return Object.values(MOVEMENT_DEBUG_LEVELS).includes(value) ? value : MOVEMENT_DEBUG_LEVELS.SUMMARY;
  }
  if (key === "movementTickDelayMs") {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? Math.max(0, numeric) : DEFAULTS.movementTickDelayMs;
  }
  if (key === "adaptiveCheckpointMaxBatchSize") {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? Math.max(1, Math.min(5, Math.round(numeric))) : DEFAULTS.adaptiveCheckpointMaxBatchSize;
  }
  if (typeof DEFAULTS[key] === "boolean") return value === true;
  return value ?? DEFAULTS[key];
}

export function refreshRuntimeSetting(key, value = undefined) {
  if (!registeredKeys.has(key)) return runtimeSettingsData;
  const next = value === undefined ? safeReadSetting(key, DEFAULTS[key]) : value;
  runtimeSettingsData[key] = normalizeSettingValue(key, next);
  return runtimeSettingsData;
}

export function refreshRuntimeSettings() {
  for (const key of registeredKeys) refreshRuntimeSetting(key);
  return runtimeSettingsData;
}

export function runtimeSetting(key, fallback = DEFAULTS[key]) {
  return Object.prototype.hasOwnProperty.call(runtimeSettingsData, key) ? runtimeSettingsData[key] : fallback;
}

export const runtimeSettings = runtimeSettingsData;
export const RUNTIME_SETTING_DEFAULTS = DEFAULTS;
