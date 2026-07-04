import { MOUNTED_STATUS_ID } from "../constants.mjs";
import { effectHasStatus, effectIsActive } from "../compat/active-effects.mjs";

const RIDE_SKILL_CID = "i.skill.ride";

function cidFlagId(item) {
  return String(item?.flags?.aov?.cidFlag?.id ?? "").trim();
}

function itemTotal(item) {
  const candidates = [
    item?.system?.total,
    item?.system?.effective,
    item?.system?.value,
    item?.system?.base
  ];
  for (const candidate of candidates) {
    const value = Number(candidate);
    if (Number.isFinite(value)) return value;
  }
  return 0;
}

/**
 * Whether an Actor currently carries the Skjaldborg Mounted status.
 *
 * @param {Actor|object|null|undefined} actor Actor to inspect.
 * @returns {boolean}
 */
export function actorIsMounted(actor) {
  return Array.from(actor?.effects ?? []).some(effect => effectIsActive(effect) && effectHasStatus(effect, MOUNTED_STATUS_ID));
}

/**
 * Resolve the Actor's Ride skill item.
 *
 * @param {Actor|object|null|undefined} actor Actor to inspect.
 * @returns {Item|object|null}
 */
export function rideSkill(actor) {
  return Array.from(actor?.items ?? []).find(item => item?.type === "skill" && cidFlagId(item) === RIDE_SKILL_CID) ?? null;
}

/**
 * Apply the RAW mounted combat cap to a weapon skill chance.
 *
 * If the actor is mounted but no Ride skill exists, the chance is left intact
 * and metadata is returned so the roll tooltip can make that visible.
 *
 * @param {Actor|object|null|undefined} actor Actor making the roll.
 * @param {number} weaponChance Current weapon skill chance.
 * @returns {{active: boolean, missingRide: boolean, weaponChance: number, rideChance: number|null, baseChance: number, modifier: number}}
 */
export function mountedWeaponCap(actor, weaponChance) {
  const chance = Math.round(Number(weaponChance) || 0);
  if (!actorIsMounted(actor)) {
    return { active: false, missingRide: false, weaponChance: chance, rideChance: null, baseChance: chance, modifier: 0 };
  }
  const ride = rideSkill(actor);
  if (!ride) {
    return { active: true, missingRide: true, weaponChance: chance, rideChance: null, baseChance: chance, modifier: 0 };
  }
  const rideChance = Math.round(itemTotal(ride));
  const baseChance = Math.min(chance, rideChance);
  return {
    active: true,
    missingRide: false,
    weaponChance: chance,
    rideChance,
    baseChance,
    modifier: baseChance - chance
  };
}

/**
 * Human-readable mounted cap segment for roll-dialog tooltips.
 *
 * @param {ReturnType<mountedWeaponCap>|null|undefined} cap Mounted cap data.
 * @returns {string}
 */
export function mountedCapSummary(cap) {
  if (!cap?.active) return "";
  if (cap.missingRide) return game.i18n.localize("AOV_SKJALDBORG.MountedCombat.RideUnavailable");
  return game.i18n.format("AOV_SKJALDBORG.MountedCombat.CapSummary", {
    weapon: cap.weaponChance,
    ride: cap.rideChance,
    cap: cap.baseChance
  });
}
