import { readdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import process from "node:process";

const root = process.cwd();
const testDirectory = join(root, "tests");
const tests = readdirSync(testDirectory)
  .filter(name => name.endsWith(".test.mjs"))
  .sort();

for (const test of tests) {
  console.log(`\n== ${test} ==`);
  const result = spawnSync(process.execPath, [join(testDirectory, test)], {
    cwd: root,
    stdio: "inherit"
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

console.log(`\nAll ${tests.length} tests passed.`);
