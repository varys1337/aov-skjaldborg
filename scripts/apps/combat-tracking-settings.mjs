import { MODULE_ID, ROUNDING_POLICIES } from "../constants.mjs";
import { normalizeNumberSetting } from "../utils/settings.mjs";
import { RenderCoordinator } from "../ui/render-coordinator.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

const LIMITS = Object.freeze({
  movementTickDelayMs: Object.freeze({ min: 0, max: 1000, step: 50 }),
  reach: Object.freeze({ min: 0.5, max: 5, step: 0.5 })
});

/**
 * AppV2 world-settings submenu for combat-flow validation and movement rules.
 */
export class CombatTrackingSettings extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    classes: ["aov-skjaldborg", "skj-combat-tracking-settings"],
    id: "aov-skjaldborg-combat-tracking-settings",
    form: {
      handler: CombatTrackingSettings.formHandler,
      closeOnSubmit: true,
      submitOnChange: false
    },
    position: {
      width: 640,
      height: "auto"
    },
    tag: "form",
    window: {
      title: "AOV_SKJALDBORG.Settings.CombatTrackingMenu.Title",
      contentClasses: ["standard-form", "skj-combat-tracking-settings-content"]
    }
  };

  static PARTS = {
    form: { template: "modules/aov-skjaldborg/templates/combat-tracking-settings.hbs" },
    footer: { template: "templates/generic/form-footer.hbs" }
  };

  get title() {
    return game.i18n.localize(this.options.window.title);
  }

  /** @override */
  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const currentRounding = game.settings.get(MODULE_ID, "movementRounding");
    return {
      ...context,
      dynamicPlanningInitiative: game.settings.get(MODULE_ID, "dynamicPlanningInitiative") === true,
      requireAllCommit: game.settings.get(MODULE_ID, "requireAllCommit") === true,
      movementRounding: currentRounding,
      movementTickDelayMs: game.settings.get(MODULE_ID, "movementTickDelayMs"),
      shortReachGridUnits: game.settings.get(MODULE_ID, "shortReachGridUnits"),
      mediumReachGridUnits: game.settings.get(MODULE_ID, "mediumReachGridUnits"),
      longReachGridUnits: game.settings.get(MODULE_ID, "longReachGridUnits"),
      roundingChoices: [
        ROUNDING_POLICIES.CEIL,
        ROUNDING_POLICIES.FLOOR,
        ROUNDING_POLICIES.NEAREST
      ].map(value => ({
        value,
        label: game.i18n.localize(`AOV_SKJALDBORG.Settings.MovementRounding.${{
          [ROUNDING_POLICIES.CEIL]: "Ceil",
          [ROUNDING_POLICIES.FLOOR]: "Floor",
          [ROUNDING_POLICIES.NEAREST]: "Nearest"
        }[value]}`),
        selected: currentRounding === value
      })),
      limits: LIMITS,
      buttons: [
        { type: "submit", icon: "fa-solid fa-save", label: "SETTINGS.Save" }
      ]
    };
  }

  /**
   * Persist the complete combat-tracking settings form.
   *
   * @param {SubmitEvent} event Submit event.
   * @param {HTMLFormElement} form Form element.
   * @param {FormDataExtended} formData Foundry form data.
   * @returns {Promise<void>}
   */
  static async formHandler(event, form, formData) {
    event.preventDefault();
    const data = foundry.utils.expandObject(formData.object ?? {});
    const rounding = Object.values(ROUNDING_POLICIES).includes(data.movementRounding)
      ? data.movementRounding
      : ROUNDING_POLICIES.CEIL;
    const values = {
      dynamicPlanningInitiative: data.dynamicPlanningInitiative === true,
      requireAllCommit: data.requireAllCommit === true,
      movementRounding: rounding,
      movementTickDelayMs: normalizeNumberSetting(data.movementTickDelayMs, 250, LIMITS.movementTickDelayMs),
      shortReachGridUnits: normalizeNumberSetting(data.shortReachGridUnits, 1, LIMITS.reach),
      mediumReachGridUnits: normalizeNumberSetting(data.mediumReachGridUnits, 2, LIMITS.reach),
      longReachGridUnits: normalizeNumberSetting(data.longReachGridUnits, 3, LIMITS.reach)
    };

    await Promise.all(Object.entries(values).map(([key, value]) => (
      game.settings.set(MODULE_ID, key, value)
    )));
    RenderCoordinator.invalidateCombatTracker("combat-tracking-settings");
  }
}
