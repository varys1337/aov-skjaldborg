import { MODULE_ID } from "../constants.mjs";
import { runtimeSettings } from "../runtime-settings.mjs";

const counters = new Map();
const measures = new Map();
const pendingMarks = new Map();
const MAX_SAMPLES = 50;
let lastEnabled = false;
let enabledAt = null;
let lastEventAt = null;
let eventCount = 0;

function isPlainObject(value) {
  return value !== null && typeof value === "object" && (value.constructor === Object || Object.getPrototypeOf(value) === null);
}

function sanitizeDiagnosticDetail(value, { maxDepth = 4, maxArray = 25, maxKeys = 50 } = {}) {
  const seen = new WeakSet();
  const clone = (candidate, depth) => {
    if (candidate === null || candidate === undefined) return candidate ?? null;
    if (typeof candidate === "string" || typeof candidate === "boolean") return candidate;
    if (typeof candidate === "number") return Number.isFinite(candidate) ? candidate : String(candidate);
    if (typeof candidate === "bigint") return candidate.toString();
    if (typeof candidate === "function") return `[Function ${candidate.name || "anonymous"}]`;
    if (typeof candidate !== "object") return String(candidate);
    if (candidate instanceof Error) return { name: candidate.name, message: candidate.message, stack: candidate.stack ?? null };
    if (depth >= maxDepth) {
      const id = candidate?.id ?? candidate?._id ?? candidate?.uuid ?? null;
      return id ? { id: String(id), __type: candidate?.constructor?.name ?? "Object" } : `[MaxDepth:${candidate?.constructor?.name ?? "Object"}]`;
    }
    if (seen.has(candidate)) return `[Circular:${candidate?.constructor?.name ?? "Object"}]`;
    seen.add(candidate);

    let result;
    if (Array.isArray(candidate)) {
      result = candidate.slice(0, maxArray).map(entry => clone(entry, depth + 1));
      if (candidate.length > maxArray) result.push(`[Truncated ${candidate.length - maxArray} entries]`);
    }
    else if (candidate instanceof Map) {
      result = Object.fromEntries(Array.from(candidate.entries()).slice(0, maxKeys).map(([key, entry]) => [String(key), clone(entry, depth + 1)]));
      if (candidate.size > maxKeys) result.__truncatedEntries = candidate.size - maxKeys;
    }
    else if (candidate instanceof Set) {
      result = Array.from(candidate.values()).slice(0, maxArray).map(entry => clone(entry, depth + 1));
      if (candidate.size > maxArray) result.push(`[Truncated ${candidate.size - maxArray} entries]`);
    }
    else {
      const entries = Object.entries(candidate).slice(0, maxKeys);
      result = {};
      const constructorName = candidate?.constructor?.name;
      if (constructorName && constructorName !== "Object") result.__type = constructorName;
      for (const [key, entry] of entries) {
        // Avoid retaining live Foundry document graphs through common backrefs.
        if (!isPlainObject(candidate) && ["parent", "object", "actor", "token", "combat", "scene"].includes(key)) {
          const id = entry?.uuid ?? entry?.id ?? entry?._id ?? null;
          result[key] = id ? String(id) : `[Reference:${entry?.constructor?.name ?? "Object"}]`;
          continue;
        }
        result[key] = clone(entry, depth + 1);
      }
      const keyCount = Object.keys(candidate).length;
      if (keyCount > maxKeys) result.__truncatedKeys = keyCount - maxKeys;
    }

    seen.delete(candidate);
    return result;
  };

  try {
    return clone(value, 0);
  }
  catch (error) {
    return { serializationError: String(error?.message ?? error) };
  }
}

function percentile(sortedDurations, percentileValue) {
  if (!sortedDurations.length) return 0;
  if (sortedDurations.length === 1) return sortedDurations[0];
  const index = Math.ceil((percentileValue / 100) * sortedDurations.length) - 1;
  return sortedDurations[Math.max(0, Math.min(sortedDurations.length - 1, index))];
}


export function performanceDiagnosticsEnabled() {
  const enabled = runtimeSettings.performanceDiagnostics === true || runtimeSettings.debug === true;
  if (enabled && !lastEnabled) enabledAt = Date.now();
  if (!enabled && lastEnabled) enabledAt = null;
  lastEnabled = enabled;
  return enabled;
}

function noteDiagnosticEvent() {
  eventCount += 1;
  lastEventAt = Date.now();
}

export function incrementCounter(name, amount = 1, detail = null) {
  if (!performanceDiagnosticsEnabled()) return;
  noteDiagnosticEvent();
  const entry = counters.get(name) ?? { count: 0, lastDetail: null };
  const numericAmount = Number(amount);
  entry.count += Number.isFinite(numericAmount) ? numericAmount : 1;
  entry.lastDetail = sanitizeDiagnosticDetail(detail);
  counters.set(name, entry);
}

