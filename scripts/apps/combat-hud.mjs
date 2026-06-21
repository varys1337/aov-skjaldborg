import { AoVAdapter } from "../adapter/aov-adapter.mjs";
import { ACTION_CATEGORIES, RESOLUTION_STATUS } from "../constants.mjs";
import { getCombatState, getCombatantState, phaseLabelKey } from "../combat/state.mjs";
import { getEnabledPhases, shouldExecuteMovementImmediately } from "../combat/phase-structure.mjs";
import { requestGm } from "../socket.mjs";
import { RenderCoordinator } from "../ui/render-coordinator.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/**
 * Token-bound combat workflow HUD.
 *
 * The HUD is an ApplicationV2/Handlebars surface for declarations, movement
 * recording, reaction counters, and GM resolution queue controls. Document
 * writes are delegated to the GM socket path even when the current user is GM,
 * keeping validation centralized.
 */
export class CombatHUD extends HandlebarsApplicationMixin(ApplicationV2) {
  static current = null;

  static DEFAULT_OPTIONS = {
    id: "aov-skjaldborg-hud",
    classes: ["aov-skjaldborg", "skj-hud"],
    tag: "form",
    window: {
      title: "AOV_SKJALDBORG.Hud.Title",
      contentClasses: ["standard-form", "skj-hud-content"],
      resizable: true
    },
    position: {
      width: 420,
      height: 760
    },
    actions: {
      submitIntent: CombatHUD.onSubmitIntent,
      holdIntent: CombatHUD.onHoldIntent,
      saveMovement: CombatHUD.onSaveMovement,
      clearMovement: CombatHUD.onClearMovement,
      incrementReaction: CombatHUD.onIncrementReaction,
      decrementReaction: CombatHUD.onDecrementReaction,
      advancePhase: CombatHUD.onAdvancePhase,
      activateAction: CombatHUD.onActivateAction,
      resolveAction: CombatHUD.onResolveAction,
      skipAction: CombatHUD.onSkipAction,
      carryoverAction: CombatHUD.onCarryoverAction
    }
  };

  static PARTS = {
    main: {
      template: "modules/aov-skjaldborg/templates/combat-hud.hbs"
    }
  };

  /**
   * @param {{combat?: Combat|null, combatant?: Combatant|null}} [config={}] Initial HUD target.
   * @param {object} [options={}] Application options.
   */
  constructor({ combat = game.combat, combatant = null, initialActionCategory = null } = {}, options = {}) {
    super(options);
    this.combat = combat;
    this.combatant = combatant ?? AoVAdapter.getControlledCombatant(combat);
    this.initialActionCategory = initialActionCategory;
  }

  /**
   * Window title including combatant name.
   *
   * @returns {string}
   */
  get title() {
    const title = game.i18n.localize("AOV_SKJALDBORG.Hud.Title");
    return this.combatant ? `${title}: ${this.combatant.name}` : title;
  }

  /**
   * Open the singleton HUD for a combatant.
   *
   * @param {Combatant|null} combatant Target combatant.
   * @param {Combat|null} [combat=game.combat] Target combat.
   * @param {{initialActionCategory?: string|null}} [options={}] Initial form selection.
   * @returns {Promise<CombatHUD|null>}
   */
  static async showForCombatant(combatant, combat = game.combat, { initialActionCategory = null } = {}) {
    if (!combatant) {
      ui.notifications.warn(game.i18n.localize("AOV_SKJALDBORG.Warnings.NoCombatant"));
      return null;
    }
    if (this.current) await this.current.close({ force: true });
    this.current = new CombatHUD({ combat, combatant, initialActionCategory });
    return this.current.render(true);
  }

  /**
   * Open the HUD for the combatant represented by a token.
   *
   * @param {Token|null} token Canvas token.
   * @param {Combat|null} [combat=game.combat] Target combat.
   * @returns {Promise<CombatHUD|null>}
   */
  static async showForToken(token, combat = game.combat) {
    return this.showForCombatant(AoVAdapter.getCombatantForToken(combat, token), combat);
  }

