import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

const root = process.cwd();
const version = process.argv[2];
const semver = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

if (!version || !semver.test(version)) {
  console.error("Usage: npm run set-version -- <major.minor.patch>");
  process.exit(1);
}

function updateJson(relativePath, mutate) {
  const path = join(root, relativePath);
  const json = JSON.parse(readFileSync(path, "utf8"));
  mutate(json);
  writeFileSync(path, `${JSON.stringify(json, null, 2)}\n`, "utf8");
}

updateJson("module.json", manifest => {
  manifest.version = version;
  manifest.download = `https://github.com/varys1337/aov-skjaldborg/releases/download/v${version}/aov-skjadlborg.zip`;
});

updateJson("package.json", packageJson => {
  packageJson.version = version;
});

try {
  updateJson("package-lock.json", packageLock => {
    packageLock.version = version;
    if (packageLock.packages?.[""]) packageLock.packages[""].version = version;
  });
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}

const constantsPath = join(root, "scripts/constants.mjs");
const constants = readFileSync(constantsPath, "utf8");
const updated = constants.replace(
  /export const MODULE_VERSION = "[^"]+";/,
  `export const MODULE_VERSION = "${version}";`
);
if (updated === constants) throw new Error("Could not locate MODULE_VERSION in scripts/constants.mjs");
writeFileSync(constantsPath, updated, "utf8");

console.log(`Updated module, package, and runtime versions to ${version}.`);
