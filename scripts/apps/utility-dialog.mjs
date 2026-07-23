import { AoVAdapter } from "../adapter/aov-adapter.mjs";
import {
  getCombatOptions,
  getReadiedWeaponList,
  isNaturalAttackWeapon,
  isShieldLikeWeapon,
  prepareReadiedWeaponState,
  setCombatOptions,
  setReadiedWeapons
} from "../combat/weapon-state.mjs";
import { resolveWeaponSkill } from "../combat/weapon-skill-resolver.mjs";
import { getCombatantState } from "../combat/state.mjs";
import { requestGm } from "../socket.mjs";
import { RenderCoordinator } from "../ui/render-coordinator.mjs";
import { error } from "../logger.mjs";
import { actionThemeClass, actorPortraitSource, isVideoSource } from "../ui/dom-utils.mjs";
import { SkjDialogV2 } from "./base/dialog-v2.mjs";

function numberWithin(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.max(min, Math.min(max, Math.round(number)));
}

function locationChoices(actor, selectedIds) {
  const selected = new Set(selectedIds.map(String));
  const wellbeing = AoVAdapter.prepareActorWellbeing(actor);
  return (wellbeing.locationList ?? [])
    .filter(location => String(location?.id ?? "").trim())
    .map(location => ({
      id: String(location.id),
      label: `${location.name} (${location.rollLabel})`,
      selected: selected.has(String(location.id))
    }));
}

function readiedSummary(weaponState) {
  const names = Array.isArray(weaponState?.names) ? weaponState.names.filter(Boolean) : [];
  return names.length ? names.join("; ") : game.i18n.localize("AOV_SKJALDBORG.Weapons.None");
}

function shieldCoverSummary(combatOptions, locations) {
  const selected = locations.filter(location => location.selected);
  if (!combatOptions.shieldCover?.shieldId) return game.i18n.localize("AOV_SKJALDBORG.Weapons.None");
  return `${selected.length}/3`;
}

function activeOptionCount({ combatOptions, weaponState }) {
  return [
    combatOptions.twoWeaponFighting?.enabled,
    combatOptions.shieldwall?.enabled,
    !!combatOptions.shieldCover?.shieldId,
    weaponState?.unlimited
  ].filter(Boolean).length;
}

function readHiddenLocationIds(form) {
  return Array.from(form?.querySelectorAll?.("input[name='shieldLocationIds']") ?? [])
    .map(input => String(input.value ?? ""))
    .filter(Boolean);
}

function weaponLabel(item, total) {
  return `${item?.name ?? ""} (${total}%)`;
}

function twoWeaponState(actor, combatOptions) {
  const readied = getReadiedWeaponList(actor)
    .filter(item => item?.type === "weapon" && !isNaturalAttackWeapon(item))
    .map(item => {
      const skill = resolveWeaponSkill(actor, item);
      return {
        item,
        id: String(item.id),
        name: String(item.name ?? ""),
        total: skill.total,
        eligible: skill.total >= 100,
        skillItemId: skill.skill?.id ?? null
      };
    });
  const eligible = readied.filter(entry => entry.eligible);
  const primary = eligible[0] ?? readied[0] ?? null;
  const secondary = eligible.find(entry => entry.id !== primary?.id) ?? readied.find(entry => entry.id !== primary?.id) ?? null;
  const available = !!primary?.eligible && !!secondary?.eligible;
  const primaryChance = available
    ? numberWithin(combatOptions.twoWeaponFighting?.primaryChance || primary.total, 0, primary.total)
    : 0;
  const secondaryChance = available
    ? numberWithin(combatOptions.twoWeaponFighting?.secondaryChance || secondary.total, 0, secondary.total)
    : 0;

  return {
    available,
    enabled: available && combatOptions.twoWeaponFighting?.enabled === true,
    hint: available
      ? game.i18n.localize("AOV_SKJALDBORG.Utility.TwoWeaponAvailable")
      : game.i18n.localize("AOV_SKJALDBORG.Utility.TwoWeaponUnavailable"),
    primary: primary
      ? { ...primary, label: weaponLabel(primary.item, primary.total), chance: primaryChance }
      : null,
    secondary: secondary
      ? { ...secondary, label: weaponLabel(secondary.item, secondary.total), chance: secondaryChance }
      : null,
    weapons: readied.map(entry => ({
      ...entry,
      label: weaponLabel(entry.item, entry.total)
    }))
  };
}

