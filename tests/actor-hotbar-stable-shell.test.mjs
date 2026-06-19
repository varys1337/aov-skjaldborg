import assert from "node:assert/strict";
import fs from "node:fs";

const hotbar = fs.readFileSync("scripts/apps/actor-hotbar.mjs", "utf8");
const template = fs.readFileSync("templates/actor-hotbar.hbs", "utf8");
const css = fs.readFileSync("styles/skjadlborg.css", "utf8");

assert.match(css, /\.skj-hotbar-layout\s*\{[^}]*--skj-hotbar-collapse-width:\s*10px;[^}]*display:\s*grid;[^}]*grid-template-columns:\s*var\(--skj-quick-stage-size, 192px\) var\(--skj-hotbar-collapse-width\) minmax\(0, var\(--skj-hotbar-action-width, 420px\)\);/s);
assert.match(css, /\.skj-hotbar-side-left \.skj-hotbar-layout\s*\{[^}]*grid-template-columns:\s*minmax\(0, var\(--skj-hotbar-action-width, 420px\)\) var\(--skj-hotbar-collapse-width\) var\(--skj-quick-stage-size, 192px\);/s);
assert.match(css, /\.skj-actor-actions\s*\{[^}]*grid-column:\s*3;[^}]*height:\s*var\(--skj-hotbar-action-height\);[^}]*overflow:\s*hidden;[^}]*width:\s*var\(--skj-hotbar-action-width, 420px\);/s);
assert.match(css, /\.skj-hotbar-side-left \.skj-actor-actions\s*\{[^}]*grid-column:\s*1;/s);
assert.match(css, /\.skj-hotbar-tab-panel\s*\{[^}]*max-width:\s*100%;[^}]*min-width:\s*0;[^}]*overflow:\s*hidden;[^}]*width:\s*100%;/s);
assert.match(css, /\.skj-named-action-groups\s*\{[^}]*max-width:\s*100%;[^}]*min-width:\s*0;[^}]*width:\s*100%;/s);
assert.match(css, /\.skj-stat-groups,\s*\.skj-history-family-groups\s*\{[^}]*max-width:\s*100%;[^}]*min-width:\s*0;[^}]*overflow:\s*auto;[^}]*width:\s*100%;/s);
assert.match(css, /\.skj-hotbar-collapse-toggle\s*\{[^}]*align-self:\s*start;[^}]*grid-column:\s*2;[^}]*height:\s*42px;[^}]*position:\s*relative;[^}]*width:\s*var\(--skj-hotbar-collapse-width, 10px\);/s);
assert.doesNotMatch(template, /skj-workflow-pips-core/);
assert.match(template, /skj-workflow-pips-combat/);
assert.match(hotbar, /skj-hotbar-side-left/);
assert.match(hotbar, /skj-hotbar-side-right/);
assert.doesNotMatch(hotbar, /skj-combat-layout-active/);
assert.doesNotMatch(hotbar, /_activateTabLayoutSync/);
assert.doesNotMatch(hotbar, /_syncTabLayoutMode/);

process.stdout.write("actor hotbar stable shell tests passed\n");
