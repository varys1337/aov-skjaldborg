import { chmodSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import process from "node:process";

if (process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true") {
  console.log("Skipping local Git hook installation in CI.");
  process.exit(0);
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const gitMarker = join(root, ".git");
const hookPath = join(root, ".githooks", "post-commit");

if (!existsSync(gitMarker)) {
  console.log("Skipping Git hook installation because this is not a Git working tree.");
  process.exit(0);
}

if (!existsSync(hookPath)) {
  console.error(`Missing tracked Git hook: ${hookPath}`);
  process.exit(1);
}

try {
  chmodSync(hookPath, 0o755);
} catch {
  // Git for Windows executes hook scripts through its bundled shell; chmod is optional there.
}

try {
  execFileSync("git", ["config", "--local", "core.hooksPath", ".githooks"], {
    cwd: root,
    stdio: "ignore"
  });
} catch (error) {
  console.error(`Unable to configure tracked Git hooks: ${error.message}`);
  process.exit(1);
}

console.log("Configured tracked Git hooks from .githooks.");
