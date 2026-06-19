import assert from "node:assert/strict";

const hooks = new Map();
const emitted = [];

function users(items) {
  const map = new Map(items.map(user => [user.id, user]));
  map.find = predicate => items.find(predicate);
  return map;
}

globalThis.game = {
  system: { id: "aov" },
  user: { id: "gm", isGM: true },
  users: users([
    { id: "gm", isGM: true, active: true },
    { id: "player", isGM: false, active: true }
  ]),
  settings: {
    get: (_namespace, key) => key === "enabled"
  },
  socket: {
    emit: (...args) => emitted.push(args)
  },
  i18n: {
    localize: key => key
  }
};

globalThis.ui = {
  notifications: {
    error: () => {},
    warn: () => {}
  },
  combat: {
    render: () => {}
  }
};

globalThis.canvas = {
  scene: {
    grid: {
      units: "ft",
      distance: 5,
      size: 100
    }
  }
};

globalThis.foundry = {
  utils: {
    randomID: () => "request-1",
    deepClone: value => structuredClone(value),
    mergeObject: (original, other) => ({ ...original, ...other })
  }
};

globalThis.Hooks = {
  on: (name, callback) => hooks.set(name, callback)
};

const { PhaseController } = await import("../scripts/combat/phase-controller.mjs");
const { handleSocketResponse } = await import("../scripts/socket.mjs");
const {
  combatNavigationKind,
  isForwardCombatNavigation,
  registerCombatNavigationHooks
} = await import("../scripts/hooks/combat-navigation.mjs");

const combat = {
  id: "combat-1",
  uuid: "Combat.combat-1",
  started: true,
  round: 1,
  turn: 0
};

assert.equal(combatNavigationKind(combat, { turn: 1 }, { direction: 1 }), "turn");
assert.equal(combatNavigationKind(combat, { round: 2, turn: 0 }, { direction: 1 }), "round");
assert.equal(isForwardCombatNavigation(combat, { turn: 1 }, { direction: 1 }), true);
assert.equal(isForwardCombatNavigation(combat, { round: 2, turn: 0 }, { direction: 1 }), true);
assert.equal(isForwardCombatNavigation(combat, { turn: 0 }, { direction: -1 }), false);
assert.equal(isForwardCombatNavigation(combat, { flags: {} }, { direction: 1 }), false);
assert.equal(isForwardCombatNavigation({ ...combat, started: false }, { turn: 1 }, { direction: 1 }), false);

registerCombatNavigationHooks();
const callback = hooks.get("preUpdateCombat");
assert.equal(typeof callback, "function");

{
  let calls = 0;
  const original = PhaseController.advanceTurn;
  PhaseController.advanceTurn = async target => {
    calls += 1;
    assert.equal(target, combat);
    return null;
  };

  const result = callback(combat, { turn: 1 }, { direction: 1 }, "gm");
  assert.equal(result, false);
  await Promise.resolve();
  assert.equal(calls, 1);
  PhaseController.advanceTurn = original;
}


{
  let calls = 0;
  const original = PhaseController.advance;
  PhaseController.advance = async target => {
    calls += 1;
    assert.equal(target, combat);
    return null;
  };

  const result = callback(combat, { round: 2, turn: 0 }, { direction: 1 }, "gm");
  assert.equal(result, false);
  await Promise.resolve();
  assert.equal(calls, 1);
  PhaseController.advance = original;
}

{
  game.user = { id: "player", isGM: false };
  const result = callback(combat, { turn: 1 }, { direction: 1 }, "player");
  assert.equal(result, false);
  await Promise.resolve();
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0][1].action, "advanceTurn");
  assert.equal(emitted[0][1].payload.combatId, "combat-1");
  assert.equal(emitted[0][1].to, "gm");
  handleSocketResponse({
    type: "response",
    requestId: emitted[0][1].requestId,
    from: "gm",
    to: "player",
    ok: true
  });
}

{
  game.user = { id: "player", isGM: false };
  const result = callback(combat, { round: 2, turn: 0 }, { direction: 1 }, "player");
  assert.equal(result, false);
  await Promise.resolve();
  assert.equal(emitted.length, 2);
  assert.equal(emitted[1][1].action, "advancePhase");
  assert.equal(emitted[1][1].payload.combatId, "combat-1");
  assert.equal(emitted[1][1].payload.phase, null);
  handleSocketResponse({
    type: "response",
    requestId: emitted[1][1].requestId,
    from: "gm",
    to: "player",
    ok: true
  });
}

{
  game.user = { id: "gm", isGM: true };
  const result = callback(combat, { turn: 1 }, {
    direction: 1,
    "aov-skjadlborg": { internal: true }
  }, "gm");
  assert.equal(result, undefined);
}

process.stdout.write("combat navigation tests passed\n");
