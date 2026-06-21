import { MODULE_ID } from "../constants.mjs";

const counters = new Map();
const measures = new Map();
const pendingMarks = new Map();
const MAX_SAMPLES = 50;
let lastEnabled = false;
let enabledAt = null;
let lastEventAt = null;
let eventCount = 0;

function setting(key, fallback = false) {
  try {
    return game.settings?.get?.(MODULE_ID, key) ?? fallback;
  } catch (_exception) {
    return fallback;
  }
}

export function performanceDiagnosticsEnabled() {
  const enabled = setting("performanceDiagnostics", false) === true || setting("debug", false) === true;
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
  entry.lastDetail = detail;
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
    detail,
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
    const total = durations.reduce((sum, duration) => sum + duration, 0);
    const max = durations.reduce((highest, duration) => Math.max(highest, duration), 0);
    return {
      count: samples.length,
      averageMs: durations.length ? Number((total / durations.length).toFixed(2)) : 0,
      maxMs: Number(max.toFixed(2)),
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