  /**
   * Prepare Handlebars context for rendering.
   *
   * @param {object} options Application render options.
   * @returns {Promise<object>}
   */
  async _prepareContext(options) {
    const combatState = getCombatState(this.combat);
    const combatantState = this.combatant ? getCombatantState(this.combatant) : null;
    return {
      combat: this.combat,
      combatant: this.combatant,
      combatState,
      phaseLabel: game.i18n.localize(phaseLabelKey(combatState.phase)),
      combatantState,
      canEdit: this.combatant ? AoVAdapter.canUserControlCombatant(game.user, this.combatant) : false,
      isGM: game.user.isGM,
      phases: getEnabledPhases().map(phase => ({ value: phase, label: game.i18n.localize(phaseLabelKey(phase)), active: combatState.phase === phase })),
      actionCategories: Object.values(ACTION_CATEGORIES).map(value => ({
        value,
        label: game.i18n.localize(`AOV_SKJALDBORG.ActionCategories.${value}`),
        selected: (this.initialActionCategory ?? combatantState?.intent?.actionCategory) === value
      })),
      movementModes: ["none", "planned", "retreat", "flee"].map(value => ({
        value,
        label: game.i18n.localize(`AOV_SKJALDBORG.Movement.${value.charAt(0).toUpperCase()}${value.slice(1)}`),
        selected: combatantState?.movement?.mode === value
      })),
      movementImmediate: shouldExecuteMovementImmediately(combatState.phase),
      movementSummary: {
        status: game.i18n.localize(`AOV_SKJALDBORG.MovementStatus.${combatantState?.movement?.planStatus ?? "none"}`),
        waypointCount: combatantState?.movement?.waypoints?.length ?? 0,
        destination: combatantState?.movement?.destination
          ? `${combatantState.movement.destination.x}, ${combatantState.movement.destination.y}`
          : "-"
      },
      queue: combatState.resolutionQueue ?? [],
      pendingQueue: (combatState.resolutionQueue ?? []).filter(a => ![RESOLUTION_STATUS.RESOLVED, RESOLUTION_STATUS.SKIPPED].includes(a.status)),
      groups: combatState.simultaneousGroups ?? [],
      units: canvas.scene?.grid?.units ?? ""
    };
  }

  /**
   * Resolve the form element used by action handlers.
   *
   * @returns {HTMLFormElement}
   */
  _form() {
    if (this.element instanceof HTMLFormElement) return this.element;
    const form = this.element?.querySelector("form");
    if (form) return form;
    throw new Error(game.i18n.localize("AOV_SKJALDBORG.Warnings.FormUnavailable"));
  }

  /**
   * Read declaration fields from the HUD form.
   *
   * @returns {object}
   */
  _intentFromForm() {
    const form = this._form();
    const data = new FormData(form);
    return {
      actionCategory: data.get("actionCategory"),
      publicText: data.get("publicText"),
      privateText: data.get("privateText"),
      modifiers: {
        drawWeapon: data.has("drawWeapon"),
        sheatheWeapon: data.has("sheatheWeapon"),
        surprised: data.has("surprised"),
        fullMove: data.has("fullMove")
      },
      delay: {
        enabled: data.has("delayEnabled"),
        targetDex: data.get("delayTargetDex")
      },
      waitInterrupt: {
        enabled: data.has("waitEnabled"),
        text: data.get("waitText")
      },
      splitCount: data.get("splitCount"),
      fixedRank: data.get("fixedRank"),
      runeCarryover: data.has("runeCarryover")
    };
  }

  /**
   * Read movement fields from the HUD form and merge optional waypoint data.
   *
   * @param {Partial<import("../types.mjs").SkjaldborgMovementPlan>} [extra={}] Overrides.
   * @returns {object}
   */
  _movementFromForm(extra = {}) {
    const form = this._form();
    const data = new FormData(form);
    const state = getCombatantState(this.combatant);
    return {
      mode: data.get("movementMode") || "planned",
      distance: data.get("movementDistance"),
      units: data.get("movementUnits") || canvas.scene?.grid?.units || "",
      waypoints: state.movement?.waypoints ?? [],
      manual: true,
      ...extra
    };
  }

