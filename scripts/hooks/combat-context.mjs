import { AoVAdapter } from "../adapter/aov-adapter.mjs";
import { PhaseController } from "../combat/phase-controller.mjs";
import { combatantFromTrackerContext } from "../compat/tracker-adapter.mjs";
import { debug } from "../logger.mjs";

let combatContextHooksRegistered = false;

/**
 * Resolve the target for the Set Current Turn context command and record the
 * reason it is hidden when debug logging is enabled.
 *
 * @param {Application|object} application Combat tracker application.
 * @param {HTMLElement|null|undefined} element Context-menu target element.
 * @returns {{combat: Combat|null, combatant: Combatant|null, reason: string|null}}
 */
function setCurrentTurnContext(application, element) {
  if (!game.user?.isGM) {
    debug("Set Current Turn context option hidden", { reason: "not-gm" });
    return { combat: null, combatant: null, reason: "not-gm" };
  }

  const context = combatantFromTrackerContext(application, element);
  if (context.reason) {
    debug("Set Current Turn context option hidden", {
      reason: context.reason,
      combatId: context.combat?.id ?? null,
      combatantId: context.combatantId ?? null
    });
  }
  return context;
}

/**
 * Add the Set Current Turn entry to a v14 CombatTracker row context menu.
 *
 * @param {Application|object} application Combat tracker application.
 * @param {object[]} menuItems Context menu entries.
 * @returns {void}
 */
function addSetCurrentTurnOption(application, menuItems) {
  if (!AoVAdapter.isAoVWorld()) return;
  if (!Array.isArray(menuItems)) return;
  if (menuItems.some(item => item?.aovSkjaldborgSetCurrentTurn === true)) return;

  menuItems.splice(Math.min(1, menuItems.length), 0, {
    aovSkjaldborgSetCurrentTurn: true,
    label: "AOV_SKJALDBORG.Controls.SetCurrentTurn",
    icon: "fa-solid fa-play",
    visible: element => {
      const { combatant } = setCurrentTurnContext(application, element);
      return !!combatant;
    },
    onClick: async (_event, element) => {
      const { combat, combatant } = setCurrentTurnContext(application, element);
      if (!combat || !combatant) return null;
      return PhaseController.setCurrentCombatant(combat, combatant.id);
    }
  });
}

/**
 * Add the GM-only Set Current Turn command to Foundry v14's Combat context menu.
 *
 * The module augments the AoV system tracker rather than replacing it.
 *
 * @returns {void}
 */
export function registerCombatContextHooks(hooks = globalThis.Hooks) {
  if (combatContextHooksRegistered) return;
  combatContextHooksRegistered = true;
  hooks.on("getAoVCombatTrackerContextOptions", addSetCurrentTurnOption);
  hooks.on("getCombatTrackerContextOptions", addSetCurrentTurnOption);
}
