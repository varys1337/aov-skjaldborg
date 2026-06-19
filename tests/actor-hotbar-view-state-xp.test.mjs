import assert from "node:assert/strict";
import fs from "node:fs";

const hotbar = fs.readFileSync("scripts/apps/actor-hotbar.mjs", "utf8");
const catalog = fs.readFileSync("scripts/ui/action-catalog.mjs", "utf8");
const template = fs.readFileSync("templates/actor-hotbar.hbs", "utf8");
const css = fs.readFileSync("styles/skjadlborg.css", "utf8");

assert.match(hotbar, /async _preRender\(context, options\) \{[\s\S]*this\._captureScrollPositions\(\);[\s\S]*await super\._preRender/s);
assert.match(hotbar, /async _onRender\(context, options\) \{[\s\S]*this\._restoreScrollPositions\(\);/s);
assert.match(hotbar, /this\._scrollPositions = new Map\(\)/);
assert.match(hotbar, /this\._renderedActorKey = null/);
assert.match(hotbar, /root\.querySelectorAll\("\[data-scroll-state\]"\)/);
assert.match(hotbar, /requestAnimationFrame\(\(\) => \{/);
assert.match(hotbar, /if \(!root\.isConnected\) return/);
assert.match(hotbar, /event\.target instanceof Element && event\.target\.closest\("\[data-xp-toggle\]"\)/);
assert.match(hotbar, /_activateXpToggleDragGuards\(\)/);
assert.match(hotbar, /source\.draggable = false/);
assert.match(hotbar, /window\.addEventListener\("pointerup", restore, \{ once: true, signal: abort\.signal \}\)/);
assert.match(hotbar, /toggleXp: ActorHotbar\.onToggleXp/);
assert.match(hotbar, /toggleActorItemXpCheck\(this\.actor, target\.dataset\.itemId\)/);
assert.match(catalog, /item\.update\(\{ "system\.xpCheck": !item\.system\?\.xpCheck \}\)/);
assert.match(catalog, /\["skill", "passion"\]\.includes\(item\.type\)/);

for (const id of ["stats", "historyFamily", "skills", "magic", "equip", "macros"]) {
  assert.match(template, new RegExp(`data-scroll-state="${id}"`));
}
assert.match(template, /class="skj-xp-toggle \{\{#if xpCheck\}\}checked/);
assert.match(template, /class="skj-skill-action-main"/);
assert.match(template, /class="skj-history-action-xp-cell"/);
assert.match(template, /data-xp-toggle/);
const collapseCss = [...css.matchAll(/\.skj-hotbar-collapse-toggle\s*\{([^}]*)\}/gs)]
  .map(match => match[1])
  .find(block => /grid-column:\s*2;/.test(block)) ?? "";
assert.match(collapseCss, /align-self:\s*start;/);
assert.match(collapseCss, /grid-column:\s*2;/);
assert.match(collapseCss, /position:\s*relative;/);
assert.match(collapseCss, /height:\s*42px;/);
assert.match(collapseCss, /width:\s*var\(--skj-hotbar-collapse-width, 10px\);/);
assert.match(css, /\.skj-xp-toggle\s*\{[^}]*cursor:\s*pointer;/s);
assert.match(css, /\.skj-skill-action-main/);

const layoutIndex = template.indexOf('class="skj-hotbar-layout"');
const coreCloseIndex = template.indexOf('</section>', template.indexOf('class="skj-actor-core"'));
const collapseIndex = template.indexOf('class="skj-hotbar-collapse-toggle"');
const actionsIndex = template.indexOf('class="skj-actor-actions"');
assert.ok(layoutIndex >= 0 && coreCloseIndex < collapseIndex && collapseIndex < actionsIndex, "collapse control must sit between actor core and action body");

process.stdout.write("actor hotbar view-state and XP tests passed\n");

assert.match(hotbar, /this\._xpUpdatePending = false/);
assert.match(hotbar, /if \(this\._xpUpdatePending\) return null;/);
assert.match(hotbar, /this\._xpUpdatePending = true;[\s\S]*await toggleActorItemXpCheck\(this\.actor, target\.dataset\.itemId\);[\s\S]*await this\.render\(false\);[\s\S]*this\._xpUpdatePending = false;/s);
assert.match(hotbar, /current\?\._xpUpdatePending && current\.actor\?\.id === item\.parent\?\.id/);
assert.match(css, /\.skj-xp-toggle\.checked:hover,[\s\S]*color:\s*var\(--skj-active\);/s);
assert.match(css, /\.skj-skill-action-main \.skj-named-action-score\s*\{[^}]*opacity:\s*1;[^}]*visibility:\s*visible;/s);
