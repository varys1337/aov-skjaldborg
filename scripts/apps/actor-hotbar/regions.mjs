import {
  HOTBAR_REGIONS,
  HOTBAR_RENDER_REGIONS,
  HOTBAR_TAB_BODY_CATEGORIES
} from "./constants.mjs";

/**
 * Map hotbar invalidation parts to independently rendered template regions.
 *
 * @param {Iterable<string>} parts Invalidation parts and cache categories.
 * @returns {string[]} Renderable internal hotbar regions.
 */
export function regionsForInvalidation(parts) {
  const regions = new Set();
  for (const part of parts ?? []) {
    if (part === "quickAccess") {
      regions.add(HOTBAR_REGIONS.PORTRAIT_QUICK_ACCESS);
      continue;
    }
    if (part === "effects") {
      regions.add(HOTBAR_REGIONS.HEADER_EFFECTS);
      continue;
    }
    if (part === "workflow" || part === "weaponControls" || part === "equipmentControls") {
      regions.add(HOTBAR_REGIONS.COMBAT_WORKFLOW);
      continue;
    }
    if (part === "resources") {
      regions.add(HOTBAR_REGIONS.RESOURCES);
      continue;
    }
    if (HOTBAR_TAB_BODY_CATEGORIES.has(part)) {
      regions.add(HOTBAR_REGIONS.TAB_BODY);
      continue;
    }
    if (HOTBAR_RENDER_REGIONS.has(part)) regions.add(part);
  }
  if (regions.has(HOTBAR_REGIONS.TAB_BODY)) regions.delete(HOTBAR_REGIONS.COMBAT_WORKFLOW);
  return Array.from(regions);
}
