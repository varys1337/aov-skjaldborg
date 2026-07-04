import { AoVAdapter } from "../adapter/aov-adapter.mjs";
import { getReadiedWeaponList, isNaturalAttackWeapon } from "../combat/weapon-state.mjs";
import { normalizeDescriptor } from "../utils/document-data.mjs";

export { normalizeDescriptor } from "../utils/document-data.mjs";

export const SITUATIONAL_MODIFIERS = Object.freeze([
  Object.freeze({ value: 40, key: "VeryEasy" }),
  Object.freeze({ value: 20, key: "Easy" }),
  Object.freeze({ value: 0, key: "Standard" }),
  Object.freeze({ value: -20, key: "Hard" }),
  Object.freeze({ value: -40, key: "VeryHard" })
]);

const DAMAGE_TYPE_ABBREVIATIONS = Object.freeze({
  c: "C",
  ct: "CT",
  h: "H",
  i: "I",
  s: "S"
});

const DAMAGE_TYPE_ALIASES = Object.freeze({
  crushing: "c",
  cutandthrust: "ct",
  "cut-and-thrust": "ct",
  handtohand: "h",
  "hand-to-hand": "h",
  impaling: "i",
  slashing: "s"
});

const CUT_AND_THRUST_MODES = Object.freeze(["i", "s"]);
const MELEE_MISSILE_DAMAGE_TYPE = "h";
const MELEE_MISSILE_DAMAGE_OVERRIDE_REASON = "melee-missile-hand-to-hand";
const AIMED_BLOW_PENALTIES = Object.freeze([-20, -40]);
const AMMUNITION_CATEGORY_DESCRIPTORS = Object.freeze(new Set([
  "bow",
  "bows",
  "selfbow",
  "selfbows",
  "crossbow",
  "crossbows",
  "sling",
  "slings",
  "ranged",
  "rangedweapon",
  "rangedweapons",
  "missile",
  "missileweapon",
  "missileweapons"
]));

/**
 * Convert one unknown AoV Item skill value to a finite percentage.
 *
 * @param {Item|object|null|undefined} item Owned Item document or plain test double.
 * @returns {number}
 */
