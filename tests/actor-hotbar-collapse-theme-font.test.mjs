import assert from "node:assert/strict";
import fs from "node:fs";

const constants = fs.readFileSync("scripts/constants.mjs", "utf8");
const settings = fs.readFileSync("scripts/settings.mjs", "utf8");
const main = fs.readFileSync("scripts/main.mjs", "utf8");
const ring = fs.readFileSync("scripts/apps/action-ring.mjs", "utf8");
const hotbar = fs.readFileSync("scripts/apps/actor-hotbar.mjs", "utf8");
const template = fs.readFileSync("templates/actor-hotbar.hbs", "utf8");
const settingsTemplate = fs.readFileSync("templates/action-ui-settings.hbs", "utf8");
const css = fs.readFileSync("styles/skjadlborg.css", "utf8");
const language = JSON.parse(fs.readFileSync("lang/en.json", "utf8"));

assert.match(constants, /ACTION_UI_THEMES = Object\.freeze/);
assert.match(constants, /actionUiTheme: ACTION_UI_THEMES\.AOV/);
assert.match(constants, /actorHotbarCollapsed: false/);
assert.match(settings, /game\.settings\.register\(MODULE_ID, "actionUiTheme"/);
assert.match(settings, /game\.settings\.register\(MODULE_ID, "actorHotbarCollapsed"/);
assert.match(settingsTemplate, /name="actionUiTheme"/);
assert.match(main, /refreshActionRing: \(\) => ActionRing\.current\?\.render\(false\)/);
assert.match(ring, /classList\.toggle\("skj-theme-aov", theme === "aov"\)/);
assert.match(hotbar, /_applyThemeClass\(\)/);
assert.match(hotbar, /static async onToggleCollapse/);
assert.match(hotbar, /game\.settings\.set\(MODULE_ID, "actorHotbarCollapsed", !collapsed\)/);
assert.match(template, /data-action="toggleCollapse"/);
assert.match(template, /skj-hotbar-collapsed/);
assert.match(template, /class="skj-actor-actions" \{\{#if collapsed\}\}hidden/);
assert.match(css, /\.skj-hotbar-collapse-toggle\s*\{/);

assert.match(css, /\.skj-hotbar-layout\s*\{[^}]*--skj-hotbar-collapse-width:\s*10px;[^}]*--skj-hotbar-header-height:\s*29px;[^}]*--skj-hotbar-total-height:\s*calc\(var\(--skj-quick-stage-size, 192px\) \+ 64px\);[^}]*--skj-hotbar-action-height:\s*calc\(var\(--skj-quick-stage-size, 192px\) \+ 42px\);[^}]*--skj-hotbar-stage-height:\s*calc\(var\(--skj-hotbar-action-height\) - var\(--skj-hotbar-header-height\) - 2px\);[^}]*display:\s*grid;/s);
assert.match(css, /\.skj-actor-actions\s*\{[^}]*height:\s*var\(--skj-hotbar-action-height\);[^}]*min-height:\s*var\(--skj-hotbar-action-height\);/s);
assert.match(css, /\.skj-hotbar-header-row\s*\{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*minmax\(0, 1fr\) auto minmax\(0, 1fr\);[^}]*width:\s*100%;/s);
assert.match(css, /\.skj-hotbar-tabs\s*\{[^}]*grid-column:\s*2;[^}]*justify-content:\s*center;[^}]*justify-self:\s*center;/s);
assert.match(css, /\.skj-effect-row\s*\{[^}]*grid-column:\s*3;[^}]*justify-self:\s*end;/s);
assert.match(css, /\.skj-hotbar-collapsed \.skj-actor-actions\s*\{[^}]*display:\s*none\s*!important;/s);
assert.match(css, /\.skj-action-ring-app\.skj-theme-aov/);
assert.match(css, /\.skj-theme-aov \.skj-resource-card/);
assert.match(css, /\.skj-actor-hotbar\.skj-theme-classic \.skj-avatar-button[\s\S]*background-image:\s*none;/);
assert.match(css, /\.skj-actor-hotbar \.skj-named-action\s*\{\s*font-size:\s*11px;/);
assert.match(css, /\.skj-actor-hotbar \.skj-stat-row[\s\S]*font-size:\s*10px;/);
assert.equal(language.AOV_SKJADLBORG.Settings.ActionUiTheme.Aov, "Age of Vikings");
assert.equal(language.AOV_SKJADLBORG.Settings.ActionUiTheme.Classic, "Classic");
assert.ok(language.AOV_SKJADLBORG.ActorHotbar.Collapse);
assert.ok(language.AOV_SKJADLBORG.ActorHotbar.Expand);

process.stdout.write("actor hotbar collapse, theme, and font tests passed\n");

assert.match(css, /\.skj-hotbar-collapse-toggle\s*\{[^}]*grid-column:\s*2;[^}]*height:\s*42px;[^}]*position:\s*relative;[^}]*width:\s*var\(--skj-hotbar-collapse-width, 10px\);/s);
assert.match(css, /\.skj-hotbar-collapse-toggle\s*\{[^}]*align-self:\s*start;[^}]*margin:\s*calc\(38px \+ \(\(var\(--skj-quick-stage-size, 192px\) - 42px\) \/ 2\)\) 0 0;/s);
assert.match(css, /\.skj-combat-stage\s*\{[^}]*justify-content:\s*center;[^}]*overflow:\s*hidden;[^}]*padding:\s*5px 7px 4px;/s);
