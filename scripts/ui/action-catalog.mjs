import { ACTION_CATEGORIES, ACTION_UI_DEFAULTS, ACTION_UI_LIMITS, INTENT_STATUS, MODULE_ID, UTILITY_ACTION_ID } from "../constants.mjs";
import { AoVAdapter } from "../adapter/aov-adapter.mjs";
import { defaultCombatantState, getCombatState, getCombatantState } from "../combat/state.mjs";
import { requestGm } from "../socket.mjs";
import { error } from "../logger.mjs";
import { clearReadiedWeaponInHand, getReadiedWeapon, getReadiedWeaponIds, getReadiedWeaponList } from "../combat/weapon-state.mjs";
import { RenderCoordinator } from "./render-coordinator.mjs";
import { activateEvadingForActor } from "../combat/evade-status.mjs";
import { performanceDiagnostics } from "../performance/performance-monitor.mjs";
import {
  clearActorPreparedIntent,
  getActorPreparedIntent,
  normalizeIntentCategory,
  sanitizePreparedIntentText,
  setActorPreparedIntent
} from "../combat/prepared-intent.mjs";
import { actionThemeClass, finiteNumber, localizeOrFallback } from "./dom-utils.mjs";

export { getActorPreparedIntent } from "../combat/prepared-intent.mjs";

const ROLLABLE_ITEM_TYPES = new Set(["weapon", "skill", "passion"]);
const MAGIC_ITEM_TYPES = new Set(["rune", "runescript", "seidur", "npcpower"]);
const HISTORY_FAMILY_ACTION_TYPES = new Set(["passion", "devotion"]);
const EQUIPMENT_ITEM_TYPES = new Set(["weapon", "gear", "armour"]);
export const ACTOR_HOTBAR_QUICK_SLOT_CAPACITY = ACTION_UI_LIMITS.actionRingMaxItems.max;
const QUICK_ACCESS_ACTION_KINDS = new Set(["item", "stat", "intent", "macro"]);
const pendingIntentCommits = new Map();
const DISPLAYABLE_INTENT_STATUSES = new Set([INTENT_STATUS.COMMITTED, INTENT_STATUS.HELD]);
const itemSnapshotsByActor = new WeakMap();

const EQUIPMENT_STATUS = Object.freeze({
  1: { key: "AOV.carried", icon: "fa-solid fa-hand-holding" },
  2: { key: "AOV.packed", icon: "fa-solid fa-horse" },
  3: { key: "AOV.stored", icon: "fa-solid fa-house" }
});

const ACTION_ICONS = Object.freeze({
  [ACTION_CATEGORIES.ATTACK]: "fa-solid fa-swords",
  [ACTION_CATEGORIES.MISSILE]: "fa-solid fa-crosshairs",
  [ACTION_CATEGORIES.KNOCKBACK]: "fa-solid fa-people-arrows-left-right",
  [ACTION_CATEGORIES.GRAPPLE]: "fa-solid fa-people-pulling",
  [ACTION_CATEGORIES.DEFEND]: "fa-solid fa-person-running",
  [ACTION_CATEGORIES.MAGIC]: "fa-solid fa-wand-magic-sparkles",
  [ACTION_CATEGORIES.RETREAT]: "fa-solid fa-person-walking-arrow-right",
  [ACTION_CATEGORIES.WAIT]: "fa-solid fa-hand",
  [ACTION_CATEGORIES.DELAY]: "fa-solid fa-clock",
  [ACTION_CATEGORIES.OTHER]: "fa-solid fa-ellipsis",
  [UTILITY_ACTION_ID]: "fa-solid fa-toolbox"
});

/**
 * Normalize the AoV carried, packed, or stored state for equipment.
 *
 * @param {unknown} value Candidate equipStatus value.
 * @returns {{value: number, label: string, icon: string}}
 */
function equipmentStatus(value) {
  const normalized = [1, 2, 3].includes(Number(value)) ? Number(value) : 1;
  const descriptor = EQUIPMENT_STATUS[normalized];
  return {
    value: normalized,
    label: localizeOrFallback(descriptor.key, normalized === 1 ? "Carried" : normalized === 2 ? "Packed" : "Stored"),
    icon: descriptor.icon
  };
}

function actorRevision(actor) {
  return [
    actor?.uuid ?? actor?.id ?? "",
    actor?.updatedAt ?? actor?._stats?.modifiedTime ?? "",
    actor?.items?.size ?? 0
  ].join(":");
}

/**
 * Build a stable per-render item index for hotbar, ring, and dialog prep.
 *
 * The snapshot avoids repeated full collection scans while remaining derived
 * from authoritative Actor-owned Item documents. Callers must not mutate the
 * returned arrays.
 *
 * @param {Actor|null|undefined} actor Actor document.
 * @returns {{items: Item[], byType: Map<string, Item[]>}}
 */
export function actorItemSnapshot(actor) {
  if (!actor) return { items: [], byType: new Map() };
  const revision = actorRevision(actor);
  const cached = itemSnapshotsByActor.get(actor);
  if (cached?.revision === revision) {
    performanceDiagnostics.count("actionCatalog.itemSnapshot.hit");
    return cached.snapshot;
  }

  const items = Array.from(actor.items ?? []);
  const byType = new Map();
  for (const item of items) {
    const type = String(item?.type ?? "");
    if (!type) continue;
    const bucket = byType.get(type) ?? [];
    bucket.push(item);
    byType.set(type, bucket);
  }
  const snapshot = { items, byType };
  itemSnapshotsByActor.set(actor, { revision, snapshot });
  performanceDiagnostics.count("actionCatalog.itemSnapshot.miss", 1, { actorId: actor.id ?? null, itemCount: items.length });
  return snapshot;
}

/**
 * Explicitly drop a cached item snapshot when hook-level invalidation knows the
 * actor's owned Item collection changed.
 *
 * @param {Actor|null|undefined} actor Actor document.
 * @returns {void}
 */
export function invalidateActorItemSnapshot(actor) {
  if (!actor) return;
  itemSnapshotsByActor.delete(actor);
  performanceDiagnostics.count("actionCatalog.itemSnapshot.invalidate", 1, { actorId: actor.id ?? null });
}

function snapshotItemsOfType(snapshot, type) {
  return snapshot.byType.get(type) ?? [];
}



/**
 * Normalize one persisted actor-hotbar quick-access entry.
 *
 * @param {unknown} value Candidate entry.
 * @returns {{kind: string, id: string}|null}
 */
function normalizeQuickAccessEntry(value) {
  if (!value || typeof value !== "object") return null;
  const kind = String(value.kind ?? "");
  let id = String(value.id ?? "");
  if (!QUICK_ACCESS_ACTION_KINDS.has(kind) || !id) return null;
  if (kind === "intent") id = normalizeIntentCategory(id);
  return { kind, id };
}

/**
 * Read the client-configured number of visible quick-access circles.
 *
 * @returns {number}
 */
