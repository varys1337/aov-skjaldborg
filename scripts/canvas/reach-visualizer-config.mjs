import {
  MODULE_ID,
  REACH_VISUALIZER_DEFAULTS,
  REACH_VISUALIZER_LIMITS,
  REACH_VISUALIZER_SHAPE,
  REACH_VISUALIZER_VISIBILITY
} from "../constants.mjs";
import { normalizeNumberSetting } from "../utils/settings.mjs";

/**
 * Normalize reach visualizer client settings.
 *
 * @param {object|null|undefined} value Raw setting payload.
 * @returns {object}
 */
export function normalizeReachVisualizerSettings(value = {}) {
  const raw = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const visibility = Object.values(REACH_VISUALIZER_VISIBILITY).includes(raw.visibility)
    ? raw.visibility
    : REACH_VISUALIZER_DEFAULTS.visibility;
  const shape = Object.values(REACH_VISUALIZER_SHAPE).includes(raw.shape)
    ? raw.shape
    : REACH_VISUALIZER_DEFAULTS.shape;
  return {
    enabled: raw.enabled === true,
    visibility,
    shape,
    opacity: normalizeNumberSetting(raw.opacity, REACH_VISUALIZER_DEFAULTS.opacity, REACH_VISUALIZER_LIMITS.opacity),
    passiveOpacity: normalizeNumberSetting(
      raw.passiveOpacity,
      REACH_VISUALIZER_DEFAULTS.passiveOpacity,
      REACH_VISUALIZER_LIMITS.passiveOpacity
    ),
    activeOpacity: normalizeNumberSetting(
      raw.activeOpacity,
      REACH_VISUALIZER_DEFAULTS.activeOpacity,
      REACH_VISUALIZER_LIMITS.activeOpacity
    ),
    lineWidth: normalizeNumberSetting(raw.lineWidth, REACH_VISUALIZER_DEFAULTS.lineWidth, REACH_VISUALIZER_LIMITS.lineWidth)
  };
}

/**
 * Read normalized reach visualizer settings from the client store.
 *
 * @returns {object}
 */
export function getReachVisualizerSettings() {
  try {
    return normalizeReachVisualizerSettings(game.settings.get(MODULE_ID, "reachVisualizer"));
  } catch (_exception) {
    return normalizeReachVisualizerSettings(REACH_VISUALIZER_DEFAULTS);
  }
}

/**
 * Persist a partial reach visualizer settings patch.
 *
 * @param {object} patch Partial setting values.
 * @returns {Promise<object>} Normalized value written to settings.
 */
export async function setReachVisualizerSettings(patch = {}) {
  const next = normalizeReachVisualizerSettings({
    ...getReachVisualizerSettings(),
    ...(patch && typeof patch === "object" ? patch : {})
  });
  await game.settings.set(MODULE_ID, "reachVisualizer", next);
  return next;
}
