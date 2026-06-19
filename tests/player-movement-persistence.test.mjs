import assert from "node:assert/strict";

function mergeObject(original, other, { inplace = true } = {}) {
  const target = inplace ? original : structuredClone(original ?? {});
  for (const [key, value] of Object.entries(other ?? {})) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const base = target[key] && typeof target[key] === "object" && !Array.isArray(target[key])
        ? target[key]
        : {};
      target[key] = mergeObject(base, value, { inplace: true });
    } else target[key] = structuredClone(value);
  }
  return target;
}

function users(items) {
  const collection = new Map(items.map(user => [user.id, user]));
  collection.find = predicate => items.find(predicate);
  return collection;
}

const gm = { id: "gm", isGM: true, active: true };
const player = { id: "player", isGM: false, active: true };
let persistedState = {};

const combatant = {
  id: "combatant-a",
  name: "Player Warrior",
  token: {
    testUserPermission: user => user.id === player.id
  },
  actor: {
    testUserPermission: user => user.id === player.id
  },
  getFlag: () => structuredClone(persistedState),
  setFlag: async (_scope, _key, value) => {
    // Recreate the original race: draft writes are deliberately slower than
    // final writes. The authoritative queue must still preserve call order.
    await new Promise(resolve => setTimeout(resolve, value.movement?.draft ? 20 : 1));
    persistedState = structuredClone(value);
    return combatant;
  }
};

const combatants = new Map([[combatant.id, combatant]]);
combatants[Symbol.iterator] = function* () {
  yield* this.values();
};
const combat = {
  id: "combat-a",
  combatants,
  getFlag: () => null
};

globalThis.canvas = {
  scene: { grid: { size: 100, distance: 5, units: "ft" } },
  grid: { size: 100 }
};
globalThis.game = {
  user: gm,
  users: users([gm, player]),
  combat,
  combats: new Map([[combat.id, combat]]),
  settings: {
    get: (_namespace, key) => {
      if (key === "enabled") return false;
      if (["phaseIntentEnabled", "phaseMovementEnabled", "phaseResolutionEnabled", "phaseBookkeepingEnabled"].includes(key)) return true;
      return false;
    }
  },
  i18n: { localize: key => key }
};
globalThis.ui = { notifications: { warn: () => {}, error: () => {}, info: () => {} }, combat: null };
globalThis.foundry = {
  utils: {
    deepClone: value => structuredClone(value),
    mergeObject,
    randomID: () => "request"
  }
};

const { handleSocketRequest } = await import("../scripts/socket.mjs");
const { pendingMovementDraftNames } = await import("../scripts/combat/phase-controller.mjs");

function movement(routeRevision, draft) {
  return {
    origin: { x: 0, y: 0 },
    waypoints: [{ x: 100, y: 0 }, { x: 200, y: 0 }],
    destination: { x: 200, y: 0 },
    routeRevision,
    routeId: `route-${routeRevision}`,
    captureSource: draft ? "token-ruler-refresh" : "pre-move-token",
    capturedAt: routeRevision,
    draft,
    planStatus: "planned"
  };
}

{
  persistedState = {};
  const draftRequest = handleSocketRequest({
    action: "recordMovement",
    from: player.id,
    payload: { combatId: combat.id, combatantId: combatant.id, movement: movement(100, true) }
  });
  const finalRequest = handleSocketRequest({
    action: "recordMovement",
    from: player.id,
    payload: { combatId: combat.id, combatantId: combatant.id, movement: movement(101, false) }
  });

  await Promise.all([draftRequest, finalRequest]);
  assert.equal(persistedState.movement.routeRevision, 101);
  assert.equal(persistedState.movement.draft, false);
  assert.equal(persistedState.movement.routeId, "route-101");
  assert.deepEqual(pendingMovementDraftNames(combat), []);
}

{
  persistedState = {};
  await handleSocketRequest({
    action: "recordMovement",
    from: player.id,
    payload: { combatId: combat.id, combatantId: combatant.id, movement: movement(201, false) }
  });
  await handleSocketRequest({
    action: "recordMovement",
    from: player.id,
    payload: { combatId: combat.id, combatantId: combatant.id, movement: movement(200, true) }
  });

  assert.equal(persistedState.movement.routeRevision, 201);
  assert.equal(persistedState.movement.draft, false, "an older late-arriving draft must be ignored");
}

{
  persistedState = { movement: movement(300, true) };
  assert.deepEqual(pendingMovementDraftNames(combat), ["Player Warrior"]);
}

console.log("player-movement-persistence ok");
