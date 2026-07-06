import { ACTION_CATEGORIES } from "../../constants.mjs";
import { performanceDiagnostics } from "../../performance/performance-monitor.mjs";
import { MAGIC_TYPE_ORDER, SKILL_CATEGORY_ORDER } from "./constants.mjs";
import { trackedResourceKind } from "./resources.mjs";

export function intentDisplayLabel(category, publicText = "") {
  const normalizedCategory = Object.values(ACTION_CATEGORIES).includes(category)
    ? category
    : ACTION_CATEGORIES.ATTACK;
  const customText = String(publicText ?? "").trim();
  if (normalizedCategory === ACTION_CATEGORIES.OTHER && customText) return customText;
  return game.i18n.localize(`AOV_SKJALDBORG.ActionCategories.${normalizedCategory}`);
}

export function localizeSkillCategory(category) {
  if (category === "other") return game.i18n.localize("AOV_SKJALDBORG.ActorHotbar.Groups.OtherSkills");
  const key = `AOV.skillCat.${category}`;
  const localized = game.i18n.localize(key);
  return localized === key ? category.toLocaleUpperCase(game.i18n.lang) : localized;
}

export function localizeMagicType(itemType) {
  if (itemType === "other") return game.i18n.localize("AOV_SKJALDBORG.ActorHotbar.Groups.OtherMagic");
  const key = `TYPES.Item.${itemType}`;
  const localized = game.i18n.localize(key);
  return localized === key ? itemType : localized;
}

export function measureHotbarContextPart(part, build) {
  const measureId = performanceDiagnostics.markStart(`actorHotbar.context.${part}`);
  try {
    return build();
  } finally {
    performanceDiagnostics.markEnd(measureId, { part });
  }
}

export async function measureHotbarContextPartAsync(part, build) {
  const measureId = performanceDiagnostics.markStart(`actorHotbar.context.${part}`);
  try {
    return await build();
  } finally {
    performanceDiagnostics.markEnd(measureId, { part });
  }
}

export function trackedResourceLabel(attribute, barName) {
  const kind = trackedResourceKind(attribute);
  if (kind === "hp") return game.i18n.localize("AOV_SKJALDBORG.ActorHotbar.HitPoints");
  if (kind === "mp") return game.i18n.localize("AOV_SKJALDBORG.ActorHotbar.MagicPoints");

  const segments = String(attribute ?? "")
    .replace(/^system\./, "")
    .replace(/\.value$/, "")
    .split(".")
    .filter(Boolean);
  const leaf = segments.at(-1) ?? barName;
  const localizationKey = `AOV.${leaf}`;
  const localized = game.i18n.localize(localizationKey);
  if (localized !== localizationKey) return localized;
  return leaf
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, character => character.toLocaleUpperCase(game.i18n.lang));
}

export function prepareNamedGroups(actions, type) {
  const order = type === "skills" ? SKILL_CATEGORY_ORDER : MAGIC_TYPE_ORDER;
  const grouped = new Map();

  for (const action of actions) {
    const key = type === "skills"
      ? (action.category || "other")
      : (MAGIC_TYPE_ORDER.includes(action.itemType) ? action.itemType : "other");
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push({ ...action, reorderable: true, section: key });
  }

  return order
    .filter(key => grouped.has(key))
    .map(key => ({
      id: key,
      label: type === "skills" ? localizeSkillCategory(key) : localizeMagicType(key),
      actions: grouped.get(key)
    }));
}
