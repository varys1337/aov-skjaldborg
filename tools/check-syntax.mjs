import { existsSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { spawnSync } from "node:child_process";
import process from "node:process";

const root = process.cwd();
const scanRoots = ["scripts", "tools"];
const files = [];
const errors = [];

for (const name of scanRoots) {
  const directory = join(root, name);
  if (!existsSync(directory)) {
    errors.push(`Missing syntax-check source directory: ${name}`);
    continue;
  }
  files.push(...collectModules(directory));
}

if (files.length === 0) errors.push("No JavaScript module files were found for syntax checking.");

for (const file of files.sort()) {
  const result = spawnSync(process.execPath, ["--check", file], {
    cwd: root,
    encoding: "utf8"
  });

  if (result.status !== 0) {
    errors.push(`Syntax check failed: ${relative(root, file)}`);
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
  }
}

if (errors.length > 0) {
  console.error("Syntax validation failed:");
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`Syntax check passed for ${files.length} module files.`);

function collectModules(directory) {
  const collected = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const fullPath = join(directory, entry.name);
    if (entry.isDirectory()) collected.push(...collectModules(fullPath));
    else if (entry.isFile() && [".js", ".mjs", ".cjs"].some(extension => entry.name.endsWith(extension))) {
      collected.push(fullPath);
    }
  }
  return collected;
}
