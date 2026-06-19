import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const app = fs.readFileSync(path.join(root, "scripts/apps/phase-structure-settings.mjs"), "utf8");
const settings = fs.readFileSync(path.join(root, "scripts/settings.mjs"), "utf8");
const template = fs.readFileSync(path.join(root, "templates/phase-structure-settings.hbs"), "utf8");
const tracker = fs.readFileSync(path.join(root, "scripts/hooks/tracker.mjs"), "utf8");
const hud = fs.readFileSync(path.join(root, "scripts/apps/combat-hud.mjs"), "utf8");

assert.match(settings, /registerMenu\(MODULE_ID, "phaseStructureConfiguration"/);
for (const key of [
  "phaseIntentEnabled",
  "phaseMovementEnabled",
  "phaseResolutionEnabled",
  "phaseBookkeepingEnabled"
]) {
  assert.match(fs.readFileSync(path.join(root, "scripts/constants.mjs"), "utf8"), new RegExp(key));
}
assert.match(app, /onStandardPreset/);
assert.match(app, /onStreamlinedPreset/);
assert.match(app, /\[PHASES\.RESOLUTION\]: true/);
assert.match(template, /name="\{\{name\}\}"/);
assert.match(template, /StreamlinedHint/);
assert.match(tracker, /getEnabledPhases\(\)/);
assert.match(hud, /getEnabledPhases\(\)/);

console.log("phase-structure-settings-layout ok");
