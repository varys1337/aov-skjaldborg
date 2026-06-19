import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const ring = fs.readFileSync(path.join(root, "scripts/apps/action-ring.mjs"), "utf8");
const hud = fs.readFileSync(path.join(root, "scripts/apps/combat-hud.mjs"), "utf8");
const adapter = fs.readFileSync(path.join(root, "scripts/adapter/aov-adapter.mjs"), "utf8");
const settings = fs.readFileSync(path.join(root, "scripts/settings.mjs"), "utf8");
const main = fs.readFileSync(path.join(root, "scripts/main.mjs"), "utf8");
const lang = fs.readFileSync(path.join(root, "lang/en.json"), "utf8");

assert.doesNotMatch(ring, /Hooks\.on\("controlToken"[^]*CombatHUD\.showForCombatant/);
assert.doesNotMatch(settings, /autoOpenHud/);
assert.doesNotMatch(lang, /AutoOpenHud/);
assert.doesNotMatch(main, /openHud:/);

assert.match(adapter, /static getCombatantForToken\(combat, token\)/);
assert.match(ring, /Hooks\.on\("renderTokenHUD"/);
assert.match(ring, /button\[data-action="config"\]/);
assert.match(ring, /configControl\.insertAdjacentElement\("afterend", control\)/);
assert.match(ring, /data-skj-token-hud/);
assert.match(ring, /ActionRing\.openForTokenHud\(token, control\)/);
assert.match(ring, /canvas\.clientCoordinatesFromCanvas\(center\)/);
assert.match(ring, /const anchor = ActionRing\.getTokenViewportCenter\(this\.token, this\.fallbackPosition\)/);
assert.doesNotMatch(ring, /this\.basePosition/);
assert.doesNotMatch(ring, /tokenHud\?\.element\?\.getBoundingClientRect/);
assert.match(ring, /sourceControl\?\.getBoundingClientRect/);
assert.match(ring, /style\.setProperty\("position", "fixed", "important"\)/);
assert.match(ring, /await app\.close\(\{ animate: false \}\)/);
assert.match(ring, /contextmenu/);

assert.match(ring, /const actions = prepareActorQuickAccess\(this\.actor\)\.slots/);
assert.doesNotMatch(ring, /const actions = inWorkflow[\s\S]*prepareIntentActions\(\)/);
assert.match(ring, /hint: game\.i18n\.localize\("AOV_SKJADLBORG\.ActionRing\.QuickAccessHint"\)/);
assert.doesNotMatch(ring, /inWorkflow && !AoVAdapter\.canUserControlCombatant/);
assert.match(ring, /CombatHUD\.showForCombatant\(combatant, combat\)/);
assert.match(hud, /initialActionCategory/);

process.stdout.write("token HUD integration tests passed\n");
