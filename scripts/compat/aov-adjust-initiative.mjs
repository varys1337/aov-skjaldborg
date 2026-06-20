import { MODULE_ID } from "../constants.mjs";
import { debug, error } from "../logger.mjs";
import { requestGm } from "../socket.mjs";
import { prepareReadiedWeaponState } from "../combat/weapon-state.mjs";

const DISMISS_GUARD_MARKER = Symbol.for(`${MODULE_ID}.aovAdjustInitiativeDismissGuard`);
const WEAPON_PATCH_MARKER = Symbol.for(`${MODULE_ID}.aovAdjustInitiativeWeaponIntegration`);

/**
 * Describe the current AoV tracker integration state without mutating the
 * tracker class.
 *
 * @returns {{hasTrackerClass: boolean, hasAdjustInit: boolean, hasAdjDex: boolean, weaponPatchInstalled: boolean, dismissGuardInstalled: boolean, status: string}}
 */
export function getAdjustInitiativeIntegrationStatus() {
  const trackerClass = CONFIG?.ui?.combat;
  const adjustInit = trackerClass?.prototype?.adjustInit;
  const adjDex = trackerClass?.adjDex;
  const hasTrackerClass = typeof trackerClass === "function";
  const hasAdjustInit = typeof adjustInit === "function";
  const hasAdjDex = typeof adjDex === "function";
  const weaponPatchInstalled = !!adjustInit?.[WEAPON_PATCH_MARKER];
  const dismissGuardInstalled = !!adjDex?.[DISMISS_GUARD_MARKER];
  let status = "ready";
  if (!hasTrackerClass) status = "tracker-class-unavailable";
  else if (!hasAdjustInit) status = "adjust-init-unavailable";
  else if (!hasAdjDex) status = "adj-dex-unavailable";
  else if (weaponPatchInstalled && dismissGuardInstalled) status = "patched";
  else if (weaponPatchInstalled) status = "weapon-patched";
  else if (dismissGuardInstalled) status = "dismiss-guarded";
  return {
    hasTrackerClass,
    hasAdjustInit,
    hasAdjDex,
    weaponPatchInstalled,
    dismissGuardInstalled,
    status
  };
}

/**
 * Determine whether an error is the known AoV Adjust Initiative dismissal bug.
 *
 * @param {unknown} exception Candidate error.
 * @returns {boolean}
 */
export function isDismissedAdjustInitiativeError(exception) {
  if (!(exception instanceof TypeError)) return false;
  const message = String(exception.message ?? "");
  const stack = String(exception.stack ?? "");
  return message.includes("adjOther")
    && /null/i.test(message)
    && stack.includes("AoVCombatTracker.adjDex");
}

/**
 * Retained narrow guard for installations where the richer integration cannot
 * be installed. The wrapper only converts AoV's close-without-submit error into
 * a zero adjustment and does not suppress unrelated failures.
 *
 * @returns {boolean}
 */
export function installAdjustInitiativeDismissGuard() {
  const trackerClass = CONFIG?.ui?.combat;
  const original = trackerClass?.adjDex;
  if (typeof original !== "function") return false;
  if (original[DISMISS_GUARD_MARKER]) return true;

  const guardedAdjDex = async function(...args) {
    try {
      return await original.apply(this, args);
    } catch (exception) {
      if (!isDismissedAdjustInitiativeError(exception)) throw exception;
      debug("Ignored a dismissed AoV Adjust Initiative dialog.");
      return 0;
    }
  };

  Object.defineProperty(guardedAdjDex, DISMISS_GUARD_MARKER, {
    value: true,
    enumerable: false,
    configurable: false,
    writable: false
  });

  trackerClass.adjDex = guardedAdjDex;
  return true;
}

/**
 * Convert a DialogV2 input result into a finite adjustment amount while
 * preserving AoV's original action values.
 *
 * @param {object} result Dialog result.
 * @param {number} initiative Current initiative.
 * @returns {number|null}
 */
