import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

export const ROOT = resolve(import.meta.dirname, "..", "..");
export const MODULE_FOLDER = "aov-skjaldborg";

export function fail(message) {
  throw new Error(message);
}

export function posixPath(path) {
  return path.split(sep).join("/");
}

export function relativePath(path) {
  return posixPath(relative(ROOT, path));
}

export function walk(directory, predicate = () => true) {
  if (!existsSync(directory)) return [];
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walk(path, predicate));
    else if (entry.isFile() && predicate(path)) files.push(path);
  }
  return files.sort((left, right) => relativePath(left).localeCompare(relativePath(right)));
}

export function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  }
  catch (error) {
    fail(`${relativePath(path)} is not valid JSON: ${error.message}`);
  }
}

export function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function normalizedText(value) {
  return String(value ?? "").replaceAll("\r\n", "\n").trimEnd();
}
