import assert from "node:assert/strict";
import fs from "node:fs";

const settings = fs.readFileSync("scripts/settings.mjs", "utf8");
const constants = fs.readFileSync("scripts/constants.mjs", "utf8");
const app = fs.readFileSync("scripts/apps/action-ui-settings.mjs", "utf8");
const template = fs.readFileSync("templates/action-ui-settings.hbs", "utf8");
const styles = fs.readFileSync("styles/skjadlborg.css", "utf8");
const language = JSON.parse(fs.readFileSync("lang/en.json", "utf8"));

assert.match(settings, /registerMenu\(MODULE_ID, "actionUiConfiguration"/);
assert.match(settings, /type: ActionUiSettings/);
assert.match(settings, /restricted: false/);

for (const key of [
  "enableActionRing",
  "actionRingMaxItems",
  "enableActorHotbar",
  "replaceCoreHotbar",
  "actorHotbarScale",
  "actorHotbarActionWidth",
  "actorHotbarOpacity"
]) {
  assert.match(settings, new RegExp(`game\\.settings\\.register\\(MODULE_ID, "${key}"[\\s\\S]*?config: false`));
  assert.match(constants, new RegExp(`${key}:`));
  assert.match(app, new RegExp(`game\\.settings\\.get\\(MODULE_ID, "${key}"\\)`));
  assert.match(template, new RegExp(`name="${key}"`));
}


assert.match(constants, /ACTION_UI_MIGRATION_VERSION = 1/);
assert.match(constants, /actionRingMaxItems: Object\.freeze\(\{ min: 6, max: 12, step: 1 \}\)/);
assert.match(settings, /game\.settings\.register\(MODULE_ID, "actionUiMigrationVersion"[\s\S]*?scope: "client"[\s\S]*?config: false/);
assert.match(settings, /export async function migrateActionUiSettings\(\)/);
assert.match(settings, /Math\.min\(limits\.max, Math\.max\(limits\.min, Math\.round\(current\)\)\)/);
assert.match(settings, /game\.aovSkjadlborg\?\.ui\?\.refreshActorHotbar\?\.\(\)/);
assert.match(settings, /game\.aovSkjadlborg\?\.ui\?\.refreshActionRing\?\.\(\)/);

assert.match(app, /HandlebarsApplicationMixin\(ApplicationV2\)/);
assert.match(app, /ACTION_UI_DEFAULTS/);
assert.match(app, /ACTION_UI_LIMITS/);
assert.match(app, /normalizeNumber/);
assert.match(app, /Object\.entries\(values\)/);
assert.match(settings, /game\.settings\.register\(MODULE_ID, "actionUiTheme"[\s\S]*?type: String[\s\S]*?choices:/);
assert.match(constants, /ACTION_UI_THEMES/);
assert.match(app, /game\.settings\.get\(MODULE_ID, "actionUiTheme"\)/);
assert.match(template, /name="actionUiTheme"/);
assert.match(settings, /game\.settings\.register\(MODULE_ID, "actorHotbarCollapsed"[\s\S]*?type: Boolean/);
assert.match(settings, /game\.settings\.register\(MODULE_ID, "actorHotbarPosition"[\s\S]*?type: Object/);
assert.match(app, /onResetHotbarPosition/);
assert.match(template, /data-action="resetPosition"/);
assert.match(template, /ActionRingGroup/);
assert.match(template, /ActorHotbarGroup/);
assert.match(styles, /\.skj-action-ui-settings-content/);
assert.match(styles, /\.skj-action-ui-settings-form/);
assert.equal(language.AOV_SKJADLBORG.Settings.ActionUiMenu.Label, "Configure action interface");
assert.equal(language.AOV_SKJADLBORG.Settings.ActionUiMenu.ActionRingGroup.Name, "Token action ring");
assert.equal(language.AOV_SKJADLBORG.Settings.ActionUiMenu.ActorHotbarGroup.Name, "Selected-actor hotbar");

process.stdout.write("action UI settings tests passed\n");
