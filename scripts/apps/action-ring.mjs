import { ACTION_CATEGORIES, MODULE_ID } from "../constants.mjs";
import { AoVAdapter } from "../adapter/aov-adapter.mjs";
import { error } from "../logger.mjs";
import { getCombatantState } from "../combat/state.mjs";
import { isPriorityStatusId } from "../compat/active-effects.mjs";
import {
  commitIntentCategory,
  executeActorItem,
  executeActorStat,
  executeEvadeIntent,
  executeMacro,
  getActorPreparedIntent,
  isSkjaldborgCombatActive,
  openActorItem,
  prepareActorQuickAccess,
  promptOtherIntentText,
  toggleIntentCategory
} from "../ui/action-catalog.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

let hooksRegistered = false;

function statusButtonId(element) {
  const candidates = [
    element?.dataset?.statusId,
    element?.dataset?.status,
    element?.dataset?.effectId,
    element?.getAttribute?.("data-status-id"),
    element?.getAttribute?.("data-status"),
    element?.getAttribute?.("data-effect-id")
  ];
  for (const candidate of candidates) {
    const value = String(candidate ?? "").trim();
    if (value && isPriorityStatusId(value)) return value;
  }
  return "";
}

function markPriorityStatusPalette(element) {
  for (const control of element.querySelectorAll("[data-status-id], [data-status], [data-effect-id], .status-effect")) {
    if (!(control instanceof HTMLElement)) continue;
    const statusId = statusButtonId(control);
    if (!statusId) continue;
    control.classList.add("skj-priority-status-effect");
    control.dataset.skjPriorityStatus = statusId;
  }
}

async function openDisengageDialog(context) {
  const { DisengageDialog } = await import("./disengage-dialog.mjs");
  return DisengageDialog.show(context);
}

async function openKnockbackRollDialog(context) {
  const { KnockbackRollDialog } = await import("./knockback-roll-dialog.mjs");
  return KnockbackRollDialog.show(context);
}

async function openGrappleRollDialog(context) {
  const { GrappleRollDialog } = await import("./grapple-roll-dialog.mjs");
  return GrappleRollDialog.show(context);
}

async function openDelayDialog(context) {
  const { DelayDialog } = await import("./delay-dialog.mjs");
  return DelayDialog.show(context);
}

async function openRunicMagicDialog(context) {
  const { RunicMagicDialog } = await import("./runic-magic-dialog.mjs");
  return RunicMagicDialog.show(context);
}

/**
 * Token-centered action ring for quick actor actions.
 *
 * The ring always mirrors the actor's configured quick-access circles.
 * Intent assignments remain executable during an enabled Skjaldborg combat,
 * while Item, statistic, and Macro assignments retain their native actions.
 */
export class ActionRing extends HandlebarsApplicationMixin(ApplicationV2) {
  static current = null;
  static BASE_RADIUS = 110;
  static BUTTON_SIZE = 56;
  static BUTTON_GAP = 10;

  static DEFAULT_OPTIONS = {
    id: "aov-skjaldborg-action-ring",
    classes: ["aov-skjaldborg", "skj-action-ring-app"],
    window: {
      frame: false
    },
    actions: {
      activate: ActionRing.onActivate,
      closeRing: ActionRing.onCloseRing
    }
  };

  static PARTS = {
    ring: {
      template: "modules/aov-skjaldborg/templates/action-ring.hbs"
    }
  };

  /**
   * @param {{token: Token, combat?: Combat|null, combatant?: Combatant|null, fallbackPosition?: {top: number, left: number}}} config Ring target.
   * @param {object} [options={}] Application options.
   */
  constructor({ token, combat = game.combat, combatant = null, fallbackPosition = null }, options = {}) {
    super(options);
    this.token = token;
    this.actor = token?.actor ?? null;
    this.combat = combat;
    this.combatant = combatant;
    this.fallbackPosition = fallbackPosition;
    this._actions = [];
    this._diameter = (ActionRing.BASE_RADIUS + ActionRing.BUTTON_SIZE) * 2;
  }

