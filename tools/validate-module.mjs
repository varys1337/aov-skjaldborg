import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

const root = process.cwd();
const expectedRepository = "https://github.com/varys1337/aov-skjaldborg";
const manifest = readJson("module.json");
const packageJson = readJson("package.json");
const constants = readFileSync(join(root, "scripts/constants.mjs"), "utf8");
const constantVersion = constants.match(/MODULE_VERSION\s*=\s*"([^"]+)"/)?.[1];
const errors = [];

function readJson(relativePath) {
  const path = join(root, relativePath);
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Invalid JSON in ${relativePath}: ${error.message}`);
  }
}

function requireCondition(condition, message) {
  if (!condition) errors.push(message);
}

function requireFile(relativePath, label = "file") {
  requireCondition(existsSync(join(root, relativePath)), `Missing ${label}: ${relativePath}`);
}

requireCondition(manifest.id === "aov-skjadlborg", "module.json id must be aov-skjadlborg");
requireCondition(manifest.title === "Age of Vikings - Skjadlborg", "Unexpected module title");
requireCondition(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version), "module.json version must be semantic");
requireCondition(packageJson.version === manifest.version, "package.json version must match module.json");
requireCondition(constantVersion === manifest.version, "MODULE_VERSION must match module.json");
requireCondition(manifest.url === expectedRepository, "module.json url must point to the GitHub repository");
requireCondition(
  manifest.manifest === `${expectedRepository}/releases/latest/download/module.json`,
  "module.json manifest URL must remain stable"
);
requireCondition(
  manifest.download === `${expectedRepository}/releases/download/v${manifest.version}/aov-skjadlborg.zip`,
  "module.json download URL must point to the matching version tag"
);
requireCondition(manifest.bugs === `${expectedRepository}/issues`, "module.json bugs URL is incorrect");
requireCondition(manifest.changelog === `${expectedRepository}/releases`, "module.json changelog URL is incorrect");
requireCondition(Array.isArray(manifest.esmodules) && manifest.esmodules.length > 0, "At least one esmodule is required");
requireCondition(Array.isArray(manifest.styles), "styles must be an array");
requireCondition(Array.isArray(manifest.languages), "languages must be an array");
requireCondition(Array.isArray(manifest.system) && manifest.system.includes("aov"), "Module must be restricted to the aov system");
requireCondition(manifest.socket === true, "Module socket must remain enabled");

for (const file of manifest.esmodules ?? []) requireFile(file, "esmodule");
for (const file of manifest.styles ?? []) requireFile(typeof file === "string" ? file : file.src, "stylesheet");
for (const language of manifest.languages ?? []) {
  requireFile(language.path, "language file");
  readJson(language.path);
}

for (const path of ["README.md", "scripts", "styles", "templates", "lang"]) requireFile(path, "runtime path");

if (errors.length) {
  console.error("Module validation failed:");
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`Module manifest and release metadata are valid for v${manifest.version}.`);
