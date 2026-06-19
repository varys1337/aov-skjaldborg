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
    mergeObject: (original, other) => mergeObject(original, other)
  }
};

globalThis.canvas = {
  scene: {
    grid: { units: "ft", distance: 5 }
  }
};

globalThis.game = {
  user: { id: "gm", isGM: true },
  settings: {
    get: (_module, key) => {
      if (key === "enabled") return true;
      if (key === "requireAllCommit") return true;
      if (key === "movementRounding") return "ceil";
      if (key === "debug" || key === "movementDebugEnabled") return false;
      return true;
    }
  },
  i18n: {
    localize: key => key,
    format: (key, data) => `${key}:${JSON.stringify(data)}`
  }
};

function actor(id, dex, int) {
  return {
    id,
    type: "character",
    system: {
      abilities: {
        dex: { total: dex },
        int: { total: int }
      },
      move: { base: 8, bonus: 0, penalty: 0 },
      hp: { value: 10 }
    }
  };
}

function combatant(id, name, representedActor) {
  let state = {};
  return {
    id,
    name,
    actor: representedActor,
    hidden: false,
    defeated: false,
    getFlag: () => state,
    setFlag: async (_module, _key, value) => {
      state = structuredClone(value);
      return value;
    }
  };
}

const first = combatant("c1", "First", actor("a1", 15, 12));
const second = combatant("c2", "Second", actor("a2", 13, 11));
const combatants = [first, second];
combatants.get = id => combatants.find(combatant => combatant.id === id) ?? null;

let combatState = {};
const initiativeUpdates = [];
const combat = {
  id: "combat-streamlined",
  uuid: "Combat.combat-streamlined",
  round: 1,
  turn: 0,
  combatants,
  getFlag: () => combatState,
  setFlag: async (_module, _key, value) => {
    // Yield so concurrent declarations overlap unless the queue serializer works.
    await new Promise(resolve => setImmediate(resolve));
    combatState = structuredClone(value);
    return value;
  },
  updateEmbeddedDocuments: async (_type, updates) => {
    initiativeUpdates.push(...updates);
    return updates;
  }
};

const { updateCombatantState, getCombatState } = await import("../scripts/combat/state.mjs");
const {
  buildResolutionQueue,
  refreshImmediateResolutionActions,
  setActionStatus
} = await import("../scripts/combat/resolution-queue.mjs");

await updateCombatantState(first, {
  intent: { status: "committed", actionCategory: "attack", splitCount: 1 },
  movement: { distance: 20 }
});
await updateCombatantState(second, {
  intent: { status: "committed", actionCategory: "magic", splitCount: 1 },
  movement: { distance: 0 }
});

await Promise.all([
  refreshImmediateResolutionActions(combat, first),
  refreshImmediateResolutionActions(combat, second)
]);

let state = getCombatState(combat);
assert.deepEqual(state.resolutionQueue.map(action => action.combatantId), ["c1", "c2"],
  "concurrent declarations must merge rather than overwrite one another");
assert.equal(state.resolutionQueue.find(action => action.combatantId === "c1").dex, 13,
  "20 feet of movement applies two AoV movement penalty units");
assert.equal(initiativeUpdates.length, 2);

const firstActionId = state.resolutionQueue.find(action => action.combatantId === "c1").id;
assert.equal(await setActionStatus(combat, firstActionId, "resolved"), true);
await updateCombatantState(first, { movement: { distance: 30 } });
await refreshImmediateResolutionActions(combat, first, { preserveStatus: true });
state = getCombatState(combat);
assert.equal(state.resolutionQueue.find(action => action.id === firstActionId).status, "resolved",
  "post-movement DEX refresh must not reopen an already resolved action");
assert.equal(state.resolutionQueue.find(action => action.id === firstActionId).dex, 12);

assert.equal(await setActionStatus(combat, firstActionId, "carryover"), true);
await updateCombatantState(first, { movement: { distance: 40 } });
await refreshImmediateResolutionActions(combat, first, { preserveStatus: true });
state = getCombatState(combat);
assert.equal(state.resolutionQueue.find(action => action.id === firstActionId).status, "carryover");
assert.equal(state.carryover.some(action => action.id === firstActionId), true,
  "a movement-driven queue refresh must preserve carryover registration");
assert.equal(await setActionStatus(combat, firstActionId, "resolved"), true);
state = getCombatState(combat);
assert.equal(state.carryover.some(action => action.id === firstActionId), false,
  "changing a carryover action to a terminal outcome must clear stale carryover state");

await updateCombatantState(second, { intent: { status: "uncommitted" } });
const rebuilt = await buildResolutionQueue(combat, { announcedOnly: true });
assert.deepEqual(rebuilt.queue.map(action => action.combatantId), ["c1"],
  "a new streamlined round must not manufacture default attacks for unannounced combatants");

console.log("streamlined-resolution-queue ok");