function formValues(form, { actor, twoWeapon }) {
  const elements = form?.elements ?? {};
  const locationIds = readHiddenLocationIds(form);
  const primaryMax = Number(elements.twoWeaponPrimaryChance?.max) || twoWeapon.primary?.total || 0;
  const secondaryMax = Number(elements.twoWeaponSecondaryChance?.max) || twoWeapon.secondary?.total || 0;
  const twoWeaponEnabled = twoWeapon.available && elements.twoWeaponEnabled?.checked === true;

  return {
    readiedWeapons: {
      right: String(elements.rightWeaponId?.value ?? "") || null,
      left: String(elements.leftWeaponId?.value ?? "") || null,
      unlimited: actor.type === "npc" && elements.unlimitedWeapons?.checked === true
    },
    combatOptions: {
      twoWeaponFighting: {
        enabled: twoWeaponEnabled,
        primaryWeaponId: twoWeaponEnabled ? String(twoWeapon.primary?.id ?? "") : "",
        secondaryWeaponId: twoWeaponEnabled ? String(twoWeapon.secondary?.id ?? "") : "",
        primaryChance: twoWeaponEnabled ? numberWithin(elements.twoWeaponPrimaryChance?.value, 0, primaryMax) : 0,
        secondaryChance: twoWeaponEnabled ? numberWithin(elements.twoWeaponSecondaryChance?.value, 0, secondaryMax) : 0
      },
      shieldCover: {
        shieldId: String(elements.shieldId?.value ?? ""),
        locationIds
      },
      shieldwall: {
        enabled: elements.shieldwallEnabled?.checked === true
      }
    }
  };
}

export class UtilityDialog extends SkjDialogV2 {
  static current = null;

  static DEFAULT_OPTIONS = {
    ...super.DEFAULT_OPTIONS,
    classes: ["aov-skjaldborg", "dialog", "skj-attack-roll-window", "skj-utility-dialog-window"],
    window: {
      ...super.DEFAULT_OPTIONS.window,
      contentTag: "form",
      contentClasses: ["aov-skjaldborg", "skj-attack-roll-content"]
    },
    position: { width: 400, height: "auto" },
    actions: {
      ...super.DEFAULT_OPTIONS.actions,
      applyUtility: function (event, target) {
        return this._onApplyUtility(event, target);
      }
    }
  };

  constructor({ actor, combatant = null, combat = game.combat } = {}) {
    let dialog;
    const themeClass = actionThemeClass();
    super({
      classes: ["aov-skjaldborg", "dialog", "skj-attack-roll-window", "skj-utility-dialog-window", themeClass],
      window: {
        title: game.i18n.localize("AOV_SKJALDBORG.Utility.Title"),
        contentTag: "form",
        contentClasses: ["aov-skjaldborg", "skj-attack-roll-content", themeClass]
      },
      buttons: [
        {
          action: "apply",
          label: game.i18n.localize("AOV_SKJALDBORG.Utility.Apply"),
          default: true,
          callback: async (_event, button) => dialog._submit(button.form)
        }
      ],
      position: { width: 400, height: "auto" },
      modal: false,
      rejectClose: false
    });
    dialog = this;
    this.actor = actor;
    this.combat = combat;
    this.combatant = combatant ?? AoVAdapter.getControlledCombatant(combat);
    this.inCombat = !!combat?.started && !!this.combatant;
  }

  /**
   * Open the Utility dialog and persist module-owned combat options.
   *
   * @param {{actor?: Actor|null, combatant?: Combatant|null, combat?: Combat|null}} [options={}] Dialog context.
   * @returns {Promise<UtilityDialog|null>} Open dialog or null when ownership checks fail.
   */
  static async show({ actor, combatant, combat = game.combat } = {}) {
    if (!actor?.isOwner) {
      ui.notifications.warn(game.i18n.localize("AOV_SKJALDBORG.Warnings.NotOwner"));
      return null;
    }
    const liveCombatant = combatant ?? AoVAdapter.getControlledCombatant(combat);
    if (combat?.started && liveCombatant && !AoVAdapter.canUserControlCombatant(game.user, liveCombatant)) {
      ui.notifications.warn(game.i18n.localize("AOV_SKJALDBORG.Warnings.NotOwner"));
      return null;
    }

    if (this.current) await this.current.close({ force: true });
    this.current = new UtilityDialog({ actor, combatant: liveCombatant, combat });
    await this.current.render({ force: true });
    return this.current;
  }