export function getQuickAccessCircleCount() {
  const limits = ACTION_UI_LIMITS.actionRingMaxItems;
  const configured = Number(game.settings.get(MODULE_ID, "actionRingMaxItems"));
  const fallback = ACTION_UI_DEFAULTS.actionRingMaxItems;
  const value = Number.isFinite(configured) ? Math.round(configured) : fallback;
  return Math.min(limits.max, Math.max(limits.min, value));
}

/**
 * Read the actor's persisted quick-access configuration.
 *
 * A null return value means the actor has never customized quick access and
 * allows the UI to retain the prior equipped-weapon fallback. An array return
 * value always matches the twelve-entry storage capacity and may contain null slots.
 *
 * @param {Actor|null|undefined} actor Actor document.
 * @returns {({kind: string, id: string}|null)[]|null}
 */
export function getActorQuickAccess(actor) {
  const stored = actor?.getFlag?.(MODULE_ID, "actorHotbarQuickAccess");
  if (!Array.isArray(stored)) return null;
  return Array.from({ length: ACTOR_HOTBAR_QUICK_SLOT_CAPACITY }, (_, index) =>
    normalizeQuickAccessEntry(stored[index])
  );
}

/**
 * Persist a complete actor-hotbar quick-access configuration.
 *
 * @param {Actor} actor Actor document.
 * @param {unknown[]} slots Candidate slot entries.
 * @returns {Promise<Actor>}
 */
export async function persistActorQuickAccess(actor, slots) {
  const normalized = Array.from({ length: ACTOR_HOTBAR_QUICK_SLOT_CAPACITY }, (_, index) =>
    normalizeQuickAccessEntry(slots?.[index])
  );
  return actor.setFlag(MODULE_ID, "actorHotbarQuickAccess", normalized);
}

/**
 * Resolve the selected or assigned actor used by the custom actor hotbar.
 *
 * Exactly one controlled token takes precedence. Multiple controlled tokens
 * deliberately produce no actor to avoid ambiguous rolls. The assigned user
 * character and then the first owned character or NPC are deterministic
 * fallbacks for players.
 *
 * @returns {Actor|null}
 */
export function resolveHotbarActor() {
  const controlled = canvas?.tokens?.controlled ?? [];
  if (controlled.length > 1) return null;

  const selected = controlled[0]?.actor ?? null;
  if (selected?.isOwner && ["character", "npc"].includes(selected.type)) return selected;

  const assigned = game.user?.character ?? null;
  if (assigned?.isOwner && ["character", "npc"].includes(assigned.type)) return assigned;

  if (game.user?.isGM) return null;
  return game.actors?.find(actor => actor.isOwner && ["character", "npc"].includes(actor.type)) ?? null;
}

/**
 * Resolve the most useful active canvas token for an actor.
 *
 * @param {Actor|null|undefined} actor Actor document.
 * @returns {Token|null}
 */
export function resolveActorToken(actor) {
  if (!actor) return null;
  const controlled = canvas?.tokens?.controlled?.find(token => token.actor?.id === actor.id) ?? null;
  if (controlled) return controlled;
  if (actor.isToken && actor.token?.object) return actor.token.object;
  return actor.getActiveTokens?.(true, true)?.[0] ?? actor.getActiveTokens?.()?.[0] ?? null;
}

/**
 * Resolve an actor's combatant in the supplied combat.
 *
 * @param {Actor|null|undefined} actor Actor document.
 * @param {Combat|null|undefined} [combat=game.combat] Combat document.
 * @returns {Combatant|null}
 */
export function resolveActorCombatant(actor, combat = game.combat) {
  if (!actor || !combat) return null;
  const token = resolveActorToken(actor);
  if (token) {
    const combatant = AoVAdapter.getCombatantForToken(combat, token);
    if (combatant) return combatant;
  }
  return combat.combatants?.find(combatant => combatant.actor?.id === actor.id) ?? null;
}

/**
 * Whether a combat currently has the Skjaldborg workflow enabled.
 *
 * @param {Combat|null|undefined} combat Combat document.
 * @returns {boolean}
 */
export function isSkjaldborgCombatActive(combat) {
  return !!combat?.started && !!getCombatState(combat).enabled;
}

/**
 * Build localized quick-intent action descriptors.
 *
 * @returns {object[]}
 */
export function prepareIntentActions({ selectedCategory = null, otherText = "", includeWait = false, includeUtility = true } = {}) {
  const selected = selectedCategory ? normalizeIntentCategory(selectedCategory) : null;
  const customText = sanitizePreparedIntentText(otherText);
  const categories = Object.values(ACTION_CATEGORIES).filter(category => includeWait || category !== ACTION_CATEGORIES.WAIT);
  const actions = categories.map(category => {
    const name = game.i18n.localize(`AOV_SKJALDBORG.ActionCategories.${category}`);
    return {
      id: category,
      kind: "intent",
      icon: ACTION_ICONS[category] ?? ACTION_ICONS[ACTION_CATEGORIES.OTHER],
      name,
      tooltip: category === ACTION_CATEGORIES.OTHER && customText
        ? `${name}: ${customText}`
        : name,
      selected: selected === category
    };
  });
  if (includeUtility) {
    actions.push({
      id: UTILITY_ACTION_ID,
      kind: "utility",
      icon: ACTION_ICONS[UTILITY_ACTION_ID],
      name: game.i18n.localize("AOV_SKJALDBORG.ActionCategories.utility"),
      tooltip: game.i18n.localize("AOV_SKJALDBORG.Utility.Title"),
      selected: false
    });
  }
  return actions;
}

/**
 * Prompt for the public text attached to an Other intent declaration.
 *
 * @param {string} [currentText=""] Existing public text.
 * @returns {Promise<string|null>} Sanitized text, or null when dismissed.
 */
export async function promptOtherIntentText(currentText = "") {
  const themeClass = actionThemeClass();
  const content = await foundry.applications.handlebars.renderTemplate(
    "modules/aov-skjaldborg/templates/other-intent-dialog.hbs",
    { currentText: sanitizePreparedIntentText(currentText) }
  );

  const result = await foundry.applications.api.DialogV2.prompt({
    classes: ["aov-skjaldborg", "dialog", "skj-attack-roll-window", "skj-other-intent-dialog-window", themeClass],
    window: {
      title: game.i18n.localize("AOV_SKJALDBORG.IntentDialog.Title"),
      contentClasses: ["aov-skjaldborg", "skj-attack-roll-content", themeClass]
    },
    content,
    rejectClose: false,
    modal: true,
    ok: {
      label: game.i18n.localize("AOV_SKJALDBORG.IntentDialog.Save"),
      callback: (_event, button) => sanitizePreparedIntentText(button.form.elements.intentText?.value)
    }
  });
  return result === null ? null : sanitizePreparedIntentText(result);
}

/**
 * Determine the compact numeric score displayed on an item action.
 *
 * @param {Item} item AoV owned Item.
 * @returns {string}
 */
