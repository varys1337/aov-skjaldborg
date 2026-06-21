import { readdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import process from "node:process";

const root = process.cwd();
const scanRoots = ["scripts", "tools"];
const files = [];

for (const scanRoot of scanRoots) collectJavaScriptFiles(join(root, scanRoot));

let failed = false;
for (const file of files) {
  const result = spawnSync(process.execPath, ["--check", file], {
    cwd: root,
    encoding: "utf8"
  });
  if (result.status !== 0) {
    failed = true;
    console.error(result.stderr || result.stdout);
  }
}

if (failed) process.exit(1);
console.log(`Syntax check passed for ${files.length} module files.`);

function collectJavaScriptFiles(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const fullPath = join(directory, entry.name);
    if (entry.isDirectory()) collectJavaScriptFiles(fullPath);
    else if (entry.isFile() && /\.(?:mjs|js)$/u.test(entry.name)) files.push(fullPath);
  }
}
