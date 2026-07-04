import { MODULE_ID } from "../constants.mjs";
import { debug, warn } from "../logger.mjs";
import {
  actorItemById,
  actorItems,
  normalizeDescriptor as normalizeWeaponDescriptor
} from "../utils/document-data.mjs";

export const READIED_WEAPON_FLAG = "readiedWeaponId";
export const READIED_WEAPONS_FLAG = "readiedWeapons";
export const COMBAT_OPTIONS_FLAG = "combatOptions";

let hooksRegistered = false;

/**
 * Return actor-owned Items in a deterministic array form for UI preparation.
 *
 * @param {Actor|object|null|undefined} actor Actor document or test double.
 * @returns {Array<Item|object>}
 */
export function getActorItems(actor) {
  return actorItems(actor);
}

/**
 * Return whether an Age of Vikings weapon is immediately available to draw.
 *
 * AoV uses equipStatus 1/2/3 for carried/packed/stored. The module keeps
 * "carried" and "readied" distinct: a carried weapon may be selected and then
 * explicitly drawn, while packed or stored weapons are not valid draw targets.
 *
 * @param {Item|object|null|undefined} item Candidate owned Item.
 * @returns {boolean}
 */
export function isCarriedWeapon(item) {
  return item?.type === "weapon" && Number(item.system?.equipStatus) === 1;
}

const HAND_TO_HAND_DESCRIPTORS = Object.freeze(new Set([
  "handtohand",
  "handtohandweapons",
  "unarmed",
  "unarmedcombat",
  "fist",
  "kick",
  "grapple"
]));

/**
 * Test a descriptor for the AoV Hand-to-hand weapon category or one of the
 * three canonical unarmed attacks.
 *
 * @param {unknown} value Category CID/name or weapon name.
 * @returns {boolean}
 */
function isHandToHandDescriptor(value) {
  const normalized = normalizeWeaponDescriptor(value);
  if (!normalized) return false;
  if (HAND_TO_HAND_DESCRIPTORS.has(normalized)) return true;
  return normalized.includes("handtohand") || normalized.includes("unarmed");
}

/**
 * Return whether an actor-owned weapon is a natural weapon. Natural attacks
 * are intrinsic and remain available regardless of carried/packed state.
 *
 * @param {Item|object|null|undefined} item Candidate owned Item.
 * @returns {boolean}
 */
export function isNaturalAttackWeapon(item) {
  return item?.type === "weapon"
    && normalizeWeaponDescriptor(item.system?.weaponType) === "naturalwpn";
}

/**
 * Resolve whether a weapon belongs to the Hand-to-hand category. The fast
 * path supports readable category values and the canonical Fist/Kick/Grapple
 * names. The CID path uses AoV's public category resolver when available.
 *
 * @param {Item|object|null|undefined} item Candidate owned Item.
 * @returns {Promise<boolean>}
 */
export async function isHandToHandAttackWeapon(item) {
  if (item?.type !== "weapon") return false;
  if (isHandToHandDescriptor(item.name)) return true;
  if (isHandToHandDescriptor(item.system?.weaponCat)) return true;
  if (isHandToHandDescriptor(item.system?.weaponCatName)) return true;

  const categoryCid = String(item.system?.weaponCat ?? "").trim();
  const resolver = globalThis.game?.aov?.cid?.fromCID;
  if (!categoryCid || typeof resolver !== "function") return false;

  try {
    const resolved = await resolver.call(globalThis.game.aov.cid, categoryCid);
    const categories = Array.isArray(resolved) ? resolved : [resolved];
    return categories.some(category =>
      isHandToHandDescriptor(category?.name)
      || isHandToHandDescriptor(category?.system?.name)
      || isHandToHandDescriptor(category?.flags?.aov?.cidFlag?.id)
    );
  } catch (exception) {
    debug("Unable to resolve an AoV weapon category while preparing attack options", {
      itemId: item?.id,
      categoryCid,
      exception
    });
    return false;
  }
}

/**
 * Return the weapons that can be used immediately for an Attack workflow.
 *
 * Physical weapons are restricted to the module-managed readied weapon.
 * Hand-to-hand attacks and natural weapons are intrinsic and remain available
 * without being readied. This intentionally differs from getCarriedWeapons(),
 * which is still used by the draw/sheathe workflow.
 *
 * @param {Actor|object|null|undefined} actor Actor document.
 * @returns {Promise<Array<Item|object>>}
 */