  async close(options = {}) {
    const result = await super.close(options);
    if (UtilityDialog.current === this) UtilityDialog.current = null;
    return result;
  }

  async _renderHTML() {
    return foundry.applications.handlebars.renderTemplate(
      "modules/aov-skjaldborg/templates/utility-dialog.hbs",
      this._prepareDialogContext()
    );
  }

  _replaceHTML(result, content) {
    content.innerHTML = result;
  }

  _prepareDialogContext() {
    const actor = this.actor;
    const weaponState = prepareReadiedWeaponState(actor);
    const combatOptions = getCombatOptions(actor);
    const readied = getReadiedWeaponList(actor);
    const shields = readied
      .filter(isShieldLikeWeapon)
      .map(item => ({
        id: String(item.id),
        name: String(item.name ?? ""),
        selected: String(item.id) === combatOptions.shieldCover.shieldId
      }));
    const locations = locationChoices(actor, combatOptions.shieldCover.locationIds);
    const twoWeapon = twoWeaponState(actor, combatOptions);
    const portrait = actorPortraitSource(actor);
    const optionCount = activeOptionCount({ combatOptions, weaponState });
    const utilitySummary = game.i18n.format("AOV_SKJALDBORG.Utility.Summary", {
      readied: readiedSummary(weaponState),
      shield: shieldCoverSummary(combatOptions, locations)
    });

    return {
      actorName: actor.name ?? "",
      actorInitial: String(actor.name ?? "?").trim().charAt(0).toUpperCase() || "?",
      actorImg: portrait,
      actorImgIsVideo: isVideoSource(portrait),
      weaponState,
      weapons: weaponState.carriedWeapons,
      isNpc: actor.type === "npc",
      combatOptions,
      shields,
      locations,
      selectedLocationCount: locations.filter(location => location.selected).length,
      twoWeapon,
      statusValue: optionCount ? String(optionCount) : game.i18n.localize("AOV_SKJALDBORG.Utility.Ready"),
      activeOptionCount: optionCount,
      activeOptionCaption: optionCount ? game.i18n.localize("AOV_SKJALDBORG.Utility.Active") : "",
      utilitySummary
    };
  }

  _onRender(context, options) {
    super._onRender(context, options);
    const form = this.element.querySelector("form.window-content")
      ?? this.element.querySelector("form");
    if (!(form instanceof HTMLFormElement) || form.dataset.skjUtilityConfigured === "true") return;
    form.dataset.skjUtilityConfigured = "true";
    form.addEventListener("click", event => this._onFormClick(event, form));
    form.addEventListener("change", event => this._onFormChange(event, form));
    this._syncTwoWeaponPanel(form);
    this._syncLocationUi(form);
  }

  _onFormClick(event, form) {
    const target = event.target instanceof Element ? event.target : null;
    const locationButton = target?.closest("[data-location-id]");
    if (locationButton instanceof HTMLElement) {
      event.preventDefault();
      this._toggleLocation(form, String(locationButton.dataset.locationId ?? ""));
      return;
    }
    const removeButton = target?.closest("[data-remove-location]");
    if (removeButton instanceof HTMLElement) {
      event.preventDefault();
      this._setLocationSelected(form, String(removeButton.dataset.removeLocation ?? ""), false);
    }
  }

  _onFormChange(event, form) {
    const target = event.target;
    if (target instanceof HTMLInputElement && target.name === "twoWeaponEnabled") this._syncTwoWeaponPanel(form);
  }

  _toggleLocation(form, id) {
    if (!id) return;
    const button = form.querySelector(`[data-location-id="${CSS.escape(id)}"]`);
    this._setLocationSelected(form, id, !button?.classList.contains("is-selected"));
  }

