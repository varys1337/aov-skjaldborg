import { MODULE_ID, PHASES } from "../constants.mjs";

/**
 * Convert a possibly absent or textual value to a finite number.
 *
 * @param {unknown} value Candidate numeric value.
 * @param {number} [fallback=0] Value returned when conversion fails.
 * @returns {number}
 */
function numberOr(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

/**
 * Read a total or raw AoV ability value.
 *
 * @param {Actor|null|undefined} actor Foundry Actor document.
 * @param {string} ability AoV ability key such as `dex` or `int`.
 * @returns {number}
 */
function totalAbility(actor, ability) {
  const data = actor?.system?.abilities?.[ability];
  return numberOr(data?.total ?? data?.value, 0);
}

/**
 * Extract the first numeric movement value from an NPC movement string.
 *
 * @param {unknown} value Candidate NPC movement string.
 * @returns {number|undefined}
 */
function parseMovementText(value) {
  if (value === undefined || value === null) return undefined;
  const match = String(value).match(/-?\d+(\.\d+)?/);
  return match ? Number(match[0]) : undefined;
}

let aovCheckApiPromise = null;

/**
 * Load the AoV system's awaited check API from the installed system package.
 *
 * The current AoV release does not expose checks through `game.aov`. The actor
 * sheet's AOVRollType wrapper starts AOVCheck asynchronously without returning
 * that Promise, which is unsuitable for an ApplicationV2 action that needs to
 * await the complete dialog workflow and catch failures. The adapter therefore
 * calls the same core AOVCheck trigger directly while keeping the system import
 * isolated here. `getRoute` preserves installations which use a route prefix.
 *
 * @returns {Promise<{AOVCheck: Function, RollType: Function, CardType: Function}>}
 */
async function getAoVCheckApi() {
  if (!aovCheckApiPromise) {
    const path = "systems/aov/system/apps/checks.mjs";
    const route = foundry.utils.getRoute?.(path) ?? `/${path}`;
    aovCheckApiPromise = import(route)
      .then(module => {
        if (typeof module.AOVCheck?._trigger !== "function") {
          throw new Error("The Age of Vikings check workflow is unavailable.");
        }
        if (!module.RollType || !module.CardType) {
          throw new Error("The Age of Vikings roll constants are unavailable.");
        }
        return {
          AOVCheck: module.AOVCheck,
          RollType: module.RollType,
          CardType: module.CardType
        };
      })
      .catch(exception => {
        aovCheckApiPromise = null;
        throw exception;
      });
  }
  return aovCheckApiPromise;
}

/**
 * Preferred zero-based cells for the standard seven-location humanoid body map.
 *
 * AoV stores the same semantic locations on character and NPC Hit Location
 * Items, but NPC Items may retain the model default `gridPos` of 0. The d20
 * ranges therefore provide a stable fallback without depending on translated
 * Item names.
 *
 * @type {ReadonlyMap<string, number>}
 */
const STANDARD_HUMANOID_GRID_BY_RANGE = new Map([
  ["19:20", 1], // Head
  ["13:15", 3], // Right Arm
  ["12:12", 4], // Chest
  ["16:18", 5], // Left Arm
  ["9:11", 7], // Abdomen
  ["1:4", 9], // Right Leg
  ["5:8", 11] // Left Leg
]);

/**
 * Resolve a standard humanoid body-map position from a Hit Location's d20
 * range. Custom creatures simply return `null` and continue through the
 * configured-grid and free-cell fallbacks.
 *
 * @param {Item} location Owned AoV Hit Location Item.
 * @returns {number|null} Zero-based 3 × 4 grid position.
 */
function standardHumanoidGridPosition(location) {
  const low = Number(location?.system?.lowRoll);
  const high = Number(location?.system?.highRoll);
  if (!Number.isInteger(low) || !Number.isInteger(high)) return null;
  return STANDARD_HUMANOID_GRID_BY_RANGE.get(`${low}:${high}`) ?? null;
}

/**
 * Thin adapter over the current AoV document surface.
 *
 * Document reads go through Foundry documents, flags, public globals, and
 * stable CONFIG values. The only direct system-module integration is the
 * isolated check-workflow loader above, required because AoV does not expose
 * its roll dispatcher through `game.aov`.
 */
export class AoVAdapter {
  /**
   * Whether the world-level full combat setting is enabled.
   *
   * @returns {boolean}
   */
  static get enabledSetting() {
    return game.settings.get(MODULE_ID, "enabled");
  }

  /**
   * Confirm this module is running in an Age of Vikings world.
   *
   * @returns {boolean}
   */
  static isAoVWorld() {
    return game.system?.id === "aov";
  }

  /**
   * Derive the current AoV system phase from its existing two-stage round model.
   *
   * @param {Combat|null|undefined} combat Foundry Combat document.
   * @returns {"intent"|"resolution"}
   */
  static getSystemPhase(combat) {
    const round = Number(combat?.round ?? 0);
    if (round <= 0) return PHASES.INTENT;
    return (round % 2 === 1) ? PHASES.INTENT : PHASES.RESOLUTION;
  }

  /**
   * Convert the AoV system's raw staged round into a logical combat round.
   *
   * @param {Combat|null|undefined} combat Foundry Combat document.
   * @returns {number}
   */
  static getSystemLogicalRound(combat) {
    const round = Number(combat?.round ?? 0);
    return Math.max(1, Math.ceil(Math.max(round, 1) / 2));
  }

  /**
   * Read actor DEX.
   *
   * @param {Actor|null|undefined} actor Foundry Actor document.
   * @returns {number}
   */
  static getDex(actor) {
    return totalAbility(actor, "dex");
  }

  /**
   * Read actor INT.
   *
   * @param {Actor|null|undefined} actor Foundry Actor document.
   * @returns {number}
   */
  static getInt(actor) {
    return totalAbility(actor, "int");
  }

  /**
   * Read actor movement allowance from derived AoV data with NPC fallbacks.
   *
   * @param {Actor|null|undefined} actor Foundry Actor document.
   * @returns {number}
   */
  static getMov(actor) {
    const system = actor?.system;
    if (!system) return 0;
    if (Number.isFinite(Number(system.moveRate))) return Number(system.moveRate);
    const move = system.move;
    if (move) {
      const base = numberOr(move.base, 0);
      const bonus = numberOr(move.bonus, 0);
      const penalty = numberOr(move.penalty, 0);
      return Math.max(0, base + bonus + penalty);
    }
    const parsed = parseMovementText(system.movement);
    return parsed ?? 0;
  }

  /**
   * Read current actor hit points.
   *
   * @param {Actor|null|undefined} actor Foundry Actor document.
   * @returns {number}
   */
  static getHp(actor) {
    return this.prepareActorHitPoints(actor).value;
  }

  /**
   * Resolve the authoritative AoV Hit Point state from the same embedded
   * document sources used by the system Actor preparation workflow.
   *
   * Character HP is `system.hp.max` minus the damage on all owned Wound Items.
   * NPC HP is `system.hp.max` minus `system.npcDmg` on all owned Hit Location
   * Items. Recomputing here avoids a transient stale `system.hp.value` on the
   * synthetic Token Actor when an embedded damage document has just changed,
   * while remaining identical to the value rendered by the AoV actor sheet.
   *
   * @param {Actor|null|undefined} actor Age of Vikings Actor document.
   * @returns {{value: number, maximum: number, damage: number}}
   */
  static prepareActorHitPoints(actor) {
    const hp = actor?.system?.hp ?? {};
    const maximum = Math.max(0, numberOr(hp.max, 0));
    if (!actor || !["character", "npc"].includes(actor.type)) {
      const value = numberOr(hp.value, maximum);
      return { value, maximum, damage: Math.max(0, maximum - value) };
    }

    const items = Array.from(actor.items ?? []);
    const damage = actor.type === "character"
      ? items
        .filter(item => item.type === "wound")
        .reduce((total, item) => total + Math.max(0, numberOr(item.system?.damage, 0)), 0)
      : items
        .filter(item => item.type === "hitloc")
        .reduce((total, item) => total + Math.max(0, numberOr(item.system?.npcDmg, 0)), 0);

    return {
      value: maximum - damage,
      maximum,
      damage
    };
  }

  /**
   * Resolve the authoritative AoV Magic Point state from the actor's current
   * prepared Rune Script and Seiðr Spell Items.
   *
   * AoV derives `system.mp.availMax` during actor preparation. Item update hooks
   * can fire before consumers see that derived value refreshed, so the hotbar
   * recomputes it through the system Actor class' own cost functions. Exact
   * local fallbacks preserve compatibility with older AoV builds where those
   * static helpers are unavailable.
   *
   * @param {Actor|null|undefined} actor Age of Vikings Actor document.
   * @returns {Promise<{value: number, total: number, available: number, locked: number}>}
   */
  static async prepareActorMagicPoints(actor) {
    const mp = actor?.system?.mp ?? {};
    const total = Math.max(0, numberOr(mp.max, 0));
    let locked = 0;
    const actorClass = actor?.constructor;

    for (const item of Array.from(actor?.items ?? [])) {
      if (!item.system?.prepared) continue;

      if (item.type === "runescript") {
        let cost;
        if (typeof actorClass?.runeMPCost === "function") {
          cost = numberOr((await actorClass.runeMPCost(item))?.cost, 0);
        } else {
          const selectedRunes = Object.values(item.system?.runes ?? {})
            .filter(rune => !["", "none"].includes(String(rune ?? ""))).length;
          cost = selectedRunes * 2;
        }
        locked += Math.max(0, cost);
      } else if (item.type === "seidur") {
        let mpLocked;
        if (typeof actorClass?.seidurMPCost === "function") {
          mpLocked = numberOr((await actorClass.seidurMPCost(item))?.mpLocked, 0);
        } else {
          mpLocked = Math.max(
            numberOr(item.system?.dimension, 0),
            numberOr(item.system?.distance, 0),
            numberOr(item.system?.duration, 0)
          );
        }
        locked += Math.max(0, mpLocked);
      }
    }

    const available = Math.max(0, total - locked);
    return {
      value: Math.max(0, numberOr(mp.value, 0)),
      total,
      available,
      locked
    };
  }

  /**
   * Toggle an owned Rune Script or Seiðr Spell between prepared and unprepared.
   *
   * @param {Actor} actor Owning character Actor.
   * @param {string} itemId Owned Item id.
   * @returns {Promise<Item>}
   */
  static async toggleActorMagicPrepared(actor, itemId) {
    if (!actor?.isOwner) throw new Error("The current user does not own this actor.");
    const item = actor.items?.get(itemId);
    if (!item || !["runescript", "seidur"].includes(item.type)) {
      throw new Error("The selected magic Item cannot be prepared.");
    }
    await item.update({ "system.prepared": !item.system?.prepared });
    return item;
  }

  /**
   * Run an AoV weapon attack or damage check through the same system router
   * used by the core actor sheet.
   *
   * @param {Actor} actor Owning actor.
   * @param {string} weaponId Owned weapon Item id.
   * @param {Event|null} event Originating interaction event.
   * @param {"combat"|"damage"} property AoV check property.
   * @returns {Promise<unknown>}
   */
  static async rollActorWeapon(actor, weaponId, event, property = "combat") {
    if (!actor?.isOwner) throw new Error("The current user does not own this actor.");
    const weapon = actor.items?.get(weaponId);
    if (!weapon || weapon.type !== "weapon") throw new Error("The selected weapon is unavailable.");
    if (!['combat', 'damage'].includes(property)) throw new Error(`Unsupported weapon roll: ${property}`);

    const { AOVCheck, RollType, CardType } = await getAoVCheckApi();
    const modifierEvent = event ?? {};
    const isDamage = property === "damage";

    return AOVCheck._trigger({
      rollType: isDamage ? RollType.DAMAGE : RollType.WEAPON,
      cardType: isDamage ? CardType.UNOPPOSED : CardType.COMBAT,
      shiftKey: Boolean(modifierEvent.shiftKey),
      actor,
      token: actor.token ?? null,
      characteristic: false,
      skillId: weapon.id,
      itemId: weapon.id,
      origID: game.user?.id ?? game.user?._id
    });
  }

  /**
   * Prepare the public Age of Vikings wellbeing model used by the actor hotbar.
   *
   * Character damage is represented by owned Wound Items. NPC damage is stored
   * directly on owned Hit Location Items. This adapter normalizes both models
   * without importing either actor-sheet implementation.
   *
   * @param {Actor|null|undefined} actor Age of Vikings Actor document.
   * @returns {object} Serializable hit-location and active-wound view data.
   */
  static prepareActorWellbeing(actor) {
    const supported = !!actor && ["character", "npc"].includes(actor.type);
    if (!supported) {
      return {
        supported: false,
        canEdit: false,
        canCreateWounds: false,
        useBodyMap: false,
        hasHitLocations: false,
        hasActiveWounds: false,
        hitLocations: [],
        locationList: [],
        activeWounds: []
      };
    }

    const items = Array.from(actor.items ?? []);
    const allLocations = items.filter(item => item.type === "hitloc");
    const visibleLocations = allLocations.filter(item => item.system?.locType !== "general");
    const characterWounds = actor.type === "character"
      ? items.filter(item => item.type === "wound")
      : [];
    const locationById = new Map(allLocations.map(item => [item.id, item]));
    const damageByLocation = new Map();

    for (const wound of characterWounds) {
      const locationId = String(wound.system?.hitLocId ?? "");
      damageByLocation.set(
        locationId,
        numberOr(damageByLocation.get(locationId), 0) + Math.max(0, numberOr(wound.system?.damage, 0))
      );
    }

    const describeLocation = (item, gridPosition = null) => {
      const lowRoll = numberOr(item.system?.lowRoll, 0);
      const highRoll = numberOr(item.system?.highRoll, lowRoll);
      const rollLabel = lowRoll === highRoll ? String(lowRoll) : `${lowRoll}-${highRoll}`;
      const damage = actor.type === "npc"
        ? Math.max(0, numberOr(item.system?.npcDmg, 0))
        : Math.max(0, numberOr(damageByLocation.get(item.id), 0));
      const hpMax = Math.max(0, numberOr(item.system?.hpMax, 0));
      const hpCurrent = numberOr(item.system?.currHp, hpMax - damage);
      const ap = actor.type === "npc"
        ? numberOr(item.system?.npcAP, 0)
        : numberOr(item.system?.map, 0);
      const position = Number.isInteger(gridPosition) ? gridPosition : null;
      return {
        id: item.id,
        name: item.name,
        rollLabel,
        ap,
        hpCurrent,
        hpMax,
        damage,
        wounded: damage > 0,
        critical: hpMax > 0 && hpCurrent <= 0,
        gridPosition: position,
        gridStyle: position === null
          ? ""
          : `grid-column: ${(position % 3) + 1}; grid-row: ${Math.floor(position / 3) + 1};`
      };
    };

    // AoV v14 exposes gridPos to users as cells 1..12. Some NPC Hit Location
    // Items still carry the model default 0, while historical actors may hold
    // explicit zero-based values. Prefer configured positions when they are
    // meaningful, infer the standard humanoid arrangement from d20 ranges when
    // they are not, and only then fill remaining cells deterministically.
    const rawGridPositions = visibleLocations
      .map(location => Number(location.system?.gridPos))
      .filter(Number.isInteger);
    let zeroBasedEvidence = 0;
    let oneBasedEvidence = 0;
    for (const location of visibleLocations) {
      const rawPosition = Number(location.system?.gridPos);
      const standardPosition = standardHumanoidGridPosition(location);
      if (!Number.isInteger(rawPosition) || standardPosition === null) continue;
      if (rawPosition === standardPosition) zeroBasedEvidence += 1;
      if ((rawPosition - 1) === standardPosition) oneBasedEvidence += 1;
    }
    const gridPositionBase = rawGridPositions.includes(0)
      && !rawGridPositions.includes(12)
      && zeroBasedEvidence > oneBasedEvidence
      ? 0
      : 1;
    const normalizeGridPosition = location => {
      const rawPosition = Number(location.system?.gridPos);
      if (!Number.isInteger(rawPosition)) return null;
      if (gridPositionBase === 0) return rawPosition >= 0 && rawPosition <= 11 ? rawPosition : null;
      return rawPosition >= 1 && rawPosition <= 12 ? rawPosition - 1 : null;
    };

    const bodySlots = Array.from({ length: 12 }, () => null);
    const unresolved = [];
    const orderedForBody = [...visibleLocations].sort((a, b) => {
      const low = numberOr(a.system?.lowRoll, 0) - numberOr(b.system?.lowRoll, 0);
      if (low) return low;
      return String(a.name).localeCompare(String(b.name), game.i18n.lang);
    });

    // Respect explicit, non-colliding grid configuration first. This preserves
    // custom creature layouts and character-sheet arrangements.
    for (const location of orderedForBody) {
      const position = normalizeGridPosition(location);
      if (Number.isInteger(position) && !bodySlots[position]) bodySlots[position] = location;
      else unresolved.push(location);
    }

    // NPCs commonly retain gridPos=0 on every location. Their standard d20
    // ranges are enough to reproduce the character-sheet body-map layout.
    const deferred = [];
    for (const location of unresolved) {
      const position = standardHumanoidGridPosition(location);
      if (Number.isInteger(position) && !bodySlots[position]) bodySlots[position] = location;
      else deferred.push(location);
    }

    // Non-humanoid and partially configured locations remain usable rather than
    // disappearing: place them in the first free body-map cells in roll order.
    for (const location of deferred) {
      const position = bodySlots.findIndex(slot => !slot);
      if (position < 0) break;
      bodySlots[position] = location;
    }

    const hitLocations = bodySlots
      .map((item, position) => item ? describeLocation(item, position) : null)
      .filter(Boolean);
    const locationList = [...visibleLocations]
      .sort((a, b) => {
        const low = numberOr(a.system?.lowRoll, 0) - numberOr(b.system?.lowRoll, 0);
        if (low) return low;
        return String(a.name).localeCompare(String(b.name), game.i18n.lang);
      })
      .map(item => describeLocation(item));

    const activeWounds = actor.type === "character"
      ? characterWounds
        .map(item => {
          const location = locationById.get(item.system?.hitLocId) ?? null;
          return {
            id: item.id,
            name: item.name,
            locationName: location?.name ?? game.i18n.localize("AOV_SKJALDBORG.ActorHotbar.UnassignedLocation"),
            locationOrder: numberOr(location?.system?.lowRoll, 999),
            damage: Math.max(0, numberOr(item.system?.damage, 0)),
            treated: !!item.system?.treated,
            sourceType: "wound",
            isWound: true,
            canTreat: !!actor.isOwner,
            canDelete: !!actor.isOwner
          };
        })
        .filter(wound => wound.damage > 0)
        .sort((a, b) => a.locationOrder - b.locationOrder || String(a.name).localeCompare(String(b.name), game.i18n.lang))
      : allLocations
        .map(item => ({
          id: item.id,
          name: item.name,
          locationName: item.name,
          locationOrder: numberOr(item.system?.lowRoll, 999),
          damage: Math.max(0, numberOr(item.system?.npcDmg, 0)),
          treated: false,
          sourceType: "hitloc",
          isWound: false,
          canTreat: false,
          canDelete: !!actor.isOwner
        }))
        .filter(wound => wound.damage > 0)
        .sort((a, b) => a.locationOrder - b.locationOrder || String(a.name).localeCompare(String(b.name), game.i18n.lang));

    return {
      supported: true,
      actorType: actor.type,
      canEdit: !!actor.isOwner,
      canCreateWounds: !!actor.isOwner && (actor.type === "character" || visibleLocations.length > 0),
      useBodyMap: visibleLocations.length > 0 && visibleLocations.length <= 12,
      hasHitLocations: visibleLocations.length > 0,
      hasActiveWounds: activeWounds.length > 0,
      hitLocations,
      locationList,
      activeWounds
    };
  }

  /**
   * Create an owned Wound Item, optionally assigned to one hit location.
   *
   * @param {Actor} actor Character Actor document.
   * @param {string|null} [hitLocationId=null] Owned Hit Location Item id.
   * @returns {Promise<Item>} Created wound.
   */
  static async createActorWound(actor, hitLocationId = null) {
    if (!actor?.isOwner) throw new Error("The current user does not own this actor.");
    if (actor.type !== "character") throw new Error("Wound Items are only supported for character actors.");
    if (hitLocationId) {
      const location = actor.items?.get(hitLocationId);
      if (!location || location.type !== "hitloc") throw new Error("The selected hit location is unavailable.");
    }

    const itemClass = globalThis.getDocumentClass?.("Item") ?? globalThis.CONFIG?.Item?.documentClass;
    const localizedName = game.i18n.localize("TYPES.Item.wound");
    const name = itemClass?.defaultName?.({ type: "wound", parent: actor })
      ?? (localizedName === "TYPES.Item.wound" ? "Wound" : localizedName);
    const [wound] = await actor.createEmbeddedDocuments("Item", [{
      name,
      type: "wound",
      system: {
        ...(hitLocationId ? { hitLocId: hitLocationId } : {})
      }
    }]);
    if (!wound) throw new Error("Age of Vikings did not create the wound Item.");

    await this.#assignActorItemCid(wound);
    wound.sheet?.render?.(true);
    return wound;
  }

  /**
   * Persist character Wound damage or NPC Hit Location damage.
   *
   * @param {Actor} actor Actor document.
   * @param {string} itemId Owned Item id.
   * @param {unknown} value Submitted damage value.
   * @returns {Promise<Document[]>} Updated owned Item collection.
   */
  static async updateActorWellbeingDamage(actor, itemId, value) {
    if (!actor?.isOwner) throw new Error("The current user does not own this actor.");
    const item = actor.items?.get(itemId);
    if (!item) throw new Error("The wound or hit location is unavailable.");
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) throw new Error("Damage must be numeric.");
    const damage = Math.max(0, Math.round(numeric));

    let field;
    if (item.type === "wound" && actor.type === "character") field = "system.damage";
    else if (item.type === "hitloc" && actor.type === "npc") field = "system.npcDmg";
    else throw new Error("This Item does not provide editable wellbeing damage.");

    return actor.updateEmbeddedDocuments("Item", [{ _id: item.id, [field]: damage }]);
  }

  /**
   * Add damage to one NPC Hit Location. This is the NPC-system equivalent of
   * creating a character Wound Item and preserves AoV's native `npcDmg` model.
   *
   * @param {Actor} actor NPC Actor document.
   * @param {string} hitLocationId Owned Hit Location Item id.
   * @param {unknown} value Damage to add.
   * @returns {Promise<Document[]>} Updated owned Hit Location collection.
   */
  static async addActorNpcDamage(actor, hitLocationId, value) {
    if (!actor?.isOwner) throw new Error("The current user does not own this actor.");
    if (actor.type !== "npc") throw new Error("NPC damage can only be added to NPC actors.");
    const location = actor.items?.get(hitLocationId);
    if (!location || location.type !== "hitloc" || location.system?.locType === "general") {
      throw new Error("The selected NPC hit location is unavailable.");
    }
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) throw new Error("Damage must be numeric.");
    const addedDamage = Math.max(1, Math.round(numeric));
    const currentDamage = Math.max(0, numberOr(location.system?.npcDmg, 0));
    return actor.updateEmbeddedDocuments("Item", [{
      _id: location.id,
      "system.npcDmg": currentDamage + addedDamage
    }]);
  }

  /**
   * Toggle the treated state of one character Wound Item.
   *
   * @param {Actor} actor Character Actor document.
   * @param {string} woundId Owned Wound Item id.
   * @returns {Promise<Document[]>} Updated owned Item collection.
   */
  static async toggleActorWoundTreated(actor, woundId) {
    if (!actor?.isOwner) throw new Error("The current user does not own this actor.");
    const wound = actor.items?.get(woundId);
    if (!wound || wound.type !== "wound") throw new Error("The wound is unavailable.");
    return actor.updateEmbeddedDocuments("Item", [{
      _id: wound.id,
      "system.treated": !wound.system?.treated
    }]);
  }

  /**
   * Remove one active wound from the normalized HUD model. Character Wound
   * Items are deleted; NPC wounds are cleared by resetting the owning Hit
   * Location's native `npcDmg` value without deleting that location.
   *
   * @param {Actor} actor Character or NPC Actor document.
   * @param {string} woundId Owned Wound or Hit Location Item id.
   * @returns {Promise<Document[]>} Updated or deleted owned Item collection.
   */
  static async deleteActorWound(actor, woundId) {
    if (!actor?.isOwner) throw new Error("The current user does not own this actor.");
    const wound = actor.items?.get(woundId);
    if (!wound) throw new Error("The wound is unavailable.");
    if (actor.type === "character" && wound.type === "wound") {
      return actor.deleteEmbeddedDocuments("Item", [wound.id]);
    }
    if (actor.type === "npc" && wound.type === "hitloc") {
      return actor.updateEmbeddedDocuments("Item", [{ _id: wound.id, "system.npcDmg": 0 }]);
    }
    throw new Error("This Item does not provide removable wound data.");
  }

  /**
   * Mirror the AoV actor-sheet CID initialization for newly created Items.
   *
   * @param {Item} item Newly created actor-owned Item.
   * @returns {Promise<void>}
   */
  static async #assignActorItemCid(item) {
    let cidEnabled = false;
    try {
      cidEnabled = !!game.settings.get("aov", "actorItemCID");
    } catch (_exception) {
      return;
    }
    if (!cidEnabled || typeof game.aov?.cid?.guessId !== "function") return;
    const key = await game.aov.cid.guessId(item);
    await item.update({
      "flags.aov.cidFlag.id": key,
      "flags.aov.cidFlag.lang": game.i18n.lang,
      "flags.aov.cidFlag.priority": 0
    });
  }

  /**
   * Persist an editable actor resource from the selected-actor hotbar.
   *
   * Age of Vikings derives character HP from owned Wound Items and NPC HP
   * from owned Hit Location damage. Directly updating `system.hp.value` would
   * therefore be overwritten during actor preparation. This method reconciles
   * those authoritative embedded Items instead. MP is an actor data field and
   * is updated directly.
   *
   * @param {Actor} actor Owned Age of Vikings Actor.
   * @param {"hp"|"mp"} resource Resource identifier.
   * @param {unknown} value Submitted current value.
   * @returns {Promise<Actor|Document[]|null>} Completed document operation.
   */
  static async updateActorResource(actor, resource, value) {
    if (!actor?.isOwner) throw new Error("The current user does not own this actor.");
    if (!['character', 'npc'].includes(actor.type)) throw new Error("Unsupported actor type.");

    if (resource === "mp") {
      const magicPoints = await this.prepareActorMagicPoints(actor);
      const target = this.#clampResourceValue(value, magicPoints.available);
      return actor.update({ "system.mp.value": target });
    }

    if (resource !== "hp") throw new Error(`Unsupported resource: ${resource}`);
    const maximum = Math.max(0, numberOr(actor.system?.hp?.max, 0));
    const target = this.#clampResourceValue(value, maximum);
    if (actor.type === "character") return this.#updateCharacterHp(actor, target);
    return this.#updateNpcHp(actor, target);
  }

  /** @returns {number} */
  static #clampResourceValue(value, maximum) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) throw new Error("Resource value must be numeric.");
    return Math.min(maximum, Math.max(0, Math.round(numeric)));
  }

  /**
   * Reconcile character HP through owned Wound Items.
   *
   * @param {Actor} actor Character actor.
   * @param {number} target Desired HP value.
   * @returns {Promise<Actor|Document[]|null>} Completed document operation.
   */
  static async #updateCharacterHp(actor, target) {
    const current = this.prepareActorHitPoints(actor).value;
    if (target === current) return actor;

    const wounds = Array.from(actor.items ?? [])
      .filter(item => item.type === "wound" && numberOr(item.system?.damage, 0) > 0);

    if (target > current) {
      let remaining = target - current;
      const updates = [];
      const deletions = [];
      const ordered = [...wounds].sort((a, b) => {
        const damage = numberOr(a.system?.damage, 0) - numberOr(b.system?.damage, 0);
        return damage || String(a.id).localeCompare(String(b.id));
      });

      for (const wound of ordered) {
        if (remaining <= 0) break;
        const damage = numberOr(wound.system?.damage, 0);
        const healed = Math.min(damage, remaining);
        const nextDamage = damage - healed;
        remaining -= healed;
        if (nextDamage <= 0) deletions.push(wound.id);
        else updates.push({ _id: wound.id, "system.damage": nextDamage });
      }

      if (updates.length) await actor.updateEmbeddedDocuments("Item", updates);
      if (deletions.length) return actor.deleteEmbeddedDocuments("Item", deletions);
      return actor;
    }

    const addedDamage = current - target;
    const locations = Array.from(actor.items ?? [])
      .filter(item => item.type === "hitloc")
      .sort((a, b) => numberOr(a.sort, 0) - numberOr(b.sort, 0) || a.name.localeCompare(b.name, game.i18n.lang));
    const generalLocation = locations.find(item => item.system?.locType === "general") ?? null;
    const existing = generalLocation
      ? wounds.find(wound => wound.system?.hitLocId === generalLocation.id) ?? null
      : [...wounds].sort((a, b) => String(a.id).localeCompare(String(b.id)))[0] ?? null;
    if (existing) {
      const damage = numberOr(existing.system?.damage, 0) + addedDamage;
      return actor.updateEmbeddedDocuments("Item", [{ _id: existing.id, "system.damage": damage }]);
    }

    const targetLocation = generalLocation ?? locations[0] ?? null;
    if (!targetLocation) throw new Error("This actor has no hit location for a wound.");
    const localizedName = game.i18n.localize("TYPES.Item.wound");
    const name = localizedName === "TYPES.Item.wound" ? "Wound" : localizedName;
    return actor.createEmbeddedDocuments("Item", [{
      name,
      type: "wound",
      system: {
        damage: addedDamage,
        hitLocId: targetLocation.id
      }
    }]);
  }

  /**
   * Reconcile NPC HP through `system.npcDmg` on owned Hit Location Items.
   *
   * @param {Actor} actor NPC actor.
   * @param {number} target Desired HP value.
   * @returns {Promise<Actor|Document[]|null>} Completed document operation.
   */
  static async #updateNpcHp(actor, target) {
    const current = this.prepareActorHitPoints(actor).value;
    if (target === current) return actor;

    const locations = Array.from(actor.items ?? [])
      .filter(item => item.type === "hitloc")
      .sort((a, b) => numberOr(a.sort, 0) - numberOr(b.sort, 0) || a.name.localeCompare(b.name, game.i18n.lang));
    if (!locations.length) throw new Error("This actor has no hit location for damage.");

    if (target > current) {
      let remaining = target - current;
      const updates = [];
      const damaged = locations
        .filter(item => numberOr(item.system?.npcDmg, 0) > 0)
        .sort((a, b) => numberOr(b.system?.npcDmg, 0) - numberOr(a.system?.npcDmg, 0) || String(a.id).localeCompare(String(b.id)));
      for (const location of damaged) {
        if (remaining <= 0) break;
        const damage = numberOr(location.system?.npcDmg, 0);
        const healed = Math.min(damage, remaining);
        remaining -= healed;
        updates.push({ _id: location.id, "system.npcDmg": damage - healed });
      }
      if (!updates.length) return actor;
      return actor.updateEmbeddedDocuments("Item", updates);
    }

    const addedDamage = current - target;
    const location = locations.find(item => item.system?.locType === "general") ?? locations[0];
    return actor.updateEmbeddedDocuments("Item", [{
      _id: location.id,
      "system.npcDmg": numberOr(location.system?.npcDmg, 0) + addedDamage
    }]);
  }

  /**
   * Determine whether a combatant should be considered able to act.
   *
   * @param {Combatant|null|undefined} combatant Foundry Combatant document.
   * @returns {boolean}
   */
  static isCombatantCapable(combatant) {
    if (!combatant) return false;
    if (combatant.defeated || combatant.isDefeated) return false;
    const actor = combatant.actor;
    if (!actor) return false;
    const hp = this.getHp(actor);
    return hp > 0;
  }

  /**
   * Determine whether a user may submit module state for a combatant.
   *
   * @param {User|null|undefined} user Foundry User document.
   * @param {Combatant|null|undefined} combatant Foundry Combatant document.
   * @returns {boolean}
   */
  static canUserControlCombatant(user, combatant) {
    if (!user || !combatant) return false;
    if (user.isGM) return true;
    const token = combatant.token?.document ?? combatant.token ?? null;
    if (token?.testUserPermission?.(user, "OWNER")) return true;
    return combatant.actor?.testUserPermission?.(user, "OWNER") ?? false;
  }

  /**
   * Project AoV DEX and INT into the current AoV decimal initiative convention.
   *
   * @param {number} dex Final DEX rank.
   * @param {number} int INT tiebreaker.
   * @returns {number}
   */
  static projectInitiative(dex, int) {
    const safeDex = numberOr(dex, 0);
    const safeInt = Math.max(0, numberOr(int, 0));
    return Number((safeDex + (safeInt / 100)).toFixed(2));
  }

  /**
   * Resolve a combatant id within a combat.
   *
   * @param {Combat|null|undefined} combat Foundry Combat document.
   * @param {string} combatantId Combatant id.
   * @returns {Combatant|null}
   */
  static getCombatantById(combat, combatantId) {
    return combat?.combatants?.get(combatantId) ?? null;
  }

  /**
   * Resolve the combatant represented by a canvas token.
   *
   * @param {Combat|null|undefined} combat Foundry Combat document.
   * @param {Token|null|undefined} token Canvas token bound to the core Token HUD.
   * @returns {Combatant|null}
   */
  static getCombatantForToken(combat, token) {
    const tokenId = token?.id ?? token?.document?.id;
    if (!combat || !tokenId) return null;
    return combat.combatants?.find(combatant => {
      return combatant.tokenId === tokenId
        || combatant.token?.id === tokenId
        || combatant.token?.object?.id === tokenId;
    }) ?? null;
  }

  /**
   * Resolve a Combat by id, falling back to the active combat.
   *
   * @param {string|null|undefined} combatId Combat id.
   * @returns {Combat|null}
   */
  static getCombatById(combatId) {
    return game.combats?.get(combatId) ?? game.combat ?? null;
  }

  /**
   * Find the most relevant combatant for the current user selection.
   *
   * @param {Combat|null|undefined} [combat=game.combat] Combat document.
   * @returns {Combatant|null}
   */
  static getControlledCombatant(combat = game.combat) {
    if (!combat) return null;
    const controlled = canvas.tokens?.controlled ?? [];
    for (const token of controlled) {
      const combatant = combat.combatants.find(c => c.tokenId === token.id || c.token?.id === token.id);
      if (combatant) return combatant;
    }
    return combat.combatant ?? combat.turns?.find(c => this.canUserControlCombatant(game.user, c)) ?? null;
  }

  /**
   * Measure a waypoint list using scene grid scale.
   *
   * @deprecated Compatibility bridge retained until every movement call site is
   * migrated to v14 TokenDocument movement summaries.
   *
   * @param {{x: number, y: number}[]} waypoints Canvas-space points.
   * @returns {number}
   */
  static measureDistanceFromWaypoints(waypoints) {
    if (!Array.isArray(waypoints) || waypoints.length < 2) return 0;
    let total = 0;
    for (let i = 1; i < waypoints.length; i += 1) {
      const a = waypoints[i - 1];
      const b = waypoints[i];
      const dx = numberOr(b.x) - numberOr(a.x);
      const dy = numberOr(b.y) - numberOr(a.y);
      const pixels = Math.hypot(dx, dy);
      const gridSize = numberOr(canvas.scene?.grid?.size ?? canvas.grid?.size, 100) || 100;
      const gridDistance = numberOr(canvas.scene?.grid?.distance, 5) || 5;
      total += (pixels / gridSize) * gridDistance;
    }
    return Number(total.toFixed(2));
  }
}
