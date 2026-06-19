import assert from "node:assert/strict";
import fs from "node:fs";

const css = fs.readFileSync(new URL("../styles/skjadlborg.css", import.meta.url), "utf8");
const app = fs.readFileSync(new URL("../scripts/apps/movement-debug-settings.mjs", import.meta.url), "utf8");

assert.match(css, /\.skj-movement-debug-settings-content\s*\{[^}]*overflow-y:\s*auto;/s);
assert.match(css, /\.skj-movement-debug-settings-content\s*\{[^}]*max-height:\s*calc\(100vh - 160px\);/s);
assert.match(app, /height:\s*Math\.min\(760,\s*Math\.max\(420,/);
assert.match(app, /action:\s*"export"/);
assert.match(app, /logMovementDebugExport/);

console.log("movement-debug-settings-layout ok");
