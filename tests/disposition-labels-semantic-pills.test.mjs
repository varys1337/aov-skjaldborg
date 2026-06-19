import assert from "node:assert/strict";
import fs from "node:fs";

const hotbar = fs.readFileSync("scripts/apps/actor-hotbar.mjs", "utf8");
const tracker = fs.readFileSync("scripts/hooks/tracker.mjs", "utf8");
const template = fs.readFileSync("templates/actor-hotbar.hbs", "utf8");
const css = fs.readFileSync("styles/skjadlborg.css", "utf8");
const constants = fs.readFileSync("scripts/constants.mjs", "utf8");
const manifest = JSON.parse(fs.readFileSync("module.json", "utf8"));

const constantVersion = constants.match(/MODULE_VERSION\s*=\s*"([^"]+)"/)?.[1];
assert.match(manifest.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
assert.equal(constantVersion, manifest.version);

assert.match(hotbar, /key: "friendly"[\s\S]*?labelColor: "#73c2ff"[\s\S]*?labelWeight: 800/);
assert.match(hotbar, /key: "neutral"[\s\S]*?labelColor: "#ffd54d"[\s\S]*?labelWeight: 900/);
assert.match(hotbar, /key: "hostile"[\s\S]*?labelColor: "#ff766d"[\s\S]*?labelWeight: 800/);
assert.match(hotbar, /dispositionKey: dispositionPalette\.key/);
assert.match(hotbar, /dispositionLabelColor: dispositionPalette\.labelColor/);
assert.match(hotbar, /dispositionLabelWeight: dispositionPalette\.labelWeight/);

assert.match(template, /data-disposition="\{\{workflow\.dispositionKey\}\}"/);
assert.match(template, /--skj-disposition-label: \{\{workflow\.dispositionLabelColor\}\}/);
assert.match(template, /--skj-disposition-label-weight: \{\{workflow\.dispositionLabelWeight\}\}/);

assert.match(css, /\.skj-actor-hotbar \.skj-stat-header,[\s\S]*?\.skj-actor-hotbar \.skj-equipment-header \{[\s\S]*?color: var\(--skj-disposition-label/);
assert.match(css, /text-shadow:[\s\S]*?-1px -1px 0 rgba\(0, 0, 0, 0\.92\)/);
assert.match(css, /\.skj-hotbar-layout\[data-disposition="neutral"\] \{[\s\S]*?--skj-disposition-label-weight: 900;/);
assert.doesNotMatch(css, /\.skj-actor-hotbar \.skj-stat-group h3[^{]*\{[^}]*color: var\(--skj-disposition-label/s);

assert.match(tracker, /const categoryClass = category \? `intent-\$\{category\}` : "intent-uncommitted";/);
assert.match(tracker, /skj-combatant-status \$\{status\} \$\{categoryClass\}/);
assert.match(css, /status-action\.intent-attack \{ --skj-indicator-accent: #e57a6b; \}/);
assert.match(css, /status-action\.intent-defend \{ --skj-indicator-accent: #78aee8; \}/);
assert.match(css, /status-action\.intent-magic \{ --skj-indicator-accent: #b78be3; \}/);
assert.match(css, /\.skj-tracker-indicator\.reactions \{[\s\S]*?--skj-indicator-accent: var\(--aov-title-font-colour, #66b596\);[\s\S]*?\}/);
assert.match(css, /\.skj-tracker-indicator\.movement \{ --skj-indicator-accent: #68c1b2; \}/);
assert.match(css, /\.skj-tracker-indicator\.readied-weapon \{ --skj-indicator-accent: #d8aa55; \}/);
assert.match(css, /\.skj-tracker-indicator > i \{[\s\S]*?color: var\(--skj-indicator-accent\);/);

process.stdout.write("disposition label and semantic tracker pill tests passed\n");