function itemScore(item) {
  const candidates = [
    item.system?.total,
    item.system?.effective,
    item.system?.mpCost,
    item.system?.dp
  ];
  for (const value of candidates) {
    const number = finiteNumber(value);
    if (number !== null) return String(number);
  }
  return "";
}

/**
 * Convert an owned AoV Item into a serializable action descriptor.
 *
 * @param {Item} item Owned Item document.
 * @param {string} group Hotbar group.
 * @returns {object}
 */
function itemAction(item, group) {
  return {
    id: item.id,
    uuid: item.uuid,
    kind: "item",
    group,
    name: item.name,
    img: item.img,
    itemType: item.type,
    category: String(item.system?.category ?? ""),
    score: itemScore(item),
    prepared: !!item.system?.prepared,
    canPrepare: ["runescript", "seidur"].includes(item.type),
    rollable: ROLLABLE_ITEM_TYPES.has(item.type),
    noXP: ["skill", "passion"].includes(item.type) && !!item.system?.noXP,
    xpCheck: ["skill", "passion"].includes(item.type) && !!item.system?.xpCheck
  };
}

/**
 * Read a persisted order for one action group.
 *
 * @param {Actor} actor Actor document.
 * @param {string} group Action group.
 * @returns {string[]}
 */
export function getPersistedActionOrder(actor, group) {
  const allOrders = actor?.getFlag?.(MODULE_ID, "actorHotbarOrder");
  const order = allOrders?.[group];
  return Array.isArray(order) ? order.filter(id => typeof id === "string") : [];
}

/**
 * Sort actions by actor flag order, with stable name fallback.
 *
 * @param {Actor} actor Actor document.
 * @param {string} group Action group.
 * @param {object[]} actions Action descriptors.
 * @returns {object[]}
 */
export function sortActorActions(actor, group, actions) {
  const order = getPersistedActionOrder(actor, group);
  const rank = new Map(order.map((id, index) => [id, index]));
  return [...actions].sort((a, b) => {
    const aRank = rank.has(a.id) ? rank.get(a.id) : Number.MAX_SAFE_INTEGER;
    const bRank = rank.has(b.id) ? rank.get(b.id) : Number.MAX_SAFE_INTEGER;
    return aRank - bRank || a.name.localeCompare(b.name, game.i18n.lang);
  });
}

/**
 * Build grouped actor actions for the ring and actor hotbar.
 *
 * @param {Actor|null|undefined} actor Actor document.
 * @returns {{weapons: object[], skills: object[], magic: object[], historyFamily: object[], ring: object[]}}
 */
export function prepareActorActions(actor) {
  if (!actor) return { weapons: [], skills: [], magic: [], historyFamily: [], ring: [] };
  const snapshot = actorItemSnapshot(actor);
  const weapons = snapshotItemsOfType(snapshot, "weapon")
    .filter(item => Number(item.system?.equipStatus) === 1)
    .map(item => itemAction(item, "combat"));
  const skills = snapshotItemsOfType(snapshot, "skill")
    .map(item => itemAction(item, "skills"));
  const magic = Array.from(MAGIC_ITEM_TYPES)
    .flatMap(type => snapshotItemsOfType(snapshot, type))
    .map(item => itemAction(item, "magic"));
  const historyFamily = Array.from(HISTORY_FAMILY_ACTION_TYPES)
    .flatMap(type => snapshotItemsOfType(snapshot, type))
    .map(item => itemAction(item, "historyFamily"));

  const sortedWeapons = sortActorActions(actor, "combat", weapons);
  const sortedSkills = sortActorActions(actor, "skills", skills);
  const sortedMagic = sortActorActions(actor, "magic", magic);
  const sortedHistoryFamily = sortActorActions(actor, "historyFamily", historyFamily);
  return {
    weapons: sortedWeapons,
    skills: sortedSkills,
    magic: sortedMagic,
    historyFamily: sortedHistoryFamily,
    ring: [...sortedWeapons, ...sortedSkills, ...sortedMagic, ...sortedHistoryFamily]
  };
}

/**
 * Build the actor-owned contents of the AoV character Equip and Combat tabs.
 *
 * Weapon descriptors mirror the compact fields presented by the AoV Combat
 * sheet. Gear and armour retain the editing controls already provided by this
 * module. Rendering remains read-only except for the explicit equipment-status
 * and gear-quantity document updates.
 *
 * @param {Actor|null|undefined} actor Actor document.
 * @returns {{id: string, label: string, isWeapon: boolean, isGear: boolean, isArmour: boolean, items: object[]}[]}
 */
