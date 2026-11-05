import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { ROOT } from "./workspace.mjs";

/** Keep historical command entry points on the maintained command runner. */
export function runLegacyCommand(command, args = process.argv.slice(2)) {
  const result = spawnSync(process.execPath, [join(ROOT, "tools", "module-tool.mjs"), command, ...args], {
    cwd: ROOT,
    stdio: "inherit",
    windowsHide: true
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
