import assert from "node:assert/strict";
import fs from "node:fs";

const hotbar = fs.readFileSync("scripts/apps/actor-hotbar.mjs", "utf8");
const adapter = fs.readFileSync("scripts/adapter/aov-adapter.mjs", "utf8");
const catalog = fs.readFileSync("scripts/ui/action-catalog.mjs", "utf8");
const settings = fs.readFileSync("scripts/settings.mjs", "utf8");
const settingsApp = fs.readFileSync("scripts/apps/action-ui-settings.mjs", "utf8");
const template = fs.readFileSync("templates/actor-hotbar.hbs", "utf8");
const settingsTemplate = fs.readFileSync("templates/action-ui-settings.hbs", "utf8");
const css = fs.readFileSync("styles/skjadlborg.css", "utf8");
const language = JSON.parse(fs.readFileSync("lang/en.json", "utf8"));

assert.doesNotMatch(template, /data-hotbar-drag-handle/);
assert.match(hotbar, /const handle = this\.element\.querySelector\("\.skj-avatar-button"\)/);
assert.match(hotbar, /if \(event\.button !== 2\) return;/);
assert.match(hotbar, /_beginPositionDrag\(event\)/);
assert.match(hotbar, /game\.settings\.set\(MODULE_ID, "actorHotbarPosition", position\)/);
assert.match(hotbar, /_preferredSide\(anchor\)/);
assert.match(hotbar, /_setPositionFromAnchor\(anchor\)/);
assert.match(hotbar, /visiblePanelSpan/);
assert.match(hotbar, /fitExpanded = options\.fitExpanded \?\? !metrics\.collapsed/);
assert.match(hotbar, /_clampAnchor\(anchor\.left, anchor\.top, null, \{ fitExpanded: false \}\)/);
assert.match(hotbar, /document\.body\.append\(element\)/);
assert.match(settings, /game\.settings\.register\(MODULE_ID, "actorHotbarPosition"/);
assert.match(settings, /type: Object/);
assert.match(settingsApp, /onResetHotbarPosition/);
assert.match(settingsTemplate, /data-action="resetPosition"/);

assert.match(template, /class="skj-intent-grid"/);
assert.doesNotMatch(template, /data-drag-group="combat"/);
assert.match(css, /grid-template-columns: repeat\(5, 54px\)/);
assert.match(css, /grid-template-rows: repeat\(2, 42px\)/);
assert.match(css, /\.skj-intent-grid\s*\{[^}]*column-gap:\s*6px;[^}]*min-height:\s*90px;[^}]*row-gap:\s*6px;/s);
assert.match(hotbar, /combatActions: intentActions/);

assert.match(catalog, /category: String\(item\.system\?\.category/);
assert.match(hotbar, /prepareNamedGroups\(prepared\.skills, "skills"\)/);
assert.match(hotbar, /prepareNamedGroups\(prepared\.magic, "magic"\)/);
assert.match(template, /skj-named-action-groups/);
assert.match(template, /skj-named-action-label/);
assert.match(css, /grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/);
assert.doesNotMatch(template, /skillActions/);
assert.doesNotMatch(template, /magicActions/);

assert.match(hotbar, /const showMacroTab = game\.settings\.get\(MODULE_ID, "replaceCoreHotbar"\)/);
assert.match(template, /\{\{#if showMacroTab\}\}[\s\S]*data-tab="macros"/);

assert.match(template, /data-resource-input="\{\{id\}\}"/);
assert.match(hotbar, /AoVAdapter\.updateActorResource\(this\.actor, resource, input\.value\)/);
assert.match(adapter, /static async updateActorResource\(actor, resource, value\)/);
assert.match(adapter, /actor\.update\(\{ "system\.mp\.value": target \}\)/);
assert.match(adapter, /actor\.updateEmbeddedDocuments\("Item"/);
assert.match(adapter, /actor\.createEmbeddedDocuments\("Item"/);
assert.match(adapter, /actor\.deleteEmbeddedDocuments\("Item"/);
assert.match(adapter, /item\.type === "wound"/);
assert.match(adapter, /item\.type === "hitloc"/);

assert.equal(language.AOV_SKJADLBORG.ActorHotbar.Move, "Right-drag portrait to move actor hotbar");
assert.equal(language.AOV_SKJADLBORG.Settings.ActorHotbarPosition.Label, "Reset position");

assert.match(template, /skj-hotbar-tab-panel skj-combat-tab-panel/);
assert.match(template, /skj-hotbar-tab-panel skj-named-tab-panel/);
assert.match(css, /--skj-hotbar-stage-height: 211px/);
assert.match(css, /--skj-hotbar-total-height:\s*calc\(var\(--skj-quick-stage-size, 192px\) \+ 64px\)/);
assert.match(css, /\.skj-combat-tab-panel\.active[\s\S]*align-items: center/);
assert.match(css, /\.skj-named-tab-panel\.active[\s\S]*align-items: flex-start/);
assert.match(css, /grid-template-columns: minmax\(0, 1fr\) 54px/);
assert.match(css, /grid-template-rows: repeat\(2, 18px\)/);
assert.match(template, /workflow-status/);
assert.match(template, /workflow-dex/);
assert.match(template, /workflow-reactions/);
const openHudIndex = template.indexOf('data-action="openCombatHud"');
const tabOrder = [
  'data-tab="combat"',
  'data-tab="stats"',
  'data-tab="skills"',
  'data-tab="equip"',
  'data-tab="magic"',
  'data-tab="historyFamily"',
  'data-action="openCombatHud"',
  'data-tab="macros"'
].map(marker => template.indexOf(marker));
for (const index of tabOrder) assert.ok(index >= 0);
assert.ok(tabOrder.every((index, i) => i === 0 || index > tabOrder[i - 1]));
assert.ok(openHudIndex >= 0);

process.stdout.write("actor hotbar improvement tests passed\n");