export function adjustmentAmount(result, initiative) {
  if (!result) return null;
  const other = Number(result.adjOther);
  if (Number.isFinite(other) && other !== 0) return other;
  switch (String(result.action ?? "")) {
    case "draw":
    case "sheath":
    case "surprised":
      return 5;
    case "move":
      return Number.isFinite(Number(initiative)) ? Number(initiative) : 0;
    default:
      return 0;
  }
}

/**
 * Present the AoV Adjust Initiative workflow with a carried-weapon selector.
 *
 * @param {Combatant} combatant Target combatant.
 * @returns {Promise<{amount: number, action: string, weaponId: string|null}|null>}
 */
export async function promptAdjustInitiative(combatant) {
  const actor = combatant?.actor;
  if (!actor) return null;

  const weaponState = prepareReadiedWeaponState(actor);
  const cardLabel = `${game.i18n.localize("AOV.Combat.combatant")}: ${combatant.name} [${combatant.initiative}]`;
  const content = await foundry.applications.handlebars.renderTemplate(
    "modules/aov-skjaldborg/templates/adjust-initiative-weapon.hbs",
    {
      cardLabel,
      weaponState,
      defaultAction: weaponState.canDraw ? "draw" : "sheath"
    }
  );

  const result = await foundry.applications.api.DialogV2.input({
    classes: ["aov", "item", "aov-skjaldborg", "skj-weapon-adjust-dialog"],
    window: { title: game.i18n.localize("AOV.Combat.adjInit") },
    content,
    rejectClose: false,
    ok: {
      label: game.i18n.localize("AOV.confirm")
    }
  });
  if (!result) return null;

  const action = String(result.action ?? "");
  const weaponId = action === "draw" ? String(result.weaponId ?? "") : null;
  if (action === "draw" && !weaponId) {
    ui.notifications.warn(game.i18n.localize("AOV_SKJALDBORG.Warnings.SelectCarriedWeapon"));
    return null;
  }

  return {
    amount: adjustmentAmount(result, combatant.initiative) ?? 0,
    action,
    weaponId
  };
}

/**
 * Replace AoV's tracker click handler with a module-compatible extension.
 *
 * The system remains authoritative for the tracker surface. This patch changes
 * only the click workflow so Draw Weapon can choose and persist one carried
 * weapon, Sheathe Weapon clears it, and all initiative writes use the module's
 * existing GM-authoritative socket validation.
 *
 * @returns {boolean} Whether the expected tracker method was found.
 */
export function installAdjustInitiativeWeaponIntegration() {
  const trackerClass = CONFIG?.ui?.combat;
  const original = trackerClass?.prototype?.adjustInit;
  if (typeof original !== "function") return false;
  if (original[WEAPON_PATCH_MARKER]) return true;

  const integratedAdjustInit = async function(event) {
    const row = event?.currentTarget?.closest?.("[data-combatant-id]")
      ?? event?.target?.closest?.("[data-combatant-id]");
    const combatantId = row?.dataset?.combatantId;
    const combatant = this.viewed?.combatants?.get?.(combatantId) ?? null;
    if (!combatant) return null;

    try {
      const selection = await promptAdjustInitiative(combatant);
      if (!selection) return null;
      return requestGm("adjustInitiative", {
        combatId: combatant.parent?.id ?? this.viewed?.id ?? game.combat?.id,
        combatantId: combatant.id,
        amount: selection.amount,
        weaponAction: selection.action === "draw"
          ? "draw"
          : selection.action === "sheath"
            ? "sheathe"
            : "none",
        weaponId: selection.weaponId
      });
    } catch (exception) {
      error("Failed to adjust AoV initiative with weapon automation.", exception);
      ui.notifications.error(game.i18n.localize("AOV_SKJALDBORG.Warnings.ActionFailed"));
      return null;
    }
  };

  Object.defineProperty(integratedAdjustInit, WEAPON_PATCH_MARKER, {
    value: true,
    enumerable: false,
    configurable: false,
    writable: false
  });
  Object.defineProperty(integratedAdjustInit, "original", {
    value: original,
    enumerable: false,
    configurable: false,
    writable: false
  });

  trackerClass.prototype.adjustInit = integratedAdjustInit;
  return true;
}