export function prepareActorEquipment(actor) {
  if (!actor) return [];

  const groups = [];
  const snapshot = actorItemSnapshot(actor);
  const readiedWeaponIds = new Set(getReadiedWeaponList(actor).map(item => String(item.id)));
  const carriedEquipment = Array.from(EQUIPMENT_ITEM_TYPES)
    .flatMap(type => snapshotItemsOfType(snapshot, type))
    .filter(item => EQUIPMENT_ITEM_TYPES.has(item.type) && Number(item.system?.equipStatus) === 1);
  const computedEncumbrance = carriedEquipment.reduce((total, item) => {
    const quantity = item.type === "gear" ? Math.max(0, finiteNumber(item.system?.quantity) ?? 0) : 1;
    const actual = finiteNumber(item.system?.actlEnc);
    const base = finiteNumber(item.system?.enc) ?? 0;
    return total + (actual ?? (base * quantity));
  }, 0);
  const actualEncumbrance = Math.max(0, Math.floor(computedEncumbrance));
  const maximumEncumbrance = finiteNumber(actor.system?.maxEnc);
  const encumbrance = {
    actual: String(actualEncumbrance),
    maximum: maximumEncumbrance === null ? "" : String(Math.max(0, Math.floor(maximumEncumbrance))),
    label: maximumEncumbrance === null
      ? String(actualEncumbrance)
      : `${actualEncumbrance}/${Math.max(0, Math.floor(maximumEncumbrance))}`
  };

  const weapons = [...snapshotItemsOfType(snapshot, "weapon")]
    .sort((a, b) => a.name.localeCompare(b.name, game.i18n.lang))
    .map(item => {
      const status = equipmentStatus(item.system?.equipStatus);
      const damage = String(item.system?.damage ?? "");
      const damageBonusKey = String(item.system?.damMod ?? "");
      const damageBonus = String(item.system?.dbLabel ?? "").trim()
        || (damageBonusKey ? localizeOrFallback(`AOV.DamMod.${damageBonusKey}`, damageBonusKey) : "-");
      const currentHp = Math.max(0, finiteNumber(item.system?.currHP) ?? 0);
      const maximumHp = Math.max(0, finiteNumber(item.system?.maxHP) ?? 0);
      return {
        id: item.id,
        name: item.name,
        itemType: item.type,
        total: String(finiteNumber(item.system?.total) ?? 0),
        damage: `${damage || "-"}${item.system?.special ? "*" : ""}`,
        damageBonus,
        encumbrance: String(finiteNumber(item.system?.actlEnc ?? item.system?.enc) ?? 0),
        hitPointsCurrent: String(currentHp),
        hitPointsMaximum: String(maximumHp),
        range: String(item.system?.weaponType ?? "") === "missile"
          ? String(finiteNumber(item.system?.range) ?? 0)
          : "-",
        statusValue: status.value,
        statusLabel: status.label,
        statusIcon: status.icon,
        readied: readiedWeaponIds.has(String(item.id))
      };
    });
  const gear = [...snapshotItemsOfType(snapshot, "gear")]
    .sort((a, b) => a.name.localeCompare(b.name, game.i18n.lang))
    .map(item => {
      const status = equipmentStatus(item.system?.equipStatus);
      return {
        id: item.id,
        name: item.name,
        itemType: item.type,
        encumbrance: String(finiteNumber(item.system?.actlEnc ?? item.system?.enc) ?? 0),
        quantity: Math.max(0, Math.trunc(finiteNumber(item.system?.quantity) ?? 0)),
        statusValue: status.value,
        statusLabel: status.label,
        statusIcon: status.icon
      };
    });

  const armour = [...snapshotItemsOfType(snapshot, "armour")]
    .sort((a, b) => a.name.localeCompare(b.name, game.i18n.lang))
    .map(item => {
      const status = equipmentStatus(item.system?.equipStatus);
      const low = finiteNumber(item.system?.lowLoc);
      const high = finiteNumber(item.system?.highLoc);
      const location = low === null
        ? String(item.system?.coverage ?? "")
        : (high === null || high === low ? String(low) : `${low}-${high}`);
      return {
        id: item.id,
        name: item.name,
        itemType: item.type,
        location,
        armourPoints: String(finiteNumber(item.system?.map) ?? 0),
        encumbrance: String(finiteNumber(item.system?.actlEnc ?? item.system?.enc) ?? 0),
        moveQuietly: String(finiteNumber(item.system?.mqPenalty) ?? 0),
        statusValue: status.value,
        statusLabel: status.label,
        statusIcon: status.icon
      };
    });

  if (weapons.length) {
    groups.push({
      id: "weapon",
      label: localizeOrFallback("TYPES.Item.weapon", "Weapons"),
      isWeapon: true,
      isGear: false,
      isArmour: false,
      encumbrance,
      items: weapons
    });
  }
  if (gear.length) {
    groups.push({
      id: "gear",
      label: localizeOrFallback("TYPES.Item.gear", "Gear"),
      isWeapon: false,
      isGear: true,
      isArmour: false,
      encumbrance,
      items: gear
    });
  }
  if (armour.length) {
    groups.push({
      id: "armour",
      label: localizeOrFallback("TYPES.Item.armour", "Armour"),
      isWeapon: false,
      isGear: false,
      isArmour: true,
      encumbrance,
      items: armour
    });
  }
  return groups;
}


/**
 * Build the compact, read-only representation of the AoV character Stats tab.
 *
 * Characteristic, Status, and Reputation rows remain rollable. Their source
 * components are shown as informational columns so the hotbar mirrors the
 * system sheet without introducing a second editing workflow. Species,
 * Homeland, Social Rank, and Vaðmál are informational only.
 *
 * @param {Actor|null|undefined} actor Actor document.
 * @returns {{id: string, label: string, isCharacteristics?: boolean, isSocial?: boolean, isIdentity?: boolean, actions: object[], entries?: object[]}[]}
 */
export function prepareActorStats(actor) {
  if (!actor) return [];

  const characteristics = Object.entries(actor.system?.abilities ?? {})
    .map(([key, ability]) => {
      const total = finiteNumber(ability?.total);
      if (total === null) return null;
      return {
        id: `ability:${key}`,
        kind: "stat",
        name: String(ability?.label ?? key.toLocaleUpperCase(game.i18n.lang)),
        base: String(finiteNumber(ability?.value) ?? 0),
        age: String(finiteNumber(ability?.age) ?? 0),
        xp: String(finiteNumber(ability?.xp) ?? 0),
        effects: String(finiteNumber(ability?.effects) ?? 0),
        total: String(total),
        formula: String(ability?.formula ?? ""),
        range: `${finiteNumber(ability?.min) ?? 0}/${finiteNumber(ability?.max) ?? 0}`,
        score: String(total)
      };
    })
    .filter(Boolean);

  const social = [];
  for (const property of ["reputation", "status"]) {
    const data = actor.system?.[property] ?? {};
    const total = finiteNumber(data.total);
    if (total === null) continue;
    const localizationKey = property === "status" ? "AOV.status" : "AOV.reput";
    social.push({
      id: property,
      kind: "stat",
      name: localizeOrFallback(localizationKey, property),
      base: String(finiteNumber(data.base) ?? 0),
      history: property === "reputation" ? String(finiteNumber(data.history) ?? 0) : "-",
      xp: String(finiteNumber(data.xp) ?? 0),
      effects: String(finiteNumber(data.effects) ?? 0),
      total: `${total}%`,
      score: `${total}%`
    });
  }

  const system = actor.system ?? {};
  const species = String(system.speciesName ?? system.species ?? "").trim();
  const homeland = String(system.homeName ?? system.home ?? "").trim();
  const socialKey = String(system.social ?? "").trim();
  const identity = [
    {
      id: "species",
      name: localizeOrFallback("TYPES.Item.species", "Species"),
      value: species || "-",
      itemId: String(system.speciesID ?? "")
    },
    {
      id: "homeland",
      name: localizeOrFallback("TYPES.Item.homeland", "Homeland"),
      value: homeland || "-",
      itemId: String(system.homeID ?? "")
    },
    {
      id: "social",
      name: localizeOrFallback("AOV.social", "Social Rank"),
      value: socialKey ? localizeOrFallback(`AOV.${socialKey}`, socialKey) : "-"
    },
    {
      id: "vadmal",
      name: localizeOrFallback("AOV.vadmal", "Vaðmál"),
      value: String(finiteNumber(system.vadmal) ?? 0)
    }
  ];

  const groups = [];
  if (characteristics.length) {
    groups.push({
      id: "characteristics",
      label: localizeOrFallback("AOV.characteristics", game.i18n.localize("AOV_SKJALDBORG.ActorHotbar.Groups.Characteristics")),
      isCharacteristics: true,
      actions: characteristics
    });
  }
  if (social.length) {
    groups.push({
      id: "social",
      label: game.i18n.localize("AOV_SKJALDBORG.ActorHotbar.Groups.SocialStats"),
      isSocial: true,
      actions: social
    });
  }
  if (actor.type === "character") {
    groups.push({
      id: "identity",
      label: game.i18n.localize("AOV_SKJALDBORG.ActorHotbar.Groups.Identity"),
      isIdentity: true,
      actions: [],
      entries: identity
    });
  }
  return groups;
}

