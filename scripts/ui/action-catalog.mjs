import { ACTION_CATEGORIES, ACTION_UI_DEFAULTS, ACTION_UI_LIMITS, INTENT_STATUS, MODULE_ID } from "../constants.mjs";
import { AoVAdapter } from "../adapter/aov-adapter.mjs";
import { defaultCombatantState, getCombatState, getCombatantState } from "../combat/state.mjs";
import { requestGm } from "../socket.mjs";
import { error } from "../logger.mjs";
import { clearReadiedWeapon, getReadiedWeapon, getReadiedWeaponId } from "../combat/weapon-state.mjs";

const ROLLABLE_ITEM_TYPES = new Set(["weapon", "skill", "passion"]);
const MAGIC_ITEM_TYPES = new Set(["runescript", "seidur", "npcpower"]);
const HISTORY_FAMILY_ACTION_TYPES = new Set(["passion", "devotion"]);
const EQUIPMENT_ITEM_TYPES = new Set(["weapon", "gear", "armour"]);
export const ACTOR_HOTBAR_QUICK_SLOT_CAPACITY = ACTION_UI_LIMITS.actionRingMaxItems.max;
const QUICK_ACCESS_ACTION_KINDS = new Set(["item", "stat", "intent", "macro"]);

const EQUIPMENT_STATUS = Object.freeze({
  1: { key: "AOV.carried", icon: "fa-solid fa-hand-holding" },
  2: { key: "AOV.packed", icon: "fa-solid fa-horse" },
  3: { key: "AOV.stored", icon: "fa-solid fa-house" }
});

const ACTION_ICONS = Object.freeze({
  [ACTION_CATEGORIES.ATTACK]: "fa-solid fa-swords",
  [ACTION_CATEGORIES.MISSILE]: "fa-solid fa-crosshairs",
  [ACTION_CATEGORIES.MAGIC]: "fa-solid fa-wand-magic-sparkles",
  [ACTION_CATEGORIES.DEFEND]: "fa-solid fa-shield-halved",
  [ACTION_CATEGORIES.RETREAT]: "fa-solid fa-person-walking-arrow-right",
  [ACTION_CATEGORIES.KNOCKBACK]: "fa-solid fa-people-arrows-left-right",
  [ACTION_CATEGORIES.FLEE]: "fa-solid fa-person-running",
  [ACTION_CATEGORIES.WAIT]: "fa-solid fa-hand",
  [ACTION_CATEGORIES.DELAY]: "fa-solid fa-clock",
  [ACTION_CATEGORIES.OTHER]: "fa-solid fa-ellipsis"
});

/**
 * Convert a candidate value to a finite number when possible.
 *
 * @param {unknown} value Candidate value.
 * @returns {number|null}
 */
function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/**
 * Resolve a localized string while preserving a deterministic fallback.
 *
 * @param {string} key Localization key.
 * @param {string} fallback Fallback label.
 * @returns {string}
 */
function localizeOrFallback(key, fallback) {
  const localized = game.i18n.localize(key);
  return localized === key ? fallback : localized;
}

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



/**
 * Normalize one persisted actor-hotbar quick-access entry.
 *
 * @param {unknown} value Candidate entry.
 * @returns {{kind: string, id: string}|null}
 */
function normalizeQuickAccessEntry(value) {
  if (!value || typeof value !== "object") return null;
  const kind = String(value.kind ?? "");
  const id = String(value.id ?? "");
  if (!QUICK_ACCESS_ACTION_KINDS.has(kind) || !id) return null;
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
  return !!combat && !!getCombatState(combat).enabled;
}

/**
 * Build localized quick-intent action descriptors.
 *
 * @returns {object[]}
 */
