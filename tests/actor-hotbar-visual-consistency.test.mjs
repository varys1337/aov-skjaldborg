import assert from "node:assert/strict";
import fs from "node:fs";

const css = fs.readFileSync("styles/skjadlborg.css", "utf8");
const hotbar = fs.readFileSync("scripts/apps/actor-hotbar.mjs", "utf8");
const template = fs.readFileSync("templates/actor-hotbar.hbs", "utf8");
const manifest = JSON.parse(fs.readFileSync("module.json", "utf8"));
const constants = fs.readFileSync("scripts/constants.mjs", "utf8");
const moduleVersion = constants.match(/MODULE_VERSION\s*=\s*"([^"]+)"/)?.[1];

assert.equal(manifest.version, moduleVersion);
assert.match(css, /\.skj-named-action-groups\s*\{[^}]*align-content:\s*start;/s);
assert.match(css, /\.skj-named-action-groups\s*\{[^}]*background:\s*transparent;/s);
assert.match(css, /\.skj-named-action-groups\s*\{[^}]*border:\s*0;/s);
assert.match(css, /\.skj-named-action-groups\s*\{[^}]*grid-auto-rows:\s*max-content;/s);
assert.match(css, /\.skj-hotbar-layout\s*\{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*var\(--skj-quick-stage-size, 192px\) var\(--skj-hotbar-collapse-width\) minmax\(0, var\(--skj-hotbar-action-width, 420px\)\);/s);
assert.match(css, /\.skj-actor-actions\s*\{[^}]*grid-column:\s*3;[^}]*width:\s*var\(--skj-hotbar-action-width, 420px\);/s);
assert.doesNotMatch(css, /skj-combat-layout-active/);
assert.match(css, /\.skj-hotbar-header-row\s*\{[^}]*height:\s*var\(--skj-hotbar-header-height\);/s);

assert.match(css, /\.skj-hotbar-layout\s*\{[^}]*--skj-hotbar-total-height:\s*calc\(var\(--skj-quick-stage-size, 192px\) \+ 64px\);/s);
assert.match(css, /\.skj-actor-core\s*\{[^}]*height:\s*var\(--skj-hotbar-total-height\);/s);
assert.match(css, /\.skj-hotbar-layout\s*\{[^}]*--skj-hotbar-action-height:\s*calc\(var\(--skj-quick-stage-size, 192px\) \+ 42px\);/s);
assert.match(css, /\.skj-actor-actions\s*\{[^}]*height:\s*var\(--skj-hotbar-action-height\);/s);
assert.match(css, /\.skj-avatar-container\s*\{[^}]*height:\s*var\(--skj-quick-stage-size, 192px\);/s);
assert.match(css, /\.skj-avatar-container\s*\{[^}]*width:\s*var\(--skj-quick-stage-size, 192px\);/s);
assert.match(css, /\.skj-workflow-pips\s*\{[^}]*margin:\s*6px auto 0;/s);
assert.match(css, /\.skj-resource-current\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) auto minmax\(0, 1fr\);/s);
assert.match(css, /\.skj-actor-hotbar \.skj-resource-input\s*\{[^}]*height:\s*100%;/s);

process.stdout.write("actor hotbar visual consistency tests passed\n");


assert.match(hotbar, /TURN_DISPOSITION_PALETTES/);
assert.match(hotbar, /friendly:[\s\S]*?color: "#3399ff"/);
assert.match(hotbar, /neutral:[\s\S]*?color: "#e7bd32"/);
assert.match(hotbar, /hostile:[\s\S]*?color: "#e53935"/);
assert.match(hotbar, /resolveTurnDispositionPalette\(this\.combatant\)/);
assert.match(template, /--skj-turn-color: \{\{workflow\.turnColor\}\}/);
assert.match(css, /border-color:\s*var\(--skj-turn-color/);
