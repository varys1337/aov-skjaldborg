import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const manifest = JSON.parse(fs.readFileSync(path.join(root, "module.json"), "utf8"));
const constants = fs.readFileSync(path.join(root, "scripts/constants.mjs"), "utf8");
const moduleVersion = constants.match(/MODULE_VERSION\s*=\s*"([^"]+)"/)?.[1];

function exists(relativePath) {
  return fs.existsSync(path.join(root, relativePath));
}

assert.equal(manifest.id, "aov-skjadlborg");
assert.equal(manifest.title, "Age of Vikings - Skjadlborg");
assert.equal(moduleVersion, manifest.version);
assert.deepEqual(manifest.authors, [{ name: "TPKomrade" }]);
assert.deepEqual(manifest.system, ["aov"]);
assert.equal(manifest.socket, true);
assert.ok(!("systems" in manifest), "module manifest must use system, not systems");
assert.ok(Array.isArray(manifest.esmodules));
assert.ok(Array.isArray(manifest.styles));
assert.ok(Array.isArray(manifest.languages));

for (const file of manifest.esmodules) assert.ok(exists(file), `missing esmodule ${file}`);
for (const file of manifest.styles) assert.ok(exists(file), `missing style ${file}`);
for (const language of manifest.languages) {
  assert.ok(exists(language.path), `missing language file ${language.path}`);
  JSON.parse(fs.readFileSync(path.join(root, language.path), "utf8"));
}

const restoredUiFiles = [
  "templates/combat-hud.hbs",
  "templates/action-ring.hbs",
  "templates/action-ui-settings.hbs",
  "templates/actor-hotbar.hbs",
  "scripts/apps/action-ring.mjs",
  "scripts/apps/action-ui-settings.mjs",
  "scripts/apps/actor-hotbar.mjs",
  "scripts/apps/combat-hud.mjs",
  "scripts/hooks/tracker.mjs",
  "scripts/hooks/combat-navigation.mjs",
  "scripts/canvas/intent-indicators.mjs",
  "scripts/ui/action-catalog.mjs",
  "tests/action-ui-layout.test.mjs",
  "tests/action-ui-settings.test.mjs",
  "tests/actor-hotbar-improvements.test.mjs",
  "tests/actor-resource-updates.test.mjs",
  "tests/actor-hotbar-stats-opacity.test.mjs",
  "tests/actor-hotbar-visual-consistency.test.mjs",
  "tests/actor-hotbar-equipment-layout.test.mjs",
  "tests/actor-hotbar-quick-access.test.mjs",
  "tests/actor-hotbar-collapse-theme-font.test.mjs",
  "tests/actor-hotbar-view-state-xp.test.mjs",
  "tests/combat-hud-layout.test.mjs",
  "tests/combat-navigation.test.mjs",
  "tests/token-hud-integration.test.mjs",
  "tests/token-intent-indicators.test.mjs",
  "tests/tracker-layout.test.mjs",
  "scripts/apps/phase-structure-settings.mjs",
  "scripts/combat/phase-structure.mjs",
  "templates/phase-structure-settings.hbs",
  "tests/phase-structure.test.mjs",
  "tests/phase-structure-settings-layout.test.mjs"
];

for (const file of restoredUiFiles) assert.ok(exists(file), `missing restored UI file ${file}`);

const engagementStatus = fs.readFileSync(path.join(root, "scripts/combat/engagement-status.mjs"), "utf8");
assert.match(engagementStatus, /const ENGAGED_EFFECT_ICON = "icons\/svg\/combat\.svg"/);
assert.ok(!exists("assets/engaged.svg"), "generated engaged asset must not be required");

process.stdout.write("module-structure tests passed\n");
