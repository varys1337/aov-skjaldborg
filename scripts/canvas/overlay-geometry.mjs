export const DEFAULT_OVERLAY_GRID_SIZE = 100;

export function finiteNumber(value, fallback = null) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

export function gridSizePixels(canvasLike = globalThis.canvas) {
  return Math.max(
    1,
    finiteNumber(canvasLike?.scene?.grid?.size ?? canvasLike?.grid?.size, DEFAULT_OVERLAY_GRID_SIZE)
      ?? DEFAULT_OVERLAY_GRID_SIZE
  );
}

export function sceneGridDistance(canvasLike = globalThis.canvas) {
  return Math.max(0, finiteNumber(canvasLike?.scene?.grid?.distance, 1) ?? 1);
}

function gridType(sceneOrGrid = globalThis.canvas?.scene?.grid) {
  return sceneOrGrid?.grid?.type ?? sceneOrGrid?.type ?? sceneOrGrid;
}

export function isSquareGrid(sceneOrGrid = globalThis.canvas?.scene?.grid) {
  const type = gridType(sceneOrGrid);
  const square = globalThis.CONST?.GRID_TYPES?.SQUARE;
  if (square !== undefined && type === square) return true;
  const normalized = String(type ?? "").toLowerCase();
  return normalized === "square" || normalized === "1";
}

export function isGridless(sceneOrGrid = globalThis.canvas?.scene?.grid) {
  const type = gridType(sceneOrGrid);
  const gridless = globalThis.CONST?.GRID_TYPES?.GRIDLESS;
  if (gridless !== undefined && type === gridless) return true;
  const normalized = String(type ?? "").toLowerCase();
  return normalized === "gridless" || normalized === "0";
}

export function tokenDocument(tokenOrDocument) {
  return tokenOrDocument?.document ?? tokenOrDocument ?? null;
}

export function tokenPixelRect(tokenOrDocument, gridSize = DEFAULT_OVERLAY_GRID_SIZE) {
  const document = tokenDocument(tokenOrDocument);
  const size = Math.max(1, finiteNumber(gridSize, DEFAULT_OVERLAY_GRID_SIZE) ?? DEFAULT_OVERLAY_GRID_SIZE);
  const x = finiteNumber(tokenOrDocument?.position?.x ?? document?.x ?? document?._source?.x);
  const y = finiteNumber(tokenOrDocument?.position?.y ?? document?.y ?? document?._source?.y);
  if (x === null || y === null) return null;
  const width = Math.max(1, finiteNumber(document?.width ?? document?._source?.width, 1) ?? 1) * size;
  const height = Math.max(1, finiteNumber(document?.height ?? document?._source?.height, 1) ?? 1) * size;
  return { x, y, width, height };
}

export function tokenCenterPoint(tokenOrDocument, gridSize = DEFAULT_OVERLAY_GRID_SIZE) {
  const center = tokenOrDocument?.center;
  if (Number.isFinite(Number(center?.x)) && Number.isFinite(Number(center?.y))) {
    return { x: Number(center.x), y: Number(center.y) };
  }
  const rect = tokenPixelRect(tokenOrDocument, gridSize);
  return rect ? { x: rect.x + (rect.width / 2), y: rect.y + (rect.height / 2) } : null;
}

export function tokenVisibleToUser(tokenOrDocument, user = globalThis.game?.user) {
  const document = tokenDocument(tokenOrDocument);
  const actor = tokenOrDocument?.actor ?? document?.actor ?? null;
  if (!document || !actor) return false;
  if (document.hidden && !user?.isGM) return false;
  if (tokenOrDocument?.visible === false || tokenOrDocument?.isVisible === false) return false;
  return true;
}

export function tokenDispositionKey(tokenOrDocument) {
  const document = tokenDocument(tokenOrDocument);
  const disposition = Number(document?.disposition);
  const dispositions = globalThis.CONST?.TOKEN_DISPOSITIONS ?? {};
  if (disposition === Number(dispositions.FRIENDLY ?? 1)) return "friendly";
  if (disposition === Number(dispositions.HOSTILE ?? -1)) return "hostile";
  if (disposition === Number(dispositions.SECRET ?? -2)) return "secret";
  if (disposition === Number(dispositions.NEUTRAL ?? 0)) return "neutral";
  return "fallback";
}
