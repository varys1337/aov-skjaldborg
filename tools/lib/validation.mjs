import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, resolve, sep } from "node:path";
import * as sass from "sass";
import { versionAtLeast } from "../../scripts/utils/version.mjs";
import { AOV_IMPORTS, AOV_TEMPLATES } from "../../scripts/adapter/aov-contract.mjs";
import { ROOT, fail, relativePath, walk, readJson, normalizedText } from "./workspace.mjs";

const AOV_CONTRACT_FILES = Object.freeze([...Object.values(AOV_IMPORTS), ...Object.values(AOV_TEMPLATES)]
  .map(path => path.replace(/^systems\/aov\//, "")));

export function syntaxCheck() {
  const files = walk(join(ROOT, "scripts"), path => extname(path) === ".mjs")
    .concat(walk(join(ROOT, "tools"), path => extname(path) === ".mjs"));
  const failures = [];
  for (const file of files) {
    const result = spawnSync(process.execPath, ["--check", file], {
      cwd: ROOT,
      encoding: "utf8",
      windowsHide: true
    });
    if (result.status !== 0) failures.push(`${relativePath(file)}\n${result.stderr || result.stdout}`);
  }
  if (failures.length) fail(`JavaScript syntax validation failed:\n${failures.join("\n")}`);
  console.log(`syntax: ${files.length} module files parsed`);
}

function manifestPaths(manifest) {
  return [
    ...(manifest.esmodules ?? []),
    ...(manifest.scripts ?? []),
    ...(manifest.styles ?? []),
    ...(manifest.languages ?? []).map(language => language.path)
  ].filter(Boolean);
}

function validateMetadata() {
  const manifest = readJson(join(ROOT, "module.json"));
  const packageJson = readJson(join(ROOT, "package.json"));
  const packageLock = readJson(join(ROOT, "package-lock.json"));
  const constants = readFileSync(join(ROOT, "scripts", "constants.mjs"), "utf8");
  const constantVersion = constants.match(/export const MODULE_VERSION = "([^"]+)"/)?.[1];
  const minimumFoundry = manifest.compatibility?.minimum;
  const verifiedFoundry = manifest.compatibility?.verified;
  const constantMinimumFoundry = constants.match(/export const MINIMUM_FOUNDRY_VERSION = "([^"]+)"/)?.[1];
  const constantVerifiedFoundry = constants.match(/export const VERIFIED_FOUNDRY_VERSION = "([^"]+)"/)?.[1];
  const minimumAoV = manifest.relationships?.systems?.find(system => system.id === "aov")?.compatibility?.minimum;
  const verifiedAoV = manifest.relationships?.systems?.find(system => system.id === "aov")?.compatibility?.verified;
  const constantMinimumAoV = constants.match(/export const MINIMUM_AOV_VERSION = "([^"]+)"/)?.[1];
  const constantVerifiedAoV = constants.match(/export const VERIFIED_AOV_VERSION = "([^"]+)"/)?.[1];
  const versions = new Map([
    ["module.json", manifest.version],
    ["package.json", packageJson.version],
    ["package-lock.json", packageLock.version],
    ["package-lock root package", packageLock.packages?.[""]?.version],
    ["scripts/constants.mjs", constantVersion]
  ]);
  const uniqueVersions = new Set(versions.values());
  if (uniqueVersions.size !== 1 || uniqueVersions.has(undefined)) {
    fail(`Version metadata is inconsistent: ${Array.from(versions, ([file, version]) => `${file}=${version}`).join(", ")}`);
  }
  if (minimumAoV !== constantMinimumAoV || verifiedAoV !== constantVerifiedAoV) {
    fail(`AoV compatibility metadata is inconsistent: manifest=${minimumAoV}/${verifiedAoV}, constants=${constantMinimumAoV}/${constantVerifiedAoV}`);
  }
  if (minimumFoundry !== constantMinimumFoundry || verifiedFoundry !== constantVerifiedFoundry) {
    fail(`Foundry compatibility metadata is inconsistent: manifest=${minimumFoundry}/${verifiedFoundry}, constants=${constantMinimumFoundry}/${constantVerifiedFoundry}`);
  }
  if (!versionAtLeast(verifiedFoundry, minimumFoundry)) {
    fail(`Foundry verified version ${verifiedFoundry} is below minimum ${minimumFoundry}`);
  }
  if (!versionAtLeast(verifiedAoV, minimumAoV)) {
    fail(`AoV verified version ${verifiedAoV} is below minimum ${minimumAoV}`);
  }
  const expectedDownload = `/releases/download/v${manifest.version}/aov-skjaldborg.zip`;
  if (!String(manifest.download ?? "").endsWith(expectedDownload)) {
    fail(`module.json download must end with ${expectedDownload}`);
  }
  const releaseNotesPath = join(ROOT, "previous-releases.md");
  if (existsSync(releaseNotesPath)) {
    const releaseHeading = readFileSync(releaseNotesPath, "utf8").match(/^##\s+([^\s]+)\s*$/m)?.[1];
    if (releaseHeading !== manifest.version) {
      fail(`previous-releases.md must begin with release ${manifest.version}; found ${releaseHeading ?? "none"}`);
    }
  }
  for (const path of manifestPaths(manifest)) {
    if (!existsSync(join(ROOT, path))) fail(`Manifest path does not exist: ${path}`);
  }
  for (const [name, command] of Object.entries(packageJson.scripts ?? {})) {
    const toolMatches = String(command).matchAll(/\bnode\s+([^\s]+)/g);
    for (const match of toolMatches) {
      const target = match[1].replaceAll("/", sep);
      if (!existsSync(join(ROOT, target))) fail(`package.json script "${name}" references missing ${match[1]}`);
    }
  }
  console.log(`metadata: version ${manifest.version}; Foundry ${minimumFoundry}-${verifiedFoundry}; AoV ${minimumAoV}-${verifiedAoV}`);
  return { manifest, packageJson, constants };
}

