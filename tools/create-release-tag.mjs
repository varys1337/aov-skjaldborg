import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
import process from "node:process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(root, "module.json"), "utf8"));
const currentVersion = manifest.version;
const semver = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const useCurrentVersion = process.argv.includes("--current-version");
const subject = git(["log", "-1", "--pretty=%s"]);
const releaseMatch = subject.match(/^Release\s+v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/i);

if (!useCurrentVersion && !releaseMatch) process.exit(0);

const requestedVersion = useCurrentVersion ? currentVersion : releaseMatch[1];
if (!semver.test(requestedVersion)) {
  console.error(`Cannot create a release tag from invalid version: ${requestedVersion}`);
  process.exit(1);
}

if (requestedVersion !== currentVersion) {
  console.error(
    `Release commit requests v${requestedVersion}, but module.json contains ${currentVersion}. `
      + "Run npm run set-version first."
  );
  process.exit(1);
}

const tagName = `v${requestedVersion}`;
const head = git(["rev-parse", "HEAD"]);
const existingTag = spawnSync("git", ["tag", "--list", tagName], {
  cwd: root,
  encoding: "utf8"
});

if (existingTag.error) {
  console.error(`Unable to inspect Git tags: ${existingTag.error.message}`);
  process.exit(1);
}
if (existingTag.status !== 0) process.exit(existingTag.status ?? 1);

if (existingTag.stdout.trim() === tagName) {
  const existingTarget = git(["rev-list", "-n", "1", tagName]);
  if (existingTarget === head) {
    console.log(`Release tag ${tagName} already points to the current commit.`);
    process.exit(0);
  }
  console.error(
    `Release tag ${tagName} already exists on ${existingTarget.slice(0, 12)}, `
      + `not the current commit ${head.slice(0, 12)}. Refusing to move it automatically.`
  );
  process.exit(1);
}

execFileSync(
  "git",
  ["tag", "-a", tagName, "-m", `Age of Vikings - Skjaldborg ${tagName}`, head],
  { cwd: root, stdio: "inherit" }
);

console.log(`Created annotated release tag ${tagName} on ${head.slice(0, 12)}.`);
console.log(`Push it with: git push origin refs/tags/${tagName}`);

function git(args) {
  try {
    return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  } catch (error) {
    console.error(`Git command failed: git ${args.join(" ")}`);
    if (error.stderr) console.error(String(error.stderr).trim());
    process.exit(1);
  }
}
