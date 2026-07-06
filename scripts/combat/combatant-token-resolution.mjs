/**
 * Centralized Combatant/Token resolution helpers.
 *
 * Foundry v14 exposes Combat#getCombatantsByToken for token-to-combatant
 * resolution. These helpers prefer that documented path when available, then
 * fall back to defensive plain-object matching used by the module regression
 * fixtures. Actor id matching is intentionally reserved for compatibility
 * cleanup only; engagement and movement state should bind to exact Token and
 * Combatant identities.
 */

/**
 * Iterate combatants from a Foundry Collection, Map, array, or plain fixture.
 *
 * @param {Combat|object|null|undefined} combat Combat document.
 * @param {Combatant[]|object[]|null} [provided=null] Optional materialized list.
 * @returns {Combatant[]|object[]}
 */
export function combatantValues(combat, provided = null) {
  if (Array.isArray(provided)) return provided.filter(Boolean);
  return Array.from(combat?.combatants ?? []).map(entry => Array.isArray(entry) ? entry[1] : entry).filter(Boolean);
}

/**
 * Resolve the most specific token id represented by a token-like value.
 *
 * @param {TokenDocument|object|null|undefined} document Token document or placeable-like object.
 * @returns {string|null}
 */
export function tokenDocumentId(document) {
  const value = document?.id
    ?? document?._id
    ?? document?.document?.id
    ?? document?.document?._id
    ?? document?.object?.id
    ?? document?.object?.document?.id
    ?? document?.object?.document?._id
    ?? null;
  const id = String(value ?? "").trim();
  return id || null;
}

/**
 * Resolve the scene id represented by a token document-like object.
 *
 * @param {TokenDocument|object|null|undefined} document Token document.
 * @returns {string|null}
 */
export function tokenDocumentSceneId(document) {
  const value = document?.parent?.id
    ?? document?.scene?.id
    ?? document?.document?.parent?.id
    ?? document?.object?.scene?.id
    ?? document?.object?.document?.parent?.id
    ?? null;
  const id = String(value ?? "").trim();
  return id || null;
}

/**
 * Resolve the scene id represented by a combatant.
 *
 * @param {Combatant|object|null|undefined} combatant Combatant document.
 * @returns {string|null}
 */
export function combatantSceneId(combatant) {
  const value = combatant?.sceneId
    ?? combatant?.token?.parent?.id
    ?? combatant?.token?.document?.parent?.id
    ?? combatant?.token?.object?.document?.parent?.id
    ?? combatant?.parent?.scene?.id
    ?? null;
  const id = String(value ?? "").trim();
  return id || null;
}

/**
 * Resolve a TokenDocument for a combatant.
 *
 * @param {Combatant|object|null|undefined} combatant Foundry Combatant.
 * @returns {TokenDocument|object|null}
 */
export function tokenDocumentForCombatant(combatant) {
  const tokenId = combatant?.tokenId ?? combatant?.token?.id ?? combatant?.token?._id ?? null;
  return combatant?.token?.object?.document
    ?? combatant?.token?.document
    ?? combatant?.token
    ?? combatant?.parent?.scene?.tokens?.get?.(tokenId)
    ?? game.scenes?.get?.(combatant?.sceneId)?.tokens?.get?.(tokenId)
    ?? canvas?.scene?.tokens?.get?.(tokenId)
    ?? null;
}

/**
 * Test whether a combatant represents the supplied token document.
 *
 * Token ids are scene-local, so scene identity is compared when both sides can
 * provide it. Actor id is deliberately not used here because linked actor token
 * copies must remain distinct for engagement and movement state.
 *
 * @param {Combatant|object|null|undefined} combatant Candidate combatant.
 * @param {TokenDocument|object|null|undefined} document Token document.
 * @returns {boolean}
 */
export function sameCombatantToken(combatant, document) {
  const tokenId = tokenDocumentId(document);
  if (!combatant || !tokenId) return false;
  const documentSceneId = tokenDocumentSceneId(document);
  const candidateSceneId = combatantSceneId(combatant);
  if (documentSceneId && candidateSceneId && documentSceneId !== candidateSceneId) return false;
  return String(combatant.tokenId ?? "") === tokenId
    || String(combatant.token?.id ?? "") === tokenId
    || String(combatant.token?._id ?? "") === tokenId
    || String(combatant.token?.document?.id ?? "") === tokenId
    || String(combatant.token?.document?._id ?? "") === tokenId
    || String(combatant.token?.object?.id ?? "") === tokenId
    || String(combatant.token?.object?.document?.id ?? "") === tokenId
    || String(combatant.token?.object?.document?._id ?? "") === tokenId;
}