function moduleReferences(source) {
  const references = new Set();
  const patterns = [
    /\b(?:import|export)\s+(?:[^"'()]*?\s+from\s*)?["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) references.add(match[1]);
  }
  return references;
}

function resolveLocalModule(fromFile, specifier) {
  if (!specifier.startsWith(".")) return null;
  const target = resolve(dirname(fromFile), specifier);
  if (existsSync(target) && statSync(target).isFile()) return target;
  if (!extname(target) && existsSync(`${target}.mjs`)) return `${target}.mjs`;
  return target;
}

function validateImportsAndReachability() {
  const scriptRoot = join(ROOT, "scripts");
  const files = walk(scriptRoot, path => extname(path) === ".mjs");
  const aovContractFile = resolve(scriptRoot, "adapter", "aov-contract.mjs");
  const chatMessageHelper = resolve(scriptRoot, "compat", "chat-message.mjs");
  const dialogV2Base = resolve(scriptRoot, "apps", "base", "dialog-v2.mjs");
  const directHookOwners = new Set([
    resolve(scriptRoot, "main.mjs"),
    resolve(scriptRoot, "core", "feature-registry.mjs"),
    resolve(scriptRoot, "apps", "target-refresh-helpers.mjs")
  ]);
  const graph = new Map();
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    if (resolve(file) !== aovContractFile && source.includes("systems/aov/")) {
      fail(`${relativePath(file)} embeds an AoV system path outside scripts/adapter/aov-contract.mjs`);
    }
    if (!directHookOwners.has(resolve(file)) && /\bHooks\.(?:on|once)\s*\(/.test(source)) {
      fail(`${relativePath(file)} registers an unscoped hook outside the feature registrar`);
    }
    if (resolve(file) !== chatMessageHelper && /\bChatMessage\.create\s*\(/.test(source)) {
      fail(`${relativePath(file)} creates ChatMessage documents outside scripts/compat/chat-message.mjs`);
    }
    if (/\.render(?:\?\.)?\s*\(\s*(?:true|false)\s*\)/.test(source)) {
      fail(`${relativePath(file)} uses the legacy boolean render signature instead of ApplicationV2 render options`);
    }
    if (resolve(file) !== dialogV2Base && /\bclass\s+\w+\s+extends\s+DialogV2\b/.test(source)) {
      fail(`${relativePath(file)} subclasses DialogV2 outside the shared 14.365-compatible base`);
    }
    if (/ArrayLike<HTMLElement>|\bhtml\s*\??\.\s*\[0\]|\bhtml\s*\[0\]/.test(source)) {
      fail(`${relativePath(file)} retains a pre-v14 array-like HTMLElement compatibility branch`);
    }
    const dependencies = [];
    for (const specifier of moduleReferences(source)) {
      const resolved = resolveLocalModule(file, specifier);
      if (!resolved) continue;
      if (!existsSync(resolved)) fail(`${relativePath(file)} imports missing ${specifier}`);
      dependencies.push(resolve(resolved));
    }
    graph.set(resolve(file), dependencies);
  }
  const entry = resolve(ROOT, "scripts", "main.mjs");
  const reachable = new Set();
  const pending = [entry];
  while (pending.length) {
    const file = pending.pop();
    if (reachable.has(file)) continue;
    reachable.add(file);
    pending.push(...(graph.get(file) ?? []));
  }
  const unreachable = files.map(file => resolve(file)).filter(file => !reachable.has(file));
  if (unreachable.length) {
    fail(`Unreachable runtime modules:\n${unreachable.map(relativePath).join("\n")}`);
  }
  console.log(`imports: ${files.length} runtime modules reachable from scripts/main.mjs`);
}

function flattenLocalization(source, prefix = "", output = new Set()) {
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    if (prefix) output.add(prefix);
    return output;
  }
  for (const [key, value] of Object.entries(source)) {
    flattenLocalization(value, prefix ? `${prefix}.${key}` : key, output);
  }
  return output;
}

function validateTemplatesAndLocalization() {
  const sources = walk(join(ROOT, "scripts"), path => extname(path) === ".mjs")
    .concat(walk(join(ROOT, "templates"), path => extname(path) === ".hbs"));
  const language = flattenLocalization(readJson(join(ROOT, "lang", "en.json")));
  const missingKeys = new Map();
  for (const file of sources) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/["'](AOV_SKJALDBORG\.[A-Za-z0-9_.-]+)["']/g)) {
      if (!language.has(match[1])) {
        if (!missingKeys.has(match[1])) missingKeys.set(match[1], new Set());
        missingKeys.get(match[1]).add(relativePath(file));
      }
    }
    for (const match of source.matchAll(/["']modules\/aov-skjaldborg\/(templates\/[^"']+\.hbs)["']/g)) {
      if (!existsSync(join(ROOT, match[1]))) fail(`${relativePath(file)} references missing ${match[1]}`);
    }
  }
  if (missingKeys.size) {
    fail(`Missing localization keys:\n${Array.from(missingKeys, ([key, files]) => `${key}: ${Array.from(files).join(", ")}`).join("\n")}`);
  }
  console.log(`templates/localization: ${language.size} English leaf keys checked`);
}