  _setLocationSelected(form, id, selected) {
    if (!id) return;
    const hiddenContainer = form.querySelector("[data-location-hidden-inputs]");
    if (!hiddenContainer) return;
    const current = new Set(readHiddenLocationIds(form));
    if (selected) current.add(id);
    else current.delete(id);
    hiddenContainer.innerHTML = "";
    for (const locationId of current) {
      const input = document.createElement("input");
      input.type = "hidden";
      input.name = "shieldLocationIds";
      input.value = locationId;
      hiddenContainer.append(input);
    }
    this._syncLocationUi(form);
  }

  _syncLocationUi(form) {
    const selected = new Set(readHiddenLocationIds(form));
    for (const button of form.querySelectorAll("[data-location-id]")) {
      button.classList.toggle("is-selected", selected.has(String(button.dataset.locationId ?? "")));
    }
    const chips = form.querySelector("[data-location-chips]");
    if (chips) {
      chips.innerHTML = "";
      const selectedButtons = Array.from(form.querySelectorAll("[data-location-id].is-selected"));
      for (const button of selectedButtons) {
        const chip = document.createElement("button");
        chip.type = "button";
        chip.className = "skj-utility-dialog__chip";
        chip.dataset.removeLocation = String(button.dataset.locationId ?? "");
        chip.textContent = button.textContent?.trim() ?? "";
        chips.append(chip);
      }
      if (!selectedButtons.length) {
        const empty = document.createElement("span");
        empty.className = "skj-utility-dialog__chip-empty";
        empty.textContent = game.i18n.localize("AOV_SKJALDBORG.Utility.NoCoveredLocations");
        chips.append(empty);
      }
    }
    const count = form.querySelector("[data-location-count]");
    if (count) count.textContent = game.i18n.format("AOV_SKJALDBORG.Utility.CoveredCount", { count: selected.size });
    this.requestContentRefit();
  }

  _syncTwoWeaponPanel(form) {
    const enabled = form.elements.twoWeaponEnabled?.checked === true;
    const panel = form.querySelector("[data-two-weapon-panel]");
    panel?.classList.toggle("is-enabled", enabled);
    for (const input of form.querySelectorAll("[data-two-weapon-chance]")) {
      if (input instanceof HTMLInputElement) input.disabled = !enabled;
    }
    this.requestContentRefit();
  }

  async _submit(form) {
    if (!(form instanceof HTMLFormElement)) return null;
    const combatOptions = getCombatOptions(this.actor);
    const twoWeapon = twoWeaponState(this.actor, combatOptions);
    const result = formValues(form, { actor: this.actor, twoWeapon });
    const locationIds = result.combatOptions.shieldCover.locationIds;
    if (locationIds.length && locationIds.length !== 3) {
      ui.notifications.warn(game.i18n.localize("AOV_SKJALDBORG.Utility.ShieldLocationWarning"));
    }

    try {
      let update;
      if (this.inCombat) {
        update = await requestGm("setUtilityOptions", {
          combatId: this.combat.id,
          combatantId: this.combatant.id,
          expectedCombatantUpdatedAt: getCombatantState(this.combatant).updatedAt,
          ...result
        });
      } else {
        await setReadiedWeapons(this.actor, result.readiedWeapons);
        update = await setCombatOptions(this.actor, result.combatOptions);
      }
      RenderCoordinator.invalidate("actorHotbar", { parts: ["workflow", "weaponControls"], reason: "utility-options" });
      RenderCoordinator.invalidateCombatTracker("utility-options", {
        combatantIds: this.combatant?.id ? [this.combatant.id] : [],
        parts: ["rows"]
      });
      RenderCoordinator.invalidate("intentIndicators", {
        reason: "utility-options",
        combatantIds: this.combatant?.id ? [this.combatant.id] : [],
        tokenIds: this.combatant?.tokenId ? [this.combatant.tokenId] : []
      });
      await this.close();
      return update;
    } catch (exception) {
      error("Failed to apply Skjaldborg utility options.", exception);
      ui.notifications.error(game.i18n.localize("AOV_SKJALDBORG.Warnings.ActionFailed"));
      return null;
    }
  }

  async _onApplyUtility(event, target) {
    event.preventDefault();
    const form = target.closest("form");
    return this._submit(form);
  }
}
