import assert from "node:assert/strict";
import fs from "node:fs";

const hotbar = fs.readFileSync("scripts/apps/actor-hotbar.mjs", "utf8");
const ring = fs.readFileSync("scripts/apps/action-ring.mjs", "utf8");
const catalog = fs.readFileSync("scripts/ui/action-catalog.mjs", "utf8");
const constants = fs.readFileSync("scripts/constants.mjs", "utf8");
const template = fs.readFileSync("templates/actor-hotbar.hbs", "utf8");
const css = fs.readFileSync("styles/skjadlborg.css", "utf8");
const language = JSON.parse(fs.readFileSync("lang/en.json", "utf8"));

assert.match(constants, /actionRingMaxItems: 6/);
assert.match(constants, /actionRingMaxItems: Object\.freeze\(\{ min: 6, max: 12, step: 1 \}\)/);
assert.match(catalog, /ACTOR_HOTBAR_QUICK_SLOT_CAPACITY = ACTION_UI_LIMITS\.actionRingMaxItems\.max/);
assert.match(catalog, /export function getQuickAccessCircleCount\(\)/);
assert.match(catalog, /export function prepareActorQuickAccess\(actor/);
assert.match(catalog, /actorHotbarQuickAccess/);
assert.match(catalog, /Array\.from\(\{ length: ACTOR_HOTBAR_QUICK_SLOT_CAPACITY \}/);
assert.match(catalog, /actor\.setFlag\(MODULE_ID, "actorHotbarQuickAccess", normalized\)/);
assert.match(catalog, /slots: entries\.slice\(0, visibleCount\)/);

assert.match(hotbar, /_prepareQuickAccessSlots/);
assert.match(hotbar, /prepareActorQuickAccess\(this\.actor, \{ prepared, statGroups \}\)/);
assert.match(hotbar, /quickAccessGeometry\(quickAccess\.count\)/);
assert.match(hotbar, /const chordRadius = \(QUICK_ACCESS_SLOT_SIZE \+ QUICK_ACCESS_SLOT_GAP\)/);
assert.match(hotbar, /_activateQuickAccessSlots\(\)/);
assert.match(hotbar, /_dropQuickAccessActionOnPortrait\(event, portraitTarget\)/);
assert.match(hotbar, /current\.slice\(0, visibleCount\)\.findIndex\(entry => !entry\)/);
assert.match(hotbar, /persistActorQuickAccess\(this\.actor, entries\)/);
assert.match(hotbar, /ACTOR_HOTBAR_QUICK_SLOT_CAPACITY/);
assert.match(hotbar, /QUICK_ACCESS_DRAG_MIME/);

assert.match(ring, /prepareActorQuickAccess\(this\.actor\)\.slots\s*\.map\(slot => slot\.action\)\s*\.filter\(Boolean\)/);
assert.match(ring, /const chordRadius = count > 2/);
assert.match(ring, /static BUTTON_GAP = 10/);
assert.match(ring, /Math\.sin\(Math\.PI \/ count\)/);
assert.doesNotMatch(ring, /MAX_PER_CIRCLE/);

assert.match(template, /--skj-quick-stage-size: \{\{quickAccessStageSize\}\}px/);
assert.match(template, /class="skj-quick-slot/);
assert.match(template, /class="skj-avatar-drop-zone"/);
assert.match(template, /data-quick-auto-target/);
assert.match(template, /data-quick-slot-index="\{\{index\}\}"/);
assert.match(template, /data-quick-kind="stat"/);
assert.match(template, /data-quick-kind="item"/);
assert.match(template, /data-quick-kind="macro"/);
assert.doesNotMatch(template, /skj-quick-slot-empty-icon/);

assert.match(css, /\.skj-actor-core\s*\{[^}]*var\(--skj-quick-stage-size, 192px\)/s);
assert.match(css, /\.skj-avatar-button\s*\{[^}]*left:\s*calc\(\(var\(--skj-quick-stage-size, 192px\) - 104px\) \/ 2\);/s);
assert.match(css, /\.skj-quick-slot\.quick-drop-target/);
assert.match(css, /\.skj-quick-slot\.empty\s*\{[^}]*opacity:\s*0;/s);
assert.equal(language.AOV_SKJADLBORG.Settings.ActionRingMaxItems.Name, "Quick-access circles");
assert.match(language.AOV_SKJADLBORG.Settings.ActionRingMaxItems.Hint, /6 to 12/);
assert.equal(language.AOV_SKJADLBORG.ActorHotbar.QuickAccess.RemoveHint, "Right-click to remove from quick access.");

process.stdout.write("actor hotbar quick-access tests passed\n");
