import assert from "node:assert/strict";

const {
  awaitCombatantWrites,
  enqueueCombatantWrite,
  hasPendingCombatantWrites,
  settleMovementWrites
} = await import("../scripts/combat/authoritative-write-queue.mjs");

{
  const order = [];
  let releaseDraft;
  const draftGate = new Promise(resolve => { releaseDraft = resolve; });
  let movement = { routeRevision: 0, draft: false };

  const draft = enqueueCombatantWrite("combat-a", "combatant-a", async () => {
    order.push("draft-start");
    await draftGate;
    movement = { routeRevision: 10, draft: true };
    order.push("draft-finish");
  }, { movement: true });

  const final = enqueueCombatantWrite("combat-a", "combatant-a", async () => {
    order.push("final-start");
    assert.equal(movement.routeRevision, 10, "final write must observe the completed draft write");
    movement = { routeRevision: 11, draft: false };
    order.push("final-finish");
  }, { movement: true });

  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(order, ["draft-start"]);
  assert.equal(hasPendingCombatantWrites("combat-a"), true);
  releaseDraft();
  await Promise.all([draft, final]);
  await awaitCombatantWrites("combat-a");

  assert.deepEqual(order, ["draft-start", "draft-finish", "final-start", "final-finish"]);
  assert.deepEqual(movement, { routeRevision: 11, draft: false });
  assert.equal(hasPendingCombatantWrites("combat-a"), false);
  assert.equal(await settleMovementWrites("combat-a", { quietMs: 1, timeoutMs: 20 }), true);
}

{
  const order = [];
  const first = enqueueCombatantWrite("combat-b", "combatant-b", async () => {
    order.push("failed");
    throw new Error("expected failure");
  });
  const second = enqueueCombatantWrite("combat-b", "combatant-b", async () => {
    order.push("recovered");
    return 42;
  });

  await assert.rejects(first, /expected failure/);
  assert.equal(await second, 42, "a rejected write must not poison the queue");
  assert.deepEqual(order, ["failed", "recovered"]);
}

console.log("authoritative-write-queue ok");