  /**
   * Resolve a Token placeable from either the core Token HUD object or a TokenDocument-like value.
   *
   * @param {Token|TokenDocument|null} token Token-like source.
   * @returns {Token|null}
   */
  static resolveTokenPlaceable(token) {
    const candidates = [token, token?.object, token?.document?.object];
    for (const candidate of candidates) {
      const center = candidate?.center;
      if (Number.isFinite(center?.x) && Number.isFinite(center?.y)) return candidate;
    }

    return null;
  }

  /**
   * Resolve the represented token center in client-viewport coordinates.
   *
   * Foundry's Token center is expressed in canvas coordinates. The documented
   * Canvas conversion accounts for the current pan and zoom. The result is
   * intentionally kept in client coordinates because the ring root is a fixed
   * viewport overlay rather than a normal document-flow Application element.
   *
   * @param {Token|TokenDocument|null} token Token represented by the ring.
   * @param {{top: number, left: number}|null} fallbackPosition Fallback anchor.
   * @returns {{top: number, left: number}}
   */
  static getTokenViewportCenter(token, fallbackPosition = null) {
    const placeable = this.resolveTokenPlaceable(token);
    const center = placeable?.center;
    const canConvert = canvas?.ready
      && Number.isFinite(center?.x)
      && Number.isFinite(center?.y)
      && typeof canvas.clientCoordinatesFromCanvas === "function";

    if (canConvert) {
      const clientPoint = canvas.clientCoordinatesFromCanvas(center);
      if (Number.isFinite(clientPoint?.x) && Number.isFinite(clientPoint?.y)) {
        return { top: clientPoint.y, left: clientPoint.x };
      }
    }

    if (Number.isFinite(fallbackPosition?.top) && Number.isFinite(fallbackPosition?.left)) {
      return fallbackPosition;
    }

    return {
      top: window.innerHeight / 2,
      left: window.innerWidth / 2
    };
  }

  /**
   * Open the ring at the represented token center.
   *
   * @param {Token|TokenDocument} token Token represented by the HUD.
   * @param {HTMLElement|null} sourceControl Exact Token HUD control which opened the ring.
   * @returns {Promise<ActionRing|null>}
   */
  static async openForTokenHud(token, sourceControl = null) {
    const placeable = this.resolveTokenPlaceable(token);
    if (!placeable?.actor) return null;
    await this.closeAll();

    const rect = sourceControl?.getBoundingClientRect?.();
    const fallbackPosition = rect
      ? { top: rect.top + (rect.height / 2), left: rect.left + (rect.width / 2) }
      : null;
    const combat = game.combat ?? null;
    const combatant = AoVAdapter.getCombatantForToken(combat, placeable);
    this.current = new ActionRing({ token: placeable, combat, combatant, fallbackPosition });
    await this.current.render(true);
    return this.current;
  }

  /**
   * Close the active ring singleton.
   *
   * @returns {Promise<void>}
   */
  static async closeAll() {
    if (!this.current) return;
    const current = this.current;
    this.current = null;
    await current.close({ animate: false });
  }

  /** @inheritdoc */
  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const actions = prepareActorQuickAccess(this.actor).slots
      .map(slot => slot.action)
      .filter(Boolean);

    const metrics = this._ringMetrics(actions.length);
    this._diameter = metrics.diameter;
    const displayedIntent = isSkjaldborgCombatActive(this.combat) && this.combatant
      ? getCombatantState(this.combatant).intent
      : getActorPreparedIntent(this.actor);
    this._actions = actions.map((action, index) => {
      const position = this._calculatePosition(index, actions.length, metrics);
      const tooltip = action.kind === "intent"
        && action.id === ACTION_CATEGORIES.OTHER
        && displayedIntent?.publicText
        ? `${action.name}: ${displayedIntent.publicText}`
        : (action.tooltip ?? action.name);
      return {
        ...action,
        tooltip,
        style: `left: ${position.x}px; top: ${position.y}px;`
      };
    });

