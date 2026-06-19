import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync("scripts/canvas/intent-indicators.mjs", "utf8");
const main = fs.readFileSync("scripts/main.mjs", "utf8");
const styles = fs.readFileSync("styles/skjadlborg.css", "utf8");

assert.match(source, /prepareIntentActions/);
assert.match(source, /DISPLAYABLE_STATUSES = new Set\(\[INTENT_STATUS\.COMMITTED, INTENT_STATUS\.HELD\]\)/);
assert.match(source, /action\.icon/);
assert.match(source, /canvas\.clientCoordinatesFromCanvas/);
assert.match(source, /token\?\.position\?\.x/);
assert.match(source, /canvas\?\.app\?\.ticker/);
assert.match(source, /ticker\.add\(tickTokenIntentIndicators\)/);
assert.match(source, /viewportSignature/);
assert.match(source, /requestAnimationFrame\(positionTokenIntentIndicators\)/);
assert.match(source, /Hooks\.on\("canvasReady"/);
assert.match(source, /Hooks\.on\("canvasPan", scheduleTokenIntentIndicatorPosition\)/);
assert.match(source, /Hooks\.on\("canvasTearDown"/);
assert.match(source, /Hooks\.on\("drawToken"/);
assert.match(source, /Hooks\.on\("refreshToken", updateIndicatorTokenReference\)/);
assert.match(source, /Hooks\.on\("destroyToken"/);
assert.match(source, /Hooks\.on\("updateToken", scheduleTokenIntentIndicatorPosition\)/);
assert.match(source, /Hooks\.on\("updateCombatant"/);
assert.match(source, /Hooks\.on\("updateCombat"/);
assert.doesNotMatch(source, /movement-controller|movement-route|TokenDocument#move|stopMovement/);
assert.match(main, /registerTokenIntentIndicatorHooks\(\)/);
assert.match(main, /refreshTokenIntentIndicators/);
assert.match(styles, /\.skj-token-intent-layer\s*\{[^}]*pointer-events:\s*none;[^}]*position:\s*fixed;/s);
assert.match(styles, /\.skj-token-intent-indicator\s*\{[^}]*border-radius:\s*50%;[^}]*height:\s*32px;[^}]*transform:\s*translate\(-50%, calc\(-100% - 7px\)\);[^}]*width:\s*32px;/s);
assert.match(styles, /\.skj-token-intent-indicator\s*\{[^}]*pointer-events:\s*auto;/s);
assert.match(source, /marker\.setAttribute\("data-tooltip", action\.name\)/);
assert.match(source, /marker\.setAttribute\("aria-label", action\.name\)/);
assert.match(source, /marker\.setAttribute\("role", "img"\)/);
assert.match(styles, /\.skj-token-intent-indicator\.held/);

process.stdout.write("token intent indicator tests passed\n");
