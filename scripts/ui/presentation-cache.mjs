import { incrementCounter } from "../performance/performance-monitor.mjs";

const cachesByActor = new WeakMap();

function actorCaches(actor) {
  let caches = cachesByActor.get(actor);
  if (!caches) {
    caches = { entries: new Map(), generation: 0, categories: new Map() };
    cachesByActor.set(actor, caches);
  }
  return caches;
}

function revisionFor(actor, category, caches) {
  return [
    actor?.uuid ?? actor?.id ?? "",
    actor?.updatedAt ?? actor?._stats?.modifiedTime ?? "",
    category,
    caches.generation,
    caches.categories.get(category) ?? 0
  ].join(":");
}

export function getCachedPresentation(actor, category, build) {
  if (!actor || typeof build !== "function") return build?.();
  const caches = actorCaches(actor);
  const revision = revisionFor(actor, category, caches);
  const cached = caches.entries.get(category);
  if (cached?.revision === revision && !cached.pending) {
    incrementCounter(`presentationCache.hit.${category}`);
    return cached.value;
  }
  const value = build();
  if (revisionFor(actor, category, caches) === revision) caches.entries.set(category, { revision, value });
  incrementCounter(`presentationCache.miss.${category}`);
  return value;
}

export async function getCachedPresentationAsync(actor, category, build) {
  if (!actor || typeof build !== "function") return build?.();
  const caches = actorCaches(actor);
  const revision = revisionFor(actor, category, caches);
  const cached = caches.entries.get(category);
  if (cached?.revision === revision) {
    incrementCounter(`presentationCache.hit.${category}`);
    return cached.pending ?? cached.value;
  }
  const entry = { revision, pending: null };
  // Defer the builder until the pending entry is visible to concurrent readers.
  entry.pending = Promise.resolve().then(build).then(value => {
    if (caches.entries.get(category) === entry && revisionFor(actor, category, caches) === revision) {
      caches.entries.set(category, { revision, value });
    }
    return value;
  }).catch(error => {
    if (caches.entries.get(category) === entry) caches.entries.delete(category);
    throw error;
  });
  caches.entries.set(category, entry);
  incrementCounter(`presentationCache.miss.${category}`);
  return entry.pending;
}

export function invalidateActorPresentation(actor, categories = null) {
  const caches = actor ? cachesByActor.get(actor) : null;
  if (!caches) return;
  if (!categories) {
    caches.generation += 1;
    caches.entries.clear();
    caches.categories.clear();
    incrementCounter("presentationCache.invalidate.all");
    return;
  }
  for (const category of categories) {
    caches.categories.set(category, (caches.categories.get(category) ?? 0) + 1);
    caches.entries.delete(category);
    incrementCounter(`presentationCache.invalidate.${category}`);
  }
}

export const PresentationCache = Object.freeze({
  get: getCachedPresentation,
  getAsync: getCachedPresentationAsync,
  invalidate: invalidateActorPresentation
});
