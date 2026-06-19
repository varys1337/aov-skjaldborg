import assert from "node:assert/strict";

const settings = new Map([
  ["movementDebugEnabled", false],
  ["movementDebugLevel", "summary"],
  ["movementDebugCategories", {
    capture: true,
    socket: true,
    route: true,
    expansion: true,
    run: true,
    scheduler: true,
    collision: true,
    engagement: true,
    stop: true,
    status: true,
    dex: true
  }],
  ["movementDebugLastRunId", ""],
  ["movementTickDelayMs", 250]
]);

globalThis.game = {
  settings: {
    get: (_module, key) => settings.get(key),
    set: async (_module, key, value) => settings.set(key, value)
  },
  combat: null,
  i18n: { localize: key => key }
};
globalThis.ui = { notifications: { info: () => {} } };
globalThis.canvas = { scene: { tokens: new Map() } };
globalThis.foundry = {
  applications: {
    api: {
      ApplicationV2: class {},
      HandlebarsApplicationMixin: Base => class extends Base {}
    }
  },
  utils: { expandObject: object => object, deepClone: value => structuredClone(value) }
};

const debugCalls = [];
const warnCalls = [];
const originalConsole = {
  debug: console.debug,
  warn: console.warn,
  groupCollapsed: console.groupCollapsed,
  table: console.table,
  groupEnd: console.groupEnd
};
console.debug = (...args) => debugCalls.push(args);
console.warn = (...args) => warnCalls.push(args);
console.groupCollapsed = (...args) => debugCalls.push(["group", ...args]);
console.table = (...args) => debugCalls.push(["table", ...args]);
console.groupEnd = () => debugCalls.push(["groupEnd"]);

try {
  const {
    logMovementDebugExport,
    movementDebug,
    movementDebugExport,
    movementDebugSnapshot,
    newMovementDebugRunId
  } = await import("../scripts/combat/movement-debugger.mjs");
  const { normalizeCategories } = await import("../scripts/apps/movement-debug-settings.mjs");

  {
    let evaluated = false;
    movementDebug("capture", "disabled", () => {
      evaluated = true;
      return {};
    });
    assert.equal(evaluated, false);
    assert.equal(debugCalls.length, 0);
  }

  {
    settings.set("movementDebugEnabled", true);
    settings.set("movementDebugCategories", { capture: false });
    let evaluated = false;
    movementDebug("capture", "category-disabled", () => {
      evaluated = true;
      return {};
    });
    assert.equal(evaluated, false);
    assert.equal(debugCalls.length, 0);
  }

  {
    settings.set("movementDebugCategories", { capture: true });
    movementDebug("capture", "category-enabled", () => ({ ok: true }));
    assert.equal(debugCalls.length, 1);
    assert.match(debugCalls[0][0], /capture:category-enabled/);
    assert.match(debugCalls[0][0], /"ok":true/);
    assert.equal(debugCalls[0][1].ok, true);
    const exported = movementDebugExport();
    assert.equal(exported.events.at(-1).event, "category-enabled");
    assert.equal(exported.events.at(-1).ok, true);
  }

  {
    const combat = {
      id: "combat-1",
      round: 2,
      turn: 0,
      started: true,
      combatants: new Map([
        ["c1", {
          id: "c1",
          name: "Test",
          tokenId: "t1",
          actorId: "a1",
          flags: {
            "aov-skjadlborg": {
              combatantState: {
                movement: { planStatus: "planned", waypoints: [{ x: 1, y: 2 }] },
                engagement: { engaged: false, partnerIds: [] }
              }
            }
          },
          token: { id: "t1", x: 10, y: 20, width: 1, height: 1 }
        }]
      ]),
      flags: {
        "aov-skjadlborg": {
          combatState: { phase: "movement" }
        }
      }
    };
    const runId = newMovementDebugRunId(combat);
    assert.match(runId, /^move:combat-1:2:/);
    const snapshot = movementDebugSnapshot(combat);
    assert.equal(snapshot.combat.id, "combat-1");
    assert.equal(snapshot.combatants[0].movement.planStatus, "planned");
    assert.equal(snapshot.combatants[0].token.x, 10);
  }

  {
    assert.deepEqual(normalizeCategories({ capture: true, socket: false }), {
      capture: true,
      socket: false,
      route: false,
      expansion: false,
      run: false,
      scheduler: false,
      collision: false,
      engagement: false,
      stop: false,
      status: false,
      dex: false
    });
  }

  {
    const before = debugCalls.length;
    const exported = await logMovementDebugExport();
    assert.equal(exported.events.length > 0, true);
    assert.equal(debugCalls.length > before, true);
  }
}
finally {
  console.debug = originalConsole.debug;
  console.warn = originalConsole.warn;
  console.groupCollapsed = originalConsole.groupCollapsed;
  console.table = originalConsole.table;
  console.groupEnd = originalConsole.groupEnd;
}

console.log("movement-debugger ok");