/**
 * Resolve a combatant by id with a Collection/Map/array fallback.
 *
 * @param {Combat|object|null|undefined} combat Combat document.
 * @param {string|null|undefined} id Combatant id.
 * @param {Combatant[]|object[]|null} [combatants=null] Optional materialized list.
 * @returns {Combatant|object|null}
 */
export function combatantById(combat, id, combatants = null) {
  const combatantId = String(id ?? "").trim();
  if (!combatantId) return null;
  return combat?.combatants?.get?.(combatantId)
    ?? combatantValues(combat, combatants).find(candidate => String(candidate?.id ?? "") === combatantId)
    ?? null;
}

function uniqueCombatants(candidates) {
  const seen = new Set();
  const unique = [];
  for (const candidate of candidates ?? []) {
    const key = String(candidate?.id ?? candidate?.uuid ?? "").trim();
    if (!candidate || !key || seen.has(key)) continue;
    seen.add(key);
    unique.push(candidate);
  }
  return unique;
}

/**
 * Resolve all combatants represented by a TokenDocument.
 *
 * @param {Combat|object|null|undefined} combat Active combat.
 * @param {TokenDocument|object|null|undefined} document Token document.
 * @param {{combatants?: Combatant[]|object[]|null}} [options={}] Lookup options.
 * @returns {Combatant[]|object[]}
 */
export function combatantsForTokenDocument(combat, document, { combatants = null } = {}) {
  const tokenId = tokenDocumentId(document);
  if (!combat || !tokenId) return [];

  if (typeof combat.getCombatantsByToken === "function") {
    try {
      const foundryMatches = uniqueCombatants(combat.getCombatantsByToken(document) ?? [])
        .filter(combatant => sameCombatantToken(combatant, document));
      if (foundryMatches.length) return foundryMatches;
    }
    catch (_exception) {
      // Plain-object tests and older compatibility surfaces use the fallback.
    }
  }

  return combatantValues(combat, combatants).filter(combatant => sameCombatantToken(combatant, document));
}

/**
 * Resolve the first combatant represented by a TokenDocument.
 *
 * @param {Combat|object|null|undefined} combat Active combat.
 * @param {TokenDocument|object|null|undefined} document Token document.
 * @param {{combatants?: Combatant[]|object[]|null}} [options={}] Lookup options.
 * @returns {Combatant|object|null}
 */
export function combatantForTokenDocument(combat, document, options = {}) {
  return combatantsForTokenDocument(combat, document, options)[0] ?? null;
}

function tokenMatchesRecord(combatant, record) {
  const tokenId = String(record?.tokenId ?? "").trim();
  if (!tokenId) return false;
  const recordSceneId = String(record?.sceneId ?? "").trim();
  const candidateSceneId = combatantSceneId(combatant);
  if (recordSceneId && candidateSceneId && recordSceneId !== candidateSceneId) return false;
  return sameCombatantToken(combatant, { id: tokenId, parent: recordSceneId ? { id: recordSceneId } : null });
}

/**
 * Resolve a combatant represented by an engagement effect record.
 *
 * Preferred order: exact combatant id, exact token/scene identity, then actor id
 * only as a last-resort compatibility fallback for older records.
 *
 * @param {object} record Engagement record.
 * @param {Combat|object|null|undefined} combat Active combat.
 * @param {{combatants?: Combatant[]|object[]|null}} [options={}] Lookup options.
 * @returns {Combatant|object|null}
 */
export function combatantFromEngagementRecord(record, combat, { combatants = null } = {}) {
  const values = combatantValues(combat, combatants);
  const byId = combatantById(combat, record?.combatantId, values);
  if (byId) return byId;

  const tokenMatches = values.filter(combatant => tokenMatchesRecord(combatant, record));
  if (tokenMatches.length === 1) return tokenMatches[0];

  const actorId = String(record?.actorId ?? "").trim();
  if (!actorId) return null;
  const actorMatches = values.filter(combatant => String(combatant?.actorId ?? combatant?.actor?.id ?? "") === actorId);
  return actorMatches.length === 1 ? actorMatches[0] : null;
}
