import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { deflateRawSync } from "node:zlib";
import * as sass from "sass";

const ROOT = resolve(import.meta.dirname, "..");
const MODULE_FOLDER = "aov-skjaldborg";
const RUNTIME_DIRECTORIES = Object.freeze(["lang", "scripts", "styles", "templates"]);
const OPTIONAL_RUNTIME_DIRECTORIES = Object.freeze(["docs"]);
const RUNTIME_FILES = Object.freeze(["module.json", "README.md"]);
const OPTIONAL_RUNTIME_FILES = Object.freeze(["LICENSE", "previous-releases.md", "previous-nongithub-releases.md"]);
const DEVELOPMENT_ONLY_PATHS = Object.freeze([
  ".git",
  ".github",
  "node_modules",
  "package.json",
  "package-lock.json",
  "src",
  "tools"
]);
const AOV_CONTRACT_FILES = Object.freeze([
  "system/apps/checks.mjs",
  "system/apps/roll-types.mjs",
  "system/apps/select-lists.mjs",
  "system/setup/aov-dialog.mjs",
  "system/chat/combat-chat.mjs",
  "templates/chat/roll-combat.hbs",
  "templates/chat/roll-resistance.hbs",
  "templates/dialog/rollOptions.hbs"
]);

function fail(message) {
  throw new Error(message);
}

function posixPath(path) {
  return path.split(sep).join("/");
}

function relativePath(path) {
  return posixPath(relative(ROOT, path));
}

function walk(directory, predicate = () => true) {
  if (!existsSync(directory)) return [];
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walk(path, predicate));
    else if (entry.isFile() && predicate(path)) files.push(path);
  }
  return files.sort((left, right) => relativePath(left).localeCompare(relativePath(right)));
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  }
  catch (error) {
    fail(`${relativePath(path)} is not valid JSON: ${error.message}`);
  }
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function normalizedText(value) {
  return String(value ?? "").replaceAll("\r\n", "\n").trimEnd();
}

function versionAtLeast(current, minimum) {
  const left = String(current ?? "").split(".").map(part => Number.parseInt(part, 10) || 0);
  const right = String(minimum ?? "").split(".").map(part => Number.parseInt(part, 10) || 0);
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    if ((left[index] ?? 0) > (right[index] ?? 0)) return true;
    if ((left[index] ?? 0) < (right[index] ?? 0)) return false;
  }
  return true;
}