export async function getAttackWeapons(actor) {
  const readiedWeapons = getReadiedWeaponList(actor);
  const candidates = actorItems(actor).filter(item => item?.type === "weapon");
  const intrinsic = [];

  for (const item of candidates) {
    if (isNaturalAttackWeapon(item) || await isHandToHandAttackWeapon(item)) {
      intrinsic.push(item);
    }
  }

  const unique = new Map();
  for (const readied of readiedWeapons) unique.set(String(readied.id), readied);
  for (const item of intrinsic) unique.set(String(item.id), item);

  const locale = globalThis.game?.i18n?.lang;
  const sortedIntrinsic = Array.from(unique.values())
    .filter(item => !readiedWeapons.some(readied => readied?.id === item?.id))
    .sort((a, b) => String(a.name ?? "").localeCompare(String(b.name ?? ""), locale));

  return [...readiedWeapons, ...sortedIntrinsic];
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
  return getReadiedWeaponIds(actor).right ?? null;
}

/**
 * Read module-managed readied weapon ids with legacy single-weapon fallback.
 *
 * The new state stores separate right/left hands and an NPC-only unlimited
 * flag. Older worlds may still have only `readiedWeaponId`; that value is
 * treated as the right hand until the next explicit readiness write migrates
 * the actor to `readiedWeapons`.
 *
 * @param {Actor|object|null|undefined} actor Actor document.
 * @returns {import("../types.mjs").SkjaldborgReadiedWeapons}
 */
export function getReadiedWeaponIds(actor) {
  const value = actor?.getFlag?.(MODULE_ID, READIED_WEAPONS_FLAG);
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return {
      right: typeof value.right === "string" && value.right ? value.right : null,
      left: typeof value.left === "string" && value.left ? value.left : null,
      unlimited: value.unlimited === true
    };
  }
  const legacy = actor?.getFlag?.(MODULE_ID, READIED_WEAPON_FLAG);
  return {
    right: typeof legacy === "string" && legacy ? legacy : null,
    left: null,
    unlimited: false
  };
}

/**
 * Resolve readied weapon ids to currently valid carried Item documents.
 *
 * @param {Actor|object|null|undefined} actor Actor document.
 * @returns {{right: Item|object|null, left: Item|object|null, unlimited: boolean}}
 */
export function getReadiedWeapons(actor) {
  const ids = getReadiedWeaponIds(actor);
  const right = actorItemById(actor, ids.right);
  const left = actorItemById(actor, ids.left);
  const weapons = {
    right: isCarriedWeapon(right) ? right : null,
    left: isCarriedWeapon(left) ? left : null,
    unlimited: ids.unlimited
  };
  if (weapons.left?.id === weapons.right?.id) weapons.left = null;
  return weapons;
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
  const readied = getReadiedWeapons(actor);
  return readied.right ?? readied.left ?? null;
}

/**
 * Return all weapons treated as available by module readiness state.
 *
 * Characters return the distinct hand-readied weapons. NPCs with the
 * `unlimited` flag also return all carried weapons for monster-style weapon
 * access without rewriting AoV equipment status.
 *
 * @param {Actor|object|null|undefined} actor Actor document.
 * @returns {Array<Item|object>}
 */
export function getReadiedWeaponList(actor) {
  const state = getReadiedWeapons(actor);
  const unique = new Map();
  for (const item of [state.right, state.left]) {
    if (item?.id) unique.set(String(item.id), item);
  }
  if (state.unlimited) {
    for (const item of getCarriedWeapons(actor)) unique.set(String(item.id), item);
  }
  return Array.from(unique.values());
}

/**
 * Prepare serializable readied-weapon state for module UIs.
 *
 * @param {Actor|object|null|undefined} actor Actor document.
 * @returns {object}
 */
