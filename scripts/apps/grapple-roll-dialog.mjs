import { hasGrappleHoldForPair, startGrappleAttack } from "../combat/grapple-automation.mjs";
import { error } from "../logger.mjs";
import { actionThemeClass, actorPortraitSource, isVideoSource } from "../ui/dom-utils.mjs";
import {
  itemTotal,
  itemsOfType,
  normalizeDescriptor,
  signed,
  SITUATIONAL_MODIFIERS,
  targetHitLocationChoices,
  updateModifierSummary
} from "./combat-roll-dialog-helpers.mjs";
import {
  captureFormValues,
  currentTargetSnapshots,
  pickFormValues,
  registerTargetRefresh,
  restoreFormValues,
  serializeTargetSnapshot,
  unregisterTargetRefresh,
  validChoiceValue
} from "./target-refresh-helpers.mjs";

const { DialogV2 } = foundry.applications.api;

const GRAPPLE_SKILL_CID = "i.skill.grapple";
const TARGET_OPTION_FIELDS = Object.freeze(["mode", "locationMode", "manualLocationId"]);

function itemCid(item) {
  return String(item?.flags?.aov?.cidFlag?.id ?? item?.system?.cid ?? item?.system?.skillCID ?? "").trim();
}

function isGrappleSkill(item) {
  if (item?.type !== "skill") return false;
  if (itemCid(item) === GRAPPLE_SKILL_CID) return true;
  const descriptors = [item.name, item.system?.name, item.system?.label]
    .map(normalizeDescriptor)
    .filter(Boolean);
  return descriptors.some(descriptor => descriptor === "grapple" || descriptor.includes("grapple"));
}

function getGrappleSkills(actor) {
  return itemsOfType(actor, "skill").filter(isGrappleSkill);
}

/**
 * Initial Grapple workflow dialog.
 *
 * The dialog prepares the core skill roll and optional grapple-location
 * selection, then delegates the actual opposed-card and follow-up automation to
 * `grapple-automation.mjs`.
 */
export class GrappleRollDialog extends DialogV2 {
  static current = null;

  static DEFAULT_OPTIONS = {
    ...super.DEFAULT_OPTIONS,
    classes: ["aov-skjaldborg", "dialog", "skj-attack-roll-window", "skj-grapple-roll-window"],
    window: {
      ...super.DEFAULT_OPTIONS.window,
      contentTag: "form",
      contentClasses: ["aov-skjaldborg", "skj-attack-roll-content"]
    },
    position: { width: 390, height: "auto" },
    actions: {
      ...super.DEFAULT_OPTIONS.actions,
      submitGrapple: function (event, target) {
        return this._onSubmitGrapple(event, target);
      }
    }
  };

