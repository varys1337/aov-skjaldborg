import assert from "node:assert/strict";

function mergeObject(original, other) {
  const output = structuredClone(original ?? {});
  for (const [key, value] of Object.entries(other ?? {})) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      output[key] = mergeObject(output[key] ?? {}, value);
    }
    else output[key] = structuredClone(value);
  }
  return output;
}

globalThis.foundry = {
  utils: {
    deepClone: value => structuredClone(value),
    mergeObject,
    randomID: () => "test-id"
  }
};

globalThis.canvas = {
  scene: { grid: { units: "ft", distance: 5, size: 100 } },
  tokens: { placeables: [] }
};

const settings = {
  enabled: true,
  requireAllCommit: true,
  phaseIntentEnabled: false,
  phaseMovementEnabled: false,
  phaseResolutionEnabled: true,
  phaseBookkeepingEnabled: false,
  movementRounding: "ceil",
  movementTickDelayMs: 0,
  reportPhaseIntent: false,
  reportPhaseMovement: false,
  reportPhaseResolution: false,
  reportPhaseBookkeeping: false,
  movementDebugEnabled: false
};

globalThis.game = {
  user: { id: "gm", isGM: true },
  users: [],
  settings: { get: (_module, key) => settings[key] ?? false },
  i18n: {
    localize: key => key,
    format: (key, data) => `${key}:${JSON.stringify(data)}`
  }
};

globalThis.ui = {
  combat: { render: () => {} },
  notifications: { warn: () => {}, error: () => {} }
};

const hookCalls = [];
globalThis.Hooks = {
  callAll: (...args) => hookCalls.push(args)
};

function createCombatant(id) {
  let flag = {};
  return {
    id,
    name: id,
    defeated: false,
    actor: {
      id: `actor-${id}`,
      type: "character",
      system: {
        abilities: { dex: { total: 15 }, int: { total: 10 } },
        move: { base: 8 },
        hp: { value: 10 }
      }
    },
    getFlag: () => flag,
    setFlag: async (_module, _key, value) => {
      flag = structuredClone(value);
      return value;
    }
  };
}

const combatant = createCombatant("combatant-1");
const combatants = [combatant];
combatants.get = id => combatants.find(candidate => candidate.id === id) ?? null;

let combatFlag = {};
const combat = {
  id: "combat-1",
  uuid: "Combat.combat-1",
  started: true,
  round: 1,
  turn: 0,
  combatants,
  turns: combatants,
  get combatant() { return combatants[this.turn] ?? null; },
  get nextCombatant() { return null; },
  getFlag: () => combatFlag,
  setFlag: async (_module, _key, value) => {
    combatFlag = structuredClone(value);
    return value;
  },
  unsetFlag: async () => { combatFlag = {}; },
  update: async function update(data) {
    Object.assign(this, data);
    return this;
  },
  updateEmbeddedDocuments: async () => [],
  rollAll: async () => {}
};

const {
  getCombatState,
  getCombatantState,
  setCombatState,
  updateCombatantState
} = await import("../scripts/combat/state.mjs");
const { PhaseController } = await import("../scripts/combat/phase-controller.mjs");

await updateCombatantState(combatant, {
  intent: { status: "committed", actionCategory: "attack" }
});
await setCombatState(combat, {
  enabled: true,
  phase: "resolution",
  logicalRound: 1,
  resolutionQueue: [{
    id: "combatant-1-1",
    combatantId: "combatant-1",
    actorName: "combatant-1",
    label: "attack",
    status: "resolved",
    dex: 15,
    int: 10
  }],
  simultaneousGroups: [],
  carryover: [],
  bookkeepingLedger: [],
  archivedRounds: []
});

await PhaseController.advance(combat);

const state = getCombatState(combat);
assert.equal(state.phase, "resolution", "the one-phase cycle remains on Resolution");
assert.equal(state.logicalRound, 2);
assert.equal(combat.round, 3, "AoV raw round advances to the next odd Intent-compatible round");
assert.equal(state.archivedRounds.length, 1);
assert.equal(state.archivedRounds[0].queue[0].status, "resolved");
assert.equal(state.archivedRounds[0].bookkeepingLedger[0].status, "resolved",
  "Bookkeeping must run before round reset in a compressed cycle");
assert.deepEqual(state.resolutionQueue, [],
  "the new round must not manufacture actions before participants announce them");
assert.equal(getCombatantState(combatant).intent.status, "uncommitted");
assert.equal(hookCalls.length, 1);
assert.equal(hookCalls[0][0], "aovSkjadlborgImmediateBookkeeping");
assert.equal(hookCalls[0][3].reason, "phase-disabled");

console.log("streamlined-phase-cycle ok");
