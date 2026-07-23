import { incrementCounter, measureAsync } from "../performance/performance-monitor.mjs";
import { warn } from "../logger.mjs";

const handlers = new Map();
const pending = new Map();
let frame = null;

function requestFrame(callback) {
  if (typeof globalThis.requestAnimationFrame === "function") return globalThis.requestAnimationFrame(callback);
  return globalThis.setTimeout(callback, 16);
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
    reasons: new Set(detail.reason ? [detail.reason] : detail.reasons ?? []),
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
  incrementCounter(`render.invalidate.${surface}`, 1, serializableDetail(pending.get(surface)));
  if (frame !== null) return;
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
  if (reasons.some(entry => String(entry).startsWith("movement") || String(entry).includes("engagement"))) {
    incrementCounter("movement.tick.trackerInvalidations", 1, serializableDetail(normalizeDetail(merged)));
  }
  invalidateRenderSurface("combatTracker", merged);
}

export function invalidateActorHotbarSurface(parts = ["shell"], reason = "actor-hotbar") {
  invalidateRenderSurface("actorHotbar", { parts, reason, full: parts.includes?.("shell") === true });
}

export async function flushRenderSurfaces() {
  const batch = Array.from(pending.entries());
  pending.clear();
  incrementCounter("render.flush", 1, {
    surfaceCount: batch.length,
    surfaces: batch.map(([surface]) => surface)
  });
  for (const [surface, detail] of batch) {
    const handler = handlers.get(surface);
    if (!handler) continue;
    incrementCounter(`render.flush.${surface}`, 1, serializableDetail(detail));
    await measureAsync(`render.${surface}`, () => handler(serializableDetail(detail)), () => serializableDetail(detail));
  }
}

export const RenderCoordinator = Object.freeze({
  register: registerRenderSurface,
  invalidate: invalidateRenderSurface,
  invalidateCombatTracker,
  invalidateActorHotbar: invalidateActorHotbarSurface,
  flush: flushRenderSurfaces
});
