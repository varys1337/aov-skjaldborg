import assert from "node:assert/strict";

globalThis.canvas = {
  scene: { grid: { size: 100, distance: 1, units: "ft" } },
  grid: { size: 100 },
  interface: null
};
const phaseSettings = new Map();
globalThis.game = {
  settings: {
    get: (_module, key) => {
      if (key === "movementTickDelayMs") return 0;
      if (key === "movementDebugEnabled") return false;
      if (phaseSettings.has(key)) return phaseSettings.get(key);
      return 1;
    }
  },
  i18n: { localize: key => key },
  user: { isGM: true }
};
globalThis.foundry = {
  utils: {
    deepClone: value => structuredClone(value),
    mergeObject(original, other, { inplace = true } = {}) {
      const target = inplace ? original : structuredClone(original ?? {});
      for (const [key, value] of Object.entries(other ?? {})) {
        if (value && typeof value === "object" && !Array.isArray(value)) {
          const base = target[key] && typeof target[key] === "object" && !Array.isArray(target[key]) ? target[key] : {};
          target[key] = this.mergeObject(base, value, { inplace: true });
        }
        else target[key] = structuredClone(value);
      }
      return target;
    }
  }
};
globalThis.ui = { combat: null, notifications: { warn: () => {}, info: () => {} } };

const {
  measureOccupiedGridSeparation,
  movementPlanFromOperation,
  movementExecutionWaypoints,
  movementCheckpointBatch,
  mergeMovementRoutes,
  moveCombatTurnToLast,
  movementCaptureDecision,
  movementRouteFromOperation,
  movementRouteFromRulerData,
  normalizeMovementRoute,
  tokenSourceGridRect
} = await import("../scripts/combat/movement-controller.mjs");

{
  const route = normalizeMovementRoute({
    waypoints: [{ x: 100, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }, { x: 100, y: 100 }],
    destination: { x: 0, y: 0 }
  });
  assert.deepEqual(route.waypoints.map(point => [point.x, point.y]), [
    [100, 0],
    [100, 100],
    [0, 100],
    [100, 100],
    [0, 0]
  ]);
}

{
  const document = { id: "token-a", x: 1700, y: 2100, _source: { x: 1700, y: 2100 } };
  const movement = {
    id: "core-drag-movement",
    origin: { x: 1700, y: 2100 },
    // Foundry identifies the checkpoint currently being processed here. It is
    // not the final destination of the complete authored route.
    destination: { x: 1700, y: 2500 },
    passed: {
      waypoints: [
        { x: 1700, y: 2200, intermediate: true },
        { x: 1700, y: 2300, intermediate: true },
        { x: 1700, y: 2400, intermediate: true },
        { x: 1700, y: 2500, explicit: true, checkpoint: true }
      ]
    },
    pending: {
      waypoints: [
        { x: 1800, y: 2500, intermediate: true },
        { x: 1900, y: 2500, explicit: true, checkpoint: true },
        { x: 1900, y: 2400, intermediate: true },
        { x: 1900, y: 2300, intermediate: true },
        { x: 1900, y: 2200, intermediate: true },
        { x: 1900, y: 2100, explicit: true, checkpoint: true }
      ]
    }
  };
  const operation = {
    movement: {
      "token-a": {
        waypoints: [
          { x: 1700, y: 2500, explicit: true, checkpoint: true },
          { x: 1900, y: 2500, explicit: true, checkpoint: true },
          { x: 1900, y: 2100, explicit: true, checkpoint: true }
        ],
        method: "dragging"
      }
    }
  };

  const operationRoute = movementRouteFromOperation(document, operation);
  assert.equal(operationRoute.source, "operation.movement.token-a.waypoints");
  assert.deepEqual(operationRoute.waypoints.map(point => [point.x, point.y]), [
    [1700, 2500],
    [1900, 2500],
    [1900, 2100]
  ]);

  const plan = movementPlanFromOperation(document, movement, operation);
  assert.equal(plan.captureSource, "operation.movement.token-a.waypoints");
  assert.deepEqual(plan.waypoints.map(point => [point.x, point.y]), [
    [1700, 2500],
    [1900, 2500],
    [1900, 2100]
  ]);
  assert.deepEqual(plan.destination, { x: 1900, y: 2100 });
}

{
  const document = {
    x: 0,
    y: 0,
    movement: {
      waypoints: [{ x: 100, y: 0 }, { x: 100, y: 100 }]
    }
  };
  const route = normalizeMovementRoute({ destination: { x: 100, y: 100 } }, { document, origin: { x: 0, y: 0 } });
  assert.equal(route.source, "document.movement.waypoints");
  assert.deepEqual(route.waypoints.map(point => [point.x, point.y]), [
    [100, 0],
    [100, 100]
  ]);
}

