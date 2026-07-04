import { getAttackWeapons, getReadiedWeapon } from "../combat/weapon-state.mjs";
import { mountedCapSummary, mountedWeaponCap } from "../combat/mounted-combat.mjs";
import { startKnockbackAttack } from "../combat/knockback-automation.mjs";
import { error } from "../logger.mjs";
import { actionThemeClass, actorPortraitSource, isVideoSource } from "../ui/dom-utils.mjs";
import {
  itemTotal,
  signed,
  SITUATIONAL_MODIFIERS,
  updateModifierSummary
} from "./special-action-dialog-helpers.mjs";
import {
  captureFormValues,
  currentTargetSnapshots,
  registerTargetRefresh,
  restoreFormValues,
  serializeTargetSnapshot,
  unregisterTargetRefresh
} from "./target-refresh-helpers.mjs";

const { DialogV2 } = foundry.applications.api;

function resistanceSummary(_actor, _targetActor) {
  return game.i18n.localize("AOV_SKJALDBORG.KnockbackDialog.ResistancePublicSummary");
}

export class KnockbackRollDialog extends DialogV2 {
  static current = null;

  static DEFAULT_OPTIONS = {
    ...super.DEFAULT_OPTIONS,
    classes: ["aov-skjaldborg", "dialog", "skj-attack-roll-window", "skj-knockback-roll-window"],
    window: {
      ...super.DEFAULT_OPTIONS.window,
      contentTag: "form",
      contentClasses: ["aov-skjaldborg", "skj-attack-roll-content"]
    },
    position: { width: 390, height: "auto" },
    actions: {
      ...super.DEFAULT_OPTIONS.actions,
      submitKnockback: function (event, target) {
        return this._onSubmitKnockback(event, target);
      }
    }
  };

  constructor({ actor, targets = [], targetToken = null, weapons = [], originEvent = null }) {
    let dialog;
    const themeClass = actionThemeClass();
    super({
      classes: ["aov-skjaldborg", "dialog", "skj-attack-roll-window", "skj-knockback-roll-window", themeClass],
      window: {
        title: game.i18n.localize("AOV_SKJALDBORG.KnockbackDialog.Title"),
        contentTag: "form",
        contentClasses: ["aov-skjaldborg", "skj-attack-roll-content", themeClass]
      },
      buttons: [
        {
          action: "roll",
          icon: '<i class="fa-solid fa-people-arrows-left-right"></i>',
          label: game.i18n.localize("AOV_SKJALDBORG.KnockbackDialog.RollKnockback"),
          default: true,
          callback: async (_event, button) => dialog._submit(button.form)
        },
        { action: "cancel", label: game.i18n.localize("Cancel") }
      ],
      position: { width: 390, height: "auto" }
    });
    dialog = this;
    this.actor = actor;
    this.targetSnapshots = targets.length ? targets : currentTargetSnapshots();
    this.activeTargetKey = this.targetSnapshots[0]?.key ?? "";
    this.targetToken = this.targetSnapshots[0]?.token ?? targetToken ?? null;
    this.targetActor = this.targetSnapshots[0]?.actor ?? targetToken?.actor ?? null;
    this.originEvent = originEvent;
    this.formValues = {};
    this.availableWeaponIds = Array.from(weapons, weapon => String(weapon?.id ?? "")).filter(Boolean);
    const readied = getReadiedWeapon(actor);
    this.weapon = weapons.find(weapon => weapon?.id === readied?.id) ?? weapons[0] ?? null;
  }

  static async show({ actor, originEvent = null } = {}) {
    if (!actor) {
      ui.notifications.warn(game.i18n.localize("AOV_SKJALDBORG.Warnings.ActorUnavailable"));
      return null;
    }
    const targets = currentTargetSnapshots();
    if (!targets.length) {
      ui.notifications.warn(game.i18n.localize("AOV_SKJALDBORG.Warnings.KnockbackTargetRequired"));
      return null;
    }
    const weapons = await getAttackWeapons(actor);
    if (!weapons.length) {
      ui.notifications.warn(game.i18n.format("AOV_SKJALDBORG.Warnings.NoKnockbackWeapons", {
        actor: actor.name ?? game.i18n.localize("AOV_SKJALDBORG.Warnings.ActorUnavailable")
      }));
      return null;
    }
    if (this.current) await this.current.close({ force: true });
    this.current = new KnockbackRollDialog({ actor, targets, weapons, originEvent });
    await this.current.render({ force: true });
    return this.current;
  }

