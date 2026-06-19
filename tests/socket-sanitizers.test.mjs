import assert from "node:assert/strict";

globalThis.canvas = {
  scene: { grid: { units: "ft" } }
};
globalThis.game = {
  settings: { get: () => false },
  i18n: { localize: key => key },
  users: [],
  user: { id: "gm", isGM: true }
};
globalThis.ui = { notifications: { warn: () => {}, info: () => {} }, combat: null };
globalThis.foundry = {
  utils: {
    deepClone: value => structuredClone(value),
    randomID: () => "request-1"
  }
};

const { handleSocketResponse, requestGm, sanitizeMovementPayload } = await import("../scripts/socket.mjs");

{
  const payload = sanitizeMovementPayload({
    origin: { x: 0, y: 0 },
    waypoints: [{ x: 100, y: 0 }],
    destination: { x: 100, y: 100 }
  });
  assert.deepEqual(payload.waypoints.map(point => [point.x, point.y]), [
    [100, 0],
    [100, 100]
  ]);
}

{
  const payload = sanitizeMovementPayload({
    origin: { x: 0, y: 0 },
    path: [{ x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }, { x: 100, y: 100 }],
    destination: { x: 0, y: 0 }
  });
  assert.deepEqual(payload.waypoints.map(point => [point.x, point.y]), [
    [100, 0],
    [100, 100],
    [0, 100],
    [100, 100],
    [0, 0]
  ]);
}


{
  const payload = sanitizeMovementPayload({
    id: "core-movement-id",
    origin: { x: 0, y: 0 },
    pending: {
      waypoints: [
        { x: 100, y: 0, explicit: true, checkpoint: true },
        { x: 200, y: 0, explicit: true, checkpoint: true }
      ]
    },
    destination: { x: 200, y: 100 },
    routeRevision: 42,
    routeId: "route-42",
    captureSource: "pre-move-token+ruler-draft",
    capturedAt: 123456,
    draft: true
  });
  assert.deepEqual(payload.waypoints.map(point => [point.x, point.y]), [
    [100, 0],
    [200, 0],
    [200, 100]
  ]);
  assert.equal(payload.routeRevision, 42);
  assert.equal(payload.routeId, "route-42");
  assert.equal(payload.captureSource, "pre-move-token+ruler-draft");
  assert.equal(payload.capturedAt, 123456);
  assert.equal(payload.draft, true);
}

{
  let emitted = null;
  game.user = { id: "player", isGM: false };
  game.users = [{ id: "gm", active: true, isGM: true }];
  game.socket = {
    emit: (_name, message) => { emitted = message; }
  };

  const request = requestGm("recordMovement", { combatId: "combat-a" });
  assert.equal(emitted.type, "request");
  assert.equal(emitted.to, "gm");
  assert.equal(handleSocketResponse({
    type: "response",
    requestId: emitted.requestId,
    from: "gm",
    to: "player",
    ok: true
  }), true);
  assert.equal(await request, true, "player requests must resolve only after GM acknowledgement");
}

console.log("socket-sanitizers ok");
