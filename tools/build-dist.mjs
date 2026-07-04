import { cp, mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distRoot = path.join(root, "dist");
const packageRoot = path.join(distRoot, "aov-skjaldborg");
const compiledCss = path.join(root, "styles", "skjaldborg.css");

const releaseEntries = [
  "module.json",
  "README.md",
  "previous-releases.md",
  "docs",
  "lang",
  "scripts",
  "templates"
];

async function assertFile(filePath, message) {
  const info = await stat(filePath).catch(() => null);
  if (!info?.isFile()) throw new Error(message);
}

async function copyEntry(entry) {
  await cp(path.join(root, entry), path.join(packageRoot, entry), {
    recursive: true,
    errorOnExist: false,
    force: true
  });
}

await assertFile(compiledCss, "Missing styles/skjaldborg.css. Run npm run styles:release before building dist.");

await rm(packageRoot, { recursive: true, force: true });
await mkdir(path.join(packageRoot, "styles"), { recursive: true });

for (const entry of releaseEntries) {
  await copyEntry(entry);
}

await cp(compiledCss, path.join(packageRoot, "styles", "skjaldborg.css"), {
  force: true
});

console.log(`Built ${path.relative(root, packageRoot)}`);