  async close(options = {}) {
    unregisterTargetRefresh(this);
    const result = await super.close(options);
    if (KnockbackRollDialog.current === this) KnockbackRollDialog.current = null;
    return result;
  }

  _activeTarget() {
    return this.targetSnapshots.find(target => target.key === this.activeTargetKey) ?? this.targetSnapshots[0] ?? null;
  }

  _setActiveTarget(snapshot) {
    this.activeTargetKey = snapshot?.key ?? "";
    this.targetToken = snapshot?.token ?? null;
    this.targetActor = snapshot?.actor ?? null;
  }

  _captureForm(form) {
    this.formValues = captureFormValues(form);
  }

  async _refreshTargets() {
    const form = this.element?.querySelector?.("form.window-content") ?? this.element?.querySelector?.("form");
    this._captureForm(form);
    this.targetSnapshots = currentTargetSnapshots();
    if (!this.targetSnapshots.some(target => target.key === this.activeTargetKey)) {
      this.activeTargetKey = this.targetSnapshots[0]?.key ?? "";
    }
    this._setActiveTarget(this._activeTarget());
    await this.render({ force: true });
  }

  async _renderHTML() {
    return foundry.applications.handlebars.renderTemplate(
      "modules/aov-skjaldborg/templates/knockback-roll-dialog.hbs",
      this._prepareDialogContext()
    );
  }

  _replaceHTML(result, content) {
    content.innerHTML = result;
  }

  _onRender(context, options) {
    super._onRender(context, options);
    const form = this.element.querySelector("form.window-content") ?? this.element.querySelector("form");
    if (!(form instanceof HTMLFormElement) || form.dataset.skjKnockbackConfigured === "true") return;
    form.dataset.skjKnockbackConfigured = "true";
    registerTargetRefresh(this, () => this._refreshTargets());
    restoreFormValues(form, this.formValues);
    form.addEventListener("change", event => this._onFormChange(event, form));
    form.addEventListener("input", event => this._onFormChange(event, form));
    form.addEventListener("click", event => {
      const targetControl = event.target instanceof Element ? event.target.closest("[data-target-key]") : null;
      if (!targetControl) return;
      event.preventDefault();
      this._captureForm(form);
      this.activeTargetKey = String(targetControl.dataset.targetKey ?? "");
      this._setActiveTarget(this._activeTarget());
      void this.render({ force: true });
    });
    this._updatePreview(form);
  }

  _getAvailableWeapons() {
    const actorItems = Array.from(this.actor?.items ?? []);
    return this.availableWeaponIds
      .map(id => this.actor?.items?.get?.(id) ?? actorItems.find(item => item?.id === id) ?? null)
      .filter(Boolean);
  }

  _getAvailableWeapon(itemId) {
    return this._getAvailableWeapons().find(item => item?.id === itemId) ?? null;
  }

  _prepareDialogContext() {
    this._setActiveTarget(this._activeTarget());
    const weapons = this._getAvailableWeapons();
    const mountedCap = mountedWeaponCap(this.actor, itemTotal(this.weapon));
    const baseChance = mountedCap.baseChance;
    const targetImg = actorPortraitSource(this.targetActor, this.targetToken);
    return {
      actorName: this.actor?.name ?? "",
      targetName: this.targetActor?.name ?? this.targetToken?.name ?? "",
      targets: this.targetSnapshots.map(target => ({
        ...serializeTargetSnapshot(target),
        active: target.key === this.activeTargetKey
      })),
      hasTargets: this.targetSnapshots.length > 0,
      targetImg,
      targetImgIsVideo: isVideoSource(targetImg),
      weaponName: this.weapon?.name ?? "",
      baseChance,
      targetNumber: baseChance,
      resistanceSummary: resistanceSummary(this.actor, this.targetActor),
      weapons: weapons.map(item => ({ id: item.id, label: `${item.name} (${mountedWeaponCap(this.actor, itemTotal(item)).baseChance}%)`, selected: item.id === this.weapon?.id })),
      modifiers: SITUATIONAL_MODIFIERS.map(entry => ({
        value: entry.value,
        label: game.i18n.localize(`AOV_SKJALDBORG.AttackDialog.Modifiers.${entry.key}`),
        selected: entry.value === 0
      })),
      initialSummary: this._formatSummary({ baseChance, mountedCap, targetNumber: baseChance, situationalModifier: 0, augmentModifier: 0 })
    };
  }

  _onFormChange(event, form) {
    const target = event.target;
    if (target instanceof HTMLSelectElement && target.name === "weaponId") {
      this.weapon = this._getAvailableWeapon(target.value) ?? this.weapon;
    }
    this._updatePreview(form);
  }

