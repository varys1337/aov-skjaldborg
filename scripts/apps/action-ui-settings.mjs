import {
  ACTION_UI_DEFAULTS,
  ACTION_UI_LIMITS,
  ACTION_UI_THEMES,
  MODULE_ID
} from "../constants.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/**
 * AppV2 settings submenu for the token action ring and selected-actor hotbar.
 */
export class ActionUiSettings extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    classes: ["aov-skjadlborg", "skj-action-ui-settings"],
    id: "aov-skjadlborg-action-ui-settings",
    actions: {
      reset: ActionUiSettings.onResetDefaults,
      resetPosition: ActionUiSettings.onResetHotbarPosition
    },
    form: {
      handler: ActionUiSettings.formHandler,
      closeOnSubmit: true,
      submitOnChange: false
    },
    position: {
      width: 640,
      height: "auto"
    },
    tag: "form",
    window: {
      title: "AOV_SKJADLBORG.Settings.ActionUiMenu.Title",
      contentClasses: ["standard-form", "skj-action-ui-settings-content"]
    }
  };

  static PARTS = {
    form: { template: "modules/aov-skjadlborg/templates/action-ui-settings.hbs" },
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
      enableActionRing: game.settings.get(MODULE_ID, "enableActionRing"),
      actionRingMaxItems: game.settings.get(MODULE_ID, "actionRingMaxItems"),
      enableActorHotbar: game.settings.get(MODULE_ID, "enableActorHotbar"),
      replaceCoreHotbar: game.settings.get(MODULE_ID, "replaceCoreHotbar"),
      actorHotbarScale: game.settings.get(MODULE_ID, "actorHotbarScale"),
      actorHotbarActionWidth: game.settings.get(MODULE_ID, "actorHotbarActionWidth"),
      actorHotbarOpacity: game.settings.get(MODULE_ID, "actorHotbarOpacity"),
      actionUiTheme: game.settings.get(MODULE_ID, "actionUiTheme"),
      themes: this._prepareThemeChoices(),
      limits: ACTION_UI_LIMITS,
      buttons: [
        { type: "submit", icon: "fa-solid fa-save", label: "SETTINGS.Save" },
        { type: "button", action: "reset", icon: "fa-solid fa-undo", label: "SETTINGS.Reset" }
      ]
    };
  }

  /**
   * Prepare explicit select options without depending on non-native helpers.
   *
   * @returns {{value: string, label: string, selected: boolean}[]}
   */
  _prepareThemeChoices() {
    const current = game.settings.get(MODULE_ID, "actionUiTheme");
    return [
      {
        value: ACTION_UI_THEMES.AOV,
        label: game.i18n.localize("AOV_SKJADLBORG.Settings.ActionUiTheme.Aov"),
        selected: current === ACTION_UI_THEMES.AOV
      },
      {
        value: ACTION_UI_THEMES.CLASSIC,
        label: game.i18n.localize("AOV_SKJADLBORG.Settings.ActionUiTheme.Classic"),
        selected: current === ACTION_UI_THEMES.CLASSIC
      }
    ];
  }

  /** @override */
  async _onRender(context, options) {
    await super._onRender(context, options);
    const input = this.element.querySelector('input[name="actorHotbarOpacity"]');
    const output = this.element.querySelector("[data-actor-hotbar-opacity-value]");
    if (!input || !output) return;
    input.addEventListener("input", () => {
      output.textContent = `${input.value}%`;
    });
  }

  /**
   * Restore every action-interface setting to its module default.
   *
   * @param {PointerEvent} event Click event.
   * @returns {Promise<void>}
   */
  static async onResetDefaults(event) {
    event.preventDefault();
    await Promise.all(Object.entries(ACTION_UI_DEFAULTS).map(([key, value]) => (
      game.settings.set(MODULE_ID, key, value)
    )));
    await this.render();
  }

  /**
   * Clear the saved actor-hotbar viewport position for this client.
   *
   * @param {PointerEvent} event Click event.
   * @returns {Promise<void>}
   */
  static async onResetHotbarPosition(event) {
    event.preventDefault();
    await game.settings.set(MODULE_ID, "actorHotbarPosition", {});
    await this.render();
  }

  /**
   * Persist the complete action-interface form deterministically.
   *
   * @param {SubmitEvent} event Submit event.
   * @param {HTMLFormElement} form Form element.
   * @param {FormDataExtended} formData Foundry form data.
   * @returns {Promise<void>}
   */
  static async formHandler(event, form, formData) {
    event.preventDefault();
    const data = foundry.utils.expandObject(formData.object ?? {});
    const values = {
      enableActionRing: data.enableActionRing === true,
      actionRingMaxItems: normalizeNumber(
        data.actionRingMaxItems,
        ACTION_UI_DEFAULTS.actionRingMaxItems,
        ACTION_UI_LIMITS.actionRingMaxItems
      ),
      enableActorHotbar: data.enableActorHotbar === true,
      replaceCoreHotbar: data.replaceCoreHotbar === true,
      actorHotbarScale: normalizeNumber(
        data.actorHotbarScale,
        ACTION_UI_DEFAULTS.actorHotbarScale,
        ACTION_UI_LIMITS.actorHotbarScale
      ),
      actorHotbarActionWidth: normalizeNumber(
        data.actorHotbarActionWidth,
        ACTION_UI_DEFAULTS.actorHotbarActionWidth,
        ACTION_UI_LIMITS.actorHotbarActionWidth
      ),
      actorHotbarOpacity: normalizeNumber(
        data.actorHotbarOpacity,
        ACTION_UI_DEFAULTS.actorHotbarOpacity,
        ACTION_UI_LIMITS.actorHotbarOpacity
      ),
      actionUiTheme: Object.values(ACTION_UI_THEMES).includes(data.actionUiTheme)
        ? data.actionUiTheme
        : ACTION_UI_DEFAULTS.actionUiTheme
    };

    await Promise.all(Object.entries(values).map(([key, value]) => (
      game.settings.set(MODULE_ID, key, value)
    )));
  }
}

/**
 * Coerce a numeric settings value to its supported range and step.
 *
 * @param {unknown} value Submitted value.
 * @param {number} fallback Default value.
 * @param {{min: number, max: number, step: number}} limits Numeric constraints.
 * @returns {number}
 */
function normalizeNumber(value, fallback, limits) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  const clamped = Math.min(limits.max, Math.max(limits.min, numeric));
  const stepped = limits.min + Math.round((clamped - limits.min) / limits.step) * limits.step;
  const decimals = String(limits.step).split(".")[1]?.length ?? 0;
  return Number(stepped.toFixed(decimals));
}
