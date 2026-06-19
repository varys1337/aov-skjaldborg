import assert from "node:assert/strict";

const values = {
  debug: true,
  movementDebugEnabled: false,
  movementDebugLevel: "summary",
  movementDebugCategories: {}
};

globalThis.game = {
  settings: {
    get: (_module, key) => values[key],
    set: async (_module, key, value) => { values[key] = value; return value; }
  }
};

const {
  movementDebugCategories,
  movementDebugEnabled
} = await import("../scripts/combat/movement-debugger.mjs");
const {
  MOVEMENT_DEBUG_CATEGORIES,
  MOVEMENT_DEBUG_LEVELS
} = await import("../scripts/constants.mjs");

const categories = movementDebugCategories();
for (const category of Object.values(MOVEMENT_DEBUG_CATEGORIES)) {
  assert.equal(categories[category], true);
  assert.equal(movementDebugEnabled(category, MOVEMENT_DEBUG_LEVELS.TRACE), true);
}

console.log("unified-debug-setting ok");
