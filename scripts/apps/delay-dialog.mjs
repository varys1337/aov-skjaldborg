import { ACTION_CATEGORIES } from "../constants.mjs";
import { AoVAdapter } from "../adapter/aov-adapter.mjs";
import { getCombatantState } from "../combat/state.mjs";
import { requestGm } from "../socket.mjs";
import { RenderCoordinator } from "../ui/render-coordinator.mjs";
import { error } from "../logger.mjs";
import { actionThemeClass } from "../ui/dom-utils.mjs";
import { numberOr } from "../utils/document-data.mjs";

const { DialogV2 } = foundry.applications.api;

/**
 * Resolve the combatant's current DEX rank for the dialog default.
 *
 * @param {Combatant|null|undefined} combatant Active combatant.
 * @returns {number}
 */
function currentDexRank(combatant) {
  const initiative = numberOr(combatant?.initiative, null);
  if (initiative !== null) return Math.max(1, Math.trunc(initiative));
  return Math.max(1, AoVAdapter.getDex(combatant?.actor));
}

export class DelayDialog {
  /**
   * Open the RAW Delay dialog and submit the selected delay through the GM.
   *
   * Delay writes are routed through `requestGm` even for owners so one
   * authoritative client performs Combatant initiative and module-state
   * updates in the same serialized socket action.
   *
   * @param {{actor?: Actor|null, combatant?: Combatant|null, combat?: Combat|null}} [options={}] Dialog context.
   * @returns {Promise<unknown|null>} Socket result or null when cancelled/blocked.
   */
  static async show({ actor, combatant, combat = game.combat } = {}) {
    const liveCombatant = combatant ?? AoVAdapter.getControlledCombatant(combat);
    if (!actor || !liveCombatant || !combat) {
      ui.notifications.warn(game.i18n.localize("AOV_SKJALDBORG.Warnings.NoCombatant"));
      return null;
    }
    if (!AoVAdapter.canUserControlCombatant(game.user, liveCombatant)) {
      ui.notifications.warn(game.i18n.localize("AOV_SKJALDBORG.Warnings.NotOwner"));
      return null;
    }

    const combatants = Array.from(combat.combatants ?? [])
      .filter(candidate => candidate.id !== liveCombatant.id && AoVAdapter.isCombatantCapable(candidate))
      .map(candidate => ({
        id: candidate.id,
        name: candidate.name,
        initiative: numberOr(candidate.initiative, 0)
      }))
      .sort((a, b) => b.initiative - a.initiative || a.name.localeCompare(b.name, game.i18n.lang));

    const content = await foundry.applications.handlebars.renderTemplate(
      "modules/aov-skjaldborg/templates/delay-dialog.hbs",
      {
        currentDex: currentDexRank(liveCombatant),
        combatants,
        hasTargets: combatants.length > 0
      }
    );

    const themeClass = actionThemeClass();
    const result = await DialogV2.input({
      classes: ["aov-skjaldborg", "dialog", "skj-attack-roll-window", "skj-delay-dialog-window", themeClass],
      window: {
        title: game.i18n.localize("AOV_SKJALDBORG.Delay.Title"),
        contentClasses: ["aov-skjaldborg", "skj-attack-roll-content", themeClass]
      },
      content,
      rejectClose: false,
      modal: true,
      ok: { label: game.i18n.localize("AOV_SKJALDBORG.Delay.Apply") }
    });
    if (!result) return null;

    try {
      const mode = String(result.mode ?? "dex");
      const payload = {
        combatId: combat.id,
        combatantId: liveCombatant.id,
        expectedCombatantUpdatedAt: getCombatantState(liveCombatant).updatedAt,
        mode: mode === "combatant" ? "combatant" : "dex",
        targetDex: result.endOfRound ? 1 : result.targetDex,
        targetCombatantId: result.targetCombatantId,
        position: result.position,
        intentCategory: ACTION_CATEGORIES.DELAY
      };
      const update = await requestGm("delayCombatant", payload);
      RenderCoordinator.invalidateCombatTracker("delay-combatant");
      return update;
    } catch (exception) {
      error("Failed to apply Skjaldborg delay.", exception);
      ui.notifications.error(game.i18n.localize("AOV_SKJALDBORG.Warnings.ActionFailed"));
      return null;
    }
  }
}
