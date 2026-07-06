import { MODULE_ID } from "../constants.mjs";
import { incrementCounter } from "../performance/performance-monitor.mjs";

const DEFAULT_IGNORED_KEYS = new Set(["createdAt", "updatedAt", "resolvedAt", "damageResolvedAt"]);

function comparisonValue(value, ignoredKeys = DEFAULT_IGNORED_KEYS) {
  if (Array.isArray(value)) return value.map(entry => comparisonValue(entry, ignoredKeys));
  if (!value || typeof value !== "object") return value;
  const entries = Object.entries(value)
    .filter(([key]) => !ignoredKeys.has(key))
    .sort(([left], [right]) => left.localeCompare(right));
  return Object.fromEntries(entries.map(([key, entry]) => [key, comparisonValue(entry, ignoredKeys)]));
}

function stableString(value, ignoredKeys) {
  return JSON.stringify(comparisonValue(value, ignoredKeys));
}

export function valuesMeaningfullyEqual(current, next, { ignoredKeys = DEFAULT_IGNORED_KEYS } = {}) {
  return stableString(current, ignoredKeys) === stableString(next, ignoredKeys);
}

function getProperty(source, path) {
  if (!source || !path) return undefined;
  if (typeof globalThis.foundry?.utils?.getProperty === "function") return globalThis.foundry.utils.getProperty(source, path);
  return String(path).split(".").reduce((value, segment) => value?.[segment], source);
}

function updateCurrentValue(document, path) {
  if (!document || !path) return undefined;
  if (path === "content") return document.content;
  if (path.startsWith("flags.")) return getProperty(document, path);
  return getProperty(document, path);
}

function countWrite(category, skipped, detail = {}) {
  incrementCounter(`document.write.${category}.${skipped ? "skipped" : "applied"}`, 1, detail);
}

function pathIsIgnored(path, ignoredKeys = DEFAULT_IGNORED_KEYS) {
  const last = String(path ?? "").split(".").at(-1);
  return ignoredKeys.has(last);
}

/**
 * Set one module flag only when the non-volatile payload meaningfully changes.
 *
 * @param {Document|object|null|undefined} document Target document.
 * @param {string} scope Flag scope.
 * @param {string} key Flag key.
 * @param {unknown} value Next flag value.
 * @param {{category?: string, ignoredKeys?: Set<string>, detail?: object}} [options={}] Guard options.
 * @returns {Promise<unknown>}
 */
export async function guardedSetFlag(document, scope, key, value, options = {}) {
  if (!document?.setFlag) return null;
  const category = options.category ?? `${scope}.${key}`;
  const current = document.getFlag?.(scope, key);
  const equal = current !== undefined && valuesMeaningfullyEqual(current, value, options);
  const detail = {
    documentId: document.id ?? document._id ?? null,
    documentUuid: document.uuid ?? null,
    scope,
    key,
    ...(options.detail ?? {})
  };
  if (equal) {
    countWrite(category, true, detail);
    return document;
  }
  const result = await document.setFlag(scope, key, value);
  countWrite(category, false, detail);
  return result;
}

/**
 * Update a document only when all submitted paths are already different.
 *
 * @param {Document|object|null|undefined} document Target document.
 * @param {object} updateData Foundry update data.
 * @param {{category?: string, ignoredKeys?: Set<string>, detail?: object, options?: object}} [options={}] Guard options.
 * @returns {Promise<unknown>}
 */
export async function guardedUpdate(document, updateData, options = {}) {
  if (!document?.update || !updateData || typeof updateData !== "object") return null;
  const entries = Object.entries(updateData);
  if (!entries.length) return document;
  const category = options.category ?? document.constructor?.name ?? "document";
  const unchanged = entries.every(([path, value]) => (
    pathIsIgnored(path, options.ignoredKeys)
    || valuesMeaningfullyEqual(updateCurrentValue(document, path), value, options)
  ));
  const detail = {
    documentId: document.id ?? document._id ?? null,
    documentUuid: document.uuid ?? null,
    paths: entries.map(([path]) => path),
    ...(options.detail ?? {})
  };
  if (unchanged) {
    countWrite(category, true, detail);
    return document;
  }
  const result = await document.update(updateData, options.options ?? {});
  countWrite(category, false, detail);
  return result;
}

export async function guardedModuleFlag(document, key, value, options = {}) {
  return guardedSetFlag(document, MODULE_ID, key, value, options);
}
