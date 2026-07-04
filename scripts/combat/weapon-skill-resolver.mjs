import { actorItems, normalizeDescriptor } from "../utils/document-data.mjs";

const SKILL_TOTAL_FIELDS = Object.freeze(["base", "xp", "home", "history", "pers", "dev", "effects"]);
const NATURAL_SKILL_TOTAL_FIELDS = Object.freeze(["base", "xp", "home", "history", "pers", "dev"]);

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function cidFlagId(item) {
  return String(item?.flags?.aov?.cidFlag?.id ?? "").trim();
}

function compactCidTail(value) {
  const text = String(value ?? "").trim();
  if (!text) return "";
  const parts = text.split(".");
  return normalizeDescriptor(parts.at(-1) ?? text);
}

function weaponCategoryKey(value) {
  return compactCidTail(value);
}

function actorCategoryBonus(actor, skill) {
  const category = String(skill?.system?.category ?? "").trim();
  if (!category) return 0;
  return finiteNumber(skill?.system?.catBonus)
    ?? finiteNumber(actor?.system?.[category])
    ?? 0;
}

/**
 * Reconstruct the AoV prepared total for a Skill item when an exported or test
 * actor does not include `system.total`.
 *
 * This mirrors the v14 AoV system preparation path: additive skill fields are
 * summed first, then category bonus is added only when the raw total is
 * positive.
 *
 * @param {Actor|object|null|undefined} actor Owning actor.
 * @param {Item|object|null|undefined} skill Candidate Skill item.
 * @returns {number}
 */
export function resolveSkillTotal(actor, skill) {
  const prepared = finiteNumber(skill?.system?.total)
    ?? finiteNumber(skill?.system?.effective)
    ?? finiteNumber(skill?.system?.value);
  if (prepared !== null) return prepared;

  const raw = SKILL_TOTAL_FIELDS.reduce((sum, field) => sum + (finiteNumber(skill?.system?.[field]) ?? 0), 0);
  return raw > 0 ? raw + actorCategoryBonus(actor, skill) : raw;
}

/**
 * Reconstruct the RAW natural skill rating used for split-attack eligibility.
 *
 * AoV stores temporary and active-effect skill contribution in `system.effects`.
 * Split attacks use the character's natural rating, so that field and all
 * dialog modifiers are excluded.
 *
 * @param {Actor|object|null|undefined} actor Owning actor.
 * @param {Item|object|null|undefined} skill Candidate Skill item.
 * @returns {number|null}
 */
export function resolveNaturalSkillTotal(actor, skill) {
  if (!skill) return null;
  const raw = NATURAL_SKILL_TOTAL_FIELDS.reduce((sum, field) => sum + (finiteNumber(skill?.system?.[field]) ?? 0), 0);
  return raw > 0 ? raw + actorCategoryBonus(actor, skill) : raw;
}

function skillMatchesWeapon(skill, weapon) {
  if (skill?.type !== "skill" || String(skill?.system?.category ?? "") !== "cbt") return false;
  const skillCid = cidFlagId(skill);
  const weaponSkillCid = String(weapon?.system?.skillCID ?? "").trim();
  if (skillCid && weaponSkillCid && skillCid === weaponSkillCid) return true;
  if (String(skill?.system?.skillCID ?? "").trim() && weaponSkillCid && String(skill.system.skillCID).trim() === weaponSkillCid) return true;

  const weaponName = normalizeDescriptor(weapon?.name);
  const skillNames = [
    skill?.name,
    skill?.system?.mainName,
    skill?.system?.label,
    compactCidTail(skillCid)
  ].map(normalizeDescriptor).filter(Boolean);
  if (weaponName && skillNames.includes(weaponName)) return true;

  const weaponSkillKey = compactCidTail(weaponSkillCid);
  return !!weaponSkillKey && skillNames.includes(weaponSkillKey);
}

function combatSkills(actor) {
  return actorItems(actor).filter(item => item?.type === "skill" && String(item?.system?.category ?? "") === "cbt");
}

/**
 * Resolve the best Combat skill that explicitly matches a weapon.
 *
 * @param {Actor|object|null|undefined} actor Owning actor.
 * @param {Item|object|null|undefined} weapon Weapon item.
 * @returns {{item: Item|object|null, total: number}}
 */
export function resolveWeaponCombatSkill(actor, weapon) {
  let best = { item: null, total: 0 };
  for (const skill of combatSkills(actor)) {
    if (!skillMatchesWeapon(skill, weapon)) continue;
    const total = resolveSkillTotal(actor, skill);
    if (!best.item || total > best.total) best = { item: skill, total };
  }
  return best;
}

