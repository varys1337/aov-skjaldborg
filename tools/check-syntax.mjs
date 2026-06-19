import { readdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import process from "node:process";

const root = process.cwd();
const scanRoots = ["scripts", "tests", "tools"];

function collectMjs(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const fullPath = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...collectMjs(fullPath));
    else if (entry.isFile() && entry.name.endsWith(".mjs")) files.push(fullPath);
  }
  return files;
}

const files = scanRoots.flatMap(name => collectMjs(join(root, name))).sort();
let failed = false;

for (const file of files) {
  const result = spawnSync(process.execPath, ["--check", file], {
    cwd: root,
    stdio: "inherit"
  });
  if (result.status !== 0) failed = true;
}

if (failed) process.exit(1);
console.log(`Syntax check passed for ${files.length} module files.`);
