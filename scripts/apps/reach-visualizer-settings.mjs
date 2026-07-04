import {
  MODULE_ID,
  REACH_VISUALIZER_LIMITS,
  REACH_VISUALIZER_SHAPE,
  REACH_VISUALIZER_VISIBILITY
} from "../constants.mjs";
import { normalizeReachVisualizerSettings } from "../canvas/reach-visualizer-config.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/**
 * AppV2 client-settings submenu for the readied-weapon reach visualizer.
 */
export class ReachVisualizerSettings extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    classes: ["aov-skjaldborg", "skj-reach-visualizer-settings"],
    id: "aov-skjaldborg-reach-visualizer-settings",
    form: {
      handler: ReachVisualizerSettings.formHandler,
      closeOnSubmit: true,
      submitOnChange: false
    },
    position: {
      width: 560,
      height: "auto"
    },
    tag: "form",
    window: {
      title: "AOV_SKJALDBORG.Settings.ReachVisualizerMenu.Title",
      contentClasses: ["standard-form", "skj-reach-visualizer-settings-content"]
    }
  };

  static PARTS = {
    form: { template: "modules/aov-skjaldborg/templates/reach-visualizer-settings.hbs" },
    footer: { template: "templates/generic/form-footer.hbs" }
  };

  get title() {
    return game.i18n.localize(this.options.window.title);
  }

  /** @override */
  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const settings = normalizeReachVisualizerSettings(game.settings.get(MODULE_ID, "reachVisualizer"));
    return {
      ...context,
      settings,
      visibilityChoices: Object.values(REACH_VISUALIZER_VISIBILITY).map(value => ({
        value,
        label: game.i18n.localize(`AOV_SKJALDBORG.ReachVisualizer.Visibility.${{
          [REACH_VISUALIZER_VISIBILITY.DYNAMIC]: "Dynamic",
          [REACH_VISUALIZER_VISIBILITY.HOVER]: "Hover",
          [REACH_VISUALIZER_VISIBILITY.ALWAYS]: "Always"
        }[value]}`),
        selected: settings.visibility === value
      })),
      shapeChoices: Object.values(REACH_VISUALIZER_SHAPE).map(value => ({
        value,
        label: game.i18n.localize(`AOV_SKJALDBORG.ReachVisualizer.Shape.${{
          [REACH_VISUALIZER_SHAPE.GRID]: "Grid",
          [REACH_VISUALIZER_SHAPE.CIRCLE]: "Circle"
        }[value]}`),
        selected: settings.shape === value
      })),
      limits: REACH_VISUALIZER_LIMITS,
      buttons: [
        { type: "submit", icon: "fa-solid fa-save", label: "SETTINGS.Save" }
      ]
    };
  }

  /**
   * Persist reach visualizer settings.
   *
   * @param {SubmitEvent} event Submit event.
   * @param {HTMLFormElement} form Form element.
   * @param {FormDataExtended} formData Foundry form data.
   * @returns {Promise<void>}
   */
  static async formHandler(event, form, formData) {
    event.preventDefault();
    const data = foundry.utils.expandObject(formData.object ?? {});
    const settings = normalizeReachVisualizerSettings(data);
    await game.settings.set(MODULE_ID, "reachVisualizer", settings);
    game.aovSkjaldborg?.reachVisualizer?.applySettings?.(settings);
  }
}
