import {
  QUICK_ACCESS_MIN_RADIUS,
  QUICK_ACCESS_MIN_STAGE_SIZE,
  QUICK_ACCESS_SLOT_GAP,
  QUICK_ACCESS_SLOT_SIZE
} from "./constants.mjs";

/**
 * Calculate a single-circle portrait layout for six through twelve slots.
 *
 * @param {number} count Visible slot count.
 * @returns {{center: number, radius: number, size: number, stageSize: number}}
 */
export function quickAccessGeometry(count) {
  const normalized = Math.max(1, Math.round(Number(count) || 1));
  const chordRadius = (QUICK_ACCESS_SLOT_SIZE + QUICK_ACCESS_SLOT_GAP)
    / (2 * Math.sin(Math.PI / normalized));
  const radius = Math.max(QUICK_ACCESS_MIN_RADIUS, Math.ceil(chordRadius));
  const stageSize = Math.max(
    QUICK_ACCESS_MIN_STAGE_SIZE,
    Math.ceil((radius + (QUICK_ACCESS_SLOT_SIZE / 2)) * 2)
  );
  return {
    center: stageSize / 2,
    radius,
    size: QUICK_ACCESS_SLOT_SIZE,
    stageSize
  };
}