    return {
      ...context,
      actions: this._actions,
      actorName: this.actor?.name ?? "",
      diameter: metrics.diameter,
      center: metrics.center,
      hint: game.i18n.localize("AOV_SKJALDBORG.ActionRing.QuickAccessHint")
    };
  }

  /**
   * Compute a single-circle canvas large enough for the rendered actions.
   *
   * @param {number} total Number of actions.
   * @returns {{center: number, diameter: number, maxRadius: number}}
   */
  _ringMetrics(total) {
    const count = Math.max(1, Math.round(Number(total) || 1));
    const chordRadius = count > 2
      ? (ActionRing.BUTTON_SIZE + ActionRing.BUTTON_GAP) / (2 * Math.sin(Math.PI / count))
      : ActionRing.BASE_RADIUS;
    const maxRadius = Math.max(ActionRing.BASE_RADIUS, Math.ceil(chordRadius));
    const center = maxRadius + ActionRing.BUTTON_SIZE;
    return { maxRadius, center, diameter: Math.ceil(center * 2) };
  }

  /**
   * Position an action on the single radial circle.
   *
   * @param {number} index Action index.
   * @param {number} total Total actions.
   * @param {{center: number, maxRadius: number}} metrics Ring metrics.
   * @returns {{x: number, y: number}}
   */
  _calculatePosition(index, total, metrics) {
    const count = Math.max(1, total);
    const angle = ((index / count) * Math.PI * 2) - (Math.PI / 2);
    return {
      x: Math.cos(angle) * metrics.maxRadius + metrics.center - (ActionRing.BUTTON_SIZE / 2),
      y: Math.sin(angle) * metrics.maxRadius + metrics.center - (ActionRing.BUTTON_SIZE / 2)
    };
  }

  /**
   * Apply the computed Application position as a fixed viewport overlay.
   *
   * ApplicationV2 retains the position state and emits its normal position
   * lifecycle, while explicit fixed CSS prevents Foundry UI containers or
   * sidebar layout from reflowing the frame-less ring.
   *
   * @param {{top?: number, left?: number, width?: number, height?: number}} position Application position.
   * @returns {void}
   */
  _applyViewportPosition(position) {
    let element = null;
    try {
      element = this.element;
    } catch (_exception) {
      return;
    }
    if (!(element instanceof HTMLElement)) return;

    const top = Number(position?.top);
    const left = Number(position?.left);
    const width = Number(position?.width);
    const height = Number(position?.height);
    if (![top, left, width, height].every(Number.isFinite)) return;

    element.style.setProperty("position", "fixed", "important");
    element.style.setProperty("top", `${Math.round(top)}px`, "important");
    element.style.setProperty("left", `${Math.round(left)}px`, "important");
    element.style.setProperty("right", "auto", "important");
    element.style.setProperty("bottom", "auto", "important");
    element.style.setProperty("width", `${Math.round(width)}px`, "important");
    element.style.setProperty("height", `${Math.round(height)}px`, "important");
    element.style.setProperty("margin", "0", "important");
    element.style.setProperty("transform", "none", "important");
  }

  /** @inheritdoc */
  setPosition(position = {}) {
    const width = this._diameter;
    const height = this._diameter;
    const margin = 8;
    const viewportWidth = document.documentElement?.clientWidth ?? window.innerWidth;
    const viewportHeight = document.documentElement?.clientHeight ?? window.innerHeight;
    const anchor = ActionRing.getTokenViewportCenter(this.token, this.fallbackPosition);
    const desiredLeft = anchor.left - (width / 2);
    const desiredTop = anchor.top - (height / 2);
    const maxLeft = Math.max(margin, viewportWidth - width - margin);
    const maxTop = Math.max(margin, viewportHeight - height - margin);
    const left = Math.max(margin, Math.min(desiredLeft, maxLeft));
    const top = Math.max(margin, Math.min(desiredTop, maxTop));
    const revised = { ...position, left, top, width, height };
    const result = super.setPosition(revised);
    this._applyViewportPosition(revised);
    return result;
  }

  /** @inheritdoc */
  async _onRender(context, options) {
    await super._onRender(context, options);
    const theme = game.settings.get(MODULE_ID, "actionUiTheme");
    this.element.classList.toggle("skj-theme-aov", theme === "aov");
    this.element.classList.toggle("skj-theme-classic", theme !== "aov");
    this.setPosition();

    this.element.addEventListener("contextmenu", event => this._onActionContextMenu(event), { capture: true });
    this.element.addEventListener("auxclick", event => this._onActionAuxClick(event), { capture: true });
    this.element.addEventListener("pointerdown", event => this._onActionCapturePointerDown(event), { capture: true });

    this.element.addEventListener("pointerdown", event => {
      if (event.button === 2) {
        const target = event.target instanceof Element ? event.target.closest("[data-action-id]") : null;
        if (target instanceof HTMLElement) {
          event.preventDefault();
          event.stopImmediatePropagation();
        }
        return;
      }
      if (event.target.closest("[data-action]")) return;
      void ActionRing.closeAll();
    });

    window.setTimeout(() => {
      this.element?.querySelectorAll(".collapsed").forEach(element => element.classList.remove("collapsed"));
    }, 20);
  }

  /** @inheritdoc */
  _onClose(options) {
    if (ActionRing.current === this) ActionRing.current = null;
    return super._onClose(options);
  }

  /**
   * Open the detailed surface for a ring action.
   *
   * @param {string|undefined} kind Action kind.
   * @param {string|undefined} actionId Action id.
   * @returns {Promise<unknown|null>}
   */
  async _openDetails(kind, actionId) {
    if (kind === "intent") return null;
    if (kind === "item") {
      await ActionRing.closeAll();
      return openActorItem(this.actor, actionId);
    }
    return null;
  }

  /**
   * Resolve one rendered ring action from a delegated event.
   *
   * @param {Event} event Delegated DOM event.
   * @returns {HTMLElement|null}
   */
  _actionTargetFromEvent(event) {
    const target = event.target instanceof Element ? event.target.closest("[data-action-id]") : null;
    return target instanceof HTMLElement ? target : null;
  }

  /**
   * Stop secondary presses before AppV2 activation can process them.
   *
   * @param {PointerEvent} event Delegated pointer event.
   * @returns {void}
   */
  _onActionCapturePointerDown(event) {
    if (event.button !== 2) return;
    const target = this._actionTargetFromEvent(event);
    if (!target) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  /**
   * Suppress secondary auxclick events after the context action runs.
   *
   * @param {MouseEvent} event Delegated auxclick event.
   * @returns {void}
   */
  _onActionAuxClick(event) {
    if (event.button !== 2) return;
    const target = this._actionTargetFromEvent(event);
    if (!target) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  /**
   * Run only right-click behavior for ring actions.
   *
   * @param {MouseEvent} event Delegated context menu event.
   * @returns {void}
   */
  _onActionContextMenu(event) {
    const target = this._actionTargetFromEvent(event);
    if (!target) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    void (async () => {
      if (target.dataset.actionKind === "intent") {
        await ActionRing.closeAll();
        return toggleIntentCategory(this.actor, this.combatant, this.combat, target.dataset.actionId, { promptOther: true });
      }
      return this._openDetails(target.dataset.actionKind, target.dataset.actionId);
    })();
  }

  /**
   * Execute a ring action.
   *
   * @param {PointerEvent} event Interaction event.
   * @param {HTMLElement} target Action control.
   * @returns {Promise<unknown|null>}
   */
  static async onActivate(event, target) {
    event.preventDefault();
    if (event instanceof MouseEvent && event.button !== 0) {
      event.stopImmediatePropagation();
      return null;
    }
    event.stopPropagation();
    const kind = target.dataset.actionKind;
    const actionId = target.dataset.actionId;

    if (kind === "intent") {
      let publicText = "";
      if (actionId === ACTION_CATEGORIES.OTHER) {
        const currentText = isSkjaldborgCombatActive(this.combat) && this.combatant
          ? getCombatantState(this.combatant).intent?.publicText
          : getActorPreparedIntent(this.actor)?.publicText;
        const entered = await promptOtherIntentText(currentText ?? "");
        if (entered === null) return null;
        publicText = entered;
      }
      await ActionRing.closeAll();
      if (actionId === ACTION_CATEGORIES.RETREAT) {
        return openDisengageDialog({ actor: this.actor, combatant: this.combatant, combat: this.combat, originEvent: event });
      }
      if (actionId === ACTION_CATEGORIES.KNOCKBACK) {
        return openKnockbackRollDialog({ actor: this.actor, originEvent: event });
      }
      if (actionId === ACTION_CATEGORIES.GRAPPLE) {
        return openGrappleRollDialog({ actor: this.actor, originEvent: event });
      }
      if (actionId === ACTION_CATEGORIES.DELAY) {
        return openDelayDialog({ actor: this.actor, combatant: this.combatant, combat: this.combat, originEvent: event });
      }
      if (actionId === ACTION_CATEGORIES.MAGIC) {
        await ActionRing.closeAll();
        return openRunicMagicDialog({ actor: this.actor, combatant: this.combatant, combat: this.combat, originEvent: event });
      }
      if (actionId === ACTION_CATEGORIES.DEFEND) {
        return executeEvadeIntent(this.actor, this.combatant, this.combat, { publicText });
      }
      return commitIntentCategory(this.actor, this.combatant, this.combat, actionId, { publicText });
    }

    if (kind === "item") {
      const execution = executeActorItem(this.actor, actionId, event);
      void ActionRing.closeAll();
      return execution;
    }
    if (kind === "stat") {
      const execution = executeActorStat(this.actor, actionId, event);
      void ActionRing.closeAll();
      return execution;
    }
    if (kind === "macro") {
      const execution = executeMacro(actionId);
      void ActionRing.closeAll();
      return execution;
    }
    return null;
  }

  /** @returns {Promise<void>} */
  static onCloseRing() {
    return ActionRing.closeAll();
  }
}

/**
 * Add the action-ring button to the core Token HUD and register close hooks.
 *
 * @returns {void}
 */
export function registerActionRingHooks() {
  if (hooksRegistered) return;
  hooksRegistered = true;

  Hooks.on("renderTokenHUD", (app, html) => {
    const element = html instanceof HTMLElement ? html : app?.element;
    if (element) markPriorityStatusPalette(element);
    if (!game.settings.get(MODULE_ID, "enableActionRing")) return;

    const token = app?.object ?? null;
    const actor = token?.actor ?? null;
    if (!element || !actor?.isOwner) return;

    const combat = game.combat ?? null;
    const combatant = AoVAdapter.getCombatantForToken(combat, token);
    const inWorkflow = isSkjaldborgCombatActive(combat) && !!combatant;

    element.querySelectorAll("[data-skj-token-hud]").forEach(control => control.remove());
    const configControl = element.querySelector('button[data-action="config"]');
    if (!(configControl instanceof HTMLButtonElement)) return;

    const label = game.i18n.localize("AOV_SKJALDBORG.Controls.OpenActionRing");
    const control = document.createElement("button");
    control.type = "button";
    control.className = configControl.className;
    control.classList.add("skj-token-hud-button");
    control.dataset.skjTokenHud = "action-ring";
    control.dataset.tooltip = label;
    control.title = label;
    control.setAttribute("aria-label", label);
    control.innerHTML = `<i class="fa-solid ${inWorkflow ? "fa-hand-fist" : "fa-hand"}" inert></i>`;

    control.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      void (async () => {
        try {
          const opened = await ActionRing.openForTokenHud(token, control);
          if (opened) await app.close({ animate: false });
        } catch (exception) {
          error("Failed to open the action ring from the Token HUD.", exception);
        }
      })();
    });

    control.addEventListener("contextmenu", event => {
      event.preventDefault();
      event.stopPropagation();
      void (async () => {
        try {
          await actor.sheet?.render?.(true);
          await app.close({ animate: false });
        } catch (exception) {
          error("Failed to open action-ring details from the Token HUD.", exception);
        }
      })();
    });

    configControl.insertAdjacentElement("afterend", control);
  });

  Hooks.on("canvasPan", () => void ActionRing.closeAll());
  Hooks.on("controlToken", () => void ActionRing.closeAll());
  Hooks.on("canvasTearDown", () => void ActionRing.closeAll());
  window.addEventListener("resize", () => ActionRing.current?.setPosition(), { passive: true });
}
