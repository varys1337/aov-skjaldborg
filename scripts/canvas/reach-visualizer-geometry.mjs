const DEFAULT_GRID_SIZE = 100;

function finiteNumber(value, fallback = null) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

/**
 * Resolve a token's occupied grid rectangle.
 *
 * @param {Token|TokenDocument|object|null} token Token placeable or document.
 * @param {number} [gridSize=100] Scene grid size in pixels.
 * @returns {{minX: number, minY: number, maxX: number, maxY: number}|null}
 */
export function tokenGridRect(token, gridSize = DEFAULT_GRID_SIZE) {
  const document = token?.document ?? token;
  const size = Math.max(1, finiteNumber(gridSize, DEFAULT_GRID_SIZE) ?? DEFAULT_GRID_SIZE);
  const x = finiteNumber(token?.position?.x ?? document?.x ?? document?._source?.x);
  const y = finiteNumber(token?.position?.y ?? document?.y ?? document?._source?.y);
  if (x === null || y === null) return null;
  const width = Math.max(1, finiteNumber(document?.width ?? document?._source?.width, 1) ?? 1);
  const height = Math.max(1, finiteNumber(document?.height ?? document?._source?.height, 1) ?? 1);
  return {
    minX: Math.floor(x / size),
    minY: Math.floor(y / size),
    maxX: Math.ceil((x + (width * size)) / size) - 1,
    maxY: Math.ceil((y + (height * size)) / size) - 1
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
  const document = token?.document ?? token;
  const size = Math.max(1, finiteNumber(gridSize, DEFAULT_GRID_SIZE) ?? DEFAULT_GRID_SIZE);
  const width = Math.max(1, finiteNumber(document?.width ?? document?._source?.width, 1) ?? 1);
  const height = Math.max(1, finiteNumber(document?.height ?? document?._source?.height, 1) ?? 1);
  return { width: width * size, height: height * size };
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
  const square = globalThis.CONST?.GRID_TYPES?.SQUARE;
  if (square !== undefined && gridType === square) return true;
  const normalized = String(gridType ?? "").toLowerCase();
  return normalized === "square" || normalized === "1";
}

export const __test = Object.freeze({
  finiteNumber
});
