import assert from "node:assert/strict";

globalThis.CONFIG = { statusEffects: {} };
globalThis.foundry = { utils: { deepClone: value => structuredClone(value) } };
globalThis.game = { i18n: { localize: key => key }, user: { isGM: true } };
globalThis.Hooks = { on: () => {} };
globalThis.ui = { combat: null };

const { engagedStatusEffectConfig, registerEngagedStatusEffect } = await import("../scripts/combat/engagement-status.mjs");

assert.equal(engagedStatusEffectConfig().img, "icons/svg/combat.svg");
registerEngagedStatusEffect();
assert.equal(CONFIG.statusEffects["aov-skjadlborg-engaged"].img, "icons/svg/combat.svg");

console.log("engagement-status ok");
