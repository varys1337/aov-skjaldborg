/**
 * Normalize a configured Token bar attribute to an Actor document path.
 *
 * Foundry Token configuration stores system-relative values such as `hp`,
 * while TokenDocument#getBarAttribute may return either that value or the
 * expanded `system.hp` path depending on the tracked attribute type.
 *
 * @param {unknown} attribute Configured or resolved Token bar attribute.
 * @returns {string}
 */
export function normalizeTrackedResourcePath(attribute) {
  let path = String(attribute ?? "").trim();
  if (!path) return "";
  if (path.startsWith("actor.")) path = path.slice("actor.".length);
  if (!path.startsWith("system.")) path = `system.${path}`;
  return path;
}

/**
 * Identify AoV resources that require system-specific write semantics.
 *
 * @param {string} attribute Normalized Actor path.
 * @returns {"hp"|"mp"|"generic"}
 */
export function trackedResourceKind(attribute) {
  const relative = String(attribute ?? "")
    .replace(/^system\./, "")
    .replace(/\.value$/, "");
  if (relative === "hp") return "hp";
  if (relative === "mp") return "mp";
  return "generic";
}

/**
 * Convert an unknown Token bar number to a finite display value.
 *
 * @param {unknown} value Candidate number.
 * @param {number} [fallback=0] Fallback number.
 * @returns {number}
 */
export function finiteResourceNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}