function validateStyles() {
  const entry = join(ROOT, "src", "styles", "skjaldborg.scss");
  const tracked = join(ROOT, "styles", "skjaldborg.css");
  const compiled = sass.compile(entry, { style: "compressed", sourceMap: false }).css;
  const current = readFileSync(tracked, "utf8");
  if (normalizedText(compiled) !== normalizedText(current)) {
    fail("styles/skjaldborg.css does not match the compressed SCSS build");
  }
  console.log(`styles: release CSS matches SCSS (${Buffer.byteLength(normalizedText(current))} bytes)`);
}

function defaultAoVSystemPath() {
  if (process.env.AOV_SYSTEM_PATH) return resolve(process.env.AOV_SYSTEM_PATH);
  if (process.env.LOCALAPPDATA) {
    return join(process.env.LOCALAPPDATA, "FoundryVTT", "Data", "systems", "aov");
  }
  return null;
}

export function validateAoVContract({ manifest }, { required = false, systemPath = defaultAoVSystemPath() } = {}) {
  const systemRoot = systemPath;
  if (!systemRoot || !existsSync(systemRoot)) {
    if (required) fail("AoV source contract is required for release builds. Set AOV_SYSTEM_PATH to the AoV system directory.");
    console.log("aov-contract: skipped (set AOV_SYSTEM_PATH to enable)");
    return;
  }
  const systemManifestPath = join(systemRoot, "system.json");
  const systemManifest = readJson(systemManifestPath);
  const relationship = manifest.relationships?.systems?.find(system => system.id === "aov");
  if (systemManifest.id !== "aov") fail(`${relativePath(systemManifestPath)} is not the AoV system`);
  if (!versionAtLeast(systemManifest.version, relationship?.compatibility?.minimum)) {
    fail(`Installed AoV ${systemManifest.version} is below module minimum ${relationship?.compatibility?.minimum}`);
  }
  for (const path of AOV_CONTRACT_FILES) {
    if (!existsSync(join(systemRoot, ...path.split("/")))) fail(`AoV ${systemManifest.version} is missing contract path ${path}`);
  }
  const exportContracts = [
    ["system/apps/checks.mjs", ["AOVCheck", "RollType", "CardType"]],
    ["system/apps/roll-types.mjs", ["AOVRollType"]],
    ["system/apps/select-lists.mjs", ["AOVSelectLists"]]
  ];
  for (const [path, names] of exportContracts) {
    const source = readFileSync(join(systemRoot, ...path.split("/")), "utf8");
    for (const name of names) {
      const pattern = new RegExp(`\\b(?:export\\s+(?:default\\s+)?(?:class|const|let|var|function)\\s+${name}\\b|export\\s*\\{[^}]*\\b${name}\\b)`);
      if (!pattern.test(source)) fail(`AoV contract ${path} no longer exports ${name}`);
    }
  }
  console.log(`aov-contract: ${systemManifest.version} (${AOV_CONTRACT_FILES.length} paths)`);
}

export function validateAll({ requireAoVContract = false } = {}) {
  syntaxCheck();
  const metadata = validateMetadata();
  validateImportsAndReachability();
  validateTemplatesAndLocalization();
  validateStyles();
  validateAoVContract(metadata, { required: requireAoVContract });
}
