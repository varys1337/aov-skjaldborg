/**
 * Draw solid grid-aligned segments with filled rectangles for crisp boundaries.
 *
 * @param {PIXI.Graphics|object} graphics Graphics object.
 * @param {Array<[number, number, number, number]>} segments Boundary segments.
 * @param {number} widthPx Line width.
 * @param {number} color Hex color.
 * @returns {void}
 */
export function drawSolidGridSegments(graphics, segments, widthPx, color) {
  const width = Math.max(1, Math.round(Number(widthPx) || 1));
  const half = width / 2;
  const eps = 1e-6;
  graphics.beginFill?.(color, 1);
  for (const segment of segments ?? []) {
    const [x1, y1, x2, y2] = segment;
    if (Math.abs(y1 - y2) <= eps) {
      const x = Math.min(x1, x2);
      const length = Math.abs(x2 - x1);
      if (length > eps) graphics.drawRect?.(x, y1 - half, length, width);
    } else if (Math.abs(x1 - x2) <= eps) {
      const y = Math.min(y1, y2);
      const length = Math.abs(y2 - y1);
      if (length > eps) graphics.drawRect?.(x1 - half, y, width, length);
    } else {
      graphics.endFill?.();
      graphics.lineStyle?.({ width, color, alpha: 1 });
      graphics.moveTo?.(x1, y1);
      graphics.lineTo?.(x2, y2);
      graphics.beginFill?.(color, 1);
    }
  }
  graphics.endFill?.();
}

/**
 * Draw a solid circle boundary.
 *
 * @param {PIXI.Graphics|object} graphics Graphics object.
 * @param {number} radiusPx Circle radius in pixels.
 * @param {number} widthPx Line width.
 * @param {number} color Hex color.
 * @returns {void}
 */
export function drawSolidCircle(graphics, radiusPx, widthPx, color) {
  const radius = Math.max(0, Number(radiusPx) || 0);
  if (!radius) return;
  const width = Math.max(1, Math.round(Number(widthPx) || 1));
  graphics.lineStyle?.({ width, color, alpha: 1 });
  graphics.drawCircle?.(0, 0, radius);
}
