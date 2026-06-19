import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const settings = fs.readFileSync(path.join(root, "scripts/settings.mjs"), "utf8");
const app = fs.readFileSync(path.join(root, "scripts/apps/combat-tracking-settings.mjs"), "utf8");
const template = fs.readFileSync(path.join(root, "templates/combat-tracking-settings.hbs"), "utf8");
const phase = fs.readFileSync(path.join(root, "scripts/combat/phase-controller.mjs"), "utf8");

assert.match(settings, /registerMenu\(MODULE_ID, "combatTrackingConfiguration"/);
assert.doesNotMatch(settings, /registerMenu\(MODULE_ID, "movementDebugConfiguration"/);
assert.match(settings, /game\.settings\.register\(MODULE_ID, "requireAllCommit"[\s\S]*?config: false[\s\S]*?default: false/);
assert.match(app, /movementRounding/);
for (const name of ["requireAllCommit", "movementTickDelayMs", "shortReachGridUnits", "mediumReachGridUnits", "longReachGridUnits"]) {
  assert.match(template, new RegExp(`name="${name}"`));
}
assert.doesNotMatch(phase, /isSequentialPhase\(/);
assert.match(phase, /automaticTarget !== PHASES\.MOVEMENT/);

console.log("combat-tracking-settings-layout ok");
