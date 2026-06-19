import assert from "node:assert/strict";
import fs from "node:fs";

const hotbar = fs.readFileSync("scripts/apps/actor-hotbar.mjs", "utf8");
const catalog = fs.readFileSync("scripts/ui/action-catalog.mjs", "utf8");
const settings = fs.readFileSync("scripts/settings.mjs", "utf8");
const constants = fs.readFileSync("scripts/constants.mjs", "utf8");
const settingsApp = fs.readFileSync("scripts/apps/action-ui-settings.mjs", "utf8");
const template = fs.readFileSync("templates/actor-hotbar.hbs", "utf8");
const settingsTemplate = fs.readFileSync("templates/action-ui-settings.hbs", "utf8");
const css = fs.readFileSync("styles/skjadlborg.css", "utf8");
const language = JSON.parse(fs.readFileSync("lang/en.json", "utf8"));

assert.match(hotbar, /\{ id: "stats", label: "AOV_SKJADLBORG\.ActorHotbar\.Tabs\.Stats" \}/);
assert.match(hotbar, /prepareActorStats\(this\.actor\)/);
assert.match(hotbar, /executeActorStat\(this\.actor, actionId, event\)/);
assert.match(catalog, /export function prepareActorStats\(actor\)/);
assert.match(catalog, /ability:\$\{key\}/);
assert.match(catalog, /\/systems\/aov\/system\/apps\/roll-types\.mjs/);
assert.match(catalog, /AOVRollType\._onDetermineCheck\(event \?\? \{\}, detail, actor\)/);
assert.match(template, /data-tab="stats"/);
assert.match(template, /data-action-kind="stat"/);
assert.match(template, /skj-stat-groups/);
assert.match(template, /skj-stat-characteristic-grid/);
assert.match(template, /skj-stat-social-grid/);
assert.match(template, /skj-identity-grid/);

assert.doesNotMatch(template, /skj-workflow-pips-core/);
assert.match(template, /skj-workflow-pips-combat/);
assert.match(template, /skj-combat-stage/);
assert.doesNotMatch(hotbar, /_syncTabLayoutMode/);
assert.doesNotMatch(hotbar, /_activateTabLayoutSync/);
assert.doesNotMatch(css, /skj-combat-layout-active/);
assert.match(css, /\.skj-combat-stage\s*\{[^}]*justify-content:\s*center;[^}]*overflow:\s*hidden;/s);

assert.match(constants, /actorHotbarOpacity: 100/);
assert.match(constants, /actorHotbarOpacity: Object\.freeze\(\{ min: 0, max: 100, step: 5 \}\)/);
assert.match(settings, /game\.settings\.register\(MODULE_ID, "actorHotbarOpacity"/);
assert.match(settingsApp, /game\.settings\.get\(MODULE_ID, "actorHotbarOpacity"\)/);
assert.match(settingsTemplate, /type="range"[\s\S]*name="actorHotbarOpacity"/);
assert.match(settingsTemplate, /data-actor-hotbar-opacity-value/);
assert.match(hotbar, /--skj-hotbar-rest-opacity/);
assert.match(css, /opacity: var\(--skj-hotbar-rest-opacity, 1\)/);
assert.equal(language.AOV_SKJADLBORG.Settings.ActorHotbarOpacity.Name, "Actor hotbar resting opacity");
assert.equal(language.AOV_SKJADLBORG.ActorHotbar.Tabs.Stats, "Statistics");

process.stdout.write("actor hotbar stats and opacity tests passed\n");