function syntaxCheck() {
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
  const expectedDownload = `/releases/download/v${manifest.version}/aov-skjaldborg.zip`;
  if (!String(manifest.download ?? "").endsWith(expectedDownload)) {
    fail(`module.json download must end with ${expectedDownload}`);
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
  console.log(`metadata: version ${manifest.version}; AoV ${minimumAoV}-${verifiedAoV}`);
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

function validateAoVContract({ manifest }) {
  const systemRoot = defaultAoVSystemPath();
  if (!systemRoot || !existsSync(systemRoot)) {
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

async function contractTests() {
  const kernel = await import("../scripts/combat/rule-kernel.mjs");
  kernel.__test.resetRules();
  kernel.registerCombatRule({
    id: "late",
    priority: 200,
    prepareAttackContext: context => {
      context.ruleMetadata.late = true;
      return { live: { ignored: true }, kept: "late" };
    }
  });
  kernel.registerCombatRule({
    id: "early",
    priority: 100,
    prepareAttackContext: context => {
      context.ruleMetadata.early = true;
      return { kept: "early" };
    }
  });
  const context = kernel.prepareAttackContext(kernel.createCombatRuleContext());
  assert.deepEqual(kernel.__test.registeredRuleIds(), ["early", "late"]);
  assert.deepEqual(context.ruleReports.map(report => report.id), ["early", "late"]);
  assert.deepEqual(context.ruleReports[1], {
    id: "late",
    stage: "prepareAttackContext",
    kept: "late"
  });
  kernel.__test.resetRules();
  const proneSource = readFileSync(join(ROOT, "scripts", "combat", "prone-automation.mjs"), "utf8");
  const aimedSource = readFileSync(join(ROOT, "scripts", "combat", "aimed-blow-automation.mjs"), "utf8");
  assert.match(proneSource, /id:\s*"prone"[\s\S]*?priority:\s*100/);
  assert.match(aimedSource, /id:\s*"aimed-blow"[\s\S]*?priority:\s*200/);

  const sanitizers = await import("../scripts/socket/sanitizers.mjs");
  const prompt = sanitizers.sanitizePromptDefensePayload({
    attackMessageId: " attack ",
    targetTokenUuid: "Scene.abc.Token.def",
    targetActorUuid: "Actor.abc",
    incomingWeaponType: "spear",
    ignored: { live: true }
  });
  assert.deepEqual(prompt, {
    attackMessageId: "attack",
    tokenUuid: "Scene.abc.Token.def",
    actorUuid: "Actor.abc",
    incomingWeaponType: "spear"
  });
  const intent = sanitizers.sanitizeCommitIntentPayload({
    combatId: "combat",
    combatantId: "combatant",
    intent: {
      status: "held",
      actionCategory: "flee",
      splitCount: 99,
      modifiers: { fullMove: true }
    }
  });
  assert.equal(intent.intent.actionCategory, "retreat");
  assert.equal(intent.intent.splitCount, 4);
  assert.equal(intent.intent.modifiers.fullMove, true);
  const combatWrite = sanitizers.sanitizeCombatWritePayload({
    combatId: " combat ",
    combatantId: " combatant ",
    actionId: " action ",
    expectedCombatUpdatedAt: "42",
    attackerCombatantId: " attacker ",
    targetCombatantId: " target "
  });
  assert.equal(combatWrite.combatId, "combat");
  assert.equal(combatWrite.combatantId, "combatant");
  assert.equal(combatWrite.actionId, "action");
  assert.equal(combatWrite.expectedCombatUpdatedAt, 42);
  assert.equal(combatWrite.attackerCombatantId, "attacker");
  assert.equal(combatWrite.targetCombatantId, "target");

  const adapterSource = readFileSync(join(ROOT, "scripts", "adapter", "aov-adapter.mjs"), "utf8");
  assert.match(adapterSource, /CORE_ROLL_PROMPT_TIMEOUT_MS\s*=\s*15000/);
  assert.match(adapterSource, /source\s*===\s*"defense"\s*&&\s*Object\.hasOwn\(options,\s*"none"\)\)\s*return\s*"none"/);
  assert.match(adapterSource, /source\s*===\s*"attack"\s*&&\s*Object\.hasOwn\(options,\s*"attack"\)\)\s*return\s*"attack"/);
  const schemaSource = readFileSync(join(ROOT, "scripts", "socket", "schema.mjs"), "utf8");
  assert.match(schemaSource, /promptDefenseRoll[\s\S]*?timeoutMs:\s*20000/);
  const socketSource = readFileSync(join(ROOT, "scripts", "socket.mjs"), "utf8");
  assert.doesNotMatch(socketSource, /switch\s*\(\s*message\.action\s*\)/);
  assert.doesNotMatch(schemaSource, /handleLegacySocketAction/);
  const socketSchema = await import("../scripts/socket/schema.mjs");
  assert.deepEqual(Object.keys(socketSchema.SOCKET_ACTIONS), [
    "initializeCombat",
    "disableCombat",
    "advancePhase",
    "advanceTurn",
    "setActionStatus",
    "submitIntent",
    "holdIntent",
    "clearIntent",
    "recordMovement",
    "clearMovement",
    "adjustInitiative",
    "delayCombatant",
    "setUtilityOptions",
    "startRuneCarving",
    "markRunePrepared",
    "castRuneScript",
    "trackSeidurRitual",
    "clearRuneMagic",
    "disruptRuneMagic",
    "activateEvade",
    "declareDisengagement",
    "resolveKnockbackDisengagement",
    "incrementReaction",
    "decrementReaction",
    "commitDefenseCard",
    "promptDefenseRoll"
  ]);
  for (const descriptor of Object.values(socketSchema.SOCKET_ACTIONS)) {
    assert.equal(typeof descriptor.sanitize, "function");
    assert.equal(typeof descriptor.resolve, "function");
    assert.equal(typeof descriptor.authorize, "function");
    assert.equal(typeof descriptor.execute, "function");
    assert.equal(typeof descriptor.normalize, "function");
    assert.equal(Number.isFinite(descriptor.timeoutMs) && descriptor.timeoutMs > 0, true);
  }
  assert.equal(socketSchema.SOCKET_ACTIONS.initializeCombat.timeoutMs, 10000);
  assert.equal(socketSchema.SOCKET_ACTIONS.promptDefenseRoll.timeoutMs, 20000);
  assert.deepEqual(socketSchema.normalizeSocketActionResult("recordMovement", {
    accepted: false,
    ignoredReason: "stale-revision",
    routeId: "route",
    routeRevision: 3,
    planStatus: "planned",
    draft: false
  }), {
    accepted: false,
    action: "recordMovement",
    ignoredReason: "stale-revision",
    routeId: "route",
    routeRevision: 3,
    planStatus: "planned",
    draft: false
  });
  const defenseSummary = socketSchema.normalizeSocketActionResult("commitDefenseCard", {
    accepted: true,
    defenseMessageId: "message",
    ignoredDocument: { uuid: "Actor.unsafe" }
  });
  assert.deepEqual(defenseSummary, {
    accepted: true,
    action: "commitDefenseCard",
    defenseMessageId: "message"
  });
  const previousHooks = globalThis.Hooks;
  let nextHookId = 1;
  const observedHooks = [];
  globalThis.Hooks = {
    on(eventName, handler) {
      observedHooks.push({ eventName, handler, once: false });
      return nextHookId++;
    },
    once(eventName, handler) {
      observedHooks.push({ eventName, handler, once: true });
      return nextHookId++;
    },
    off() {}
  };
  try {
    const registry = await import("../scripts/core/feature-registry.mjs");
    registry.__test.reset();
    registry.registerFeature({
      id: "contract-feature",
      label: "Contract Feature",
      initialize: hooks => {
        hooks.on("updateCombat", () => undefined);
        hooks.once("ready", () => undefined);
      }
    });
    registry.initializeRegisteredFeatures();
    registry.initializeRegisteredFeatures();
    const report = registry.getFeatureRegistryReport();
    assert.equal(observedHooks.length, 2);
    assert.equal(report.hookCount, 2);
    assert.equal(report.hookCountSource, "tracked");
    assert.equal(report.features[0].trackedHookCount, 2);
    assert.equal(report.features[0].declaredHookCount, 0);
  } finally {
    globalThis.Hooks = previousHooks;
  }
  const changedPaths = await import("../scripts/utils/changed-paths.mjs");
  assert.equal(changedPaths.combatTrackerAffectedByCombatChange({ active: true }), false);
  assert.equal(changedPaths.combatTrackerAffectedByCombatChange({
    flags: { "aov-skjaldborg": { combatState: { phase: "action" } } }
  }), true);
  assert.equal(changedPaths.combatTrackerAffectedByCombatantChange({ sort: 10 }), false);
  assert.equal(changedPaths.combatTrackerAffectedByCombatantChange({ initiative: 12 }), true);
  console.log("contracts: rule ordering, primitive reports, socket schemas, serialization, and prompt fallbacks passed");
}

function cleanBuildPath(path) {
  const resolvedPath = resolve(path);
  const distRoot = resolve(ROOT, "dist");
  const releaseRoot = resolve(ROOT, "release");
  if (resolvedPath !== distRoot && resolvedPath !== releaseRoot
    && !resolvedPath.startsWith(`${distRoot}${sep}`)
    && !resolvedPath.startsWith(`${releaseRoot}${sep}`)) {
    fail(`Refusing to clean path outside build roots: ${resolvedPath}`);
  }
  rmSync(resolvedPath, { recursive: true, force: true });
}

function copyRuntimeSource(destination) {
  mkdirSync(destination, { recursive: true });
  for (const file of RUNTIME_FILES) {
    const source = join(ROOT, file);
    if (!existsSync(source)) fail(`Missing required runtime file ${file}`);
    cpSync(source, join(destination, file));
  }
  for (const file of OPTIONAL_RUNTIME_FILES) {
    const source = join(ROOT, file);
    if (existsSync(source)) cpSync(source, join(destination, file));
  }
  for (const directory of RUNTIME_DIRECTORIES) {
    const source = join(ROOT, directory);
    if (!existsSync(source)) fail(`Missing required runtime directory ${directory}`);
    cpSync(source, join(destination, directory), { recursive: true });
  }
  for (const directory of OPTIONAL_RUNTIME_DIRECTORIES) {
    const source = join(ROOT, directory);
    if (existsSync(source)) cpSync(source, join(destination, directory), { recursive: true });
  }
  for (const path of DEVELOPMENT_ONLY_PATHS) {
    if (existsSync(join(destination, path))) fail(`Build contains development-only path ${path}`);
  }
}

function buildFolder() {
  validateAll();
  const distRoot = join(ROOT, "dist");
  const destination = join(distRoot, MODULE_FOLDER);
  cleanBuildPath(distRoot);
  copyRuntimeSource(destination);
  console.log(`build-folder: ${relativePath(destination)}`);
  return destination;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ (0xEDB88320 & -(value & 1));
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xFFFFFFFF;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function createDeterministicZip(sourceDirectory, outputPath) {
  const files = walk(sourceDirectory);
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(`${MODULE_FOLDER}/${posixPath(relative(sourceDirectory, file))}`, "utf8");
    const content = readFileSync(file);
    const compressed = deflateRawSync(content, { level: 9 });
    const checksum = crc32(content);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034B50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x0021, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, name, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014B50, 0);
    central.writeUInt16LE(0x0314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x0021, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(content.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + compressed.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054B50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, Buffer.concat([...localParts, centralDirectory, end]));
}

function buildRelease() {
  const source = buildFolder();
  const manifest = readJson(join(ROOT, "module.json"));
  const releaseRoot = join(ROOT, "release");
  mkdirSync(releaseRoot, { recursive: true });
  const zipPath = join(releaseRoot, `aov-skjaldborg-v${manifest.version}.zip`);
  cleanBuildPath(zipPath);
  cleanBuildPath(`${zipPath}.sha256`);
  createDeterministicZip(source, zipPath);
  const digest = createHash("sha256").update(readFileSync(zipPath)).digest("hex");
  writeFileSync(`${zipPath}.sha256`, `${digest}  ${posixPath(relative(releaseRoot, zipPath))}\n`, "utf8");
  console.log(`build: ${relativePath(zipPath)}`);
  console.log(`sha256: ${digest}`);
}

function validateAll() {
  syntaxCheck();
  const metadata = validateMetadata();
  validateImportsAndReachability();
  validateTemplatesAndLocalization();
  validateStyles();
  validateAoVContract(metadata);
}

function replaceConstantVersion(source, name, version) {
  const pattern = new RegExp(`(export const ${name} = ")[^"]+(";)`);
  if (!pattern.test(source)) fail(`Unable to locate ${name} in scripts/constants.mjs`);
  return source.replace(pattern, `$1${version}$2`);
}

function setVersion(version) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    fail(`Invalid semantic version "${version}"`);
  }
  const manifestPath = join(ROOT, "module.json");
  const packagePath = join(ROOT, "package.json");
  const lockPath = join(ROOT, "package-lock.json");
  const constantsPath = join(ROOT, "scripts", "constants.mjs");
  const manifest = readJson(manifestPath);
  const packageJson = readJson(packagePath);
  const packageLock = readJson(lockPath);
  manifest.version = version;
  manifest.download = String(manifest.download ?? "").replace(
    /\/releases\/download\/v[^/]+\//,
    `/releases/download/v${version}/`
  );
  packageJson.version = version;
  packageLock.version = version;
  packageLock.packages[""].version = version;
  const constants = replaceConstantVersion(readFileSync(constantsPath, "utf8"), "MODULE_VERSION", version);
  writeJson(manifestPath, manifest);
  writeJson(packagePath, packageJson);
  writeJson(lockPath, packageLock);
  writeFileSync(constantsPath, constants, "utf8");
  console.log(`set-version: ${version}`);
}

const [command = "validate", ...args] = process.argv.slice(2);
try {
  if (command === "syntax") syntaxCheck();
  else if (command === "validate") validateAll();
  else if (command === "contracts") await contractTests();
  else if (command === "build-folder") buildFolder();
  else if (command === "build") buildRelease();
  else if (command === "set-version") setVersion(args[0] ?? "");
  else fail(`Unknown command "${command}"`);
}
catch (error) {
  console.error(error?.stack ?? error);
  process.exitCode = 1;
}
