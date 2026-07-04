import { DISENGAGEMENT_METHODS } from "../constants.mjs";
import { isCombatantMounted } from "../combat/disengagement.mjs";
import { getCombatantState } from "../combat/state.mjs";
import { requestGm } from "../socket.mjs";
import { RenderCoordinator } from "../ui/render-coordinator.mjs";
import { error } from "../logger.mjs";
import { actionThemeClass, actorPortraitSource, htmlEscape, isVideoSource } from "../ui/dom-utils.mjs";
import {
  currentTargetSnapshots,
  registerTargetRefresh,
  unregisterTargetRefresh
} from "./target-refresh-helpers.mjs";

const { DialogV2 } = foundry.applications.api;

function localize(key) {
  return game.i18n.localize(key);
}

function partnerOptions(combat, combatant) {
  const state = getCombatantState(combatant);
  const ids = Array.from(new Set(state.engagement?.partnerIds ?? []));
  const combatants = Array.from(combat?.combatants ?? []);
  return ids
    .map(id => combat?.combatants?.get?.(id) ?? combatants.find(candidate => candidate?.id === id) ?? null)
    .filter(Boolean);
}

function combatantPortrait(combatant) {
  const src = actorPortraitSource(combatant?.actor, combatant?.token);
  if (!src) return '<i class="fa-solid fa-person-running" inert></i>';
  const safe = htmlEscape(src);
  return isVideoSource(src)
    ? `<video src="${safe}" autoplay muted loop playsinline></video>`
    : `<img src="${safe}" alt="" loading="lazy">`;
}

function partnerNames(partners) {
  const names = partners.map(partner => partner?.name).filter(Boolean);
  return names.length ? names.join(", ") : localize("AOV_SKJALDBORG.DisengageDialog.NoEngagedOpponents");
}

function combatantTokenIds(combatant) {
  const token = combatant?.token ?? combatant?.tokenDocument ?? null;
  return new Set([
    combatant?.tokenId,
    token?.id,
    token?._id,
    token?.uuid
  ].map(value => String(value ?? "").trim()).filter(Boolean));
}

function targetMatchesCombatant(target, combatant) {
  const ids = combatantTokenIds(combatant);
  return ids.has(String(target?.tokenId ?? "")) || ids.has(String(target?.tokenUuid ?? ""));
}

function selectedPartnerIds(partners, targets) {
  const targetedPartners = partners.filter(partner => targets.some(target => targetMatchesCombatant(target, partner)));
  const selected = targetedPartners.length ? targetedPartners : partners;
  return new Set(selected.map(partner => String(partner?.id ?? "")).filter(Boolean));
}

function renderOpponentCards(partners, selectedIds) {
  if (!partners.length) {
    return `<div class="skj-disengage-opponents__empty">${htmlEscape(localize("AOV_SKJALDBORG.DisengageDialog.NoEngagedOpponentsHint"))}</div>`;
  }
  return partners.map(partner => {
    const name = partner.name ?? localize("AOV_SKJALDBORG.DisengageDialog.UnknownOpponent");
    const mountedClass = isCombatantMounted(partner) ? " is-mounted" : "";
    const checked = selectedIds.has(String(partner.id ?? "")) ? " checked" : "";
    const tooltip = game.i18n.format("AOV_SKJALDBORG.DisengageDialog.OpponentSelectionTooltip", { opponent: name });
    return `
      <label class="skj-disengage-opponent${mountedClass}" data-opponent-id="${htmlEscape(partner.id)}" data-tooltip="${htmlEscape(tooltip)}">
        <input type="checkbox" name="partnerIds" value="${htmlEscape(partner.id)}"${checked}>
        <span class="skj-disengage-opponent__check" aria-hidden="true"></span>
        <span class="skj-disengage-opponent__portrait" aria-hidden="true">${combatantPortrait(partner)}</span>
        <span class="skj-disengage-opponent__copy">
          <strong>${htmlEscape(name)}</strong>
        </span>
      </label>
    `;
  }).join("");
}

