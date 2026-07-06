const features = new Map();
const hookRegistrations = new Map();
const initializedFeatures = new Map();

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
  return `${featureId}:${eventName}:${handler?.name ?? "anonymous"}`;
}

function registerFeatureHooks(feature) {
  const registered = [];
  for (const entry of feature.hooks) {
    const [eventName, handler, options = {}] = entry ?? [];
    const hookName = String(eventName ?? "").trim();
    if (!hookName || typeof handler !== "function") continue;
    const key = hookKey(feature.id, hookName, handler);
    if (hookRegistrations.has(key)) continue;
    const once = options?.once === true;
    const hookId = once ? Hooks.once(hookName, handler) : Hooks.on(hookName, handler);
    const registration = {
      featureId: feature.id,
      eventName: hookName,
      hookId,
      once,
      handlerName: handler.name || ""
    };
    hookRegistrations.set(key, registration);
    registered.push(registration);
  }
  return registered;
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
 * @returns {Map<string, {enabled: boolean, initialized: boolean, result: unknown, hookCount: number}>}
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
        hookCount: feature.declaredHookCount || feature.hooks.length
      });
      continue;
    }
    const registeredHooks = registerFeatureHooks(feature);
    const result = feature.initialize ? feature.initialize() : null;
    initializedFeatures.set(feature.id, {
      enabled: true,
      initialized: true,
      result,
      hookCount: feature.declaredHookCount || registeredHooks.length
    });
  }
  return new Map(initializedFeatures);
}

/**
 * Return a primitive-only feature registry report for diagnostics.
 *
 * @returns {{registeredFeatureCount: number, initializedFeatureCount: number, hookCount: number, features: object[]}}
 */
export function getFeatureRegistryReport() {
  const hookCounts = new Map();
  for (const registration of hookRegistrations.values()) {
    hookCounts.set(registration.featureId, (hookCounts.get(registration.featureId) ?? 0) + 1);
  }
  return {
    registeredFeatureCount: features.size,
    initializedFeatureCount: initializedFeatures.size,
    hookCount: hookRegistrations.size,
    features: Array.from(features.values()).map(feature => {
      const state = initializedFeatures.get(feature.id) ?? null;
      return {
        id: feature.id,
        label: feature.label,
        enabled: state?.enabled === true,
        initialized: state?.initialized === true,
        hookCount: hookCounts.get(feature.id) ?? state?.hookCount ?? feature.declaredHookCount
      };
    })
  };
}

export const __test = {
  reset() {
    features.clear();
    hookRegistrations.clear();
    initializedFeatures.clear();
  }
};
