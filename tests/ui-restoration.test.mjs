import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const read = file => fs.readFileSync(path.join(root, file), "utf8");

const hotbar = read("scripts/apps/actor-hotbar.mjs");
const hotbarTemplate = read("templates/actor-hotbar.hbs");
const actionRing = read("scripts/apps/action-ring.mjs");
const tracker = read("scripts/hooks/tracker.mjs");
const settings = read("scripts/settings.mjs");
const styles = read("styles/skjadlborg.css");
const engagement = read("scripts/combat/engagement-status.mjs");
const manifest = JSON.parse(read("module.json"));
const constants = read("scripts/constants.mjs");
const moduleVersion = constants.match(/MODULE_VERSION\s*=\s*"([^"]+)"/)?.[1];

assert.equal(manifest.version, moduleVersion);

// Latest actor Action HUD branch.
assert.match(hotbar, /actorHotbarPosition/);
assert.match(hotbar, /_captureScrollPositions/);
assert.match(hotbar, /_restoreScrollPositions/);
assert.match(hotbar, /toggleActorItemXpCheck/);
assert.match(hotbar, /prepareActorStats/);
assert.match(hotbar, /prepareActorHistoryFamily/);
assert.match(hotbar, /prepareActorEquipment/);
assert.match(hotbarTemplate, /data-quick-auto-target/);
assert.match(hotbarTemplate, /data-tab="historyFamily"/);
assert.match(hotbarTemplate, /data-action="toggleCollapse"/);
assert.match(hotbarTemplate, /data-xp-toggle/);
assert.doesNotMatch(hotbarTemplate, /data-hotbar-drag-handle/);
assert.match(hotbarTemplate, /skj-workflow-pips-combat/);
assert.match(hotbar, /_preferredSide\(anchor\)/);
assert.match(hotbar, /event\.button !== 2/);
assert.match(settings, /actionUiTheme/);
assert.match(settings, /actorHotbarOpacity/);
assert.match(settings, /actionRingMaxItems/);
assert.match(styles, /grid-template-columns:\s*var\(--skj-quick-stage-size/);
assert.match(styles, /\.skj-hotbar-side-left \.skj-hotbar-layout/);
assert.match(styles, /\.skj-hotbar-collapsed \.skj-hotbar-layout/);
assert.match(actionRing, /prepareActorQuickAccess\(this\.actor\)\.slots/);

// Restored tracker workflow indicators.
assert.match(tracker, /renderIntentIndicators/);
assert.match(tracker, /data-skj-intent-indicators/);
assert.match(tracker, /status-action skj-pill skj-combatant-status/);
assert.match(tracker, /movementStatus/);
assert.match(tracker, /MOVEMENT_PLAN_STATUS\.COMPLETED/);
assert.match(tracker, /MOVEMENT_PLAN_STATUS\.STOPPED/);
assert.doesNotMatch(tracker, /intent\.delay\?\.enabled/);
assert.doesNotMatch(tracker, /intent\.waitInterrupt\?\.enabled/);
assert.doesNotMatch(tracker, /engagement\.engaged === true/);
assert.match(tracker, /getReadiedWeapon/);
assert.doesNotMatch(tracker, /remaining-actions/);
assert.doesNotMatch(tracker, /simultaneous-group/);
assert.match(styles, /\.skj-combatant-indicators/);
assert.match(styles, /\.skj-tracker-indicator/);

// Engaged uses Foundry's default combat status artwork.
assert.match(engagement, /const ENGAGED_EFFECT_ICON = "icons\/svg\/combat\.svg"/);
assert.doesNotMatch(engagement, /modules\/\$\{MODULE_ID\}\/assets\/engaged\.svg/);

process.stdout.write("UI restoration tests passed\n");
