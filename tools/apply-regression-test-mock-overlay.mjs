import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const targetPath = resolve(process.cwd(), "tools/regression-tests.mjs");
let source = readFileSync(targetPath, "utf8");
let changed = false;

const setPropertyFunction = `
function setProperty(object, path, value) {
  const parts = String(path ?? "").split(".").filter(Boolean);
  if (!object || typeof object !== "object" || !parts.length) return object;

  let target = object;
  for (const part of parts.slice(0, -1)) {
    if (!target[part] || typeof target[part] !== "object" || Array.isArray(target[part])) {
      target[part] = {};
    }
    target = target[part];
  }

  target[parts.at(-1)] = clone(value);
  return object;
}
`;

if (!source.includes("function setProperty(object, path, value)")) {
  const anchor = `function mergeObject(base = {}, patch = {}, { inplace = false } = {}) {
  const target = inplace ? base : clone(base);
  for (const [key, value] of Object.entries(patch ?? {})) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      target[key] = mergeObject(target[key] ?? {}, value, { inplace: false });
    } else {
      target[key] = clone(value);
    }
  }
  return target;
}
`;
  if (!source.includes(anchor)) {
    throw new Error("Unable to locate mergeObject helper in tools/regression-tests.mjs.");
  }
  source = source.replace(anchor, `${anchor}${setPropertyFunction}`);
  changed = true;
}

const utilsAnchor = `      deepClone: clone,
      mergeObject,
      randomID: () => \`test-\${++idCounter}\`,`;

if (!source.includes("      setProperty,")) {
  if (!source.includes(utilsAnchor)) {
    throw new Error("Unable to locate foundry.utils mock in tools/regression-tests.mjs.");
  }
  source = source.replace(utilsAnchor, `      deepClone: clone,
      mergeObject,
      setProperty,
      randomID: () => \`test-\${++idCounter}\`,`);
  changed = true;
}

const oldEmbeddedUpdate = `        Object.assign(entry, clone(update));
        delete entry._id;`;

const newEmbeddedUpdate = `        for (const [key, value] of Object.entries(update)) {
          if (key === "_id") continue;
          if (key.includes(".")) foundry.utils.setProperty(entry, key, value);
          else entry[key] = clone(value);
        }`;

if (source.includes(oldEmbeddedUpdate)) {
  source = source.replace(oldEmbeddedUpdate, newEmbeddedUpdate);
  changed = true;
} else if (!source.includes("foundry.utils.setProperty(entry, key, value)")) {
  throw new Error("Unable to locate combat.updateEmbeddedDocuments mock block in tools/regression-tests.mjs.");
}

if (changed) {
  writeFileSync(targetPath, source, "utf8");
  console.log("Applied regression test embedded-update mock overlay.");
} else {
  console.log("Regression test embedded-update mock overlay is already applied.");
}