function renderContent({ combat, combatant, targets = [] }) {
  const partners = partnerOptions(combat, combatant);
  const selectedIds = selectedPartnerIds(partners, targets);
  const mounted = isCombatantMounted(combatant);
  const mountedOpponents = partners.filter(isCombatantMounted);
  const retreatDisabled = !mounted && mountedOpponents.length > 0;
  return `
    <div class="skj-disengage-dialog ${actionThemeClass()}">
      <header class="skj-disengage-dialog__header">
        <div class="skj-disengage-dialog__portrait">${combatantPortrait(combatant)}</div>
        <div class="skj-disengage-dialog__identity">
          <span class="skj-disengage-dialog__actor">${htmlEscape(combatant?.name ?? "")}</span>
          <strong>${htmlEscape(localize("AOV_SKJALDBORG.DisengageDialog.HeaderTitle"))}</strong>
          <span>${htmlEscape(game.i18n.format("AOV_SKJALDBORG.DisengageDialog.EngagedWith", { opponents: partnerNames(partners) }))}</span>
        </div>
        <div class="skj-disengage-dialog__badge">
          <span>${htmlEscape(localize("AOV_SKJALDBORG.DisengageDialog.Badge"))}</span>
          <strong>${partners.length}</strong>
        </div>
      </header>
      <section class="skj-disengage-dialog__body">
        <p class="skj-dialog-note">${htmlEscape(localize("AOV_SKJALDBORG.DisengageDialog.Intro"))}</p>
        ${retreatDisabled ? `<p class="skj-dialog-warning"><i class="fa-solid fa-triangle-exclamation" inert></i>${htmlEscape(localize("AOV_SKJALDBORG.Warnings.CannotRetreatFromMounted"))}</p>` : ""}
        <div class="skj-disengage-options">
          <label class="skj-disengage-option ${retreatDisabled ? "is-disabled" : ""}" data-tooltip="${htmlEscape(localize("AOV_SKJALDBORG.DisengageDialog.Methods.retreat.Description"))}">
            <input type="radio" name="method" value="${DISENGAGEMENT_METHODS.RETREAT}" ${retreatDisabled ? "disabled" : "checked"}>
            <span class="skj-disengage-option__mark" aria-hidden="true"></span>
            <span class="skj-disengage-option__copy"><strong>${htmlEscape(localize("AOV_SKJALDBORG.DisengageDialog.Methods.retreat.Label"))}</strong></span>
          </label>
          <label class="skj-disengage-option" data-tooltip="${htmlEscape(localize("AOV_SKJALDBORG.DisengageDialog.Methods.flee.Description"))}">
            <input type="radio" name="method" value="${DISENGAGEMENT_METHODS.FLEE}" ${retreatDisabled ? "checked" : ""}>
            <span class="skj-disengage-option__mark" aria-hidden="true"></span>
            <span class="skj-disengage-option__copy"><strong>${htmlEscape(localize("AOV_SKJALDBORG.DisengageDialog.Methods.flee.Label"))}</strong></span>
          </label>
        </div>
        <section class="skj-disengage-opponents" aria-label="${htmlEscape(localize("AOV_SKJALDBORG.DisengageDialog.Opponents"))}">
          <header class="skj-disengage-opponents__header">
            <span><i class="fa-solid fa-people-arrows" inert></i>${htmlEscape(localize("AOV_SKJALDBORG.DisengageDialog.Opponents"))}</span>
            <small>${htmlEscape(localize("AOV_SKJALDBORG.DisengageDialog.OpponentsHint"))}</small>
          </header>
          <div class="skj-disengage-opponents__list ${partners.length ? "" : "is-empty"}">
            ${renderOpponentCards(partners, selectedIds)}
          </div>
        </section>
      </section>
      <footer class="skj-disengage-dialog__footer">
        <button type="button" class="skj-disengage-confirm-button" data-action="confirmDisengage" ${partners.length ? "" : "disabled"}>
          <i class="fa-solid fa-person-running" aria-hidden="true"></i>
          <span>${htmlEscape(localize("AOV_SKJALDBORG.DisengageDialog.Confirm"))}</span>
        </button>
      </footer>
    </div>`;
}

export class DisengageDialog extends DialogV2 {
  static current = null;

  static DEFAULT_OPTIONS = {
    ...super.DEFAULT_OPTIONS,
    classes: ["aov-skjaldborg", "dialog", "skj-disengage-window"],
    window: {
      ...super.DEFAULT_OPTIONS.window,
      contentTag: "form",
      contentClasses: ["aov-skjaldborg", "skj-disengage-content"]
    },
    position: { width: 430, height: "auto" },
    actions: {
      ...super.DEFAULT_OPTIONS.actions,
      confirmDisengage: function (event, target) {
        return this._onConfirmDisengage(event, target);
      }
    }
  };

