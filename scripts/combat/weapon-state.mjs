import { MODULE_ID } from "../constants.mjs";
import { debug, warn } from "../logger.mjs";

export const READIED_WEAPON_FLAG = "readiedWeaponId";

let hooksRegistered = false;

/**
 * Normalize an Actor embedded Item collection without depending on one
 * particular Collection iterator implementation.
 *
 * @param {Actor|object|null|undefined} actor Actor document.
 * @returns {Array<Item|object>}
 */
function actorItems(actor) {
  const items = actor?.items;
  if (!items) return [];
  if (Array.isArray(items)) return items;
  if (Array.isArray(items.contents)) return items.contents;
  if (typeof items.values === "function") return Array.from(items.values());
  return Array.from(items).map(entry => Array.isArray(entry) ? entry[1] : entry).filter(Boolean);
}

/**
 * Resolve one actor-owned Item by id.
 *
 * @param {Actor|object|null|undefined} actor Actor document.
 * @param {string|null|undefined} itemId Embedded Item id.
 * @returns {Item|object|null}
 */
function actorItem(actor, itemId) {
  if (!itemId) return null;
  return actor?.items?.get?.(itemId)
    ?? actorItems(actor).find(candidate => candidate?.id === itemId)
    ?? null;
}

/**
 * Return whether an Age of Vikings weapon is immediately available to draw.
 *
 * AoV 13.29 uses equipStatus 1/2/3 for carried/packed/stored. The module keeps
 * "carried" and "readied" distinct: a carried weapon may be selected and then
 * explicitly drawn, while packed or stored weapons are not valid draw targets.
 *
 * @param {Item|object|null|undefined} item Candidate owned Item.
 * @returns {boolean}
 */
export function isCarriedWeapon(item) {
  return item?.type === "weapon" && Number(item.system?.equipStatus) === 1;
}

/**
 * Return the actor's carried weapons in deterministic name order.
 *
 * @param {Actor|object|null|undefined} actor Actor document.
 * @returns {Array<Item|object>}
 */
export function getCarriedWeapons(actor) {
  const locale = globalThis.game?.i18n?.lang;
  return actorItems(actor)
    .filter(isCarriedWeapon)
    .sort((a, b) => String(a.name ?? "").localeCompare(String(b.name ?? ""), locale));
}

/**
 * Read the module-managed currently readied weapon id.
 *
 * @param {Actor|object|null|undefined} actor Actor document.
 * @returns {string|null}
 */
export function getReadiedWeaponId(actor) {
  const value = actor?.getFlag?.(MODULE_ID, READIED_WEAPON_FLAG);
  return typeof value === "string" && value ? value : null;
}

/**
 * Resolve the module-managed currently readied weapon.
 *
 * Invalid, deleted, packed, or stored weapons are treated as not readied. The
 * read operation is intentionally side-effect free; lifecycle hooks reconcile
 * invalid persisted flags through document updates.
 *
 * @param {Actor|object|null|undefined} actor Actor document.
 * @returns {Item|object|null}
 */
export function getReadiedWeapon(actor) {
  const weaponId = getReadiedWeaponId(actor);
  if (!weaponId) return null;
  const item = actorItem(actor, weaponId);
  return isCarriedWeapon(item) ? item : null;
}

/**
 * Prepare serializable readied-weapon state for module UIs.
 *
 * @param {Actor|object|null|undefined} actor Actor document.
 * @returns {{id: string|null, name: string, carriedWeapons: {id: string, name: string, selected: boolean}[], canDraw: boolean, canSheathe: boolean}}
 */
export function prepareReadiedWeaponState(actor) {
  const current = getReadiedWeapon(actor);
  const carriedWeapons = getCarriedWeapons(actor).map(item => ({
    id: String(item.id),
    name: String(item.name ?? ""),
    selected: item.id === current?.id
  }));
  if (carriedWeapons.length && !carriedWeapons.some(item => item.selected)) {
    carriedWeapons[0].selected = true;
  }
  return {
    id: current?.id ?? null,
    name: current?.name ?? "",
    carriedWeapons,
    canDraw: carriedWeapons.length > 0,
    canSheathe: !!current
  };
}

/**
 * Mark one actor-owned carried weapon as the currently readied weapon.
 *
 * @param {Actor} actor Actor document.
 * @param {string} weaponId Owned weapon Item id.
 * @returns {Promise<Actor>}
 */
export async function setReadiedWeapon(actor, weaponId) {
  if (!actor) throw new Error("Actor unavailable.");
  const item = actorItem(actor, weaponId);
  if (!isCarriedWeapon(item)) {
    throw new Error(game.i18n.localize("AOV_SKJADLBORG.Warnings.WeaponMustBeCarried"));
  }
  return actor.setFlag(MODULE_ID, READIED_WEAPON_FLAG, item.id);
}

/**
 * Clear the actor's currently readied weapon.
 *
 * @param {Actor} actor Actor document.
 * @returns {Promise<Actor|undefined>}
 */
export async function clearReadiedWeapon(actor) {
  if (!actor || !getReadiedWeaponId(actor)) return actor;
  if (typeof actor.unsetFlag === "function") {
    return actor.unsetFlag(MODULE_ID, READIED_WEAPON_FLAG);
  }
  return actor.setFlag(MODULE_ID, READIED_WEAPON_FLAG, null);
}

/**
 * Remove a stale readied-weapon flag after the Item is packed, stored, deleted,
 * or otherwise ceases to be a carried actor-owned weapon.
 *
 * @param {Actor|object|null|undefined} actor Actor document.
 * @returns {Promise<boolean>} Whether stale state was cleared.
 */
export async function reconcileReadiedWeapon(actor) {
  const weaponId = getReadiedWeaponId(actor);
  if (!weaponId) return false;
  if (getReadiedWeapon(actor)) return false;
  try {
    await clearReadiedWeapon(actor);
    debug("Cleared stale readied weapon", { actorId: actor?.id, weaponId });
    return true;
  } catch (exception) {
    warn(exception);
    return false;
  }
}

/**
 * Register v13 document lifecycle reconciliation for module-managed weapon state.
 *
 * @returns {void}
 */
export function registerReadiedWeaponHooks() {
  if (hooksRegistered) return;
  hooksRegistered = true;

  Hooks.on("updateItem", (item, changed) => {
    if (item?.type !== "weapon" || !item.parent) return;
    if (!foundry.utils.hasProperty(changed, "system.equipStatus")) return;
    void reconcileReadiedWeapon(item.parent);
  });

  Hooks.on("deleteItem", item => {
    if (item?.type !== "weapon" || !item.parent) return;
    if (getReadiedWeaponId(item.parent) !== item.id) return;
    void clearReadiedWeapon(item.parent).catch(warn);
  });
}
