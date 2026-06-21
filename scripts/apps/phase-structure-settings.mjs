import {
  MODULE_ID,
  PHASE_ORDER,
  PHASE_STRUCTURE_SETTING_KEYS,
  PHASES
} from "../constants.mjs";
import { RenderCoordinator } from "../ui/render-coordinator.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/**
 * AppV2 world-settings submenu for the active combat-round phase structure.
 */
export class PhaseStructureSettings extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    classes: ["aov-skjaldborg", "skj-phase-structure-settings"],
    id: "aov-skjaldborg-phase-structure-settings",
    actions: {
      standard: PhaseStructureSettings.onStandardPreset,
      streamlined: PhaseStructureSettings.onStreamlinedPreset
    },
    form: {
      handler: PhaseStructureSettings.formHandler,
      closeOnSubmit: true,
      submitOnChange: false
    },
    position: {
      width: 640,
      height: "auto"
    },
    tag: "form",
    window: {
      title: "AOV_SKJALDBORG.Settings.PhaseStructureMenu.Title",
      contentClasses: ["standard-form", "skj-phase-structure-settings-content"]
    }
  };

  static PARTS = {
    form: { template: "modules/aov-skjaldborg/templates/phase-structure-settings.hbs" },
    footer: { template: "templates/generic/form-footer.hbs" }
  };

  get title() {
    return game.i18n.localize(this.options.window.title);
  }

  /** @override */
  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    return {
      ...context,
      phases: PHASE_ORDER.map(phase => ({
        id: phase,
        name: `phases.${phase}`,
        label: game.i18n.localize(`AOV_SKJALDBORG.Phases.${phase}`),
        hint: game.i18n.localize(`AOV_SKJALDBORG.Settings.PhaseStructureMenu.Phases.${phase}.Hint`),
        checked: game.settings.get(MODULE_ID, PHASE_STRUCTURE_SETTING_KEYS[phase]) !== false
      })),
      buttons: [
        { type: "submit", icon: "fa-solid fa-save", label: "SETTINGS.Save" },
        { type: "button", action: "standard", icon: "fa-solid fa-list-check", label: "AOV_SKJALDBORG.Settings.PhaseStructureMenu.Standard" },
        { type: "button", action: "streamlined", icon: "fa-solid fa-forward-fast", label: "AOV_SKJALDBORG.Settings.PhaseStructureMenu.Streamlined" }
      ]
    };
  }

  /**
   * Restore the complete four-phase tactical round.
   *
   * @param {PointerEvent} event Click event.
   * @returns {Promise<void>}
   */
  static async onStandardPreset(event) {
    event.preventDefault();
    await PhaseStructureSettings._persistSelection(Object.fromEntries(PHASE_ORDER.map(phase => [phase, true])));
    await this.render();
  }

  /**
   * Apply the optional compressed announce-and-act rules structure.
   *
   * Resolution remains as the visible initiative-countdown phase. Statement,
   * Movement, and Bookkeeping side effects are executed inline as required.
   *
   * @param {PointerEvent} event Click event.
   * @returns {Promise<void>}
   */
  static async onStreamlinedPreset(event) {
    event.preventDefault();
    await PhaseStructureSettings._persistSelection({
      [PHASES.INTENT]: false,
      [PHASES.MOVEMENT]: false,
      [PHASES.RESOLUTION]: true,
      [PHASES.BOOKKEEPING]: false
    });
    await this.render();
  }

  /**
   * Persist one normalized phase selection and reconcile an active combat.
   *
   * @param {Record<string, boolean>} selection Phase selection.
   * @returns {Promise<void>}
   * @protected
   */
  static async _persistSelection(selection) {
    const normalized = Object.fromEntries(PHASE_ORDER.map(phase => [phase, selection?.[phase] === true]));
    if (!Object.values(normalized).some(Boolean)) normalized[PHASES.RESOLUTION] = true;

    await Promise.all(PHASE_ORDER.map(phase => game.settings.set(
      MODULE_ID,
      PHASE_STRUCTURE_SETTING_KEYS[phase],
      normalized[phase]
    )));

    await game.aovSkjaldborg?.phase?.reconcilePhaseStructure?.(game.combat);
    RenderCoordinator.invalidateCombatTracker("phase-structure-settings");
  }

  /**
   * Persist the custom phase checklist.
   *
   * @param {SubmitEvent} event Submit event.
   * @param {HTMLFormElement} form Form element.
   * @param {FormDataExtended} formData Foundry form data.
   * @returns {Promise<void>}
   */
  static async formHandler(event, form, formData) {
    event.preventDefault();
    const data = foundry.utils.expandObject(formData.object ?? {});
    const selection = Object.fromEntries(PHASE_ORDER.map(phase => [
      phase,
      data.phases?.[phase] === true
    ]));

    if (!Object.values(selection).some(Boolean)) {
      ui.notifications.warn(game.i18n.localize("AOV_SKJALDBORG.Warnings.AtLeastOnePhase"));
      selection[PHASES.RESOLUTION] = true;
    }
    await PhaseStructureSettings._persistSelection(selection);
  }
}
