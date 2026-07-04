import { actorItems, cleanString, cleanStringArray, numberOr } from "../utils/document-data.mjs";

export const RUNE_MAGIC_STATUSES = Object.freeze({
  NONE: "none",
  CARVING: "carving",
  READY: "ready",
  FAILED: "failed",
  DISRUPTED: "disrupted",
  RESOLVED: "resolved",
  RITUAL: "ritual"
});

export const RUNE_MAGIC_RESULT_LEVELS = Object.freeze({
  FUMBLE: 0,
  FAILURE: 1,
  SUCCESS: 2,
  SPECIAL: 3,
  CRITICAL: 4
});

export const CRAFT_RUNE_MODES = Object.freeze({
  CARPENTRY: "carpentry",
  MASONRY: "masonry",
  CUSTOM: "custom"
});

function normalizedText(value) {
  return cleanString(value, 240)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[()]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function skillSearchText(item) {
  return normalizedText(`${item?.flags?.aov?.cidFlag?.id ?? ""} ${item?.name ?? ""}`);
}

export function runeScriptDetails(item) {
  const runes = Object.values(item?.system?.runes ?? {})
    .map(value => cleanString(value, 80))
    .filter(value => value && value !== "none");
  const runeCount = runes.length;
  return {
    runeCount,
    mpCost: runeCount * 2,
    maxEffects: Math.max(0, Math.floor((runeCount - 1) / 2)),
    effective: [3, 5, 7, 9].includes(runeCount),
    dexPenalty: Math.max(1, runeCount)
  };
}

export function seidurDetails(item) {
  const dimension = Math.max(0, numberOr(item?.system?.dimension, 0));
  const distance = Math.max(0, numberOr(item?.system?.distance, 0));
  const duration = Math.max(0, numberOr(item?.system?.duration, 0));
  const partCost = value => value > 0 ? Math.max(((value - 1) * 3), 1) : 0;
  const cost = partCost(dimension) + partCost(distance) + partCost(duration);
  return {
    realm: cleanString(item?.system?.realm, 80),
    dimension,
    distance,
    duration,
    mpCost: cost,
    mpLocked: Math.max(dimension, distance, duration),
    castTime: cost * 10
  };
}

export function actorMagicItems(actor) {
  const items = actorItems(actor);
  return {
    runescripts: items
      .filter(item => item?.type === "runescript")
      .sort((a, b) => String(a.name ?? "").localeCompare(String(b.name ?? ""))),
    seidurs: items
      .filter(item => item?.type === "seidur")
      .sort((a, b) => String(a.name ?? "").localeCompare(String(b.name ?? "")))
  };
}

export function actorSkillChoices(actor) {
  const skills = actorItems(actor)
    .filter(item => item?.type === "skill")
    .map(item => {
      const cid = cleanString(item.flags?.aov?.cidFlag?.id, 120);
      const name = cleanString(item.name, 160);
      const normalized = skillSearchText(item);
      return {
        id: String(item.id ?? ""),
        name,
        cid,
        total: numberOr(item.system?.total, 0),
        craft: normalized.includes("craft"),
        craftCarpentry: normalized.includes("craft") && normalized.includes("carpent"),
        craftMasonry: normalized.includes("craft") && normalized.includes("mason"),
        readWriteRunes: (cid === "i.skill.read-write" || normalized.includes("read/write") || normalized.includes("read write"))
          && normalized.includes("rune"),
        runeMagic: cid === "i.skill.rune-magic" || normalized.includes("rune magic"),
        seidurMagic: cid === "i.skill.seiour-magic" || normalized.includes("seidur magic") || normalized.includes("seiour magic")
      };
    })
    .filter(choice => choice.id);
  return skills.sort((a, b) => {
    if (a.craft !== b.craft) return a.craft ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

export function firstRuneMagicSkill(actor) {
  return actorSkillChoices(actor).find(choice => choice.runeMagic) ?? null;
}

export function firstSeidurMagicSkill(actor) {
  return actorSkillChoices(actor).find(choice => choice.seidurMagic) ?? null;
}

export function readWriteRunesSkill(actor) {
  return actorSkillChoices(actor).find(choice => choice.readWriteRunes) ?? null;
}

export function runeCraftChoices(actor) {
  const skills = actorSkillChoices(actor);
  const carpentry = skills.find(choice => choice.craftCarpentry) ?? null;
  const masonry = skills.find(choice => choice.craftMasonry) ?? null;
  return [
    {
      mode: CRAFT_RUNE_MODES.CARPENTRY,
      skillId: carpentry?.id ?? "",
      name: carpentry?.name ?? "Craft (carpentry)",
      total: carpentry?.total ?? 0,
      available: !!carpentry
    },
    {
      mode: CRAFT_RUNE_MODES.MASONRY,
      skillId: masonry?.id ?? "",
      name: masonry?.name ?? "Craft (masonry)",
      total: masonry?.total ?? 0,
      available: !!masonry
    },
    {
      mode: CRAFT_RUNE_MODES.CUSTOM,
      skillId: "",
      name: "Custom",
      total: 0,
      available: true
    }
  ];
}

export function runeMagicNarrativeKey(resultLevel) {
  const level = Number(resultLevel);
  if (!Number.isFinite(level)) return "";
  if (level >= RUNE_MAGIC_RESULT_LEVELS.CRITICAL) return "AOV_SKJALDBORG.RunicMagic.Results.Critical";
  if (level === RUNE_MAGIC_RESULT_LEVELS.SPECIAL) return "AOV_SKJALDBORG.RunicMagic.Results.Special";
  if (level === RUNE_MAGIC_RESULT_LEVELS.SUCCESS) return "AOV_SKJALDBORG.RunicMagic.Results.Success";
  if (level === RUNE_MAGIC_RESULT_LEVELS.FAILURE) return "AOV_SKJALDBORG.RunicMagic.Results.Failure";
  if (level <= RUNE_MAGIC_RESULT_LEVELS.FUMBLE) return "AOV_SKJALDBORG.RunicMagic.Results.Fumble";
  return "";
}

export function runeMagicConsumesPrepared(resultLevel) {
  if (resultLevel === null || resultLevel === undefined || resultLevel === "") return false;
  const level = Number(resultLevel);
  if (!Number.isFinite(level)) return false;
  return level !== RUNE_MAGIC_RESULT_LEVELS.FAILURE;
}

export function cleanTargetRefs(value) {
  const source = Array.isArray(value) ? value : [];
  return source.map(entry => ({
    key: cleanString(entry?.key, 200),
    tokenUuid: cleanString(entry?.tokenUuid, 200),
    tokenId: cleanString(entry?.tokenId, 100),
    actorUuid: cleanString(entry?.actorUuid, 200),
    actorId: cleanString(entry?.actorId, 100),
    name: cleanString(entry?.name, 160),
    img: cleanString(entry?.img, 500),
    imgIsVideo: entry?.imgIsVideo === true
  })).filter(entry => entry.tokenUuid || entry.actorUuid || entry.name);
}

export function targetNames(targetRefs) {
  const names = cleanTargetRefs(targetRefs).map(entry => entry.name).filter(Boolean);
  return cleanStringArray(names, 160);
}
