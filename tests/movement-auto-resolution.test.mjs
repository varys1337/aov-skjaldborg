import assert from "node:assert/strict";

function mergeObject(original, other) {
  const output = structuredClone(original ?? {});
  for (const [key, value] of Object.entries(other ?? {})) {
    if (value && typeof value === "object" && !Array.isArray(value)) output[key] = mergeObject(output[key] ?? {}, value);
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
  scene: { id: "scene-1", grid: { units: "ft", distance: 5, size: 100 }, tokens: { get: () => null } },
  tokens: { placeables: [], get: () => null }
};

const settings = {
  enabled: true,
  requireAllCommit: false,
  phaseIntentEnabled: true,
  phaseMovementEnabled: true,
  phaseResolutionEnabled: true,
  phaseBookkeepingEnabled: true,
  movementRounding: "ceil",
  movementTickDelayMs: 0,
  reportPhaseIntent: false,
  reportPhaseMovement: false,
  reportPhaseResolution: false,
  reportPhaseBookkeeping: false,
  movementDebugEnabled: false,
  movementDebugLevel: "summary",
  movementDebugCategories: {},
  debug: false,
  movementDebugLastRunId: ""
};

globalThis.game = {
  version: "13.351",
  release: { build: 351 },
  system: { id: "aov", version: "13.29" },
  user: { id: "gm", isGM: true },
  users: [],
  settings: {
    get: (_module, key) => settings[key] ?? false,
    set: async (_module, key, value) => { settings[key] = value; return value; }
  },
  i18n: {
    localize: key => key,
    format: (key, data) => `${key}:${JSON.stringify(data)}`
  }
};

globalThis.ui = {
  combat: { render: () => {} },
  notifications: { warn: () => {}, error: () => {} }
};
globalThis.Hooks = { callAll: () => {} };

let combatantFlag = {};
const combatant = {
  id: "combatant-1",
  name: "Combatant One",
  defeated: false,
  initiative: 15,
  actor: {
    id: "actor-1",
    type: "character",
    system: {
      abilities: { dex: { total: 15 }, int: { total: 10 } },
      move: { base: 8 },
      hp: { value: 10 }
    }
  },
  getFlag: () => combatantFlag,
  setFlag: async (_module, _key, value) => {
    combatantFlag = structuredClone(value);
    return value;
  }
};
const combatants = [combatant];
combatants.get = id => combatants.find(entry => entry.id === id) ?? null;

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
  update: async function update(data) { Object.assign(this, data); return this; },
  updateEmbeddedDocuments: async () => [],
  rollAll: async () => {}
};
game.combat = combat;

const { setCombatState, updateCombatantState, getCombatState } = await import("../scripts/combat/state.mjs");
const { PhaseController } = await import("../scripts/combat/phase-controller.mjs");

await updateCombatantState(combatant, {
  intent: { status: "committed", actionCategory: "attack", publicText: "Attack" }
});
await setCombatState(combat, {
  enabled: true,
  phase: "intent",
  logicalRound: 1,
  resolutionQueue: [],
  simultaneousGroups: [],
  carryover: [],
  bookkeepingLedger: [],
  archivedRounds: [],
  movementRun: { status: "none", startedAt: null, completedAt: null, pendingCombatantIds: [] }
});

const result = await PhaseController.advance(combat);
assert.equal(result.phase, "resolution", "Movement should remain active for execution and then continue automatically");
assert.equal(getCombatState(combat).phase, "resolution");
assert.equal(getCombatState(combat).movementRun.status, "completed");
assert.equal(combat.turn, 0, "Resolution starts at the first initiative entry rather than parking at the last");

console.log("movement-auto-resolution ok");
