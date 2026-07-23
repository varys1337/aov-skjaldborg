const features = new Map();
const hookRegistrations = new Map();
const initializedFeatures = new Map();
const handlerIds = new WeakMap();
let nextHandlerId = 1;

function normalizeFeature(feature) {
  if (!feature || typeof feature !== "object") throw new TypeError("Feature registration must be an object.");
  const id = String(feature.id ?? "").trim();
  if (!id) throw new TypeError("Feature id is required.");
  return {
    id,
    label: String(feature.label ?? id),
    enabled: typeof feature.enabled === "function" ? feature.enabled : () => true,
    initialize: typeof feature.initialize === "function" ? feature.initialize : null,
    hooks: Array.isArray(feature.hooks) ? feature.hooks : [],
    declaredHookCount: Math.max(0, Number(feature.hookCount) || 0)
  };
}

function hookKey(featureId, eventName, handler) {
  if (!handlerIds.has(handler)) handlerIds.set(handler, nextHandlerId++);
  return `${featureId}:${eventName}:${handlerIds.get(handler)}`;
}

function createFeatureHookRegistrar(featureId) {
  function register(eventName, handler, { once = false } = {}) {
    const hookName = String(eventName ?? "").trim();
    if (!hookName || typeof handler !== "function") return null;
    const key = hookKey(featureId, hookName, handler);
    if (hookRegistrations.has(key)) return hookRegistrations.get(key).hookId;
    const hookId = once ? Hooks.once(hookName, handler) : Hooks.on(hookName, handler);
    const registration = {
      featureId,
      eventName: hookName,
      hookId,
      once,
      handlerName: handler.name || ""
    };
    hookRegistrations.set(key, registration);
    return hookId;
  }
  return Object.freeze({
    on: (eventName, handler) => register(eventName, handler),
    once: (eventName, handler) => register(eventName, handler, { once: true }),
    off: (eventName, hookId) => Hooks.off(eventName, hookId)
  });
}

function registerFeatureHooks(feature, registrar) {
  for (const entry of feature.hooks) {
    const [eventName, handler, options = {}] = entry ?? [];
    if (options?.once === true) registrar.once(eventName, handler);
    else registrar.on(eventName, handler);
  }
}

/**
 * Register one Skjaldborg feature initializer.
 *
 * Re-registering an existing id is a no-op and returns the original feature.
 * This prevents duplicate hook listeners during settings refreshes or module
 * reload experiments.
 *
 * @param {object} feature Feature descriptor.
 * @returns {object} Registered feature descriptor.
 */
export function registerFeature(feature) {
  const normalized = normalizeFeature(feature);
  if (features.has(normalized.id)) return features.get(normalized.id);
  features.set(normalized.id, normalized);
  return normalized;
}

/**
 * Initialize all registered features in insertion order.
 *
 * @returns {Map<string, {enabled: boolean, initialized: boolean, result: unknown, trackedHookCount: number}>}
 */
export function initializeRegisteredFeatures() {
  for (const feature of features.values()) {
    const previous = initializedFeatures.get(feature.id);
    if (previous?.initialized === true) continue;
    const enabled = feature.enabled() !== false;
    if (!enabled) {
      initializedFeatures.set(feature.id, {
        enabled: false,
        initialized: false,
        result: null,
        declaredHookCount: feature.declaredHookCount || feature.hooks.length
      });
      continue;
    }
    const registrar = createFeatureHookRegistrar(feature.id);
    registerFeatureHooks(feature, registrar);
    const result = feature.initialize ? feature.initialize(registrar) : null;
    const trackedHookCount = Array.from(hookRegistrations.values())
      .filter(registration => registration.featureId === feature.id)
      .length;
    initializedFeatures.set(feature.id, {
      enabled: true,
      initialized: true,
      result,
      declaredHookCount: feature.declaredHookCount || feature.hooks.length,
      trackedHookCount
    });
  }
  return new Map(initializedFeatures);
}

/**
 * Return a primitive-only feature registry report for diagnostics.
 *
 * @returns {{registeredFeatureCount: number, initializedFeatureCount: number, hookCount: number, hookCountSource: string, trackedHookCount: number, declaredHookCount: number, features: object[]}}
 */
export function getFeatureRegistryReport() {
  const hookCounts = new Map();
  for (const registration of hookRegistrations.values()) {
    hookCounts.set(registration.featureId, (hookCounts.get(registration.featureId) ?? 0) + 1);
  }
  const featureReports = Array.from(features.values()).map(feature => {
    const state = initializedFeatures.get(feature.id) ?? null;
    const trackedHookCount = hookCounts.get(feature.id) ?? state?.trackedHookCount ?? 0;
    const declaredHookCount = state?.declaredHookCount ?? feature.declaredHookCount;
    return {
      id: feature.id,
      label: feature.label,
      enabled: state?.enabled === true,
      initialized: state?.initialized === true,
      hookCount: trackedHookCount,
      hookCountSource: "tracked",
      trackedHookCount,
      declaredHookCount
    };
  });
  const trackedHookCount = featureReports.reduce((total, feature) => total + feature.trackedHookCount, 0);
  const declaredHookCount = featureReports.reduce((total, feature) => total + feature.declaredHookCount, 0);
  return {
    registeredFeatureCount: features.size,
    initializedFeatureCount: initializedFeatures.size,
    hookCount: trackedHookCount,
    hookCountSource: "tracked",
    trackedHookCount,
    declaredHookCount,
    features: featureReports
  };
}

export const __test = {
  reset() {
    features.clear();
    hookRegistrations.clear();
    initializedFeatures.clear();
  }
};