/**
 * Resolve the actor-backed quick-access slots shared by the portrait HUD and
 * token action ring. The persisted flag retains twelve entries so reducing the
 * visible count never deletes assignments which may become visible again.
 *
 * Before the actor has customized quick access, equipped weapons remain the
 * compatibility fallback used by earlier module releases.
 *
 * @param {Actor|null|undefined} actor Actor document.
 * @param {object} [options={}] Prepared source overrides.
 * @param {number} [options.count] Number of visible slots.
 * @param {ReturnType<prepareActorActions>} [options.prepared] Prepared item actions.
 * @param {ReturnType<prepareActorStats>} [options.statGroups] Prepared statistic groups.
 * @returns {{count: number, entries: ({kind: string, id: string}|null)[], slots: {index: number, entry: ({kind: string, id: string}|null), action: object|null}[]}}
 */
export function prepareActorQuickAccess(actor, {
  count = getQuickAccessCircleCount(),
  prepared = prepareActorActions(actor),
  statGroups = prepareActorStats(actor)
} = {}) {
  const limits = ACTION_UI_LIMITS.actionRingMaxItems;
  const requested = Number(count);
  const visibleCount = Math.min(
    limits.max,
    Math.max(limits.min, Number.isFinite(requested) ? Math.round(requested) : ACTION_UI_DEFAULTS.actionRingMaxItems)
  );

  if (!actor) {
    const entries = Array.from({ length: ACTOR_HOTBAR_QUICK_SLOT_CAPACITY }, () => null);
    return {
      count: visibleCount,
      entries,
      slots: entries.slice(0, visibleCount).map((entry, index) => ({ index, entry, action: null }))
    };
  }

  const stored = getActorQuickAccess(actor);
  const fallback = prepared.weapons.slice(0, ACTOR_HOTBAR_QUICK_SLOT_CAPACITY)
    .map(action => ({ kind: "item", id: action.id }));
  const entries = stored ?? Array.from(
    { length: ACTOR_HOTBAR_QUICK_SLOT_CAPACITY },
    (_, index) => fallback[index] ?? null
  );

  const itemActions = new Map([
    ...prepared.weapons,
    ...prepared.skills,
    ...prepared.magic,
    ...prepared.historyFamily
  ].map(action => [action.id, action]));
  const statActions = new Map(
    statGroups.flatMap(group => group.actions ?? []).map(action => [action.id, action])
  );
  const intentActions = new Map(prepareIntentActions().map(action => [action.id, action]));

  const resolveAction = entry => {
    if (!entry) return null;
    if (entry.kind === "item") {
      const known = itemActions.get(entry.id);
      if (known) return { ...known, kind: "item" };
      const item = actor.items?.get?.(entry.id) ?? Array.from(actor.items ?? []).find(candidate => candidate.id === entry.id);
      return item ? { ...itemAction(item, "quickAccess"), icon: "fa-solid fa-box" } : null;
    }
    if (entry.kind === "stat") {
      const stat = statActions.get(entry.id);
      return stat ? { ...stat, kind: "stat", icon: "fa-solid fa-chart-simple" } : null;
    }
    if (entry.kind === "intent") {
      const intent = intentActions.get(entry.id);
      return intent ? { ...intent, kind: "intent" } : null;
    }
    if (entry.kind === "macro") {
      const macro = game.macros?.get(entry.id) ?? null;
      return macro ? {
        id: macro.id,
        kind: "macro",
        name: macro.name,
        img: macro.img,
        icon: "fa-solid fa-scroll",
        score: ""
      } : null;
    }
    return null;
  };

  return {
    count: visibleCount,
    entries: entries.map(entry => entry ? { ...entry } : null),
    slots: entries.slice(0, visibleCount).map((entry, index) => ({
      index,
      entry: entry ? { ...entry } : null,
      action: resolveAction(entry)
    }))
  };
}

/**
 * Remove markup from a short informational description.
 *
 * @param {unknown} value Candidate HTML string.
 * @returns {string}
 */
