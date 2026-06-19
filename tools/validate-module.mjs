import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

const root = process.cwd();
const repository = "varys1337/aov-skjaldborg";
const repositoryUrl = `https://github.com/${repository}`;
const archiveName = "aov-skjadlborg.zip";
const errors = [];

const manifest = readJson("module.json");
const packageJson = readJson("package.json");
const packageLock = existsSync(join(root, "package-lock.json")) ? readJson("package-lock.json") : null;
const constants = readText("scripts/constants.mjs");
const runtimeVersion = constants?.match(/MODULE_VERSION\s*=\s*["']([^"']+)["']/)?.[1];

requireCondition(manifest?.id === "aov-skjadlborg", "module.json id must be aov-skjadlborg");
requireCondition(manifest?.title === "Age of Vikings - Skjadlborg", "module.json title is unexpected");
requireCondition(isSemver(manifest?.version), "module.json version must use semantic versioning");
requireCondition(packageJson?.version === manifest?.version, "package.json version must match module.json");
requireCondition(runtimeVersion === manifest?.version, "scripts/constants.mjs MODULE_VERSION must match module.json");

if (packageLock) {
  requireCondition(packageLock.version === manifest?.version, "package-lock.json version must match module.json");
  requireCondition(
    packageLock.packages?.[""]?.version === manifest?.version,
    "package-lock.json root package version must match module.json"
  );
}

requireCondition(manifest?.url === repositoryUrl, "module.json url must point to the GitHub repository");
requireCondition(
  manifest?.manifest === `${repositoryUrl}/releases/latest/download/module.json`,
  "module.json manifest URL must remain the stable latest-release URL"
);
requireCondition(
  manifest?.download === `${repositoryUrl}/releases/download/v${manifest?.version}/${archiveName}`,
  "module.json download URL must target the matching version tag"
);
requireCondition(manifest?.readme === `${repositoryUrl}/blob/main/README.md`, "module.json readme URL is incorrect");
requireCondition(manifest?.bugs === `${repositoryUrl}/issues`, "module.json bugs URL is incorrect");
requireCondition(manifest?.changelog === `${repositoryUrl}/releases`, "module.json changelog URL is incorrect");
requireCondition(Array.isArray(manifest?.esmodules) && manifest.esmodules.length > 0, "At least one esmodule is required");
requireCondition(Array.isArray(manifest?.styles), "module.json styles must be an array");
requireCondition(Array.isArray(manifest?.languages), "module.json languages must be an array");
requireCondition(Array.isArray(manifest?.system) && manifest.system.includes("aov"), "Module must target the aov system");
requireCondition(manifest?.socket === true, "Module socket support must remain enabled");

for (const file of manifest?.esmodules ?? []) requireRuntimeFile(file, "esmodule");
for (const style of manifest?.styles ?? []) {
  requireRuntimeFile(typeof style === "string" ? style : style?.src, "stylesheet");
}
for (const language of manifest?.languages ?? []) {
  requireRuntimeFile(language?.path, "language file");
  if (language?.path && existsSync(join(root, language.path))) readJson(language.path);
}

for (const path of ["README.md", "LICENSE", "lang", "scripts", "styles", "templates"]) {
  requireRuntimeFile(path, "runtime path");
}

if (errors.length > 0) {
  console.error("Module validation failed:");
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`Module manifest and release metadata are valid for v${manifest.version}.`);

function readJson(relativePath) {
  const text = readText(relativePath);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch (error) {
    errors.push(`Invalid JSON in ${relativePath}: ${error.message}`);
    return null;
  }
}

function readText(relativePath) {
  const path = join(root, relativePath);
  if (!existsSync(path)) {
    errors.push(`Missing file: ${relativePath}`);
    return null;
  }
  return readFileSync(path, "utf8");
}

function requireCondition(condition, message) {
  if (!condition) errors.push(message);
}

function requireRuntimeFile(relativePath, label) {
  if (!relativePath || typeof relativePath !== "string") {
    errors.push(`Invalid ${label} path in module.json`);
    return;
  }
  const path = join(root, relativePath);
  if (!existsSync(path)) {
    errors.push(`Missing ${label}: ${relativePath}`);
    return;
  }
  try {
    statSync(path);
  } catch (error) {
    errors.push(`Cannot access ${label} ${relativePath}: ${error.message}`);
  }
}

function isSemver(value) {
  return typeof value === "string" && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value);
}
