import { tokenDispositionKey } from "./overlay-geometry.mjs";

export const OVERLAY_DISPOSITION_COLORS = Object.freeze({
  friendly: 0x42d392,
  neutral: 0xf0c04a,
  hostile: 0xff5c5c,
  secret: 0xa874ff,
  fallback: 0x7cc7ff
});

export function normalizeAlpha(value, fallback = 1) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return Math.max(0, Math.min(1, Number(fallback) || 0));
  return Math.max(0, Math.min(1, numeric));
}

export function parseHexColor(value, fallback = OVERLAY_DISPOSITION_COLORS.fallback) {
  if (Number.isInteger(value) && value >= 0 && value <= 0xffffff) return value;
  const text = String(value ?? "").trim();
  const normalized = text.startsWith("#") ? text.slice(1) : text.replace(/^0x/i, "");
  if (!/^[0-9a-f]{6}$/i.test(normalized)) return fallback;
  return Number.parseInt(normalized, 16);
}

export function colorForDisposition(key, fallback = OVERLAY_DISPOSITION_COLORS.fallback) {
  return OVERLAY_DISPOSITION_COLORS[String(key ?? "")] ?? fallback;
}

export function colorForToken(tokenOrDocument, fallback = OVERLAY_DISPOSITION_COLORS.fallback) {
  return colorForDisposition(tokenDispositionKey(tokenOrDocument), fallback);
}
