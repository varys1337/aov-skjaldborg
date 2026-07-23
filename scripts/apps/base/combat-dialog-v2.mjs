import { actionThemeClass } from "../../ui/dom-utils.mjs";
import { SkjDialogV2 } from "./dialog-v2.mjs";

const BASE_DEFAULT_OPTIONS = SkjDialogV2.DEFAULT_OPTIONS ?? {};
const BASE_WINDOW_OPTIONS = BASE_DEFAULT_OPTIONS.window ?? {};
const BASE_ACTIONS = BASE_DEFAULT_OPTIONS.actions ?? {};

/**
 * Shared DialogV2 shell for Skjaldborg combat workflow dialogs.
 *
 * Subclasses keep their own payload preparation and workflow semantics. This
 * base centralizes the form wrapper, template/content rendering, and primary
 * submit action routing.
 */
export class SkjCombatDialogV2 extends SkjDialogV2 {
  static DEFAULT_OPTIONS = {
    ...BASE_DEFAULT_OPTIONS,
    classes: ["aov-skjaldborg", "dialog", "skj-combat-dialog"],
    window: {
      ...BASE_WINDOW_OPTIONS,
      contentTag: "form",
      contentClasses: ["aov-skjaldborg", "skj-combat-dialog-content"]
    },
    position: { width: 390, height: "auto" },
    actions: {
      ...BASE_ACTIONS,
      submitWorkflow(event, target) {
        return this._onSubmitWorkflow(event, target);
      },
      toggleSection(event, target) {
        return this._onToggleSection(event, target);
      }
    }
  };

  /**
   * @param {object} [config={}] Shared dialog configuration.
   * @param {string} [config.title=""] Window title.
   * @param {string} [config.template=""] Handlebars template path.
   * @param {number} [config.width=390] Window width.
   * @param {string[]} [config.classes=[]] Extra window classes.
   * @param {string[]} [config.contentClasses=[]] Extra content classes.
   * @param {object[]} [config.buttons=[]] DialogV2 footer buttons.
   * @param {boolean} [config.modal=false] Whether the dialog is modal.
   * @param {Event|null} [config.originEvent=null] Optional source event.
   * @param {object} [options={}] Additional DialogV2 options.
   */
  constructor(config = {}, options = {}) {
    const themeClass = actionThemeClass();
    const configured = {
      classes: ["aov-skjaldborg", "dialog", "skj-combat-dialog", themeClass, ...(config.classes ?? [])],
      window: {
        title: config.title ?? "",
        contentTag: "form",
        contentClasses: [
          "aov-skjaldborg",
          "skj-combat-dialog-content",
          themeClass,
          ...(config.contentClasses ?? [])
        ]
      },
      position: { width: config.width ?? 390, height: "auto" },
      modal: config.modal === true,
      buttons: Array.isArray(config.buttons) ? config.buttons : []
    };
    super(foundry.utils.mergeObject(configured, options, { inplace: false }));
    this._template = String(config.template ?? "");
    this._formValues = {};
    this.originEvent = config.originEvent ?? null;
  }

  get formElement() {
    const form = this.form;
    if (form instanceof HTMLFormElement) return form;
    return this.element?.querySelector?.("form.window-content")
      ?? this.element?.querySelector?.("form")
      ?? null;
  }

  /** @override */
  async _renderHTML(context, options) {
    const prepared = await this._prepareDialogContext(context, options);
    if (this._template) {
      return foundry.applications.handlebars.renderTemplate(this._template, prepared);
    }
    return this._renderDialogContent(prepared, options);
  }

  /**
   * Render non-template dialog content.
   *
   * @param {object} _context Prepared context.
   * @param {object} _options Render options.
   * @returns {Promise<string>|string}
   */
  _renderDialogContent(_context, _options) {
    throw new Error(`${this.constructor.name} must configure a template or implement _renderDialogContent.`);
  }

  /** @override */
  _replaceHTML(result, content, options) {
    content.innerHTML = String(result ?? "");
  }

  /** @override */
  _onRender(context, options) {
    super._onRender(context, options);
    const form = this.formElement;
    if (!(form instanceof HTMLFormElement)) return;
    if (form.dataset.skjCombatDialogConfigured === "true") return;
    form.dataset.skjCombatDialogConfigured = "true";
    this._configureForm(form, context, options);
  }

  /**
   * Bind shared form listeners.
   *
   * @param {HTMLFormElement} form Rendered form.
   * @param {object} context Render context.
   * @param {object} options Render options.
   * @returns {void}
   */
  _configureForm(form, context, options) {
    form.addEventListener("change", event => this._onFormChange(event, form, context, options));
    form.addEventListener("input", event => this._onFormChange(event, form, context, options));
  }

  /**
   * Shared primary workflow submit action.
   *
   * @param {Event} event Action event.
   * @param {HTMLElement} target Action target.
   * @returns {Promise<unknown>|unknown}
   */
  async _onSubmitWorkflow(event, target) {
    event.preventDefault();
    event.stopPropagation();
    const form = this.formElement;
    if (!(form instanceof HTMLFormElement)) return null;
    return this._submit(form, event, target);
  }

  /**
   * Shared collapsible-section action.
   *
   * @param {Event} event Action event.
   * @param {HTMLElement} target Action target.
   * @returns {void}
   */
  _onToggleSection(event, target) {
    event.preventDefault();
    const section = target?.closest?.("[data-collapsible-section]");
    if (!(section instanceof HTMLElement)) return;
    const collapsed = !section.classList.contains("collapsed");
    section.classList.toggle("collapsed", collapsed);
    section.setAttribute("aria-expanded", collapsed ? "false" : "true");
    this.requestContentRefit();
  }

  /**
   * Hook for subclasses that need local preview state.
   *
   * @param {Event} _event Form event.
   * @param {HTMLFormElement} _form Active form.
   * @returns {void}
   */
  _onFormChange(_event, _form) {}

  /**
   * Prepare template/content context.
   *
   * @param {object} context Base context.
   * @param {object} _options Render options.
   * @returns {Promise<object>|object}
   */
  async _prepareDialogContext(context, _options) {
    return context ?? {};
  }

  /**
   * Submit the concrete workflow.
   *
   * @param {HTMLFormElement} _form Active form.
   * @param {Event} _event Submit event.
   * @param {HTMLElement} _target Submit target.
   * @returns {Promise<unknown>|unknown}
   */
  async _submit(_form, _event, _target) {
    throw new Error(`${this.constructor.name} must implement _submit.`);
  }
}
