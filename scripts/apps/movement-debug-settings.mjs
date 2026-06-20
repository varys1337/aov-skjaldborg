import {
  MODULE_ID,
  MOVEMENT_DEBUG_CATEGORIES,
  MOVEMENT_DEBUG_DEFAULT_CATEGORIES,
  MOVEMENT_DEBUG_LEVELS
} from "../constants.mjs";
import { logMovementDebugExport, logMovementDebugSnapshot } from "../combat/movement-debugger.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/**
 * AppV2 settings submenu for movement diagnostics.
 */
export class MovementDebugSettings extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    classes: ["aov-skjaldborg", "skj-movement-debug-settings"],
    id: "aov-skjaldborg-movement-debug-settings",
    actions: {
      export: MovementDebugSettings.onExportDebug,
      reset: MovementDebugSettings.onResetDefaults,
      snapshot: MovementDebugSettings.onLogSnapshot
    },
    form: {
      handler: MovementDebugSettings.formHandler,
      closeOnSubmit: true,
      submitOnChange: false
    },
    position: {
      width: 680,
      height: Math.min(760, Math.max(420, globalThis.window?.innerHeight ? globalThis.window.innerHeight - 96 : 720))
    },
    tag: "form",
    window: {
      title: "AOV_SKJALDBORG.Settings.MovementDebugMenu.Title",
      contentClasses: ["standard-form", "skj-movement-debug-settings-content"]
    }
  };

  static PARTS = {
    form: { template: "modules/aov-skjaldborg/templates/movement-debug-settings.hbs" },
    footer: { template: "templates/generic/form-footer.hbs" }
  };

  get title() {
    return game.i18n.localize(this.options.window.title);
  }

  /** @override */
  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const categories = normalizeCategories(game.settings.get(MODULE_ID, "movementDebugCategories"));
    const level = game.settings.get(MODULE_ID, "movementDebugLevel");
    return {
      ...context,
      enabled: game.settings.get(MODULE_ID, "movementDebugEnabled"),
      level,
      levels: Object.values(MOVEMENT_DEBUG_LEVELS).map(value => ({
        value,
        label: game.i18n.localize(`AOV_SKJALDBORG.Settings.MovementDebugMenu.Levels.${value}`),
        selected: value === level
      })),
      categories: Object.values(MOVEMENT_DEBUG_CATEGORIES).map(value => ({
        value,
        checked: categories[value] === true,
        label: game.i18n.localize(`AOV_SKJALDBORG.Settings.MovementDebugMenu.Categories.${value}.Name`),
        hint: game.i18n.localize(`AOV_SKJALDBORG.Settings.MovementDebugMenu.Categories.${value}.Hint`)
      })),
      buttons: [
        { type: "submit", icon: "fa-solid fa-save", label: "SETTINGS.Save" },
        { type: "button", action: "snapshot", icon: "fa-solid fa-bug", label: "AOV_SKJALDBORG.Settings.MovementDebugMenu.LogSnapshot" },
        { type: "button", action: "export", icon: "fa-solid fa-file-export", label: "AOV_SKJALDBORG.Settings.MovementDebugMenu.ExportDebug" },
        { type: "button", action: "reset", icon: "fa-solid fa-undo", label: "SETTINGS.Reset" }
      ]
    };
  }

  /**
   * Restore movement-debug settings to defaults.
   *
   * @param {PointerEvent} event Click event.
   * @returns {Promise<void>}
   */
  static async onResetDefaults(event) {
    event.preventDefault();
    await Promise.all([
      game.settings.set(MODULE_ID, "movementDebugEnabled", false),
      game.settings.set(MODULE_ID, "movementDebugLevel", MOVEMENT_DEBUG_LEVELS.SUMMARY),
      game.settings.set(MODULE_ID, "movementDebugCategories", MOVEMENT_DEBUG_DEFAULT_CATEGORIES),
      game.settings.set(MODULE_ID, "movementDebugLastRunId", "")
    ]);
    await this.render();
  }

  /**
   * Print a current movement-state snapshot to the console.
   *
   * @param {PointerEvent} event Click event.
   * @returns {Promise<void>}
   */
  static async onLogSnapshot(event) {
    event.preventDefault();
    logMovementDebugSnapshot(game.combat);
  }

  /**
   * Log and copy the recent movement-debug event export.
   *
   * @param {PointerEvent} event Click event.
   * @returns {Promise<void>}
   */
  static async onExportDebug(event) {
    event.preventDefault();
    await logMovementDebugExport(game.combat);
  }

  /**
   * Persist the complete movement-debugger settings form.
   *
   * @param {SubmitEvent} event Submit event.
   * @param {HTMLFormElement} form Form element.
   * @param {FormDataExtended} formData Foundry form data.
   * @returns {Promise<void>}
   */
  static async formHandler(event, form, formData) {
    event.preventDefault();
    const data = foundry.utils.expandObject(formData.object ?? {});
    const level = Object.values(MOVEMENT_DEBUG_LEVELS).includes(data.level)
      ? data.level
      : MOVEMENT_DEBUG_LEVELS.SUMMARY;
    await Promise.all([
      game.settings.set(MODULE_ID, "movementDebugEnabled", data.enabled === true),
      game.settings.set(MODULE_ID, "movementDebugLevel", level),
      game.settings.set(MODULE_ID, "movementDebugCategories", normalizeCategories(data.categories))
    ]);
  }
}

/**
 * Normalize debug category checkbox data.
 *
 * @param {unknown} value Submitted or stored category map.
 * @returns {Record<string, boolean>}
 */
export function normalizeCategories(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return Object.fromEntries(Object.values(MOVEMENT_DEBUG_CATEGORIES).map(category => [
    category,
    source[category] === true
  ]));
}
