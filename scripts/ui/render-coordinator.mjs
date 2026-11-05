import { incrementCounter, measureAsync, performanceDiagnosticsEnabled } from "../performance/performance-monitor.mjs";
import { warn } from "../logger.mjs";

const handlers = new Map();
const pending = new Map();
let frame = null;
let activeFlush = null;

function requestFrame(callback) {
  if (typeof globalThis.requestAnimationFrame === "function") {
    return { id: globalThis.requestAnimationFrame(callback), cancel: id => globalThis.cancelAnimationFrame?.(id) };
  }
  return { id: globalThis.setTimeout(callback, 16), cancel: id => globalThis.clearTimeout(id) };
}

function mergeSet(target, source) {
  if (!source) return target;
  for (const value of source) target.add(value);
  return target;
}

function normalizeDetail(detail = {}) {
  return {
    ...detail,
    parts: new Set(detail.parts ?? []),
    tokenIds: new Set(detail.tokenIds ?? []),
    combatantIds: new Set(detail.combatantIds ?? []),
    reasons: new Set([...(detail.reasons ?? []), ...(detail.reason ? [detail.reason] : [])]),
    positionOnly: detail.positionOnly === true
  };
}

function mergeDetail(existing, incoming) {
  if (!existing) return normalizeDetail(incoming);
  const next = normalizeDetail(existing);
  const detail = normalizeDetail(incoming);
  mergeSet(next.parts, detail.parts);
  mergeSet(next.tokenIds, detail.tokenIds);
  mergeSet(next.combatantIds, detail.combatantIds);
  mergeSet(next.reasons, detail.reasons);
  next.full = next.full === true || detail.full === true;
  next.positionOnly = next.positionOnly === true && detail.positionOnly === true;
  return next;
}

function serializableDetail(detail) {
  return {
    ...detail,
    parts: Array.from(detail.parts ?? []),
    tokenIds: Array.from(detail.tokenIds ?? []),
    combatantIds: Array.from(detail.combatantIds ?? []),
    reasons: Array.from(detail.reasons ?? [])
  };
}

export function registerRenderSurface(surface, handler) {
  if (!surface || typeof handler !== "function") throw new TypeError("Render surface registration requires a name and handler.");
  handlers.set(surface, handler);
}

export function invalidateRenderSurface(surface, detail = {}) {
  if (!surface) return;
  pending.set(surface, mergeDetail(pending.get(surface), detail));
  if (performanceDiagnosticsEnabled()) incrementCounter(`render.invalidate.${surface}`, 1, serializableDetail(pending.get(surface)));
  scheduleFlush();
}

function scheduleFlush() {
  if (frame !== null || activeFlush) return;
  frame = requestFrame(() => {
    frame = null;
    void flushRenderSurfaces().catch(exception => {
      warn("A coordinated render surface failed.", exception);
    });
  });
}

export function invalidateCombatTracker(reason = "combat-tracker", detail = {}) {
  const merged = typeof reason === "object" && reason !== null
    ? reason
    : { ...detail, reason };
  const reasons = Array.isArray(merged?.reasons) ? merged.reasons : [merged?.reason].filter(Boolean);
  if (performanceDiagnosticsEnabled() && reasons.some(entry => String(entry).startsWith("movement") || String(entry).includes("engagement"))) {
    incrementCounter("movement.tick.trackerInvalidations", 1, serializableDetail(normalizeDetail(merged)));
  }
  invalidateRenderSurface("combatTracker", merged);
}

export function invalidateActorHotbarSurface(parts = ["shell"], reason = "actor-hotbar") {
  invalidateRenderSurface("actorHotbar", { parts, reason, full: parts.includes?.("shell") === true });
}

export function flushRenderSurfaces() {
  if (activeFlush) return activeFlush;
  if (frame !== null) {
    frame.cancel(frame.id);
    frame = null;
  }
  // Assign the shared promise before invoking handlers, including synchronous
  // ones which invalidate another surface or explicitly request a flush.
  activeFlush = Promise.resolve().then(async () => {
    while (pending.size) {
      const batch = Array.from(pending.entries());
      pending.clear();
      if (performanceDiagnosticsEnabled()) incrementCounter("render.flush", 1, {
        surfaceCount: batch.length,
        surfaces: batch.map(([surface]) => surface)
      });
      for (const [surface, detail] of batch) {
        const handler = handlers.get(surface);
        if (!handler) continue;
        try {
          const payload = serializableDetail(detail);
          incrementCounter(`render.flush.${surface}`, 1, payload);
          await measureAsync(`render.${surface}`, () => handler(payload), () => payload);
        } catch (exception) {
          warn(`Coordinated render failed for ${surface}.`, exception);
        }
      }
    }
  }).finally(() => {
    activeFlush = null;
    if (pending.size) scheduleFlush();
  });
  return activeFlush;
}

export const RenderCoordinator = Object.freeze({
  register: registerRenderSurface,
  invalidate: invalidateRenderSurface,
  invalidateCombatTracker,
  invalidateActorHotbar: invalidateActorHotbarSurface,
  flush: flushRenderSurfaces
});