{
  const document = { x: 0, y: 0 };
  const stalePassed = normalizeMovementRoute({
    origin: { x: 0, y: 0 },
    destination: { x: 200, y: 200 },
    passed: {
      waypoints: [
        { x: 100, y: 0 },
        { x: 100, y: 100 }
      ]
    }
  }, { document, origin: { x: 0, y: 0 } });
  assert.equal(stalePassed.source, "destination");
  assert.deepEqual(stalePassed.waypoints.map(point => [point.x, point.y]), [[200, 200]]);

  const staleRecorded = normalizeMovementRoute({
    origin: { x: 0, y: 0 },
    destination: { x: 300, y: 300 },
    history: {
      recorded: {
        waypoints: [
          { x: 100, y: 0 },
          { x: 100, y: 100 }
        ]
      }
    }
  }, { document, origin: { x: 0, y: 0 } });
  assert.equal(staleRecorded.source, "destination");
  assert.deepEqual(staleRecorded.waypoints.map(point => [point.x, point.y]), [[300, 300]]);
}

{
  const document = {
    x: 0,
    y: 0,
    movementHistory: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }]
  };
  const route = normalizeMovementRoute({ destination: { x: 100, y: 100 } }, { document, origin: { x: 0, y: 0 } });
  assert.equal(route.source, "document.movementHistory");
  assert.deepEqual(route.waypoints.map(point => [point.x, point.y]), [
    [100, 0],
    [100, 100]
  ]);

  const stale = normalizeMovementRoute({ destination: { x: 200, y: 200 } }, { document, origin: { x: 0, y: 0 } });
  assert.equal(stale.source, "destination");
  assert.deepEqual(stale.waypoints.map(point => [point.x, point.y]), [[200, 200]]);
}

{
  const document = {
    x: 0,
    y: 0,
    movement: { path: [{ x: 100, y: 0 }, { x: 100, y: 100 }] }
  };
  const plan = movementPlanFromOperation(document, { destination: { x: 100, y: 100 } });
  assert.deepEqual(plan.route.map(point => [point.x, point.y]), [
    [100, 0],
    [100, 100]
  ]);
  assert.deepEqual(plan.waypoints.map(point => [point.x, point.y]), [
    [100, 0],
    [100, 100]
  ]);
}


{
  const document = { x: 0, y: 0 };
  const plan = movementPlanFromOperation(
    document,
    { destination: { x: 100, y: 100 } },
    { waypoints: [{ x: 100, y: 0 }, { x: 100, y: 100 }] }
  );
  assert.deepEqual(plan.waypoints.map(point => [point.x, point.y]), [
    [100, 0],
    [100, 100]
  ]);
}



{
  const document = { x: 0, y: 0 };
  const movement = {
    id: "movement-v13-pending",
    origin: { x: 0, y: 0 },
    destination: { x: 200, y: 100 },
    pending: {
      waypoints: [
        { x: 0, y: 0, explicit: true, checkpoint: true },
        { x: 100, y: 0, explicit: true, checkpoint: true },
        { x: 200, y: 0, explicit: true, checkpoint: true },
        { x: 200, y: 100, explicit: true, checkpoint: true }
      ]
    },
    passed: { waypoints: [] },
    history: { recorded: { waypoints: [] }, unrecorded: { waypoints: [] } }
  };
  const normalized = normalizeMovementRoute(movement, { document, origin: movement.origin });
  assert.equal(normalized.source, "payload.pending.waypoints");
  assert.deepEqual(normalized.waypoints.map(point => [point.x, point.y]), [
    [100, 0],
    [200, 0],
    [200, 100]
  ]);

  const plan = movementPlanFromOperation(document, movement, { animate: true });
  assert.equal(plan.captureSource, "payload.pending.waypoints");
  assert.equal(plan.routeId, "movement-v13-pending");
  assert.deepEqual(plan.waypoints.map(point => [point.x, point.y]), [
    [100, 0],
    [200, 0],
    [200, 100]
  ]);
}

{
  const rulerData = {
    passedWaypoints: [{ x: -100, y: 0 }],
    pendingWaypoints: [{ x: 300, y: 300, explicit: true }],
    plannedMovement: {
      user1: {
        foundPath: [
          { x: 0, y: 0, explicit: false, checkpoint: false },
          { x: 100, y: 0, explicit: true, checkpoint: true },
          { x: 150, y: 0, explicit: false, checkpoint: false },
          { x: 200, y: 100, explicit: true, checkpoint: true }
        ],
        history: [{ x: -100, y: 0 }],
        searching: false,
        hidden: false,
        unreachableWaypoints: []
      }
    }
  };
  const route = movementRouteFromRulerData(rulerData, "user1");
  assert.equal(route.source, "plannedMovement.foundPath");
  assert.equal(route.plannedUserId, "user1");
  assert.deepEqual(route.explicitWaypoints.map(point => [point.x, point.y]), [
    [100, 0],
    [200, 100]
  ]);
  assert.deepEqual(route.pendingWaypoints.map(point => [point.x, point.y]), [[300, 300]]);
}

