import assert from "node:assert/strict";

const settings = new Map();
globalThis.game = {
  settings: {
    get: (_module, key) => settings.has(key) ? settings.get(key) : true
  }
};

const {
  PHASES,
  PHASE_STRUCTURE_SETTING_KEYS
} = await import("../scripts/constants.mjs");
const {
  canonicalTransitionPath,
  firstEnabledPhase,
  getEnabledPhases,
  isMovementPlanningPhase,
  isSequentialEnabledPhase,
  nextEnabledPhase,
  shouldExecuteMovementImmediately,
  shouldQueueResolutionImmediately
} = await import("../scripts/combat/phase-structure.mjs");

function configure(enabled) {
  for (const [phase, key] of Object.entries(PHASE_STRUCTURE_SETTING_KEYS)) {
    settings.set(key, enabled.includes(phase));
  }
}

configure([PHASES.INTENT, PHASES.MOVEMENT, PHASES.RESOLUTION, PHASES.BOOKKEEPING]);
assert.deepEqual(getEnabledPhases(), [
  PHASES.INTENT,
  PHASES.MOVEMENT,
  PHASES.RESOLUTION,
  PHASES.BOOKKEEPING
]);
assert.equal(firstEnabledPhase(), PHASES.INTENT);
assert.equal(nextEnabledPhase(PHASES.INTENT), PHASES.MOVEMENT);
assert.deepEqual(canonicalTransitionPath(PHASES.INTENT, PHASES.MOVEMENT), [PHASES.MOVEMENT]);
assert.equal(isSequentialEnabledPhase(PHASES.INTENT, PHASES.MOVEMENT), true);
assert.equal(isMovementPlanningPhase(PHASES.INTENT), true);
assert.equal(shouldExecuteMovementImmediately(PHASES.INTENT), false);
assert.equal(shouldQueueResolutionImmediately(), false);

configure([PHASES.INTENT, PHASES.RESOLUTION, PHASES.BOOKKEEPING]);
assert.deepEqual(getEnabledPhases(), [PHASES.INTENT, PHASES.RESOLUTION, PHASES.BOOKKEEPING]);
assert.equal(nextEnabledPhase(PHASES.INTENT), PHASES.RESOLUTION);
assert.deepEqual(canonicalTransitionPath(PHASES.INTENT, PHASES.RESOLUTION), [
  PHASES.MOVEMENT,
  PHASES.RESOLUTION
]);
assert.equal(isSequentialEnabledPhase(PHASES.INTENT, PHASES.RESOLUTION), true);
assert.equal(shouldExecuteMovementImmediately(PHASES.INTENT), true);
assert.equal(shouldQueueResolutionImmediately(), false);

configure([PHASES.INTENT, PHASES.MOVEMENT, PHASES.RESOLUTION]);
assert.equal(nextEnabledPhase(PHASES.RESOLUTION), PHASES.INTENT);
assert.deepEqual(canonicalTransitionPath(PHASES.RESOLUTION, PHASES.INTENT), [
  PHASES.BOOKKEEPING,
  PHASES.INTENT
]);

configure([PHASES.RESOLUTION]);
assert.deepEqual(getEnabledPhases(), [PHASES.RESOLUTION]);
assert.equal(firstEnabledPhase(), PHASES.RESOLUTION);
assert.equal(nextEnabledPhase(PHASES.RESOLUTION), PHASES.RESOLUTION);
assert.equal(isSequentialEnabledPhase(PHASES.RESOLUTION, PHASES.RESOLUTION, { forceCycle: true }), true);
assert.deepEqual(canonicalTransitionPath(PHASES.RESOLUTION, PHASES.RESOLUTION, { forceCycle: true }), [
  PHASES.BOOKKEEPING,
  PHASES.INTENT,
  PHASES.MOVEMENT,
  PHASES.RESOLUTION
]);
assert.equal(isMovementPlanningPhase(PHASES.RESOLUTION), true);
assert.equal(shouldExecuteMovementImmediately(PHASES.RESOLUTION), true);
assert.equal(shouldQueueResolutionImmediately(), true);

configure([PHASES.INTENT]);
assert.equal(shouldQueueResolutionImmediately(), true, "omitting Resolution requires announce-and-act queueing");

configure([]);
assert.deepEqual(getEnabledPhases(), [PHASES.RESOLUTION], "malformed empty settings must retain a safe initiative phase");

console.log("phase-structure ok");
