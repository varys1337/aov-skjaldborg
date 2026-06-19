import {
  MODULE_ID,
  PHASE_ORDER,
  PHASE_STRUCTURE_SETTING_KEYS,
  PHASES
} from "../constants.mjs";

/**
 * Read one phase toggle. Missing values are treated as enabled so existing
 * worlds and lightweight test harnesses retain the original four-phase cycle.
 *
 * @param {string} phase Phase id.
 * @returns {boolean}
 */
export function isPhaseEnabled(phase) {
  const key = PHASE_STRUCTURE_SETTING_KEYS[phase];
  if (!key) return false;
  try {
    return game.settings.get(MODULE_ID, key) !== false;
  }
  catch (_exception) {
    return true;
  }
}

/**
 * Return the configured phase cycle in canonical rules order.
 *
 * Resolution is the final safety fallback if malformed external settings leave
 * no phase selected. The settings UI also prevents saving an empty structure.
 *
 * @returns {string[]}
 */
export function getEnabledPhases() {
  const phases = PHASE_ORDER.filter(isPhaseEnabled);
  return phases.length ? phases : [PHASES.RESOLUTION];
}

/**
 * Return the first configured phase in canonical order.
 *
 * @returns {string}
 */
export function firstEnabledPhase() {
  return getEnabledPhases()[0] ?? PHASES.RESOLUTION;
}

/**
 * Return the next configured phase after a canonical phase position.
 *
 * A one-phase streamlined cycle intentionally returns the same phase. Callers
 * distinguish an explicit same-phase request from a full-cycle advance.
 *
 * @param {string} current Current phase id.
 * @returns {string}
 */
export function nextEnabledPhase(current) {
  const enabled = new Set(getEnabledPhases());
  const start = PHASE_ORDER.indexOf(current);
  if (start < 0) return firstEnabledPhase();
  for (let offset = 1; offset <= PHASE_ORDER.length; offset += 1) {
    const phase = PHASE_ORDER[(start + offset) % PHASE_ORDER.length];
    if (enabled.has(phase)) return phase;
  }
  return firstEnabledPhase();
}

/**
 * List every canonical rules phase crossed by one configured transition.
 * Disabled phases remain in this path so their required automation can be run
 * at the boundary instead of being silently discarded.
 *
 * @param {string} current Current phase id.
 * @param {string} target Next configured phase id.
 * @param {{forceCycle?: boolean}} [options={}] Transition options.
 * @returns {string[]}
 */
export function canonicalTransitionPath(current, target, { forceCycle = false } = {}) {
  const start = PHASE_ORDER.indexOf(current);
  if (start < 0 || !PHASE_ORDER.includes(target)) return [target].filter(Boolean);
  if (current === target && !forceCycle) return [];

  const path = [];
  for (let offset = 1; offset <= PHASE_ORDER.length; offset += 1) {
    const phase = PHASE_ORDER[(start + offset) % PHASE_ORDER.length];
    path.push(phase);
    if (phase === target) return path;
  }
  return path;
}

/**
 * Determine whether a target is the legal next configured phase.
 *
 * @param {string} current Current phase id.
 * @param {string} target Candidate target phase id.
 * @param {{forceCycle?: boolean}} [options={}] Transition options.
 * @returns {boolean}
 */
export function isSequentialEnabledPhase(current, target, { forceCycle = false } = {}) {
  if (!getEnabledPhases().includes(target)) return false;
  if (current === target && !forceCycle) return false;
  return target === nextEnabledPhase(current);
}

/**
 * Whether movement declarations should be captured in the current structure.
 *
 * With Statement enabled, planning remains exclusive to Statement. If it is
 * omitted, the first configured phase becomes the compressed announce-and-act
 * surface used by Streamlined Combat.
 *
 * @param {string} phase Current phase id.
 * @returns {boolean}
 */
export function isMovementPlanningPhase(phase) {
  if (isPhaseEnabled(PHASES.INTENT)) return phase === PHASES.INTENT;
  return phase === firstEnabledPhase();
}

/**
 * Whether a newly persisted plan should execute immediately instead of waiting
 * for a later dedicated Movement phase.
 *
 * @param {string} phase Current phase id.
 * @returns {boolean}
 */
export function shouldExecuteMovementImmediately(phase) {
  if (!isMovementPlanningPhase(phase)) return false;
  return !isPhaseEnabled(PHASES.MOVEMENT) || !isPhaseEnabled(PHASES.INTENT);
}

/**
 * Whether announced actions must be inserted into the live Resolution queue
 * immediately instead of waiting for entry into a dedicated Resolution phase.
 *
 * This is required both by the Streamlined preset (Statement omitted) and by
 * custom structures which omit Resolution itself.
 *
 * @returns {boolean}
 */
export function shouldQueueResolutionImmediately() {
  return !isPhaseEnabled(PHASES.INTENT) || !isPhaseEnabled(PHASES.RESOLUTION);
}
