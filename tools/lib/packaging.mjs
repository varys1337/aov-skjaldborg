import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { deflateRawSync } from "node:zlib";
import { ROOT, MODULE_FOLDER, fail, posixPath, relativePath, walk, readJson } from "./workspace.mjs";
import { validateAll } from "./validation.mjs";

const RUNTIME_DIRECTORIES = Object.freeze(["lang", "scripts", "styles", "templates"]);
const OPTIONAL_RUNTIME_DIRECTORIES = Object.freeze(["docs"]);
const RUNTIME_FILES = Object.freeze(["module.json", "README.md"]);
const OPTIONAL_RUNTIME_FILES = Object.freeze(["LICENSE", "previous-releases.md", "previous-nongithub-releases.md"]);
const DEVELOPMENT_ONLY_PATHS = Object.freeze([
  ".maintenance",
  ".ci",
  ".githooks",
  ".git",
  ".github",
  "node_modules",
  "package.json",
  "package-lock.json",
  "src",
  "tools"
]);
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

export function copyRuntimeSource(destination) {
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

export function buildFolder({ requireAoVContract = false } = {}) {
  validateAll({ requireAoVContract });
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

export function createDeterministicZip(sourceDirectory, outputPath) {
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

/** Reject a tag/version mismatch before modifying any generated output. */
export function validateReleaseTag(tag, version = readJson(join(ROOT, "module.json")).version) {
  const expected = `v${version}`;
  if (tag !== undefined && tag !== expected) fail(`Release tag ${tag} does not match module version ${version} (expected ${expected}).`);
  return expected;
}

export function buildRelease({ tag } = {}) {
  const manifest = readJson(join(ROOT, "module.json"));
  validateReleaseTag(tag, manifest.version);
  const source = buildFolder({ requireAoVContract: true });
  const releaseRoot = join(ROOT, "release");
  mkdirSync(releaseRoot, { recursive: true });
  const zipPath = join(releaseRoot, `${MODULE_FOLDER}.zip`);
  const manifestPath = join(releaseRoot, "module.json");
  const checksumPath = join(releaseRoot, "SHA256SUMS.txt");
  cleanBuildPath(zipPath);
  createDeterministicZip(source, zipPath);
  // Copy the exact packaged manifest bytes; standalone and embedded assets must agree.
  cpSync(join(source, "module.json"), manifestPath);
  const checksums = [zipPath, manifestPath].map(path => {
    const digest = createHash("sha256").update(readFileSync(path)).digest("hex");
    return `${digest}  ${posixPath(relative(releaseRoot, path))}`;
  });
  writeFileSync(checksumPath, `${checksums.join("\n")}\n`, "utf8");
  console.log(`build: ${relativePath(zipPath)}`);
  console.log(`manifest: ${relativePath(manifestPath)}`);
  console.log(`checksums: ${relativePath(checksumPath)}`);
  return { zipPath, manifestPath, checksumPath };
}
