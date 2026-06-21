import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

const root = process.cwd();
const requestedVersion = process.argv[2];
const version = requestedVersion?.startsWith("v") ? requestedVersion.slice(1) : requestedVersion;
const semver = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const repositoryUrl = "https://github.com/varys1337/aov-skjaldborg";
const archiveName = "aov-skjaldborg.zip";

if (!version || !semver.test(version)) {
  console.error("Usage: npm run set-version -- <major.minor.patch[-prerelease]>");
  process.exit(1);
}

updateJson("module.json", manifest => {
  manifest.version = version;
  manifest.url = repositoryUrl;
  manifest.manifest = `${repositoryUrl}/releases/latest/download/module.json`;
  manifest.download = `${repositoryUrl}/releases/download/v${version}/${archiveName}`;
  manifest.readme = `${repositoryUrl}/blob/main/README.md`;
  manifest.bugs = `${repositoryUrl}/issues`;
  manifest.changelog = `${repositoryUrl}/releases`;
});

updateJson("package.json", packageJson => {
  packageJson.version = version;
});

if (existsSync(join(root, "package-lock.json"))) {
  updateJson("package-lock.json", packageLock => {
    packageLock.version = version;
    if (packageLock.packages?.[""]) packageLock.packages[""].version = version;
  });
}

const constantsPath = join(root, "scripts/constants.mjs");
const constants = readFileSync(constantsPath, "utf8");
const versionPattern = /export const MODULE_VERSION = ["'][^"']+["'];/;
if (!versionPattern.test(constants)) {
  throw new Error("Could not locate MODULE_VERSION in scripts/constants.mjs");
}
writeFileSync(
  constantsPath,
  constants.replace(versionPattern, `export const MODULE_VERSION = "${version}";`),
  "utf8"
);

console.log(`Updated module, package, lockfile, and runtime versions to ${version}.`);

function updateJson(relativePath, mutate) {
  const path = join(root, relativePath);
  const json = JSON.parse(readFileSync(path, "utf8"));
  mutate(json);
  writeFileSync(path, `${JSON.stringify(json, null, 2)}\n`, "utf8");
}