export function prepareIntentActions() {
  return Object.values(ACTION_CATEGORIES).map(category => ({
    id: category,
    kind: "intent",
    icon: ACTION_ICONS[category] ?? ACTION_ICONS[ACTION_CATEGORIES.OTHER],
    name: game.i18n.localize(`AOV_SKJADLBORG.ActionCategories.${category}`),
    requiresDetails: [ACTION_CATEGORIES.WAIT, ACTION_CATEGORIES.DELAY].includes(category)
  }));
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
  const items = Array.from(actor.items ?? []);
  const weapons = items
    .filter(item => item.type === "weapon" && Number(item.system?.equipStatus) === 1)
    .map(item => itemAction(item, "combat"));
  const skills = items
    .filter(item => item.type === "skill")
    .map(item => itemAction(item, "skills"));
  const magic = items
    .filter(item => MAGIC_ITEM_TYPES.has(item.type))
    .map(item => itemAction(item, "magic"));
  const historyFamily = items
    .filter(item => HISTORY_FAMILY_ACTION_TYPES.has(item.type))
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
  const items = Array.from(actor.items ?? []);
  const readiedWeaponId = getReadiedWeapon(actor)?.id ?? null;
  const weapons = items
    .filter(item => item.type === "weapon")
    .sort((a, b) => a.name.localeCompare(b.name, game.i18n.lang))
    .map(item => {
      const status = equipmentStatus(item.system?.equipStatus);
      const damage = String(item.system?.damage ?? "");
      const damageBonusKey = String(item.system?.damMod ?? "");
      const damageBonus = String(item.system?.dbLabel ?? "").trim()
        || (damageBonusKey ? localizeOrFallback(`AOV.DamMod.${damageBonusKey}`, damageBonusKey) : "-");
      const currentHp = finiteNumber(item.system?.currHP);
      const maximumHp = finiteNumber(item.system?.maxHP);
      return {
        id: item.id,
        name: item.name,
        itemType: item.type,
        total: String(finiteNumber(item.system?.total) ?? 0),
        damage: `${damage || "-"}${item.system?.special ? "*" : ""}`,
        damageBonus,
        encumbrance: String(finiteNumber(item.system?.actlEnc ?? item.system?.enc) ?? 0),
        hitPoints: `${currentHp ?? 0}/${maximumHp ?? 0}`,
        range: String(item.system?.weaponType ?? "") === "missile"
          ? String(finiteNumber(item.system?.range) ?? 0)
          : "-",
        statusValue: status.value,
        statusLabel: status.label,
        statusIcon: status.icon,
        readied: item.id === readiedWeaponId
      };
    });
  const gear = items
    .filter(item => item.type === "gear")
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

  const armour = items
    .filter(item => item.type === "armour")
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
      label: localizeOrFallback("AOV.characteristics", game.i18n.localize("AOV_SKJADLBORG.ActorHotbar.Groups.Characteristics")),
      isCharacteristics: true,
      actions: characteristics
    });
  }
  if (social.length) {
    groups.push({
      id: "social",
      label: game.i18n.localize("AOV_SKJADLBORG.ActorHotbar.Groups.SocialStats"),
      isSocial: true,
      actions: social
    });
  }
  if (actor.type === "character") {
    groups.push({
      id: "identity",
      label: game.i18n.localize("AOV_SKJADLBORG.ActorHotbar.Groups.Identity"),
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
    dependents: 0,
    thrallCount: 0,
    hasContent: false
  };
  if (!actor) return empty;

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
      farms.push({ uuid, name: game.i18n.localize("AOV_SKJADLBORG.ActorHotbar.UnavailableDocument"), size: "-", type: "-", value: "-" });
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
    dependents: finiteNumber(actor.system?.dependents) ?? 0,
    thrallCount: livingThralls
  };
  result.hasContent = actionGroups.length > 0 || histories.length > 0 || families.length > 0 || thralls.length > 0 || farms.length > 0;
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
    ui.notifications.warn(game.i18n.localize("AOV_SKJADLBORG.Warnings.ItemUnavailable"));
    return null;
  }
  try {
    if (typeof item.roll === "function") return await item.roll(event ?? undefined);
    return item.sheet?.render?.(true) ?? null;
  } catch (exception) {
    error(`Failed to execute actor item ${item.uuid}.`, exception);
    ui.notifications.error(game.i18n.localize("AOV_SKJADLBORG.Warnings.ActionFailed"));
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
    ui.notifications.error(game.i18n.localize("AOV_SKJADLBORG.Warnings.ActionFailed"));
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
    ui.notifications.warn(game.i18n.localize("AOV_SKJADLBORG.Warnings.StatUnavailable"));
    return null;
  }

  try {
    const { AOVRollType } = await import("/systems/aov/system/apps/roll-types.mjs");
    if (typeof AOVRollType?._onDetermineCheck !== "function") {
      throw new Error("AoV statistic roll router is unavailable.");
    }
    return await AOVRollType._onDetermineCheck(event ?? {}, detail, actor);
  } catch (exception) {
    error(`Failed to execute actor statistic ${statId}.`, exception);
    ui.notifications.error(game.i18n.localize("AOV_SKJADLBORG.Warnings.ActionFailed"));
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
  return item.sheet?.render?.(true) ?? null;
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
    if (item.type === "weapon" && next !== 1 && getReadiedWeaponId(actor) === item.id) {
      await clearReadiedWeapon(actor);
    }
    return result;
  } catch (exception) {
    error(`Failed to update equipment status for ${item.uuid}.`, exception);
    ui.notifications.error(game.i18n.localize("AOV_SKJADLBORG.Warnings.ActionFailed"));
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
    ui.notifications.error(game.i18n.localize("AOV_SKJADLBORG.Warnings.ActionFailed"));
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
    ui.notifications.error(game.i18n.localize("AOV_SKJADLBORG.Warnings.ActionFailed"));
    return null;
  }
}

/**
 * Commit a quick intent category using the module's GM-authoritative socket.
 *
 * Wait and Delay are intentionally excluded because both require additional
 * declaration data. Callers must open the detailed combat HUD for them.
 *
 * @param {Combatant} combatant Target combatant.
 * @param {Combat} combat Target combat.
 * @param {string} category Action category.
 * @returns {Promise<unknown|null>}
 */
export async function commitIntentCategory(combatant, combat, category) {
  if (!combatant || !combat || !Object.values(ACTION_CATEGORIES).includes(category)) return null;
  if ([ACTION_CATEGORIES.WAIT, ACTION_CATEGORIES.DELAY].includes(category)) return null;
  if (!AoVAdapter.canUserControlCombatant(game.user, combatant)) {
    ui.notifications.warn(game.i18n.localize("AOV_SKJADLBORG.Warnings.NotOwner"));
    return null;
  }

  const combatantState = getCombatantState(combatant);
  const intent = foundry.utils.deepClone(defaultCombatantState().intent);
  intent.status = INTENT_STATUS.COMMITTED;
  intent.actionCategory = category;

  const result = await requestGm("submitIntent", {
    combatId: combat.id,
    combatantId: combatant.id,
    expectedCombatantUpdatedAt: combatantState.updatedAt,
    intent
  });
  ui.combat?.render?.();
  return result;
}
