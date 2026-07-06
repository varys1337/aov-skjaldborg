import {
  DEFAULT_OVERLAY_GRID_SIZE,
  finiteNumber,
  isSquareGrid,
  tokenPixelRect
} from "./overlay-geometry.mjs";

const DEFAULT_GRID_SIZE = DEFAULT_OVERLAY_GRID_SIZE;

/**
 * Resolve a token's occupied grid rectangle.
 *
 * @param {Token|TokenDocument|object|null} token Token placeable or document.
 * @param {number} [gridSize=100] Scene grid size in pixels.
 * @returns {{minX: number, minY: number, maxX: number, maxY: number}|null}
 */
export function tokenGridRect(token, gridSize = DEFAULT_GRID_SIZE) {
  const size = Math.max(1, finiteNumber(gridSize, DEFAULT_GRID_SIZE) ?? DEFAULT_GRID_SIZE);
  const rect = tokenPixelRect(token, size);
  if (!rect) return null;
  return {
    minX: Math.floor(rect.x / size),
    minY: Math.floor(rect.y / size),
    maxX: Math.ceil((rect.x + rect.width) / size) - 1,
    maxY: Math.ceil((rect.y + rect.height) / size) - 1
  };
}

/**
 * Compute a square-grid reach boundary as four grid-aligned line segments.
 *
 * @param {Token|TokenDocument|object|null} token Token placeable or document.
 * @param {number} reachUnits Engagement reach in grid units.
 * @param {number} [gridSize=100] Scene grid size in pixels.
 * @returns {{segments: Array<[number, number, number, number]>, rect: object|null}}
 */
export function squareReachOutline(token, reachUnits, gridSize = DEFAULT_GRID_SIZE) {
  const rect = tokenGridRect(token, gridSize);
  const reach = Math.max(0, Math.round(finiteNumber(reachUnits, 0) ?? 0));
  const size = Math.max(1, finiteNumber(gridSize, DEFAULT_GRID_SIZE) ?? DEFAULT_GRID_SIZE);
  if (!rect) return { segments: [], rect: null };
  const expanded = {
    minX: rect.minX - reach,
    minY: rect.minY - reach,
    maxX: rect.maxX + reach,
    maxY: rect.maxY + reach
  };
  const left = expanded.minX * size;
  const top = expanded.minY * size;
  const right = (expanded.maxX + 1) * size;
  const bottom = (expanded.maxY + 1) * size;
  return {
    rect: expanded,
    segments: [
      [left, top, right, top],
      [right, top, right, bottom],
      [right, bottom, left, bottom],
      [left, bottom, left, top]
    ]
  };
}

/**
 * Resolve a token's rendered footprint in pixels.
 *
 * Token width and height remain expressed in grid-size units even when the
 * scene is gridless, so this helper deliberately uses the same grid-size based
 * footprint math as the engagement helpers.
 *
 * @param {Token|TokenDocument|object|null} token Token placeable or document.
 * @param {number} [gridSize=100] Scene grid size in pixels.
 * @returns {{width: number, height: number}}
 */
export function tokenPixelDimensions(token, gridSize = DEFAULT_GRID_SIZE) {
  const size = Math.max(1, finiteNumber(gridSize, DEFAULT_GRID_SIZE) ?? DEFAULT_GRID_SIZE);
  const rect = tokenPixelRect(token, size);
  if (rect) return { width: rect.width, height: rect.height };
  return { width: size, height: size };
}

/**
 * Compute the circle fallback radius for gridless, hex, or explicitly circular
 * reach rendering. The radius includes the token footprint plus its reach so a
 * one-unit reach around a 1x1 token is drawn from the token edge, not only from
 * its center.
 *
 * @param {Token|TokenDocument|object|null} token Token placeable or document.
 * @param {number} reachUnits Engagement reach in grid units.
 * @param {number} [gridSize=100] Scene grid size in pixels.
 * @returns {number}
 */
export function circleReachRadius(token, reachUnits, gridSize = DEFAULT_GRID_SIZE) {
  const size = Math.max(1, finiteNumber(gridSize, DEFAULT_GRID_SIZE) ?? DEFAULT_GRID_SIZE);
  const reach = Math.max(0, finiteNumber(reachUnits, 0) ?? 0);
  const dimensions = tokenPixelDimensions(token, size);
  const footprintRadius = Math.max(dimensions.width, dimensions.height) / 2;
  return footprintRadius + (reach * size);
}

/**
 * Determine whether a Foundry grid type is square.
 *
 * @param {unknown} gridType Scene grid type.
 * @returns {boolean}
 */
export function isSquareGridType(gridType) {
  return isSquareGrid(gridType);
}

export const __test = Object.freeze({
  finiteNumber
});
