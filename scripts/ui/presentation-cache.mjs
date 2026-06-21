import { incrementCounter } from "../performance/performance-monitor.mjs";

const cachesByActor = new WeakMap();

function actorCaches(actor) {
  let caches = cachesByActor.get(actor);
  if (!caches) {
    caches = new Map();
    cachesByActor.set(actor, caches);
  }
  return caches;
}

function revisionFor(actor, category) {
  return [
    actor?.uuid ?? actor?.id ?? "",
    actor?.updatedAt ?? actor?._stats?.modifiedTime ?? "",
    category
  ].join(":");
}

export function getCachedPresentation(actor, category, build) {
  if (!actor || typeof build !== "function") return build?.();
  const caches = actorCaches(actor);
  const revision = revisionFor(actor, category);
  const cached = caches.get(category);
  if (cached?.revision === revision) {
    incrementCounter(`presentationCache.hit.${category}`);
    return cached.value;
  }
  const value = build();
  caches.set(category, { revision, value });
  incrementCounter(`presentationCache.miss.${category}`);
  return value;
}

export async function getCachedPresentationAsync(actor, category, build) {
  if (!actor || typeof build !== "function") return build?.();
  const caches = actorCaches(actor);
  const revision = revisionFor(actor, category);
  const cached = caches.get(category);
  if (cached?.revision === revision) {
    incrementCounter(`presentationCache.hit.${category}`);
    return cached.value;
  }
  const value = await build();
  caches.set(category, { revision, value });
  incrementCounter(`presentationCache.miss.${category}`);
  return value;
}

export function invalidateActorPresentation(actor, categories = null) {
  const caches = actor ? cachesByActor.get(actor) : null;
  if (!caches) return;
  if (!categories) {
    caches.clear();
    incrementCounter("presentationCache.invalidate.all");
    return;
  }
  for (const category of categories) {
    caches.delete(category);
    incrementCounter(`presentationCache.invalidate.${category}`);
  }
}

export const PresentationCache = Object.freeze({
  get: getCachedPresentation,
  getAsync: getCachedPresentationAsync,
  invalidate: invalidateActorPresentation
});