export function markStart(name) {
  if (!performanceDiagnosticsEnabled()) return null;
  noteDiagnosticEvent();
  const id = `${name}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
  pendingMarks.set(id, {
    name,
    startedAt: globalThis.performance?.now?.() ?? Date.now()
  });
  return id;
}

export function markEnd(id, detail = null) {
  if (!id || !performanceDiagnosticsEnabled()) return 0;
  const started = pendingMarks.get(id);
  if (!started) return 0;
  pendingMarks.delete(id);
  const endedAt = globalThis.performance?.now?.() ?? Date.now();
  const duration = Math.max(0, endedAt - started.startedAt);
  recordMeasure(started.name, duration, detail);
  return duration;
}

export async function measureAsync(name, operation, detailFactory = null) {
  const id = markStart(name);
  try {
    return await operation();
  } finally {
    const detail = typeof detailFactory === "function" ? detailFactory() : detailFactory;
    markEnd(id, detail);
  }
}

export function recordMeasure(name, duration, detail = null) {
  if (!performanceDiagnosticsEnabled()) return;
  noteDiagnosticEvent();
  const samples = measures.get(name) ?? [];
  samples.push({
    duration,
    detail: sanitizeDiagnosticDetail(detail),
    at: Date.now()
  });
  while (samples.length > MAX_SAMPLES) samples.shift();
  measures.set(name, samples);
}

export function performanceReport() {
  const enabled = performanceDiagnosticsEnabled();
  const counterCount = counters.size;
  const measureCount = measures.size;
  const empty = counterCount === 0 && measureCount === 0 && pendingMarks.size === 0;
  const summarize = samples => {
    const durations = samples.map(sample => Number(sample.duration) || 0);
    const sorted = durations.slice().sort((left, right) => left - right);
    const total = durations.reduce((sum, duration) => sum + duration, 0);
    const max = durations.reduce((highest, duration) => Math.max(highest, duration), 0);
    return {
      count: samples.length,
      averageMs: durations.length ? Number((total / durations.length).toFixed(2)) : 0,
      maxMs: Number(max.toFixed(2)),
      p50Ms: Number(percentile(sorted, 50).toFixed(2)),
      p95Ms: Number(percentile(sorted, 95).toFixed(2)),
      last: samples.at(-1) ?? null
    };
  };
  return {
    enabled,
    metadata: {
      enabledAt: enabledAt ? new Date(enabledAt).toISOString() : null,
      lastEventAt: lastEventAt ? new Date(lastEventAt).toISOString() : null,
      eventCount,
      counterCount,
      measureCount,
      pendingMeasureCount: pendingMarks.size,
      empty,
      guidance: empty && enabled
        ? "Performance diagnostics are enabled, but no measured Skjaldborg activity has occurred yet. Enable this setting before reload or before repeating the action you want to profile."
        : ""
    },
    counters: Object.fromEntries(counters.entries()),
    measures: Object.fromEntries(Array.from(measures.entries(), ([name, samples]) => [name, summarize(samples)]))
  };
}

export function resetPerformanceReport() {
  counters.clear();
  measures.clear();
  pendingMarks.clear();
  eventCount = 0;
  lastEventAt = null;
  if (performanceDiagnosticsEnabled()) enabledAt = Date.now();
}

export function performanceDiagnosticsHelp() {
  const report = performanceReport();
  const lines = [
    "Skjaldborg performance diagnostics are client-local and disabled by default.",
    report.enabled
      ? "Diagnostics are currently enabled."
      : "Enable them with: await game.settings.set(\"aov-skjaldborg\", \"performanceDiagnostics\", true)",
    "For startup or first-render timing, enable diagnostics, reload Foundry, repeat the slow action, then run: game.aovSkjaldborg.diagnostics.performance.report()"
  ];
  if (report.metadata.guidance) lines.push(report.metadata.guidance);
  const message = lines.join("\n");
  console.info(message, report);
  return { message, report };
}

export function performanceDiagnosticsTable() {
  const report = performanceReport();
  console.info("Skjaldborg performance diagnostics", report.metadata);
  console.table(Object.entries(report.counters).map(([name, entry]) => ({
    name,
    count: entry.count,
    lastDetail: entry.lastDetail
  })));
  console.table(Object.entries(report.measures).map(([name, entry]) => ({
    name,
    count: entry.count,
    averageMs: entry.averageMs,
    maxMs: entry.maxMs,
    p50Ms: entry.p50Ms,
    p95Ms: entry.p95Ms,
    lastDetail: entry.last?.detail ?? null
  })));
  return report;
}

export const performanceDiagnostics = Object.freeze({
  enabled: performanceDiagnosticsEnabled,
  count: incrementCounter,
  markStart,
  markEnd,
  measureAsync,
  recordMeasure,
  report: performanceReport,
  reset: resetPerformanceReport,
  help: performanceDiagnosticsHelp,
  table: performanceDiagnosticsTable
});
