import { createHash } from "node:crypto";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { basename, join, relative } from "node:path";
import process from "node:process";
import { deflateRawSync } from "node:zlib";

const root = process.cwd();
const dist = join(root, "dist");
const staging = join(dist, "package");
const archiveName = "aov-skjaldborg.zip";
const archivePath = join(dist, archiveName);
const manifestAssetPath = join(dist, "module.json");
const checksumPath = join(dist, "SHA256SUMS.txt");
const repository = process.env.GITHUB_REPOSITORY || "varys1337/aov-skjaldborg";
const repositoryUrl = `https://github.com/${repository}`;
const sourceManifest = JSON.parse(readFileSync(join(root, "module.json"), "utf8"));
const tag = readTagArgument() ?? `v${sourceManifest.version}`;
const normalizedTag = tag.startsWith("v") ? tag : `v${tag}`;

const requiredRuntimeFiles = ["README.md"];
const optionalRuntimeFiles = ["previous-releases.md"];
const requiredRuntimeDirectories = ["lang", "scripts", "styles", "templates"];
const optionalRuntimeDirectories = ["docs"];

const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
  }
  return value >>> 0;
});

if (normalizedTag !== `v${sourceManifest.version}`) {
  console.error(`Release tag ${tag} does not match module version ${sourceManifest.version}.`);
  process.exit(1);
}

const releaseManifest = {
  ...sourceManifest,
  url: repositoryUrl,
  manifest: `${repositoryUrl}/releases/latest/download/module.json`,
  download: `${repositoryUrl}/releases/download/${normalizedTag}/${archiveName}`,
  readme: `${repositoryUrl}/blob/main/README.md`,
  bugs: `${repositoryUrl}/issues`,
  changelog: `${repositoryUrl}/releases`
};

rmSync(dist, { recursive: true, force: true });
mkdirSync(staging, { recursive: true });

for (const file of requiredRuntimeFiles) {
  copyFileSync(join(root, file), join(staging, file));
}
for (const file of optionalRuntimeFiles) {
  const source = join(root, file);
  if (existsSync(source)) copyFileSync(source, join(staging, file));
}
for (const directory of requiredRuntimeDirectories) {
  cpSync(join(root, directory), join(staging, directory), { recursive: true });
}
for (const directory of optionalRuntimeDirectories) {
  const source = join(root, directory);
  if (existsSync(source)) cpSync(source, join(staging, directory), { recursive: true });
}

const manifestText = `${JSON.stringify(releaseManifest, null, 2)}\n`;
writeFileSync(join(staging, "module.json"), manifestText, "utf8");
writeFileSync(manifestAssetPath, manifestText, "utf8");
writeZip(staging, archivePath);

const checksums = [archivePath, manifestAssetPath].map(path => {
  const digest = createHash("sha256").update(readFileSync(path)).digest("hex");
  return `${digest}  ${basename(path)}`;
});
writeFileSync(checksumPath, `${checksums.join("\n")}\n`, "utf8");

console.log(`Built ${relative(root, archivePath)} for ${normalizedTag}.`);
console.log(`Release manifest: ${relative(root, manifestAssetPath)}`);
console.log(`Checksums: ${relative(root, checksumPath)}`);

function readTagArgument() {
  const index = process.argv.indexOf("--tag");
  if (index === -1) return null;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) {
    console.error("The --tag option requires a value.");
    process.exit(1);
  }
  return value;
}

function collectFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const fullPath = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...collectFiles(fullPath));
    else if (entry.isFile()) files.push(fullPath);
  }
  return files.sort((left, right) => relative(directory, left).localeCompare(relative(directory, right)));
}

function writeZip(sourceDirectory, destination) {
  const body = [];
  const centralDirectory = [];
  let offset = 0;
  let entryCount = 0;
  const timestamp = dosTimestamp(new Date(Number(process.env.SOURCE_DATE_EPOCH || 1577836800) * 1000));

  for (const file of collectFiles(sourceDirectory)) {
    const name = relative(sourceDirectory, file).replaceAll("\\\\", "/");
    const nameBuffer = Buffer.from(name, "utf8");
    const data = readFileSync(file);
    const compressed = deflateRawSync(data, { level: 9 });
    const crc = crc32(data);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x0800, 6);
    localHeader.writeUInt16LE(8, 8);
    localHeader.writeUInt16LE(timestamp.time, 10);
    localHeader.writeUInt16LE(timestamp.date, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(compressed.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(nameBuffer.length, 26);
    localHeader.writeUInt16LE(0, 28);

    body.push(localHeader, nameBuffer, compressed);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(0x031e, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt16LE(8, 10);
    centralHeader.writeUInt16LE(timestamp.time, 12);
    centralHeader.writeUInt16LE(timestamp.date, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(compressed.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(nameBuffer.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    centralDirectory.push(centralHeader, nameBuffer);

    offset += localHeader.length + nameBuffer.length + compressed.length;
    entryCount += 1;
  }

  if (entryCount === 0) throw new Error("Cannot build an empty module archive.");
  if (entryCount > 0xffff) throw new Error("ZIP64 output is not supported by this release builder.");

  const centralSize = centralDirectory.reduce((sum, chunk) => sum + chunk.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entryCount, 8);
  end.writeUInt16LE(entryCount, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  writeFileSync(destination, Buffer.concat([...body, ...centralDirectory, end]));
}

function dosTimestamp(date) {
  const year = Math.min(2107, Math.max(1980, date.getUTCFullYear()));
  return {
    time: (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | Math.floor(date.getUTCSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate()
  };
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
