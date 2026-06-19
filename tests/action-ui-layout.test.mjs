import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const ring = fs.readFileSync(path.join(root, "scripts/apps/action-ring.mjs"), "utf8");
const hotbar = fs.readFileSync(path.join(root, "scripts/apps/actor-hotbar.mjs"), "utf8");
const catalog = fs.readFileSync(path.join(root, "scripts/ui/action-catalog.mjs"), "utf8");
const ringTemplate = fs.readFileSync(path.join(root, "templates/action-ring.hbs"), "utf8");
const hotbarTemplate = fs.readFileSync(path.join(root, "templates/actor-hotbar.hbs"), "utf8");
const css = fs.readFileSync(path.join(root, "styles/skjadlborg.css"), "utf8");
const settings = fs.readFileSync(path.join(root, "scripts/settings.mjs"), "utf8");
const main = fs.readFileSync(path.join(root, "scripts/main.mjs"), "utf8");

assert.match(ring, /HandlebarsApplicationMixin\(ApplicationV2\)/);
assert.match(ring, /window:\s*\{\s*frame: false/);
assert.match(ring, /static BUTTON_GAP = 10/);
assert.match(ring, /const chordRadius = count > 2[\s\S]*?\(ActionRing\.BUTTON_SIZE \+ ActionRing\.BUTTON_GAP\)/);
assert.match(ring, /commitIntentCategory/);
assert.match(ring, /prepareActorQuickAccess\(this\.actor\)\.slots\s*\.map\(slot => slot\.action\)\s*\.filter\(Boolean\)/);
assert.doesNotMatch(ring, /prepareActorActions/);
assert.match(ring, /executeActorStat/);
assert.match(ring, /executeMacro/);
assert.match(ring, /static getTokenViewportCenter\(token, fallbackPosition = null\)/);
assert.match(ring, /canvas\.clientCoordinatesFromCanvas\(center\)/);
assert.match(ring, /element\.style\.setProperty\("position", "fixed", "important"\)/);
assert.doesNotMatch(ring, /document\.body\?\.getBoundingClientRect/);
assert.match(ringTemplate, /skj-ring-action/);
assert.match(ringTemplate, /data-action-kind/);

assert.match(hotbar, /HandlebarsApplicationMixin\(ApplicationV2\)/);
assert.match(hotbar, /static TABS/);
assert.match(hotbar, /_insertElement\(element\)/);
assert.match(catalog, /actorHotbarOrder/);
assert.match(hotbar, /persistActionOrder/);
assert.match(hotbarTemplate, /skj-hotbar-resources/);
assert.match(hotbarTemplate, /skj-avatar-container/);
assert.match(hotbarTemplate, /skj-actions-bar/);
assert.match(hotbarTemplate, /data-drag-group/);
assert.match(hotbarTemplate, /workflow\.statusLabel/);
assert.match(hotbarTemplate.trim(), /^<div class="skj-hotbar-inner[^"]*"[\s\S]*<\/div>$/);
assert.match(hotbarTemplate, /<div class="skj-hotbar-inner[^"]*" \{\{#unless actor\}\}hidden\{\{\/unless\}\}>/);
assert.doesNotMatch(hotbarTemplate.trim(), /^\{\{#if actor\}\}/);
assert.match(hotbar, /if \(!resolveHotbarActor\(\)\) \{/);

assert.match(catalog, /item\.system\?\.equipStatus/);
assert.match(catalog, /requestGm\("submitIntent"/);
assert.match(catalog, /defaultCombatantState\(\)\.intent/);
assert.match(catalog, /intent\.status = INTENT_STATUS\.COMMITTED/);
assert.match(catalog, /intent\.actionCategory = category/);

assert.match(css, /\.skj-action-ring-app\s*\{[^}]*position:\s*fixed\s*!important/s);
assert.match(css, /\.skj-actor-hotbar/);
assert.match(css, /\.skj-core-hotbar-hidden/);
assert.match(css, /--skj-hotbar-stage-height: 211px/);
assert.match(css, /--skj-hotbar-collapse-width:\s*10px/);
assert.match(css, /--skj-hotbar-total-height:\s*calc\(var\(--skj-quick-stage-size, 192px\) \+ 64px\)/);
assert.match(css, /\.skj-combat-stage \.skj-intent-grid\s*\{[^}]*grid-template-rows:\s*repeat\(2, var\(--skj-slot-size\)\);[^}]*min-height:\s*calc\(var\(--skj-slot-size\) \+ var\(--skj-slot-size\) \+ 8px\);[^}]*row-gap:\s*8px;/s);
assert.match(css, /\.skj-combat-stage \.skj-weapon-action-strip\s*\{[^}]*margin-top:\s*2px;/s);

for (const key of [
  "enableActionRing",
  "actionRingMaxItems",
  "enableActorHotbar",
  "replaceCoreHotbar",
  "actorHotbarScale",
  "actorHotbarActionWidth",
  "actorHotbarOpacity",
  "actionUiTheme",
  "actorHotbarCollapsed"
]) assert.match(settings, new RegExp(`game\\.settings\\.register\\(MODULE_ID, "${key}"`));

assert.match(main, /registerActionRingHooks\(\)/);
assert.match(main, /registerActorHotbarHooks\(\)/);
assert.match(main, /refreshActorHotbar/);

process.stdout.write("action UI layout tests passed\n");
