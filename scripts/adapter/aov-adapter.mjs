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

/**
 * Thin adapter over the current AoV document surface.
 *
 * The module intentionally does not import private AoV source files. All reads
 * go through Foundry documents, flags, public globals, or stable CONFIG values
 * so a compatible AoV system can provide a replacement adapter with the same
 * semantic contract.
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
    return numberOr(actor?.system?.hp?.value, 1);
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
      const mp = actor.system?.mp ?? {};
      const maximum = Math.max(0, numberOr(mp.availMax ?? mp.max, 0));
      const target = this.#clampResourceValue(value, maximum);
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
    const current = numberOr(actor.system?.hp?.value, 0);
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
    const current = numberOr(actor.system?.hp?.value, 0);
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
   * @deprecated Temporary AoV 13.29 test bridge. Prefer TokenDocument movement
   * summaries during any later major-version migration.
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