  constructor({ actor, combatant, combat = game.combat }) {
    let dialog;
    const themeClass = actionThemeClass();
    super({
      classes: ["aov-skjaldborg", "dialog", "skj-disengage-window", themeClass],
      window: {
        title: localize("AOV_SKJALDBORG.DisengageDialog.Title"),
        contentTag: "form",
        contentClasses: ["aov-skjaldborg", "skj-disengage-content", themeClass]
      },
      position: { width: 430, height: "auto" },
      modal: true,
      buttons: [
        {
          action: "confirm",
          label: localize("AOV_SKJALDBORG.DisengageDialog.Confirm"),
          default: true,
          callback: async (_event, button) => dialog._submit(button.form)
        },
        { action: "cancel", label: localize("Cancel") }
      ]
    });
    dialog = this;
    this.actor = actor;
    this.combatant = combatant;
    this.combat = combat;
    this.targets = currentTargetSnapshots();
    this.methodValue = "";
    this._waitResolve = null;
    this._submitted = false;
  }

  wait() {
    return new Promise(resolve => {
      this._waitResolve = resolve;
    });
  }

  async _renderHTML() {
    return renderContent({ combat: this.combat, combatant: this.combatant, targets: this.targets });
  }

  _replaceHTML(result, content) {
    content.innerHTML = result;
  }

  _onRender(context, options) {
    super._onRender(context, options);
    const form = this.element.querySelector("form.window-content") ?? this.element.querySelector("form");
    if (!(form instanceof HTMLFormElement) || form.dataset.skjDisengageConfigured === "true") return;
    form.dataset.skjDisengageConfigured = "true";
    registerTargetRefresh(this, () => this._refreshTargets());
    this._restoreMethod(form);
    form.addEventListener("change", () => this._captureMethod(form));
  }

  async close(options = {}) {
    unregisterTargetRefresh(this);
    const result = await super.close(options);
    if (DisengageDialog.current === this) DisengageDialog.current = null;
    if (!this._submitted) this._waitResolve?.(null);
    return result;
  }

  _captureMethod(form) {
    const method = form?.elements?.method;
    this.methodValue = String(method?.value ?? this.methodValue ?? "");
  }

  _restoreMethod(form) {
    if (!this.methodValue) return;
    const input = Array.from(form.querySelectorAll("input[name='method']:not(:disabled)"))
      .find(candidate => String(candidate.value ?? "") === this.methodValue);
    if (input instanceof HTMLInputElement) input.checked = true;
  }

  async _refreshTargets() {
    const form = this.element?.querySelector?.("form.window-content") ?? this.element?.querySelector?.("form");
    this._captureMethod(form);
    this.targets = currentTargetSnapshots();
    await this.render({ force: true });
  }

  _readResult(form) {
    const selectedPartnerIds = Array.from(form?.querySelectorAll?.("input[name='partnerIds']:checked") ?? [])
      .map(input => String(input.value ?? ""))
      .filter(Boolean);
    return {
      method: String(form?.elements?.method?.value ?? DISENGAGEMENT_METHODS.RETREAT),
      partnerIds: selectedPartnerIds,
      opportunityAttackerId: selectedPartnerIds[0] ?? "",
      opportunityAttackerIds: selectedPartnerIds,
      opportunityMode: "all"
    };
  }

  async _submit(form) {
    const result = this._readResult(form);
    this._submitted = true;
    this._waitResolve?.(result);
    await this.close();
    return result;
  }

  async _onConfirmDisengage(event, target) {
    event.preventDefault();
    const form = target.closest("form");
    return this._submit(form);
  }

  static async show({ actor, combatant, combat = game.combat } = {}) {
    if (!actor?.isOwner) {
      ui.notifications.warn(localize("AOV_SKJALDBORG.Warnings.NotOwner"));
      return null;
    }
    if (!combat?.started || !combatant) {
      ui.notifications.warn(localize("AOV_SKJALDBORG.Warnings.NoCombatant"));
      return null;
    }
    try {
      if (this.current) await this.current.close({ force: true });
      this.current = new DisengageDialog({ actor, combatant, combat });
      const wait = this.current.wait();
      await this.current.render({ force: true });
      const result = await wait;
      if (!result) return null;
      const liveState = getCombatantState(combatant);
      const declared = await requestGm("declareDisengagement", {
        combatId: combat.id,
        combatantId: combatant.id,
        expectedCombatantUpdatedAt: liveState.updatedAt,
        method: result.method,
        partnerIds: Array.isArray(result.partnerIds) ? result.partnerIds : [],
        opportunityAttackerId: result.opportunityAttackerId || null,
        opportunityAttackerIds: Array.isArray(result.opportunityAttackerIds) ? result.opportunityAttackerIds : [],
        opportunityMode: result.opportunityMode
      });
      RenderCoordinator.invalidateCombatTracker("disengagement-dialog");
      return declared;
    } catch (exception) {
      error("Failed to declare disengagement.", exception);
      ui.notifications.error(exception?.message ?? localize("AOV_SKJALDBORG.Warnings.ActionFailed"));
      return null;
    }
  }
}