function plainText(value) {
  return String(value ?? "")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Prepare the combined History and Family hotbar tab.
 *
 * The tab mirrors the actor sheet's History, Family, Thrall, Farm, Passion,
 * and Devotion data. History and family records are informational/openable;
 * Passion and Devotion items remain executable and quick-access compatible.
 * Farm and Thrall records are resolved from the character's authoritative farm
 * UUID list without copying or mutating their source documents.
 *
 * @param {Actor|null|undefined} actor Actor document.
 * @returns {Promise<object>}
 */
export async function prepareActorHistoryFamily(actor) {
  const empty = {
    actions: [],
    histories: [],
    families: [],
    thralls: [],
    farms: [],
    general: {
      hasContent: false,
      personal: []
    },
    dependents: 0,
    thrallCount: 0,
    hasContent: false,
    hasDisplayContent: false
  };
  if (!actor) return empty;

  const system = actor.system ?? {};
  const present = value => {
    const text = String(value ?? "").trim();
    return text || "-";
  };
  const personalityKey = String(system.persType ?? "");
  const genderKey = String(system.gender ?? "");
  const general = {
    hasContent: true,
    personal: [
      { id: "name", label: localizeOrFallback("AOV.name", "Name"), value: present(actor.name) },
      { id: "nickname", label: localizeOrFallback("AOV.nickname", "Nickname"), value: present(system.nickname) },
      { id: "meaning", label: localizeOrFallback("AOV.nameMeanAbbr", "Meaning"), value: present(system.nameMean) },
      {
        id: "personality",
        label: localizeOrFallback("AOV.persTypeAbbr", "Personality"),
        value: personalityKey ? localizeOrFallback(`AOV.Personality.${personalityKey}`, personalityKey) : "-"
      },
      { id: "spirit", label: localizeOrFallback("AOV.spiritAnAbbr", "Spirit"), value: present(system.spiritAn) },
      {
        id: "gender",
        label: localizeOrFallback("AOV.genderAbbr", "Gender"),
        value: genderKey ? localizeOrFallback(`AOV.${genderKey}`, genderKey) : "-"
      },
      { id: "born", label: localizeOrFallback("AOV.birthYearAbbr", "Born"), value: present(system.birthYear) },
      { id: "age", label: localizeOrFallback("AOV.ageAbbr", "Age"), value: present(system.age) },
      {
        id: "features",
        label: localizeOrFallback("AOV.distFeaturesAbbr", "Features"),
        value: present(system.distFeatures),
        wide: true
      }
    ]
  };

  const items = Array.from(actor.items ?? []);
  const passionItems = items.filter(item => item.type === "passion");
  const devotionItems = items.filter(item => item.type === "devotion");
  const passionById = new Map(passionItems.map(item => [item.id, item]));
  const devotionById = new Map(devotionItems.map(item => [item.id, item]));

  const passions = sortActorActions(actor, "historyFamily", passionItems
    .map(item => itemAction(item, "historyFamily")))
    .map(action => {
      const item = passionById.get(action.id);
      return {
        ...action,
        section: "passions",
        reorderable: true,
        noXP: !!item?.system?.noXP,
        xpCheck: !!item?.system?.xpCheck,
        augment: !!item?.system?.augment
      };
    });
  const devotions = sortActorActions(actor, "historyFamily", devotionItems
    .map(item => itemAction(item, "historyFamily")))
    .map(action => {
      const item = devotionById.get(action.id);
      return {
        ...action,
        section: "devotions",
        reorderable: true,
        ideals: String(item?.system?.ideals ?? "") || "-",
        devotionPoints: String(finiteNumber(item?.system?.dp) ?? 0)
      };
    });

  const histories = items
    .filter(item => item.type === "history")
    .map(item => ({
      id: item.id,
      name: item.name,
      year: String(finiteNumber(item.system?.year) ?? 0),
      description: plainText(item.system?.description),
      order: String(item.flags?.aov?.cidFlag?.id ?? "")
    }))
    .sort((a, b) => Number(b.year) - Number(a.year) || b.order.localeCompare(a.order) || a.name.localeCompare(b.name, game.i18n.lang));

  const families = items
    .filter(item => item.type === "family")
    .map(item => ({
      id: item.id,
      name: item.name,
      gender: localizeOrFallback(`AOV.${item.system?.gender}`, String(item.system?.gender ?? "-")),
      relationship: localizeOrFallback(`AOV.Relation.${item.system?.relationship}`, String(item.system?.relationship ?? "-")),
      dependent: !!item.system?.depend,
      born: String(finiteNumber(item.system?.born) ?? "-"),
      died: item.system?.died ? String(item.system.died) : "-"
    }))
    .sort((a, b) => a.name.localeCompare(b.name, game.i18n.lang));

  const farms = [];
  const thralls = [];
  const farmRefs = Array.isArray(actor.system?.farms) ? actor.system.farms : [];
  for (const reference of farmRefs) {
    const uuid = String(reference?.uuid ?? reference ?? "");
    if (!uuid) continue;
    let farm = null;
    try {
      farm = typeof globalThis.fromUuid === "function" ? await globalThis.fromUuid(uuid) : null;
    } catch (_exception) {
      farm = null;
    }

    if (!farm) {
      farms.push({ uuid, name: game.i18n.localize("AOV_SKJALDBORG.ActorHotbar.UnavailableDocument"), size: "-", type: "-", value: "-" });
      continue;
    }

    farms.push({
      uuid: farm.uuid,
      name: farm.name,
      size: String(farm.system?.size ?? "-"),
      type: localizeOrFallback(`AOV.Farm.${farm.system?.farmType}`, String(farm.system?.farmType ?? "-")),
      value: String(finiteNumber(farm.system?.value) ?? 0)
    });

    for (const thrall of Array.from(farm.items ?? []).filter(item => item.type === "thrall")) {
      thralls.push({
        uuid: thrall.uuid,
        name: thrall.name,
        gender: localizeOrFallback(`AOV.${thrall.system?.gender}`, String(thrall.system?.gender ?? "-")),
        farm: farm.name,
        born: String(finiteNumber(thrall.system?.born) ?? "-"),
        died: thrall.system?.died ? String(thrall.system.died) : "-",
        living: !thrall.system?.died
      });
    }
  }
  farms.sort((a, b) => a.name.localeCompare(b.name, game.i18n.lang));
  thralls.sort((a, b) => a.name.localeCompare(b.name, game.i18n.lang));

  const actionGroups = [];
  if (passions.length) {
    actionGroups.push({
      id: "passions",
      label: localizeOrFallback("TYPES.Item.passion", "Passions"),
      isPassions: true,
      isDevotions: false,
      actions: passions
    });
  }
  if (devotions.length) {
    actionGroups.push({
      id: "devotions",
      label: localizeOrFallback("TYPES.Item.devotion", "Devotions"),
      isPassions: false,
      isDevotions: true,
      actions: devotions
    });
  }

  const livingThralls = thralls.filter(thrall => thrall.living).length;
  const result = {
    actions: actionGroups,
    histories,
    families,
    thralls,
    farms,
    general,
    dependents: finiteNumber(actor.system?.dependents) ?? 0,
    thrallCount: livingThralls
  };
  result.hasContent = actionGroups.length > 0 || histories.length > 0 || families.length > 0 || thralls.length > 0 || farms.length > 0;
  result.hasDisplayContent = general.hasContent || result.hasContent;
  return result;
}

/**
 * Persist a deterministic action order for one actor hotbar group.
 *
 * @param {Actor} actor Actor document.
 * @param {string} group Group id.
 * @param {string[]} order Ordered action ids.
 * @returns {Promise<Actor>}
 */
export async function persistActionOrder(actor, group, order) {
  const current = foundry.utils.deepClone(actor.getFlag(MODULE_ID, "actorHotbarOrder") ?? {});
  current[group] = [...new Set(order.filter(id => typeof id === "string"))];
  return actor.setFlag(MODULE_ID, "actorHotbarOrder", current);
}

/**
 * Execute one actor-owned AoV item through the system document method.
 *
 * The click event is forwarded because the current AoV item workflow reads
 * modifier keys to choose opposed, augment, and dialog behavior.
 *
 * @param {Actor} actor Actor document.
 * @param {string} itemId Owned Item id.
 * @param {Event|null} [event=null] Originating interaction event.
 * @returns {Promise<unknown|null>}
 */
export async function executeActorItem(actor, itemId, event = null) {
  const item = actor?.items?.get(itemId) ?? null;
  if (!item) {
    ui.notifications.warn(game.i18n.localize("AOV_SKJALDBORG.Warnings.ItemUnavailable"));
    return null;
  }
  try {
    if (typeof item.roll === "function") return await item.roll(event ?? undefined);
    return item.sheet?.render?.({ force: true }) ?? null;
  } catch (exception) {
    error(`Failed to execute actor item ${item.uuid}.`, exception);
    ui.notifications.error(game.i18n.localize("AOV_SKJALDBORG.Warnings.ActionFailed"));
    return null;
  }
}


/**
 * Toggle the XP check on an actor-owned Skill or Passion Item.
 *
 * @param {Actor} actor Actor document.
 * @param {string} itemId Owned Item id.
 * @returns {Promise<unknown|null>}
 */
export async function toggleActorItemXpCheck(actor, itemId) {
  const item = actor?.items?.get(itemId) ?? null;
  if (!item || !["skill", "passion"].includes(item.type) || item.system?.noXP) return null;
  try {
    return await item.update({ "system.xpCheck": !item.system?.xpCheck });
  } catch (exception) {
    error(`Failed to toggle XP check for ${item.uuid}.`, exception);
    ui.notifications.error(game.i18n.localize("AOV_SKJALDBORG.Warnings.ActionFailed"));
    return null;
  }
}


/**
 * Execute a rollable AoV actor statistic through the system's own check router.
 *
 * The supplied AoV reference build does not expose characteristic checks on its public `game.aov` API.
 * The current system sheet routes these controls through AOVRollType, so this
 * adapter loads that exact system module lazily and forwards the originating
 * pointer event to preserve Shift, Alt, and Ctrl roll modifiers.
 *
 * @param {Actor} actor Actor document.
 * @param {string} statId `ability:<key>`, `status`, or `reputation`.
 * @param {Event|null} [event=null] Originating interaction event.
 * @returns {Promise<unknown|null>}
 */
export async function executeActorStat(actor, statId, event = null) {
  if (!actor || typeof statId !== "string") return null;

  const abilityPrefix = "ability:";
  const detail = statId.startsWith(abilityPrefix)
    ? { property: "ability", characteristic: statId.slice(abilityPrefix.length) }
    : (["status", "reputation"].includes(statId) ? { property: statId } : null);
  if (!detail || (detail.property === "ability" && !actor.system?.abilities?.[detail.characteristic])) {
    ui.notifications.warn(game.i18n.localize("AOV_SKJALDBORG.Warnings.StatUnavailable"));
    return null;
  }

  try {
    return await AoVAdapter.executeAovActorStatCheck(actor, detail, event);
  } catch (exception) {
    error(`Failed to execute actor statistic ${statId}.`, exception);
    ui.notifications.error(game.i18n.localize("AOV_SKJALDBORG.Warnings.ActionFailed"));
    return null;
  }
}

/**
 * Open an actor-owned AoV item's sheet.
 *
 * @param {Actor} actor Actor document.
 * @param {string} itemId Owned Item id.
 * @returns {Promise<unknown|null>}
 */
export async function openActorItem(actor, itemId) {
  const item = actor?.items?.get(itemId) ?? null;
  if (!item) return null;
  try {
    return await item.sheet?.render?.({ force: true }) ?? null;
  } catch (exception) {
    error(`Failed to open actor Item ${item.uuid}.`, exception);
    ui.notifications.error(game.i18n.localize("AOV_SKJALDBORG.Warnings.ActionFailed"));
    return null;
  }
}

/**
 * Cycle an owned weapon, gear, or armour Item through AoV equipStatus values 1-3.
 *
 * @param {Actor} actor Actor document.
 * @param {string} itemId Owned Item id.
 * @returns {Promise<unknown|null>}
 */
export async function cycleActorEquipmentStatus(actor, itemId) {
  const item = actor?.items?.get(itemId) ?? null;
  if (!item || !EQUIPMENT_ITEM_TYPES.has(item.type)) return null;

  const current = equipmentStatus(item.system?.equipStatus).value;
  const next = current >= 3 ? 1 : current + 1;
  try {
    const result = await actor.updateEmbeddedDocuments("Item", [{
      _id: item.id,
      "system.equipStatus": next
    }]);
    if (item.type === "weapon" && next !== 1) {
      const readied = getReadiedWeaponIds(actor);
      if (readied.right === item.id) await clearReadiedWeaponInHand(actor, "right");
      if (readied.left === item.id) await clearReadiedWeaponInHand(actor, "left");
    }
    return result;
  } catch (exception) {
    error(`Failed to update equipment status for ${item.uuid}.`, exception);
    ui.notifications.error(game.i18n.localize("AOV_SKJALDBORG.Warnings.ActionFailed"));
    return null;
  }
}

/**
 * Persist a non-negative integer quantity for an owned AoV gear Item.
 *
 * @param {Actor} actor Actor document.
 * @param {string} itemId Owned gear Item id.
 * @param {unknown} value Candidate quantity.
 * @returns {Promise<unknown|null>}
 */
export async function updateActorEquipmentQuantity(actor, itemId, value) {
  const item = actor?.items?.get(itemId) ?? null;
  if (!item || item.type !== "gear") return null;

  const number = finiteNumber(value);
  if (number === null) return null;
  const quantity = Math.max(0, Math.trunc(number));
  try {
    return await actor.updateEmbeddedDocuments("Item", [{
      _id: item.id,
      "system.quantity": quantity
    }]);
  } catch (exception) {
    error(`Failed to update equipment quantity for ${item.uuid}.`, exception);
    ui.notifications.error(game.i18n.localize("AOV_SKJALDBORG.Warnings.ActionFailed"));
    return null;
  }
}

/**
 * Persist current hit points for one owned AoV weapon Item.
 *
 * @param {Actor} actor Actor document.
 * @param {string} itemId Owned weapon Item id.
 * @param {unknown} value Candidate current HP value.
 * @returns {Promise<unknown|null>}
 */
export async function updateActorWeaponHitPoints(actor, itemId, value) {
  const item = actor?.items?.get(itemId) ?? null;
  if (!item || item.type !== "weapon") return null;

  const number = finiteNumber(value);
  if (number === null) return null;
  const maximum = Math.max(0, finiteNumber(item.system?.maxHP) ?? 0);
  const current = Math.min(maximum, Math.max(0, Math.trunc(number)));
  try {
    return await actor.updateEmbeddedDocuments("Item", [{
      _id: item.id,
      "system.currHP": current
    }]);
  } catch (exception) {
    error(`Failed to update weapon hit points for ${item.uuid}.`, exception);
    ui.notifications.error(game.i18n.localize("AOV_SKJALDBORG.Warnings.ActionFailed"));
    return null;
  }
}

/**
 * Execute a user hotbar macro by id.
 *
 * @param {string} macroId Macro id.
 * @returns {Promise<unknown|null>}
 */
export async function executeMacro(macroId) {
  const macro = game.macros?.get(macroId) ?? null;
  if (!macro) return null;
  try {
    return await macro.execute();
  } catch (exception) {
    error(`Failed to execute macro ${macroId}.`, exception);
    ui.notifications.error(game.i18n.localize("AOV_SKJALDBORG.Warnings.ActionFailed"));
    return null;
  }
}

/**
 * Determine whether one intent category is currently displayed for the actor or
 * combatant. Used by right-click intent indicators so a repeated right-click on
 * the same declaration clears the visible token marker instead of re-submitting
 * it.
 *
 * @param {Actor} actor Target Actor.
 * @param {Combatant|null} combatant Target Combatant when active.
 * @param {Combat|null} combat Target Combat when active.
 * @param {string} category Candidate action category.
 * @returns {boolean}
 */
export function isIntentCategoryDeclared(actor, combatant, combat, category) {
  const normalizedCategory = normalizeIntentCategory(category);
  const liveCombatant = resolveActorCombatant(actor, combat) ?? combatant ?? null;
  if (isSkjaldborgCombatActive(combat) && liveCombatant) {
    const intent = getCombatantState(liveCombatant).intent;
    return DISPLAYABLE_INTENT_STATUSES.has(intent?.status) && normalizeIntentCategory(intent?.actionCategory) === normalizedCategory;
  }
  const prepared = getActorPreparedIntent(actor);
  return !!prepared && normalizeIntentCategory(prepared.actionCategory) === normalizedCategory;
}

/**
 * Clear the current visual intent declaration from the actor or combatant.
 * This does not execute the action; it only removes the marker used by the
 * token intent visualizer.
 *
 * @param {Actor} actor Target Actor.
 * @param {Combatant|null} combatant Target Combatant when active.
 * @param {Combat|null} combat Target Combat when active.
 * @returns {Promise<unknown|null>}
 */
export async function clearIntentCategory(actor, combatant, combat) {
  if (!actor?.isOwner) {
    ui.notifications.warn(game.i18n.localize("AOV_SKJALDBORG.Warnings.NotOwner"));
    return null;
  }

  const liveCombatant = resolveActorCombatant(actor, combat) ?? combatant ?? null;
  if (isSkjaldborgCombatActive(combat) && liveCombatant) {
    if (!AoVAdapter.canUserControlCombatant(game.user, liveCombatant)) {
      ui.notifications.warn(game.i18n.localize("AOV_SKJALDBORG.Warnings.NotOwner"));
      return null;
    }
    const combatantState = getCombatantState(liveCombatant);
    const result = await requestGm("clearIntent", {
      combatId: combat.id,
      combatantId: liveCombatant.id,
      expectedCombatantUpdatedAt: combatantState.updatedAt
    });
    await clearActorPreparedIntent(actor);
    RenderCoordinator.invalidateCombatTracker("intent-clear");
    return result;
  }

  const result = await clearActorPreparedIntent(actor);
  RenderCoordinator.invalidateCombatTracker("prepared-intent-clear");
  return result;
}

/**
 * Toggle the visual intent declaration used by right-click intent controls.
 * Re-selecting the current intent clears it. Selecting a different intent only
 * commits the declaration and never runs Evade, Attack, Missile, or other
 * executable action automation.
 *
 * @param {Actor} actor Target Actor.
 * @param {Combatant|null} combatant Target Combatant when active.
 * @param {Combat|null} combat Target Combat when active.
 * @param {string} category Candidate action category.
 * @param {{publicText?: string, promptOther?: boolean}} [options={}] Toggle options.
 * @returns {Promise<unknown|null>}
 */
export async function toggleIntentCategory(actor, combatant, combat, category, { publicText = "", promptOther = false } = {}) {
  const normalizedCategory = normalizeIntentCategory(category);
  const liveCombatant = resolveActorCombatant(actor, combat) ?? combatant ?? null;
  if (isIntentCategoryDeclared(actor, liveCombatant, combat, normalizedCategory)) {
    return clearIntentCategory(actor, liveCombatant, combat);
  }

  let resolvedPublicText = publicText;
  if (normalizedCategory === ACTION_CATEGORIES.OTHER && promptOther) {
    const activeText = isSkjaldborgCombatActive(combat) && liveCombatant
      ? getCombatantState(liveCombatant).intent?.publicText
      : getActorPreparedIntent(actor)?.publicText;
    const entered = await promptOtherIntentText(activeText ?? "");
    if (entered === null) return null;
    resolvedPublicText = entered;
  }

  return commitIntentCategory(actor, liveCombatant, combat, normalizedCategory, { publicText: resolvedPublicText });
}

/**
 * Commit the Evade intent and mark the actor with the module-owned Evading
 * status effect. During enabled combat the status write is GM-authoritative;
 * outside combat it is applied directly to the owned Actor as a visual marker.
 *
 * @param {Actor} actor Target Actor.
 * @param {Combatant|null} combatant Target Combatant when active.
 * @param {Combat|null} combat Target Combat when active.
 * @param {{publicText?: string}} [options={}] Options.
 * @returns {Promise<object|null>} Combined result.
 */

export async function executeEvadeIntent(actor, combatant, combat, { publicText = "" } = {}) {
  if (!actor?.isOwner) {
    ui.notifications.warn(game.i18n.localize("AOV_SKJALDBORG.Warnings.NotOwner"));
    return null;
  }

  let evadeResult = null;
  const liveCombatant = resolveActorCombatant(actor, combat) ?? combatant ?? null;
  if (isSkjaldborgCombatActive(combat) && liveCombatant) {
    if (!AoVAdapter.canUserControlCombatant(game.user, liveCombatant)) {
      ui.notifications.warn(game.i18n.localize("AOV_SKJALDBORG.Warnings.NotOwner"));
      return null;
    }
    const combatantState = getCombatantState(liveCombatant);
    evadeResult = await requestGm("activateEvade", {
      combatId: combat.id,
      combatantId: liveCombatant.id,
      expectedCombatantUpdatedAt: combatantState.updatedAt
    });
  } else {
    evadeResult = await activateEvadingForActor(actor, { combat: null, combatant: liveCombatant });
  }

  const intentResult = await commitIntentCategory(actor, liveCombatant, combat, ACTION_CATEGORIES.DEFEND, { publicText });
  return { evade: evadeResult, intent: intentResult };
}

/**
 * Commit a quick intent category using the module's GM-authoritative socket.
 *
 * Before combat, the declaration is staged on the Actor. During active combat,
 * it is written through the existing GM-authoritative Combatant socket path.
 *
 * @param {Actor} actor Target Actor.
 * @param {Combatant|null} combatant Target Combatant when active.
 * @param {Combat|null} combat Target Combat when active.
 * @param {string} category Action category.
 * @returns {Promise<unknown|null>}
 */
export async function commitIntentCategory(actor, combatant, combat, category, { publicText = "" } = {}) {
  if (!actor?.isOwner) {
    ui.notifications.warn(game.i18n.localize("AOV_SKJALDBORG.Warnings.NotOwner"));
    return null;
  }

  const normalizedCategory = normalizeIntentCategory(category);
  const sanitizedPublicText = normalizedCategory === ACTION_CATEGORIES.OTHER
    ? sanitizePreparedIntentText(publicText)
    : "";
  if (!isSkjaldborgCombatActive(combat) || !combatant) {
    return setActorPreparedIntent(actor, normalizedCategory, sanitizedPublicText);
  }

  if (!AoVAdapter.canUserControlCombatant(game.user, combatant)) {
    ui.notifications.warn(game.i18n.localize("AOV_SKJALDBORG.Warnings.NotOwner"));
    return null;
  }

  const combatantState = getCombatantState(combatant);
  const intent = foundry.utils.deepClone(defaultCombatantState().intent);
  intent.status = INTENT_STATUS.COMMITTED;
  intent.actionCategory = normalizedCategory;
  intent.publicText = sanitizedPublicText;

  const key = [
    combat.id,
    combatant.id,
    normalizedCategory,
    sanitizedPublicText
  ].join(":");
  const pending = pendingIntentCommits.get(key);
  if (pending) {
    performanceDiagnostics.count("intent.commit.duplicateSuppressed", 1, {
      combatId: combat.id,
      combatantId: combatant.id,
      actionCategory: normalizedCategory
    });
    return pending;
  }

  const operation = (async () => {
    const result = await requestGm("submitIntent", {
      combatId: combat.id,
      combatantId: combatant.id,
      expectedCombatantUpdatedAt: combatantState.updatedAt,
      intent
    });
    await clearActorPreparedIntent(actor);
    RenderCoordinator.invalidateCombatTracker("intent-commit");
    return result;
  })().finally(() => {
    if (pendingIntentCommits.get(key) === operation) pendingIntentCommits.delete(key);
  });

  pendingIntentCommits.set(key, operation);
  return operation;
}

export const __test = {
  pendingIntentCommits
};
