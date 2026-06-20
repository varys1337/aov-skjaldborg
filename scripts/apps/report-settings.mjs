import {
  MODULE_ID,
  PHASE_ORDER,
  REPORT_DELIVERY,
  REPORT_PHASE_SETTING_KEYS,
  REPORT_RECIPIENTS,
  REPORT_SCOPE
} from "../constants.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/**
 * AppV2 settings submenu for phase-report delivery and content rules.
 */
export class ReportSettings extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    classes: ["aov-skjaldborg", "skj-report-settings"],
    id: "aov-skjaldborg-report-settings",
    actions: {
      reset: ReportSettings.onResetDefaults
    },
    form: {
      handler: ReportSettings.formHandler,
      closeOnSubmit: true,
      submitOnChange: false
    },
    position: {
      width: 640,
      height: "auto"
    },
    tag: "form",
    window: {
      title: "AOV_SKJALDBORG.Settings.ReportMenu.Title",
      contentClasses: ["standard-form", "skj-report-settings-content"]
    }
  };

  static PARTS = {
    form: { template: "modules/aov-skjaldborg/templates/report-settings.hbs" },
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
        checked: game.settings.get(MODULE_ID, REPORT_PHASE_SETTING_KEYS[phase])
      })),
      delivery: game.settings.get(MODULE_ID, "reportDelivery"),
      recipients: game.settings.get(MODULE_ID, "reportWhisperRecipients"),
      scope: game.settings.get(MODULE_ID, "reportCombatantScope"),
      deliveryChoices: [
        { value: REPORT_DELIVERY.PUBLIC, label: game.i18n.localize("AOV_SKJALDBORG.Settings.ReportMenu.Delivery.Public") },
        { value: REPORT_DELIVERY.WHISPER, label: game.i18n.localize("AOV_SKJALDBORG.Settings.ReportMenu.Delivery.Whisper") }
      ],
      recipientChoices: [
        { value: REPORT_RECIPIENTS.GM, label: game.i18n.localize("AOV_SKJALDBORG.Settings.ReportMenu.Recipients.Gm") },
        { value: REPORT_RECIPIENTS.GM_AND_PLAYERS, label: game.i18n.localize("AOV_SKJALDBORG.Settings.ReportMenu.Recipients.GmAndPlayers") }
      ],
      scopeChoices: [
        { value: REPORT_SCOPE.ALL, label: game.i18n.localize("AOV_SKJALDBORG.Settings.ReportMenu.Scope.All") },
        { value: REPORT_SCOPE.PLAYER_OWNED, label: game.i18n.localize("AOV_SKJALDBORG.Settings.ReportMenu.Scope.PlayerOwned") }
      ],
      buttons: [
        { type: "submit", icon: "fa-solid fa-save", label: "SETTINGS.Save" },
        { type: "button", action: "reset", icon: "fa-solid fa-undo", label: "SETTINGS.Reset" }
      ]
    };
  }

  /**
   * Restore report settings to module defaults.
   *
   * @param {PointerEvent} event Click event.
   * @returns {Promise<void>}
   */
  static async onResetDefaults(event) {
    event.preventDefault();
    await Promise.all([
      ...PHASE_ORDER.map(phase => game.settings.set(MODULE_ID, REPORT_PHASE_SETTING_KEYS[phase], true)),
      game.settings.set(MODULE_ID, "reportDelivery", REPORT_DELIVERY.WHISPER),
      game.settings.set(MODULE_ID, "reportWhisperRecipients", REPORT_RECIPIENTS.GM),
      game.settings.set(MODULE_ID, "reportCombatantScope", REPORT_SCOPE.PLAYER_OWNED),
      game.settings.set(MODULE_ID, "reportSettingsMigrated", true)
    ]);
    await this.render();
  }

  /**
   * Persist the complete report-settings form deterministically.
   *
   * @param {SubmitEvent} event Submit event.
   * @param {HTMLFormElement} form Form element.
   * @param {FormDataExtended} formData Foundry form data.
   * @returns {Promise<void>}
   */
  static async formHandler(event, form, formData) {
    event.preventDefault();
    const data = foundry.utils.expandObject(formData.object ?? {});
    const selectedDelivery = Object.values(REPORT_DELIVERY).includes(data.delivery)
      ? data.delivery
      : REPORT_DELIVERY.WHISPER;
    const selectedRecipients = Object.values(REPORT_RECIPIENTS).includes(data.recipients)
      ? data.recipients
      : REPORT_RECIPIENTS.GM;
    const selectedScope = Object.values(REPORT_SCOPE).includes(data.scope)
      ? data.scope
      : REPORT_SCOPE.PLAYER_OWNED;

    await Promise.all([
      ...PHASE_ORDER.map(phase => game.settings.set(
        MODULE_ID,
        REPORT_PHASE_SETTING_KEYS[phase],
        data.phases?.[phase] === true
      )),
      game.settings.set(MODULE_ID, "reportDelivery", selectedDelivery),
      game.settings.set(MODULE_ID, "reportWhisperRecipients", selectedRecipients),
      game.settings.set(MODULE_ID, "reportCombatantScope", selectedScope),
      game.settings.set(MODULE_ID, "reportSettingsMigrated", true)
    ]);
  }
}