export function itemTotal(item) {
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
 * Sort actor-owned Items by localized name without depending on Collection APIs.
 *
 * @param {Actor|object|null|undefined} actor Actor document or plain test double.
 * @param {string} type AoV Item type.
 * @returns {Array<Item|object>}
 */
export function itemsOfType(actor, type) {
  return Array.from(actor?.items ?? [])
    .filter(item => item?.type === type)
    .sort((a, b) => String(a.name ?? "").localeCompare(String(b.name ?? ""), game.i18n.lang));
}

/**
 * Format a signed integer for compact modifier summaries.
 *
 * @param {unknown} value Numeric modifier.
 * @returns {string}
 */
export function signed(value) {
  const number = Number(value) || 0;
  return number > 0 ? `+${number}` : String(number);
}

/**
 * Normalize AoV's weaponType field.
 *
 * @param {Item|object|null|undefined} weapon Candidate weapon.
 * @returns {string}
 */
export function weaponType(weapon) {
  return normalizeDescriptor(weapon?.system?.weaponType);
}

/**
 * Whether a melee Attack dialog weapon is an ammunition-driven launcher.
 *
 * @param {Item|object|null|undefined} weapon Candidate weapon.
 * @returns {boolean}
 */
export function isAmmunitionDrivenWeapon(weapon) {
  if (weapon?.type !== "weapon") return false;
  if (weaponType(weapon) === "missile") return true;
  const descriptors = [weapon?.name, weapon?.system?.weaponCat, weapon?.system?.weaponCatName, weapon?.system?.skillCID]
    .map(normalizeDescriptor)
    .filter(Boolean);
  return descriptors.some(descriptor => AMMUNITION_CATEGORY_DESCRIPTORS.has(descriptor));
}

/**
 * Build selectable hit-location choices from the target's current body map.
 *
 * @param {Actor|object|null|undefined} actor Target Actor.
 * @param {{wellbeing?: object|null}} [options={}] Optional prepared wellbeing cache.
 * @returns {{id: string, label: string, name: string, rollLabel: string}[]}
 */
export function targetHitLocationChoices(actor, { wellbeing = null } = {}) {
  const prepared = wellbeing ?? AoVAdapter.prepareActorWellbeing(actor);
  const locations = Array.isArray(prepared?.locationList) ? prepared.locationList : [];
  return locations
    .filter(location => String(location?.id ?? "").trim())
    .map(location => ({
      id: String(location.id),
      label: `${location.name} (${location.rollLabel})`,
      name: String(location.name ?? ""),
      rollLabel: String(location.rollLabel ?? "")
    }));
}

/**
 * Build selectable equipped target weapons.
 *
 * @param {Actor|object|null|undefined} actor Target Actor.
 * @returns {{id: string, label: string, name: string, uuid: string|null, currentHp: number, maximumHp: number}[]}
 */
export function targetEquippedWeaponChoices(actor) {
  return Array.from(actor?.items ?? [])
    .filter(item => item?.type === "weapon" && Number(item.system?.equipStatus) === 1)
    .sort((a, b) => String(a.name ?? "").localeCompare(String(b.name ?? ""), game.i18n.lang))
    .map(item => {
      const currentHp = Math.max(0, Number(item.system?.currHP) || 0);
      const maximumHp = Math.max(0, Number(item.system?.maxHP) || 0);
      return {
        id: String(item.id),
        label: `${item.name} (${currentHp}/${maximumHp} HP)`,
        name: String(item.name ?? ""),
        uuid: item.uuid ?? null,
        currentHp,
        maximumHp
      };
    });
}

function isIntrinsicHandToHandWeapon(item) {
  if (isNaturalAttackWeapon(item)) return true;
  const descriptors = [item?.name, item?.system?.weaponCat, item?.system?.weaponCatName, item?.system?.skillCID]
    .map(normalizeDescriptor)
    .filter(Boolean);
  return descriptors.some(value => (
    value === "fist"
    || value === "kick"
    || value === "grapple"
    || value === "handtohand"
    || value === "handtohandweapons"
    || value === "unarmed"
    || value === "unarmedcombat"
  ));
}

/**
 * Build selectable readied target weapons for Aimed equipment attacks.
 *
 * @param {Actor|object|null|undefined} actor Target Actor.
 * @returns {{id: string, label: string, name: string, uuid: string|null, currentHp: number, maximumHp: number}[]}
 */
export function targetAimedEquipmentChoices(actor) {
  return getReadiedWeaponList(actor)
    .filter(item => item?.type === "weapon" && !isIntrinsicHandToHandWeapon(item))
    .sort((a, b) => String(a.name ?? "").localeCompare(String(b.name ?? ""), game.i18n.lang))
    .map(item => {
      const currentHp = Math.max(0, Number(item.system?.currHP) || 0);
      const maximumHp = Math.max(0, Number(item.system?.maxHP) || 0);
      return {
        id: String(item.id),
        label: `${item.name} (${currentHp}/${maximumHp} HP)`,
        name: String(item.name ?? ""),
        uuid: item.uuid ?? null,
        currentHp,
        maximumHp
      };
    });
}

/**
 * Build combined Aimed target choices from body locations and equipped weapons.
 *
 * @param {Actor|object|null|undefined} actor Target Actor.
 * @param {{wellbeing?: object|null}} [options={}] Optional prepared wellbeing cache.
 * @returns {Array<object>}
 */
export function targetAimedChoices(actor, options = {}) {
  const locations = targetHitLocationChoices(actor, options).map(location => ({
    ...location,
    value: `hitLocation:${location.id}`,
    targetKind: "hitLocation",
    targetWeaponId: "",
    targetWeaponName: "",
    targetWeaponUuid: null,
    targetWeaponCurrentHp: 0,
    targetWeaponMaximumHp: 0
  }));
  const equipment = targetAimedEquipmentChoices(actor).map(item => ({
    id: item.id,
    value: `equipment:${item.id}`,
    targetKind: "equipment",
    label: game.i18n.format("AOV_SKJALDBORG.AttackDialog.AimedEquipmentOption", { weapon: item.label }),
    name: item.name,
    rollLabel: "",
    targetWeaponId: item.id,
    targetWeaponName: item.name,
    targetWeaponUuid: item.uuid,
    targetWeaponCurrentHp: item.currentHp,
    targetWeaponMaximumHp: item.maximumHp
  }));
  return [...locations, ...equipment];
}

/**
 * Sort Stun locations and prefer head-like entries by default.
 *
 * @param {Actor|object|null|undefined} actor Target Actor.
 * @param {{wellbeing?: object|null}} [options={}] Optional prepared wellbeing cache.
 * @returns {{locations: object[], selectedId: string}}
 */
export function targetStunLocationState(actor, options = {}) {
  const locations = targetHitLocationChoices(actor, options)
    .sort((a, b) => String(a.name ?? "").localeCompare(String(b.name ?? ""), game.i18n.lang)
      || String(a.id ?? "").localeCompare(String(b.id ?? "")));
  const byName = locations.find(location => /\bhead\b/i.test(String(location.name ?? "")));
  const byRange = locations.find(location => {
    const [lowRaw, highRaw = lowRaw] = String(location.rollLabel ?? "").split("-");
    return Number(lowRaw) === 19 && Number(highRaw) === 20;
  });
  return { locations, selectedId: String((byName ?? byRange ?? locations[0])?.id ?? "") };
}

/**
 * Prepare all target-dependent dialog choices from one wellbeing read.
 *
 * @param {Actor|object|null|undefined} actor Target Actor.
 * @returns {{hitLocations: object[], aimedTargets: object[], stunState: object, equippedWeapons: object[]}}
 */
export function targetDialogChoiceState(actor) {
  const wellbeing = AoVAdapter.prepareActorWellbeing(actor);
  return {
    hitLocations: targetHitLocationChoices(actor, { wellbeing }),
    aimedTargets: targetAimedChoices(actor, { wellbeing }),
    stunState: targetStunLocationState(actor, { wellbeing }),
    equippedWeapons: targetEquippedWeaponChoices(actor)
  };
}

/**
 * Clamp the aimed-blow penalty to the explicitly supported UI options.
 *
 * @param {unknown} value Submitted penalty value.
 * @returns {-20|-40}
 */
export function aimedPenalty(value) {
  const penalty = Number(value);
  return AIMED_BLOW_PENALTIES.includes(penalty) ? penalty : -20;
}

/**
 * Resolve the Age of Vikings weapon damage type into display metadata.
 *
 * @param {Item|object|null|undefined} weapon Weapon Item.
 * @returns {{key: string, abbreviation: string, label: string}}
 */
export function weaponDamageType(weapon) {
  const source = String(
    weapon?.system?.damType
      ?? weapon?.system?.damageType
      ?? weapon?.system?.damage_type
      ?? ""
  ).trim().toLowerCase();
  const compact = source.replace(/[\s_]/g, "");
  const key = DAMAGE_TYPE_ABBREVIATIONS[source]
    ? source
    : (DAMAGE_TYPE_ALIASES[source] ?? DAMAGE_TYPE_ALIASES[compact] ?? source);
  const abbreviation = DAMAGE_TYPE_ABBREVIATIONS[key]
    ?? (source ? source.toUpperCase() : "-");
  const localizationKey = key ? `AOV.DamType.${key}` : "";
  const localized = localizationKey ? game.i18n.localize(localizationKey) : "";
  const label = localized && localized !== localizationKey ? localized : abbreviation;
  return { key, abbreviation, label };
}

/**
 * Resolve one normalized AoV damage-type key into display metadata.
 *
 * @param {string} key Canonical AoV damage-type key.
 * @returns {{key: string, abbreviation: string, label: string}}
 */
export function damageTypeFromKey(key) {
  const normalized = String(key ?? "").trim().toLowerCase();
  const abbreviation = DAMAGE_TYPE_ABBREVIATIONS[normalized]
    ?? (normalized ? normalized.toUpperCase() : "-");
  const localizationKey = normalized ? `AOV.DamType.${normalized}` : "";
  const localized = localizationKey ? game.i18n.localize(localizationKey) : "";
  const label = localized && localized !== localizationKey ? localized : abbreviation;
  return { key: normalized, abbreviation, label };
}

/**
 * Resolve the per-attack/per-shot damage mode.
 *
 * @param {Item|object|null|undefined} weapon Weapon Item.
 * @param {string} requestedKey Previously selected per-roll mode.
 * @param {{workflow?: "melee"|"missile", forceMeleeMissileHandToHand?: boolean}} [options={}] Behavior options.
 * @returns {{source: object, effective: object, selectable: boolean, next: object|null, tooltip: string, override: object|null, workflow: string}}
 */
export function attackDamageSelection(weapon, requestedKey = "", { workflow = "melee", forceMeleeMissileHandToHand = false } = {}) {
  const source = weaponDamageType(weapon);
  const meleeMissileOverride = forceMeleeMissileHandToHand && isAmmunitionDrivenWeapon(weapon);
  const selectable = !meleeMissileOverride && source.key === "ct";
  const selectedKey = meleeMissileOverride
    ? MELEE_MISSILE_DAMAGE_TYPE
    : (selectable
      ? (CUT_AND_THRUST_MODES.includes(requestedKey) ? requestedKey : "i")
      : source.key);
  const effective = damageTypeFromKey(selectedKey);
  const next = selectable
    ? damageTypeFromKey(selectedKey === "i" ? "s" : "i")
    : null;
  const override = meleeMissileOverride
    ? {
        reason: MELEE_MISSILE_DAMAGE_OVERRIDE_REASON,
        workflow,
        sourceDamageType: { ...source },
        effectiveDamageType: { ...effective }
      }
    : null;
  const tooltip = selectable
    ? game.i18n.format("AOV_SKJALDBORG.AttackDialog.DamageTypeSwitchTooltip", {
        label: effective.label,
        abbreviation: effective.abbreviation,
        nextLabel: next.label,
        nextAbbreviation: next.abbreviation,
        sourceLabel: source.label,
        sourceAbbreviation: source.abbreviation
      })
    : (override
      ? game.i18n.format("AOV_SKJALDBORG.AttackDialog.MeleeMissileDamageTooltip", {
          sourceLabel: source.label,
          sourceAbbreviation: source.abbreviation,
          label: effective.label,
          abbreviation: effective.abbreviation
        })
      : game.i18n.format("AOV_SKJALDBORG.AttackDialog.DamageTypeFixedTooltip", {
          label: effective.label,
          abbreviation: effective.abbreviation
        }));
  return { source, effective, selectable, next, tooltip, override, workflow };
}

/**
 * Determine the weapon-adjusted AoV damage-bonus formula without rolling it.
 *
 * @param {Actor|object|null|undefined} actor Acting Actor.
 * @param {Item|object|null|undefined} weapon Weapon Item.
 * @returns {{mode: string, sourceFormula: string, formula: string}}
 */
export function weaponDamageBonus(actor, weapon) {
  const mode = String(weapon?.system?.damMod ?? "d").trim().toLowerCase();
  const sourceFormula = String(actor?.system?.dmgBonus ?? "0").trim() || "0";
  const formula = mode === "h"
    ? `${sourceFormula}/2`
    : (mode === "n" ? "0" : sourceFormula);
  return { mode, sourceFormula, formula };
}

/**
 * Build the damage contract consumed by later normal, special, and critical automation.
 *
 * @param {Actor|object|null|undefined} actor Acting Actor.
 * @param {Item|object|null|undefined} weapon Weapon Item.
 * @param {ReturnType<attackDamageSelection>} selection Damage selection.
 * @returns {object}
 */
export function buildDamageProfile(actor, weapon, selection) {
  const baseFormula = String(weapon?.system?.damage ?? "-");
  const damageBonus = weaponDamageBonus(actor, weapon);
  const key = selection.effective.key;
  const doublesWeaponDamage = key === "i" || key === "s";
  const addsMaximumDamageBonus = key === "c" || key === "h";
  const specialKind = key === "i"
    ? "impaling"
    : (key === "s" ? "slashing" : (addsMaximumDamageBonus ? "crushing" : "normal"));

  return {
    baseFormula,
    sourceType: { ...selection.source },
    effectiveType: { ...selection.effective },
    selectionRequired: selection.selectable,
    workflow: selection.workflow ?? "melee",
    damageOverride: selection.override ? foundry.utils.deepClone(selection.override) : null,
    damageBonus,
    normal: {
      weaponFormula: baseFormula,
      damageBonusFormula: damageBonus.formula
    },
    special: {
      kind: specialKind,
      weaponFormula: doublesWeaponDamage ? `${baseFormula}+${baseFormula}` : baseFormula,
      damageBonusFormula: damageBonus.formula,
      doublesWeaponDamage,
      addsMaximumDamageBonus,
      impales: key === "i",
      testsConsciousnessOnLocationThreshold: key === "s"
    },
    critical: {
      kind: specialKind,
      maximizeSpecialWeaponDamage: true,
      ignoresArmor: true,
      damageBonusFormula: damageBonus.formula,
      addsMaximumDamageBonus,
      impales: key === "i",
      testsConsciousnessOnLocationThreshold: key === "s"
    },
    core: {
      rollType: "DM",
      workflow: selection.workflow ?? "melee",
      damageType: key,
      sourceDamageType: selection.source.key,
      damageOverrideReason: selection.override?.reason ?? null,
      successLevels: {
        normal: "2",
        special: "3",
        critical: "4"
      }
    }
  };
}

/**
 * Prepare serializable item choices with total percentages.
 *
 * @param {Actor|object|null|undefined} actor Actor document.
 * @param {string} type Item type.
 * @returns {{id: string, label: string, value: number}[]}
 */
export function prepareSourceChoices(actor, type) {
  return itemsOfType(actor, type).map(item => ({
    id: item.id,
    label: `${item.name} (${itemTotal(item)}%)`,
    value: itemTotal(item)
  }));
}

/**
 * Show details only for currently selected augmentation scaffolds.
 *
 * @param {HTMLFormElement} form Dialog form.
 * @returns {void}
 */
export function updateAugmentDetails(form) {
  const selected = new Set(new FormData(form).getAll("augmentOptions").map(String));
  for (const detail of form.querySelectorAll("[data-augment-detail]")) {
    detail.hidden = !selected.has(detail.dataset.augmentDetail);
  }
}

/**
 * Keep roll-dialog chance cards updated with the full modifier breakdown
 * through Foundry's native data-tooltip rendering.
 *
 * @param {HTMLFormElement} form Dialog form.
 * @param {{targetNumber?: number}} state Current roll preview state.
 * @param {string} detail Complete modifier breakdown.
 * @returns {void}
 */
export function updateModifierSummary(form, state, detail) {
  const targetNumber = form.querySelector("[data-target-number]");
  const card = targetNumber?.closest(".skj-roll-dialog__rating-card");
  if (!card) return;
  card.removeAttribute("title");
  card.setAttribute("data-tooltip", detail);
  card.setAttribute("aria-label", detail);
}
