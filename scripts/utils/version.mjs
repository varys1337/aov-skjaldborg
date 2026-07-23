/**
 * Compare dotted numeric version strings without relying on deprecated or
 * package-manager-specific helpers.
 *
 * Non-numeric separators are treated as component boundaries so Foundry-style
 * values such as "14.365.0" and ordinary semantic versions compare
 * consistently.
 *
 * @param {string|number|null|undefined} leftVersion Left-hand version.
 * @param {string|number|null|undefined} rightVersion Right-hand version.
 * @returns {-1|0|1}
 */
export function compareVersions(leftVersion, rightVersion) {
  const components = value => String(value ?? "")
    .split(/[^0-9]+/)
    .filter(Boolean)
    .map(component => Number(component));
  const left = components(leftVersion);
  const right = components(rightVersion);
  if (!left.length && !right.length) return 0;
  if (!left.length) return -1;
  if (!right.length) return 1;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const a = Number(left[index] ?? 0);
    const b = Number(right[index] ?? 0);
    if (a > b) return 1;
    if (a < b) return -1;
  }
  return 0;
}

/**
 * Determine whether a version meets a minimum dotted numeric version.
 *
 * @param {string|number|null|undefined} current Current version.
 * @param {string|number|null|undefined} minimum Minimum version.
 * @returns {boolean}
 */
export function versionAtLeast(current, minimum) {
  return compareVersions(current, minimum) >= 0;
}