  /**
   * Send a HUD action through the GM-authoritative socket path.
   *
   * @param {string} action Local HUD action id.
   * @param {object} [payload={}] Socket payload.
   * @returns {Promise<unknown|null>}
   */
  async _send(action, payload = {}) {
    if (!this.combatant && !["advancePhase"].includes(action)) return null;
    const combatState = this.combat ? getCombatState(this.combat) : null;
    const combatantState = this.combatant ? getCombatantState(this.combatant) : null;
    const socketAction = {
      advancePhase: "advancePhase",
      submitIntent: "submitIntent",
      holdIntent: "holdIntent",
      recordMovement: "recordMovement",
      clearMovement: "clearMovement",
      incrementReaction: "incrementReaction",
      decrementReaction: "decrementReaction",
      setActionStatus: "setActionStatus"
    }[action];
    const result = await requestGm(socketAction, {
      combatId: this.combat?.id,
      combatantId: this.combatant?.id,
      expectedCombatUpdatedAt: combatState?.updatedAt,
      expectedCombatantUpdatedAt: combatantState?.updatedAt,
      ...payload
    });
    if (action === "submitIntent") this.initialActionCategory = null;
    void this.render(false);
    RenderCoordinator.invalidateCombatTracker(`combat-hud-${action}`);
    return result;
  }

  /** @param {Event} event Form action event. */
  static onSubmitIntent(event) {
    event.preventDefault();
    return this._send("submitIntent", { intent: this._intentFromForm() });
  }

  /** @param {Event} event Form action event. */
  static onHoldIntent(event) {
    event.preventDefault();
    return this._send("holdIntent");
  }

  /** @param {Event} event Form action event. */
  static onSaveMovement(event) {
    event.preventDefault();
    return this._send("recordMovement", { movement: this._movementFromForm({ manual: true }) });
  }

  /** @param {Event} event Form action event. */
  static onClearMovement(event) {
    event.preventDefault();
    return this._send("clearMovement");
  }

  /** @param {Event} event Form action event. */
  static onIncrementReaction(event) {
    event.preventDefault();
    return this._send("incrementReaction");
  }

  /** @param {Event} event Form action event. */
  static onDecrementReaction(event) {
    event.preventDefault();
    return this._send("decrementReaction");
  }

  /**
   * @param {Event} event Form action event.
   * @param {HTMLElement} target Clicked control.
   */
  static onAdvancePhase(event, target) {
    event.preventDefault();
    return this._send("advancePhase", { phase: target.dataset.phase || null });
  }

  /**
   * @param {Event} event Form action event.
   * @param {HTMLElement} target Clicked control.
   */
  static onResolveAction(event, target) {
    event.preventDefault();
    return this._send("setActionStatus", { actionId: target.dataset.actionId, status: RESOLUTION_STATUS.RESOLVED });
  }

  /**
   * @param {Event} event Form action event.
   * @param {HTMLElement} target Clicked control.
   */
  static onActivateAction(event, target) {
    event.preventDefault();
    return this._send("setActionStatus", { actionId: target.dataset.actionId, status: RESOLUTION_STATUS.ACTIVE });
  }

  /**
   * @param {Event} event Form action event.
   * @param {HTMLElement} target Clicked control.
   */
  static onSkipAction(event, target) {
    event.preventDefault();
    return this._send("setActionStatus", { actionId: target.dataset.actionId, status: RESOLUTION_STATUS.SKIPPED });
  }

  /**
   * @param {Event} event Form action event.
   * @param {HTMLElement} target Clicked control.
   */
  static onCarryoverAction(event, target) {
    event.preventDefault();
    return this._send("setActionStatus", { actionId: target.dataset.actionId, status: RESOLUTION_STATUS.CARRYOVER });
  }
}
