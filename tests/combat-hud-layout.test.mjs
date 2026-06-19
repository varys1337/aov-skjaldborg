import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const script = fs.readFileSync(path.join(root, "scripts/apps/combat-hud.mjs"), "utf8");
const styles = fs.readFileSync(path.join(root, "styles/skjadlborg.css"), "utf8");

assert.match(script, /contentClasses:\s*\["standard-form",\s*"skj-hud-content"\]/);
assert.match(script, /resizable:\s*true/);
assert.match(script, /position:\s*\{[\s\S]*?width:\s*420,[\s\S]*?height:\s*760[\s\S]*?\}/);
assert.doesNotMatch(script, /height:\s*"auto"/);

assert.match(styles, /\.skj-hud\s*\{[\s\S]*?max-height:\s*calc\(100vh - 16px\)/);
assert.match(styles, /\.skj-hud \.skj-hud-content\s*\{[\s\S]*?min-height:\s*0;[\s\S]*?overflow-y:\s*auto;/);
assert.match(styles, /overscroll-behavior:\s*contain/);

process.stdout.write("combat-hud layout tests passed\n");
