import assert from "node:assert/strict";

globalThis.game = { settings: { get: () => false } };

const { AoVAdapter } = await import("../scripts/adapter/aov-adapter.mjs");
const player = { id: "player", isGM: false };
const gm = { id: "gm", isGM: true };

{
  const combatant = {
    isOwner: true,
    token: { testUserPermission: user => user.id === "other" },
    actor: { testUserPermission: user => user.id === "other" }
  };
  assert.equal(
    AoVAdapter.canUserControlCombatant(player, combatant),
    false,
    "the authoritative GM client's combatant.isOwner value must not grant a remote player access"
  );
}

{
  const combatant = {
    isOwner: false,
    token: { testUserPermission: user => user.id === "player" },
    actor: { testUserPermission: () => false }
  };
  assert.equal(AoVAdapter.canUserControlCombatant(player, combatant), true);
}

{
  const combatant = {
    token: { testUserPermission: () => false },
    actor: { testUserPermission: user => user.id === "player" }
  };
  assert.equal(AoVAdapter.canUserControlCombatant(player, combatant), true);
  assert.equal(AoVAdapter.canUserControlCombatant(gm, combatant), true);
}

console.log("combatant-permission ok");