  constructor({ actor, targets = [], targetToken = null, weapons = [], originEvent = null }) {
    let dialog;
    const themeClass = actionThemeClass();
    super({
      classes: ["aov-skjaldborg", "dialog", "skj-attack-roll-window", "skj-grapple-roll-window", themeClass],
      window: {
        title: game.i18n.localize("AOV_SKJALDBORG.GrappleDialog.Title"),
        contentTag: "form",
        contentClasses: ["aov-skjaldborg", "skj-attack-roll-content", themeClass]
      },
      buttons: [
        {
          action: "roll",
          icon: '<i class="fa-solid fa-people-pulling"></i>',
          label: game.i18n.localize("AOV_SKJALDBORG.GrappleDialog.RollGrapple"),
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
    this.targetOptionValues = new Map();
    this.availableWeaponIds = Array.from(weapons, weapon => String(weapon?.id ?? "")).filter(Boolean);
    this.weapon = weapons[0] ?? null;
  }

  static async show({ actor, originEvent = null } = {}) {
    if (!actor) {
      ui.notifications.warn(game.i18n.localize("AOV_SKJALDBORG.Warnings.ActorUnavailable"));
      return null;
    }
    const targets = currentTargetSnapshots();
    if (!targets.length) {
      ui.notifications.warn(game.i18n.localize("AOV_SKJALDBORG.Warnings.GrappleTargetRequired"));
      return null;
    }
    const weapons = getGrappleSkills(actor);
    if (!weapons.length) {
      ui.notifications.warn(game.i18n.format("AOV_SKJALDBORG.Warnings.NoGrappleSkill", {
        actor: actor.name ?? game.i18n.localize("AOV_SKJALDBORG.Warnings.ActorUnavailable")
      }));
      return null;
    }
    if (this.current) await this.current.close({ force: true });
    this.current = new GrappleRollDialog({ actor, targets, weapons, originEvent });
    await this.current.render({ force: true });
    return this.current;
  }

  async close(options = {}) {
    unregisterTargetRefresh(this);
    const result = await super.close(options);
    if (GrappleRollDialog.current === this) GrappleRollDialog.current = null;
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
    const values = captureFormValues(form);
    if (this.activeTargetKey) {
      this.targetOptionValues.set(this.activeTargetKey, pickFormValues(values, TARGET_OPTION_FIELDS));
    }
    this.formValues = values;
  }

  _restoreForm(form) {
    const commonValues = { ...this.formValues };
    for (const field of TARGET_OPTION_FIELDS) delete commonValues[field];
    restoreFormValues(form, commonValues);
    const targetValues = this.targetOptionValues.get(this.activeTargetKey);
    if (targetValues) restoreFormValues(form, targetValues);
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
      "modules/aov-skjaldborg/templates/grapple-roll-dialog.hbs",
      this._prepareDialogContext()
    );
  }

  _replaceHTML(result, content) {
    content.innerHTML = result;
  }

  _onRender(context, options) {
    super._onRender(context, options);
    const form = this.element.querySelector("form.window-content") ?? this.element.querySelector("form");
    if (!(form instanceof HTMLFormElement) || form.dataset.skjGrappleConfigured === "true") return;
    form.dataset.skjGrappleConfigured = "true";
    registerTargetRefresh(this, () => this._refreshTargets());
    this._restoreForm(form);
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
    this._updateLocationMode(form);
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
    if (!weapons.some(item => item.id === this.weapon?.id)) this.weapon = weapons[0] ?? null;
    const baseChance = itemTotal(this.weapon);
    const targetImg = actorPortraitSource(this.targetActor, this.targetToken);
    const held = hasGrappleHoldForPair(this.targetActor, this.actor);
    const locations = targetHitLocationChoices(this.targetActor);
    return {
      actorName: this.actor?.name ?? "",
      targetName: this.targetActor?.name ?? this.targetToken?.name ?? "",
      targets: this.targetSnapshots.map(target => ({
        ...serializeTargetSnapshot(target),
        active: target.key === this.activeTargetKey
      })),
      targetCount: this.targetSnapshots.length,
      hasTargets: this.targetSnapshots.length > 0,
      targetImg,
      targetImgIsVideo: isVideoSource(targetImg),
      weaponName: this.weapon?.name ?? "",
      baseChance,
      targetNumber: baseChance,
      held,
      locations,
      hasLocations: locations.length > 0,
      resistanceSummary: game.i18n.localize("AOV_SKJALDBORG.GrappleDialog.ResistancePublicSummary"),
      weapons: weapons.map(item => ({ id: item.id, label: `${item.name} (${itemTotal(item)}%)`, selected: item.id === this.weapon?.id })),
      modifiers: SITUATIONAL_MODIFIERS.map(entry => ({
        value: entry.value,
        label: game.i18n.localize(`AOV_SKJALDBORG.AttackDialog.Modifiers.${entry.key}`),
        selected: entry.value === 0
      })),
      modes: [
        { value: "grapple", label: game.i18n.localize("AOV_SKJALDBORG.GrappleDialog.Modes.Grapple"), disabled: false, selected: !held },
        { value: "immobilize", label: game.i18n.localize("AOV_SKJALDBORG.GrappleDialog.Modes.Immobilize"), disabled: !held, selected: held },
        { value: "throw", label: game.i18n.localize("AOV_SKJALDBORG.GrappleDialog.Modes.Throw"), disabled: !held, selected: false }
      ],
      initialSummary: this._formatSummary({ baseChance, targetNumber: baseChance, situationalModifier: 0, augmentModifier: 0 })
    };
  }

  _onFormChange(event, form) {
    const target = event.target;
    if (target instanceof HTMLSelectElement && target.name === "weaponId") {
      this.weapon = this._getAvailableWeapon(target.value) ?? this.weapon;
    }
    this._updateLocationMode(form);
    this._updatePreview(form);
  }

  _updateLocationMode(form) {
    const data = new FormData(form);
    const mode = String(data.get("mode") ?? "grapple");
    const locationMode = String(data.get("locationMode") ?? "roll");
    const locationSection = form.querySelector("[data-grapple-location-section]");
    const manualRow = form.querySelector("[data-grapple-manual-location]");
    if (locationSection) locationSection.hidden = mode !== "grapple";
    if (manualRow) manualRow.hidden = mode !== "grapple" || locationMode !== "manual";
  }

  _readFormState(form, targetSnapshot = this._activeTarget()) {
    const data = new FormData(form);
    const weaponId = String(data.get("weaponId") ?? this.weapon?.id ?? "");
    const weapon = this._getAvailableWeapon(weaponId) ?? this.weapon;
    const targetActor = targetSnapshot?.actor ?? this.targetActor;
    const targetToken = targetSnapshot?.token ?? this.targetToken;
    const storedTargetOptions = this.targetOptionValues.get(targetSnapshot?.key ?? "") ?? {};
    const targetValue = (name, fallback = "") => {
      const direct = data.get(name);
      if (targetSnapshot?.key === this.activeTargetKey && direct !== null) return direct;
      return storedTargetOptions[name]?.at?.(-1) ?? fallback;
    };
    const baseChance = itemTotal(weapon);
    const situationalModifier = Number(data.get("situationalModifier")) || 0;
    const augmentModifier = Number(data.get("customAugmentValue")) || 0;
    const customReason = String(data.get("customAugmentReason") ?? "").trim();
    const held = hasGrappleHoldForPair(targetActor, this.actor);
    const requestedMode = String(targetValue("mode", held ? "immobilize" : "grapple"));
    const mode = (requestedMode === "immobilize" || requestedMode === "throw")
      ? (held ? requestedMode : "grapple")
      : "grapple";
    const locations = targetHitLocationChoices(targetActor);
    const requestedLocationMode = String(targetValue("locationMode", "roll"));
    const locationMode = requestedLocationMode === "manual" && mode === "grapple" && locations.length ? "manual" : "roll";
    const manualLocationId = locationMode === "manual"
      ? validChoiceValue(targetValue("manualLocationId"), locations, "id")
      : "";
    return {
      weapon,
      weaponId: weapon?.id ?? weaponId,
      targetSnapshot,
      targetToken,
      targetActor,
      baseChance,
      situationalModifier,
      augmentModifier,
      targetNumber: baseChance + situationalModifier + augmentModifier,
      mode,
      locationMode,
      manualLocationId,
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
    updateModifierSummary(form, state, this._formatSummary(state));
    const buttonText = form.querySelector("[data-grapple-submit-label]");
    if (buttonText) buttonText.textContent = game.i18n.localize(`AOV_SKJALDBORG.GrappleDialog.Submit.${state.mode}`);
    const submit = form.querySelector("[data-action='submitGrapple']");
    if (submit instanceof HTMLButtonElement) submit.disabled = !this.targetSnapshots.length;
  }

  _formatSummary(state) {
    return game.i18n.format("AOV_SKJALDBORG.GrappleDialog.Summary", {
      base: state.baseChance,
      situation: signed(state.situationalModifier),
      augment: signed(state.augmentModifier)
    });
  }

  async _submit(form) {
    if (!(form instanceof HTMLFormElement)) return null;
    try {
      this._captureForm(form);
      if (!this.targetSnapshots.length) {
        ui.notifications.warn(game.i18n.localize("AOV_SKJALDBORG.Warnings.GrappleTargetRequired"));
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
          mode: state.mode,
          locationMode: state.locationMode,
          manualLocationId: state.manualLocationId,
          targets: this.targetSnapshots.map(serializeTargetSnapshot).filter(Boolean),
          targetOptionsByTokenUuid: Object.fromEntries(this.targetOptionValues),
          batchId,
          batchIndex: index,
          batchSize: this.targetSnapshots.length,
          originEvent: this.originEvent
        };
      });
      const payload = payloads[0];
      for (const requestPayload of payloads) {
        Hooks.callAll("aovSkjaldborgGrappleRollRequested", requestPayload);
        await startGrappleAttack(requestPayload);
      }
      ui.notifications.info(game.i18n.localize("AOV_SKJALDBORG.GrappleDialog.WorkflowQueued"));
      await this.close();
      return payload;
    } catch (exception) {
      error("Failed to prepare the Skjaldborg grapple workflow request.", exception);
      ui.notifications.error(game.i18n.localize("AOV_SKJALDBORG.Warnings.ActionFailed"));
      return null;
    }
  }

  async _onSubmitGrapple(event, target) {
    event.preventDefault();
    const form = target.closest("form");
    return this._submit(form);
  }
}