/**
 * Resolve the best natural Combat skill that explicitly matches a weapon.
 *
 * @param {Actor|object|null|undefined} actor Owning actor.
 * @param {Item|object|null|undefined} weapon Weapon item.
 * @returns {{item: Item|object|null, total: number|null}}
 */
export function resolveNaturalWeaponCombatSkill(actor, weapon) {
  let best = { item: null, total: null };
  for (const skill of combatSkills(actor)) {
    if (!skillMatchesWeapon(skill, weapon)) continue;
    const total = resolveNaturalSkillTotal(actor, skill);
    if (total === null) continue;
    if (!best.item || total > best.total) best = { item: skill, total };
  }
  return best;
}

/**
 * Resolve the best skill total in a weapon category.
 *
 * @param {Actor|object|null|undefined} actor Owning actor.
 * @param {string} categoryKey Normalized AoV weapon category key.
 * @returns {number}
 */
export function resolveWeaponCategoryTotal(actor, categoryKey) {
  const key = weaponCategoryKey(categoryKey);
  if (!key) return 0;

  const prepared = finiteNumber(actor?.system?.weaponCats?.[key]);
  if (prepared !== null) return prepared;

  let best = 0;
  for (const skill of combatSkills(actor)) {
    if (weaponCategoryKey(skill?.system?.weaponCat) !== key) continue;
    best = Math.max(best, resolveSkillTotal(actor, skill));
  }
  return best;
}

/**
 * Resolve the best natural skill total in a weapon category.
 *
 * @param {Actor|object|null|undefined} actor Owning actor.
 * @param {string} categoryKey Normalized AoV weapon category key.
 * @returns {number|null}
 */
export function resolveNaturalWeaponCategoryTotal(actor, categoryKey) {
  const key = weaponCategoryKey(categoryKey);
  if (!key) return null;

  let best = null;
  for (const skill of combatSkills(actor)) {
    if (weaponCategoryKey(skill?.system?.weaponCat) !== key) continue;
    const total = resolveNaturalSkillTotal(actor, skill);
    if (total === null) continue;
    best = Math.max(best ?? 0, total);
  }
  return best;
}

/**
 * Resolve the attack/parry chance for a weapon using AoV's prepared-data rule:
 * exact weapon skill, or half of the best skill in the same weapon category,
 * whichever is higher.
 *
 * @param {Actor|object|null|undefined} actor Owning actor.
 * @param {Item|object|null|undefined} weapon Weapon item.
 * @returns {{total: number, directTotal: number, categoryTotal: number, skill: Item|object|null}}
 */
export function resolveWeaponSkill(actor, weapon) {
  const prepared = finiteNumber(weapon?.system?.total);
  if (prepared !== null) {
    const direct = resolveWeaponCombatSkill(actor, weapon);
    return {
      total: prepared,
      directTotal: direct.total,
      categoryTotal: resolveWeaponCategoryTotal(actor, weapon?.system?.weaponCat),
      skill: direct.item
    };
  }

  const direct = resolveWeaponCombatSkill(actor, weapon);
  const categoryTotal = resolveWeaponCategoryTotal(actor, weapon?.system?.weaponCat);
  return {
    total: Math.max(direct.total, Math.ceil(categoryTotal / 2)),
    directTotal: direct.total,
    categoryTotal,
    skill: direct.item
  };
}

/**
 * Resolve the natural weapon skill for RAW split-attack eligibility.
 *
 * If no matching natural skill data can be found, `total` is null rather than
 * falling back to `weapon.system.total`, because that prepared value may include
 * active effects.
 *
 * @param {Actor|object|null|undefined} actor Owning actor.
 * @param {Item|object|null|undefined} weapon Weapon item.
 * @returns {{total: number|null, directTotal: number|null, categoryTotal: number|null, skill: Item|object|null}}
 */
export function resolveNaturalWeaponSkill(actor, weapon) {
  const direct = resolveNaturalWeaponCombatSkill(actor, weapon);
  const categoryTotal = resolveNaturalWeaponCategoryTotal(actor, weapon?.system?.weaponCat);
  const fallback = categoryTotal === null ? null : Math.ceil(categoryTotal / 2);
  const totals = [direct.total, fallback].filter(value => value !== null);
  return {
    total: totals.length ? Math.max(...totals) : null,
    directTotal: direct.total,
    categoryTotal,
    skill: direct.item
  };
}