  _readFormState(form, targetSnapshot = this._activeTarget()) {
    const data = new FormData(form);
    const weaponId = String(data.get("weaponId") ?? this.weapon?.id ?? "");
    const weapon = this._getAvailableWeapon(weaponId) ?? this.weapon;
    const mountedCap = mountedWeaponCap(this.actor, itemTotal(weapon));
    const baseChance = mountedCap.baseChance;
    const situationalModifier = Number(data.get("situationalModifier")) || 0;
    const augmentModifier = Number(data.get("customAugmentValue")) || 0;
    const customReason = String(data.get("customAugmentReason") ?? "").trim();
    return {
      weapon,
      weaponId: weapon?.id ?? weaponId,
      targetSnapshot,
      targetToken: targetSnapshot?.token ?? this.targetToken,
      targetActor: targetSnapshot?.actor ?? this.targetActor,
      baseChance,
      mountedCap,
      situationalModifier,
      augmentModifier,
      targetNumber: baseChance + situationalModifier + augmentModifier,
      augmentations: {
        custom: customReason || augmentModifier
          ? {
              reason: customReason,
              value: augmentModifier
            }
          : null
      }
    };
  }

  _updatePreview(form) {
    const state = this._readFormState(form);
    this.weapon = state.weapon;
    const targetNumber = form.querySelector("[data-target-number]");
    if (targetNumber) targetNumber.textContent = `${state.targetNumber}%`;
    const chanceLabel = form.querySelector("[data-target-caption]");
    if (chanceLabel) {
      const select = form.elements.namedItem("situationalModifier");
      const option = select instanceof HTMLSelectElement ? select.selectedOptions[0] : null;
      chanceLabel.textContent = option?.textContent?.trim() ?? game.i18n.localize("AOV_SKJALDBORG.AttackDialog.Modifiers.Standard");
    }
    const submit = form.querySelector("[data-action='submitKnockback']");
    if (submit instanceof HTMLButtonElement) submit.disabled = !this.targetSnapshots.length;
    updateModifierSummary(form, state, this._formatSummary(state));
  }

  _formatSummary(state) {
    const summary = game.i18n.format("AOV_SKJALDBORG.KnockbackDialog.Summary", {
      base: state.baseChance,
      situation: signed(state.situationalModifier),
      augment: signed(state.augmentModifier)
    });
    const mounted = mountedCapSummary(state.mountedCap);
    return mounted ? `${summary} · ${mounted}` : summary;
  }

  async _submit(form) {
    if (!(form instanceof HTMLFormElement)) return null;
    try {
      this._captureForm(form);
      if (!this.targetSnapshots.length) {
        ui.notifications.warn(game.i18n.localize("AOV_SKJALDBORG.Warnings.KnockbackTargetRequired"));
        return null;
      }
      const batchId = foundry.utils.randomID();
      const payloads = this.targetSnapshots.map((target, index) => {
        const state = this._readFormState(form, target);
        return {
          app: this,
          actor: this.actor,
          actorUuid: this.actor?.uuid ?? null,
          targetToken: state.targetToken,
          targetTokenUuid: state.targetToken?.document?.uuid ?? state.targetSnapshot?.tokenUuid ?? null,
          targetActor: state.targetActor,
          targetActorUuid: state.targetActor?.uuid ?? state.targetSnapshot?.actorUuid ?? null,
          weapon: state.weapon,
          weaponUuid: state.weapon?.uuid ?? null,
          baseChance: state.baseChance,
          situationalModifier: state.situationalModifier,
          augmentModifier: state.augmentModifier,
          targetNumber: state.targetNumber,
          augmentations: state.augmentations,
          batchId,
          batchIndex: index,
          batchSize: this.targetSnapshots.length,
          originEvent: this.originEvent
        };
      });
      const payload = payloads[0];
      for (const requestPayload of payloads) {
        Hooks.callAll("aovSkjaldborgKnockbackRollRequested", requestPayload);
        await startKnockbackAttack(requestPayload);
      }
      ui.notifications.info(game.i18n.localize("AOV_SKJALDBORG.KnockbackDialog.WorkflowQueued"));
      await this.close();
      return payload;
    } catch (exception) {
      error("Failed to prepare the Skjaldborg knockback workflow request.", exception);
      ui.notifications.error(game.i18n.localize("AOV_SKJALDBORG.Warnings.ActionFailed"));
      return null;
    }
  }

  async _onSubmitKnockback(event, target) {
    event.preventDefault();
    const form = target.closest("form");
    return this._submit(form);
  }
}
