/**
 * Convert one unknown value to a finite number.
 *
 * @param {unknown} value Candidate value.
 * @param {number|null} [fallback=0] Fallback returned when conversion fails.
 * @returns {number|null}
 */
export function numberOr(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

/**
 * Sanitize and clamp a user- or document-sourced string.
 *
 * @param {unknown} value Candidate string.
 * @param {number} [max=500] Maximum retained length.
 * @returns {string}
 */
export function cleanString(value, max = 500) {
  return String(value ?? "").slice(0, max).trim();
}

/**
 * Sanitize a list of strings while preserving first-seen order.
 *
 * @param {unknown} value Candidate array.
 * @param {number} [max=500] Maximum retained length for each entry.
 * @returns {string[]}
 */
export function cleanStringArray(value, max = 500) {
  const source = Array.isArray(value) ? value : [];
  return Array.from(new Set(source.map(entry => cleanString(entry, max)).filter(Boolean)));
}

/**
 * Normalize a Foundry Collection, Map, array, or array-like iterable.
 *
 * @template T
 * @param {Collection<T>|Map<unknown, T>|T[]|Iterable<T>|null|undefined} source Candidate collection.
 * @returns {T[]}
 */
export function collectionArray(source) {
  if (!source) return [];
  if (Array.isArray(source)) return source;
  if (Array.isArray(source.contents)) return source.contents;
  if (typeof source.values === "function") return Array.from(source.values());
  return Array.from(source).map(entry => Array.isArray(entry) ? entry[1] : entry).filter(Boolean);
}

/**
 * Normalize an Actor embedded Item collection without depending on one
 * particular Foundry Collection iterator implementation.
 *
 * @param {Actor|object|null|undefined} actor Actor document or test double.
 * @returns {Array<Item|object>}
 */
export function actorItems(actor) {
  return collectionArray(actor?.items);
}

/**
 * Resolve one actor-owned Item by embedded id.
 *
 * @param {Actor|object|null|undefined} actor Actor document or test double.
 * @param {unknown} itemId Embedded Item id.
 * @returns {Item|object|null}
 */
export function actorItemById(actor, itemId) {
  const id = cleanString(itemId, 100);
  if (!id) return null;
  return actor?.items?.get?.(id)
    ?? actorItems(actor).find(candidate => String(candidate?.id ?? "") === id)
    ?? null;
}

/**
 * Resolve the owning Actor for an embedded Item or Item-like value.
 *
 * @param {Item|object|null|undefined} item Candidate Item.
 * @returns {Actor|object|null}
 */
export function itemActor(item) {
  return item?.parent?.documentName === "Actor"
    ? item.parent
    : (item?.actor ?? item?.parent ?? null);
}

/**
 * Normalize authored AoV descriptor text for stable comparisons.
 *
 * @param {unknown} value Candidate descriptor.
 * @returns {string}
 */
export function normalizeDescriptor(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

/**
 * Resolve a UUID without surfacing Foundry lookup errors to users.
 *
 * @param {unknown} uuid Candidate UUID.
 * @returns {Promise<Document|null>}
 */
export async function safeFromUuid(uuid) {
  if (!uuid || typeof globalThis.fromUuid !== "function") return null;
  try {
    return await globalThis.fromUuid(uuid);
  } catch (_exception) {
    return null;
  }
}