{
  const mergedFromCollapsedOperation = mergeMovementRoutes(
    [{ x: 100, y: 0 }, { x: 200, y: 0 }],
    [{ x: 100, y: 0 }],
    { x: 200, y: 100 }
  );
  assert.deepEqual(mergedFromCollapsedOperation.map(point => [point.x, point.y]), [
    [100, 0],
    [200, 0],
    [200, 100]
  ]);

  const authoritativeOperation = mergeMovementRoutes(
    [{ x: 100, y: 0 }, { x: 200, y: 0 }],
    [{ x: 50, y: 0 }, { x: 100, y: 0 }, { x: 150, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 100 }],
    { x: 200, y: 100 }
  );
  assert.deepEqual(authoritativeOperation.map(point => [point.x, point.y]), [
    [50, 0],
    [100, 0],
    [150, 0],
    [200, 0],
    [200, 100]
  ]);
}

{
  const waypoints = [
    { x: 100, y: 0, segmentIndex: 0 },
    { x: 200, y: 0, segmentIndex: 0 },
    { x: 200, y: 100, segmentIndex: 1 }
  ];
  assert.deepEqual(movementCheckpointBatch({ waypoints, index: 0 }), [waypoints[0]]);
  assert.deepEqual(movementCheckpointBatch({ waypoints, index: 1 }), [waypoints[1]]);
  assert.deepEqual(movementCheckpointBatch({ waypoints, index: 3 }), []);
}

{
  const origin = { x: 0, y: 0, width: 1, height: 1 };
  const orthogonal = { x: 100, y: 0, width: 1, height: 1 };
  const diagonal = { x: 100, y: 100, width: 1, height: 1 };
  const gap = { x: 200, y: 0, width: 1, height: 1 };
  assert.equal(measureOccupiedGridSeparation(tokenSourceGridRect(origin), tokenSourceGridRect(orthogonal)), 1);
  assert.equal(measureOccupiedGridSeparation(tokenSourceGridRect(origin), tokenSourceGridRect(diagonal)), 1);
  assert.equal(measureOccupiedGridSeparation(tokenSourceGridRect(origin), tokenSourceGridRect(gap)), 2);
}

{
  const calls = [];
  const document = {
    x: 0,
    y: 0,
    width: 1,
    height: 1,
    getCompleteMovementPath(segment) {
      calls.push(segment.map(point => [point.x, point.y]));
      return segment;
    }
  };
  const waypoints = movementExecutionWaypoints(document, [{ x: 100, y: 0 }, { x: 100, y: 100 }]);
  assert.deepEqual(calls, [
    [[0, 0], [100, 0]],
    [[100, 0], [100, 100]]
  ]);
  assert.deepEqual(waypoints.map(point => [point.x, point.y]), [
    [100, 0],
    [100, 100]
  ]);
  assert.deepEqual(waypoints.map(point => point.segmentIndex), [0, 1]);
  assert.deepEqual(waypoints.map(point => point.explicitCorner), [true, true]);
}

{
  phaseSettings.set("phaseIntentEnabled", false);
  phaseSettings.set("phaseMovementEnabled", false);
  phaseSettings.set("phaseResolutionEnabled", true);
  phaseSettings.set("phaseBookkeepingEnabled", false);
  const combatantState = {
    intent: { actionCategory: "other" },
    engagement: { engaged: false }
  };
  const combatant = {
    id: "combatant-streamlined",
    tokenId: "token-streamlined",
    actor: { system: { hp: { value: 10 } } },
    getFlag: () => combatantState
  };
  const combat = {
    started: true,
    combatants: [combatant],
    round: 1,
    getFlag: () => ({
      enabled: true,
      phase: "resolution",
      movementRun: { status: "executing" }
    })
  };
  const decision = movementCaptureDecision({ id: "token-streamlined" }, {}, combat);
  assert.equal(decision.capture, true, "streamlined declarations remain capturable during another serialized run");
  assert.equal(decision.reason, "ok");
  phaseSettings.clear();
}

{
  const updates = [];
  const combat = {
    started: true,
    turn: 0,
    turns: [{ id: "a" }, { id: "b" }, { id: "c" }],
    async update(data, options) {
      updates.push({ data, options });
      this.turn = data.turn;
      return this;
    }
  };
  await moveCombatTurnToLast(combat);
  assert.equal(combat.turn, 2);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].options.turnEvents, false);
  assert.equal(updates[0].options["aov-skjadlborg"].internal, true);
  assert.equal(updates[0].options["aov-skjadlborg"].reason, "movement-complete-last-turn");
}

console.log("movement-controller ok");