export function prepareReadiedWeaponState(actor) {
  const current = getReadiedWeapon(actor);
  const readied = getReadiedWeapons(actor);
  const currentIds = new Set([readied.right?.id, readied.left?.id].filter(Boolean).map(String));
  const carriedWeapons = getCarriedWeapons(actor).map(item => ({
    id: String(item.id),
    name: String(item.name ?? ""),
    selected: item.id === current?.id,
    readied: currentIds.has(String(item.id)),
    right: item.id === readied.right?.id,
    left: item.id === readied.left?.id
  }));
  if (carriedWeapons.length && !carriedWeapons.some(item => item.selected)) {
    carriedWeapons[0].selected = true;
  }
  return {
    id: current?.id ?? null,
    name: current?.name ?? "",
    rightId: readied.right?.id ?? null,
    leftId: readied.left?.id ?? null,
    rightName: readied.right?.name ?? "",
    leftName: readied.left?.name ?? "",
    names: [readied.right?.name, readied.left?.name].filter(Boolean),
    unlimited: readied.unlimited,
    carriedWeapons,
    canDraw: carriedWeapons.length > 0,
    canSheathe: !!currentIds.size
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
  return setReadiedWeaponInHand(actor, "right", weaponId);
}

/**
 * Mark one actor-owned carried weapon as readied in a specific hand.
 *
 * @param {Actor} actor Actor document.
 * @param {"right"|"left"|string} hand Requested hand; unknown values become right.
 * @param {string} weaponId Owned weapon Item id.
 * @returns {Promise<Actor>}
 */
export async function setReadiedWeaponInHand(actor, hand, weaponId) {
  if (!actor) throw new Error("Actor unavailable.");
  const item = actorItemById(actor, weaponId);
  if (!isCarriedWeapon(item)) {
    throw new Error(game.i18n.localize("AOV_SKJALDBORG.Warnings.WeaponMustBeCarried"));
  }
  const side = hand === "left" ? "left" : "right";
  const current = getReadiedWeaponIds(actor);
  const next = {
    right: current.right,
    left: current.left,
    unlimited: current.unlimited === true
  };
  next[side] = item.id;
  const other = side === "right" ? "left" : "right";
  if (next[other] === item.id) next[other] = null;
  await actor.setFlag(MODULE_ID, READIED_WEAPONS_FLAG, next);
  if (typeof actor.unsetFlag === "function" && actor.getFlag?.(MODULE_ID, READIED_WEAPON_FLAG)) {
    await actor.unsetFlag(MODULE_ID, READIED_WEAPON_FLAG);
  }
  return actor;
}

/**
 * Clear the actor's currently readied weapon.
 *
 * @param {Actor} actor Actor document.
 * @returns {Promise<Actor|undefined>}
 */
export async function clearReadiedWeapon(actor) {
  if (!actor) return actor;
  const current = getReadiedWeaponIds(actor);
  const hasState = current.right || current.left || current.unlimited || actor.getFlag?.(MODULE_ID, READIED_WEAPON_FLAG);
  if (!hasState) return actor;
  await actor.setFlag(MODULE_ID, READIED_WEAPONS_FLAG, {
    right: null,
    left: null,
    unlimited: current.unlimited === true
  });
  if (typeof actor.unsetFlag === "function" && actor.getFlag?.(MODULE_ID, READIED_WEAPON_FLAG)) {
    await actor.unsetFlag(MODULE_ID, READIED_WEAPON_FLAG);
  }
  return actor;
}

/**
 * Clear one readied hand while preserving the other hand and NPC unlimited flag.
 *
 * @param {Actor} actor Actor document.
 * @param {"right"|"left"|string} hand Requested hand; unknown values become right.
 * @returns {Promise<Actor|undefined>}
 */
export async function clearReadiedWeaponInHand(actor, hand) {
  if (!actor) return actor;
  const side = hand === "left" ? "left" : "right";
  const current = getReadiedWeaponIds(actor);
  const next = {
    right: current.right,
    left: current.left,
    unlimited: current.unlimited === true
  };
  next[side] = null;
  await actor.setFlag(MODULE_ID, READIED_WEAPONS_FLAG, next);
  if (typeof actor.unsetFlag === "function" && actor.getFlag?.(MODULE_ID, READIED_WEAPON_FLAG)) {
    await actor.unsetFlag(MODULE_ID, READIED_WEAPON_FLAG);
  }
  return actor;
}

/**
 * Persist normalized multi-hand readiness state.
 *
 * @param {Actor} actor Actor document.
 * @param {Partial<import("../types.mjs").SkjaldborgReadiedWeapons>} [value={}] Readiness patch.
 * @returns {Promise<Actor>}
 */
export async function setReadiedWeapons(actor, value = {}) {
  if (!actor) throw new Error("Actor unavailable.");
  const right = actorItemById(actor, value.right);
  const left = actorItemById(actor, value.left);
  const next = {
    right: isCarriedWeapon(right) ? right.id : null,
    left: isCarriedWeapon(left) ? left.id : null,
    unlimited: value.unlimited === true
  };
  if (next.left && next.left === next.right) next.left = null;
  await actor.setFlag(MODULE_ID, READIED_WEAPONS_FLAG, next);
  if (typeof actor.unsetFlag === "function" && actor.getFlag?.(MODULE_ID, READIED_WEAPON_FLAG)) {
    await actor.unsetFlag(MODULE_ID, READIED_WEAPON_FLAG);
  }
  return actor;
}

/**
 * Read normalized utility combat options from module flags.
 *
 * @param {Actor|object|null|undefined} actor Actor document.
 * @returns {import("../types.mjs").SkjaldborgCombatOptions}
 */
export function getCombatOptions(actor) {
  const raw = actor?.getFlag?.(MODULE_ID, COMBAT_OPTIONS_FLAG);
  const options = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  return {
    twoWeaponFighting: {
      enabled: options.twoWeaponFighting?.enabled === true,
      primaryWeaponId: typeof options.twoWeaponFighting?.primaryWeaponId === "string" ? options.twoWeaponFighting.primaryWeaponId : "",
      secondaryWeaponId: typeof options.twoWeaponFighting?.secondaryWeaponId === "string" ? options.twoWeaponFighting.secondaryWeaponId : "",
      primaryChance: Math.max(0, Number(options.twoWeaponFighting?.primaryChance) || 0),
      secondaryChance: Math.max(0, Number(options.twoWeaponFighting?.secondaryChance) || 0)
    },
    shieldCover: {
      shieldId: typeof options.shieldCover?.shieldId === "string" ? options.shieldCover.shieldId : "",
      locationIds: Array.isArray(options.shieldCover?.locationIds)
        ? options.shieldCover.locationIds.map(String).filter(Boolean)
        : []
    },
    shieldwall: {
      enabled: options.shieldwall?.enabled === true
    }
  };
}

/**
 * Persist normalized utility combat options.
 *
 * @param {Actor} actor Actor document.
 * @param {Partial<import("../types.mjs").SkjaldborgCombatOptions>} [value={}] Options patch.
 * @returns {Promise<unknown>}
 */
export async function setCombatOptions(actor, value = {}) {
  if (!actor) throw new Error("Actor unavailable.");
  const current = getCombatOptions(actor);
  const next = foundry.utils.mergeObject(current, value, { inplace: false });
  next.twoWeaponFighting = {
    enabled: next.twoWeaponFighting?.enabled === true,
    primaryWeaponId: typeof next.twoWeaponFighting?.primaryWeaponId === "string" ? next.twoWeaponFighting.primaryWeaponId : "",
    secondaryWeaponId: typeof next.twoWeaponFighting?.secondaryWeaponId === "string" ? next.twoWeaponFighting.secondaryWeaponId : "",
    primaryChance: Math.max(0, Number(next.twoWeaponFighting?.primaryChance) || 0),
    secondaryChance: Math.max(0, Number(next.twoWeaponFighting?.secondaryChance) || 0)
  };
  next.shieldCover = {
    shieldId: typeof next.shieldCover?.shieldId === "string" ? next.shieldCover.shieldId : "",
    locationIds: Array.isArray(next.shieldCover?.locationIds)
      ? Array.from(new Set(next.shieldCover.locationIds.map(String).filter(Boolean)))
      : []
  };
  next.shieldwall = {
    enabled: next.shieldwall?.enabled === true
  };
  return actor.setFlag(MODULE_ID, COMBAT_OPTIONS_FLAG, next);
}

/**
 * Pragmatically identify shield-like weapons without changing AoV schemas.
 *
 * @param {Item|object|null|undefined} item Candidate weapon.
 * @returns {boolean}
 */
export function isShieldLikeWeapon(item) {
  if (item?.type !== "weapon") return false;
  const descriptors = [
    item.name,
    item.system?.weaponCat,
    item.system?.weaponCatName,
    item.system?.skillCID,
    item.system?.weaponType
  ].map(normalizeWeaponDescriptor);
  return descriptors.some(value => value.includes("shield"));
}

/**
 * Remove a stale readied-weapon flag after the Item is packed, stored, deleted,
 * or otherwise ceases to be a carried actor-owned weapon.
 *
 * @param {Actor|object|null|undefined} actor Actor document.
 * @returns {Promise<boolean>} Whether stale state was cleared.
 */
export async function reconcileReadiedWeapon(actor) {
  const current = getReadiedWeaponIds(actor);
  if (!current.right && !current.left) return false;
  const right = actorItem(actor, current.right);
  const left = actorItem(actor, current.left);
  const next = {
    right: isCarriedWeapon(right) ? right.id : null,
    left: isCarriedWeapon(left) ? left.id : null,
    unlimited: current.unlimited === true
  };
  if (next.right === current.right && next.left === current.left) return false;
  try {
    await setReadiedWeapons(actor, next);
    debug("Cleared stale readied weapon", { actorId: actor?.id, current, next });
    return true;
  } catch (exception) {
    warn(exception);
    return false;
  }
}

/**
 * Register v14 document lifecycle reconciliation for module-managed weapon state.
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
    const ids = getReadiedWeaponIds(item.parent);
    if (ids.right !== item.id && ids.left !== item.id) return;
    void reconcileReadiedWeapon(item.parent).catch(warn);
  });
}
