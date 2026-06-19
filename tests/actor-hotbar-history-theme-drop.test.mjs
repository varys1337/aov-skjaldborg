import assert from "node:assert/strict";
import fs from "node:fs";

const hotbar = fs.readFileSync("scripts/apps/actor-hotbar.mjs", "utf8");
const catalog = fs.readFileSync("scripts/ui/action-catalog.mjs", "utf8");
const template = fs.readFileSync("templates/actor-hotbar.hbs", "utf8");
const css = fs.readFileSync("styles/skjadlborg.css", "utf8");
const language = JSON.parse(fs.readFileSync("lang/en.json", "utf8"));

assert.match(hotbar, /\{ id: "historyFamily", label: "AOV_SKJADLBORG\.ActorHotbar\.Tabs\.HistoryFamily" \}/);
assert.match(hotbar, /prepareActorHistoryFamily\(this\.actor\)/);
assert.match(hotbar, /this\.element\.classList\.add\("skj-quick-drag-active"\)/);
assert.match(hotbar, /_dropQuickAccessActionOnPortrait\(event, portraitTarget\)/);
assert.match(hotbar, /targetIndex = current\.slice\(0, visibleCount\)\.findIndex\(entry => !entry\)/);
assert.match(catalog, /MAGIC_ITEM_TYPES = new Set\(\["runescript", "seidur", "npcpower"\]\)/);
assert.match(catalog, /HISTORY_FAMILY_ACTION_TYPES = new Set\(\["passion", "devotion"\]\)/);
assert.match(catalog, /export async function prepareActorHistoryFamily\(actor\)/);
assert.match(catalog, /isPassions: true/);
assert.match(catalog, /isDevotions: true/);
assert.match(catalog, /identity/);
assert.match(catalog, /reputation/);
assert.match(catalog, /status/);

assert.match(template, /class="skj-avatar-drop-zone"/);
assert.match(template, /data-quick-auto-target/);
assert.match(template, /data-tab="historyFamily"/);
assert.match(template, /skj-passion-grid/);
assert.match(template, /skj-devotion-grid/);
assert.match(template, /historyFamily\.histories/);
assert.match(template, /historyFamily\.families/);
assert.match(template, /historyFamily\.thralls/);
assert.match(template, /historyFamily\.farms/);

assert.match(css, /url\("\/systems\/aov\/art-assets\/lightstone\.jpg"\)/);
assert.match(css, /body\.theme-dark \.skj-action-ring-app\.skj-theme-aov,[\s\S]*url\("\/systems\/aov\/art-assets\/darkstone\.jpg"\)/);
assert.match(css, /\.skj-actor-hotbar\.skj-quick-drag-active \.skj-avatar-drop-zone\s*\{[^}]*pointer-events:\s*auto;/s);
assert.match(css, /\.skj-avatar-drop-zone\.quick-drop-target/);
assert.doesNotMatch(css, /color-mix\(/);

assert.equal(language.AOV_SKJADLBORG.ActorHotbar.Tabs.HistoryFamily, "History and family");
assert.equal(language.AOV_SKJADLBORG.ActorHotbar.Tabs.Skills, "Skills");
assert.equal(language.AOV_SKJADLBORG.ActorHotbar.Tabs.Magic, "Rune scripts, Seiðr, and powers");
assert.ok(language.AOV_SKJADLBORG.ActorHotbar.QuickAccess.PortraitDropHint);
assert.ok(language.AOV_SKJADLBORG.ActorHotbar.QuickAccess.Full);

process.stdout.write("actor hotbar history, theme, and portrait drop tests passed\n");
