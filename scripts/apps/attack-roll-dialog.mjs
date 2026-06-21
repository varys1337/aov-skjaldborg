import { MODULE_ID } from "../constants.mjs";
import { getAttackWeapons, getReadiedWeapon } from "../combat/weapon-state.mjs";
import { error } from "../logger.mjs";

const { DialogV2 } = foundry.applications.api;

const SITUATIONAL_MODIFIERS = Object.freeze([
  Object.freeze({ value: 40, key: "VeryEasy" }),
  Object.freeze({ value: 20, key: "Easy" }),
  Object.freeze({ value: 0, key: "Standard" }),
  Object.freeze({ value: -20, key: "Hard" }),
  Object.freeze({ value: -40, key: "VeryHard" })
]);

const DAMAGE_TYPE_ABBREVIATIONS = Object.freeze({
  c: "C",
  ct: "CT",
  h: "H",
  i: "I",
  s: "S"
});

const DAMAGE_TYPE_ALIASES = Object.freeze({
  crushing: "c",
  cutandthrust: "ct",
  "cut-and-thrust": "ct",
  handtohand: "h",
  "hand-to-hand": "h",
  impaling: "i",
  slashing: "s"
});

const CUT_AND_THRUST_MODES = Object.freeze(["i", "s"]);

/**
 * Convert one unknown AoV Item value to a finite percentage.
 *
 * @param {Item|object|null|undefined} item Owned Item document.
 * @returns {number}
 */
function itemTotal(item) {
  const candidates = [
    item?.system?.total,
    item?.system?.effective,
    item?.system?.value,
    item?.system?.base
  ];
  for (const candidate of candidates) {
    const value = Number(candidate);
    if (Number.isFinite(value)) return value;
  }
  return 0;
}

/**
 * Sort actor-owned Items by localized name without depending on Collection APIs.
 *
 * @param {Actor|null|undefined} actor Actor document.
 * @param {string} type AoV Item type.
 * @returns {Item[]}
 */
function itemsOfType(actor, type) {
  return Array.from(actor?.items ?? [])
    .filter(item => item.type === type)
    .sort((a, b) => String(a.name ?? "").localeCompare(String(b.name ?? ""), game.i18n.lang));
}

/**
 * Resolve the configured action-interface theme without making dialog creation
 * depend on settings registration order.
 *
 * @returns {"skj-theme-aov"|"skj-theme-classic"}
 */
function actionThemeClass() {
  try {
    return game.settings.get(MODULE_ID, "actionUiTheme") === "classic"
      ? "skj-theme-classic"
      : "skj-theme-aov";
  } catch (_exception) {
    return "skj-theme-aov";
  }
}

/**
 * Format a signed integer for compact modifier summaries.
 *
 * @param {number} value Numeric modifier.
 * @returns {string}
 */
function signed(value) {
  const number = Number(value) || 0;
  return number > 0 ? `+${number}` : String(number);
}

/**
 * Resolve the Age of Vikings weapon damage type into both its stored key and
 * the compact RAW abbreviation used by the attack workflow surface.
 *
 * AoV stores the value in `system.damType` with the canonical keys c, ct, h,
 * i, and s. The small alias table keeps older or manually-authored Items
 * readable without changing their source data.
 *
 * @param {Item|object|null|undefined} weapon Weapon Item.
 * @returns {{key: string, abbreviation: string, label: string}}
 */
function weaponDamageType(weapon) {
  const source = String(
    weapon?.system?.damType
      ?? weapon?.system?.damageType
      ?? weapon?.system?.damage_type
      ?? ""
  ).trim().toLowerCase();
  const compact = source.replace(/[\s_]/g, "");
  const key = DAMAGE_TYPE_ABBREVIATIONS[source]
    ? source
    : (DAMAGE_TYPE_ALIASES[source] ?? DAMAGE_TYPE_ALIASES[compact] ?? source);
  const abbreviation = DAMAGE_TYPE_ABBREVIATIONS[key]
    ?? (source ? source.toUpperCase() : "—");
  const localizationKey = key ? `AOV.DamType.${key}` : "";
  const localized = localizationKey ? game.i18n.localize(localizationKey) : "";
  const label = localized && localized !== localizationKey ? localized : abbreviation;
  return { key, abbreviation, label };
}

/**
 * Resolve one normalized AoV damage-type key into display metadata.
 *
 * @param {string} key Canonical AoV damage-type key.
 * @returns {{key: string, abbreviation: string, label: string}}
 */
function damageTypeFromKey(key) {
  const normalized = String(key ?? "").trim().toLowerCase();
  const abbreviation = DAMAGE_TYPE_ABBREVIATIONS[normalized]
    ?? (normalized ? normalized.toUpperCase() : "—");
  const localizationKey = normalized ? `AOV.DamType.${normalized}` : "";
  const localized = localizationKey ? game.i18n.localize(localizationKey) : "";
  const label = localized && localized !== localizationKey ? localized : abbreviation;
  return { key: normalized, abbreviation, label };
}

/**
 * Resolve the per-attack damage mode. Cut-and-thrust weapons must declare
 * Impaling or Slashing before the attack roll; every other weapon remains on
 * its authored AoV damage type.
 *
 * @param {Item|object|null|undefined} weapon Weapon Item.
 * @param {string} requestedKey Previously selected per-attack mode.
 * @returns {{source: object, effective: object, selectable: boolean, next: object|null, tooltip: string}}
 */
function attackDamageSelection(weapon, requestedKey = "") {
  const source = weaponDamageType(weapon);
  const selectable = source.key === "ct";
  const selectedKey = selectable
    ? (CUT_AND_THRUST_MODES.includes(requestedKey) ? requestedKey : "i")
    : source.key;
  const effective = damageTypeFromKey(selectedKey);
  const next = selectable
    ? damageTypeFromKey(selectedKey === "i" ? "s" : "i")
    : null;
  const tooltip = selectable
    ? game.i18n.format("AOV_SKJALDBORG.AttackDialog.DamageTypeSwitchTooltip", {
        label: effective.label,
        abbreviation: effective.abbreviation,
        nextLabel: next.label,
        nextAbbreviation: next.abbreviation,
        sourceLabel: source.label,
        sourceAbbreviation: source.abbreviation
      })
    : game.i18n.format("AOV_SKJALDBORG.AttackDialog.DamageTypeFixedTooltip", {
        label: effective.label,
        abbreviation: effective.abbreviation
      });
  return { source, effective, selectable, next, tooltip };
}

/**
 * Determine the weapon-adjusted AoV damage-bonus formula without rolling it.
 * This mirrors the core system's full, half, or none handling through
 * `system.damMod`.
 *
 * @param {Actor|null|undefined} actor Acting Actor.
 * @param {Item|object|null|undefined} weapon Weapon Item.
 * @returns {{mode: string, sourceFormula: string, formula: string}}
 */
function weaponDamageBonus(actor, weapon) {
  const mode = String(weapon?.system?.damMod ?? "d").trim().toLowerCase();
  const sourceFormula = String(actor?.system?.dmgBonus ?? "0").trim() || "0";
  const formula = mode === "h"
    ? `${sourceFormula}/2`
    : (mode === "n" ? "0" : sourceFormula);
  return { mode, sourceFormula, formula };
}

/**
 * Build the attack-scoped damage contract consumed by later normal, special,
 * and critical damage automation. The selected effective type, not the source
 * `ct` category, controls downstream special and critical behavior.
 *
 * @param {Actor|null|undefined} actor Acting Actor.
 * @param {Item|object|null|undefined} weapon Weapon Item.
 * @param {ReturnType<attackDamageSelection>} selection Damage selection.
 * @returns {object}
 */
function buildDamageProfile(actor, weapon, selection) {
  const baseFormula = String(weapon?.system?.damage ?? "—");
  const damageBonus = weaponDamageBonus(actor, weapon);
  const key = selection.effective.key;
  const doublesWeaponDamage = key === "i" || key === "s";
  const addsMaximumDamageBonus = key === "c" || key === "h";
  const specialKind = key === "i"
    ? "impaling"
    : (key === "s" ? "slashing" : (addsMaximumDamageBonus ? "crushing" : "normal"));

  return {
    baseFormula,
    sourceType: { ...selection.source },
    effectiveType: { ...selection.effective },
    selectionRequired: selection.selectable,
    damageBonus,
    normal: {
      weaponFormula: baseFormula,
      damageBonusFormula: damageBonus.formula
    },
    special: {
      kind: specialKind,
      weaponFormula: doublesWeaponDamage ? `${baseFormula}+${baseFormula}` : baseFormula,
      damageBonusFormula: damageBonus.formula,
      doublesWeaponDamage,
      addsMaximumDamageBonus,
      impales: key === "i",
      testsConsciousnessOnLocationThreshold: key === "s"
    },
    critical: {
      kind: specialKind,
      maximizeSpecialWeaponDamage: true,
      ignoresArmor: true,
      damageBonusFormula: damageBonus.formula,
      addsMaximumDamageBonus,
      impales: key === "i",
      testsConsciousnessOnLocationThreshold: key === "s"
    },
    core: {
      rollType: "DM",
      damageType: key,
      successLevels: {
        normal: "2",
        special: "3",
        critical: "4"
      }
    }
  };
}

/**
 * Detect whether a Token texture needs a video element rather than an image.
 *
 * @param {string} source Texture source.
 * @returns {boolean}
 */
function isVideoTexture(source) {
  return /\.(?:webm|mp4|m4v|ogv|ogg)(?:$|[?#])/i.test(String(source ?? ""));
}

/**
 * Initial Attack workflow dialog.
 *
 * The application deliberately owns only selection and preview state in this
 * milestone. Submitting publishes a stable hook payload for later attack,
 * defence, damage, and chat-card automation; it does not alter Actor, Token,
 * Combat, or Item documents.
 */
export class AttackRollDialog extends DialogV2 {
  static current = null;

  static DEFAULT_OPTIONS = {
    ...super.DEFAULT_OPTIONS,
    classes: ["aov-skjaldborg", "dialog", "skj-attack-roll-window"],
    window: {
      ...super.DEFAULT_OPTIONS.window,
      contentTag: "form",
      contentClasses: ["aov-skjaldborg", "skj-attack-roll-content"]
    },
    position: {
      width: 390,
      height: "auto"
    },
    actions: {
      ...super.DEFAULT_OPTIONS.actions,
      submitAttack: function (event, target) {
        return this._onSubmitAttack(event, target);
      }
    }
  };

  /**
   * @param {{actor: Actor, targetToken: Token, weapons: Item[], originEvent?: Event|null}} config Dialog source.
   */
  constructor({ actor, targetToken, weapons = [], originEvent = null }) {
    let dialog;
    const themeClass = actionThemeClass();
    super({
      classes: ["aov-skjaldborg", "dialog", "skj-attack-roll-window", themeClass],
      window: {
        title: game.i18n.localize("AOV_SKJALDBORG.AttackDialog.Title"),
        contentTag: "form",
        contentClasses: ["aov-skjaldborg", "skj-attack-roll-content", themeClass]
      },
      buttons: [
        {
          action: "roll",
          icon: '<i class="fa-solid fa-dice"></i>',
          label: game.i18n.localize("AOV_SKJALDBORG.AttackDialog.RollAttack"),
          default: true,
          callback: async (_event, button) => dialog._submit(button.form)
        },
        {
          action: "cancel",
          label: game.i18n.localize("Cancel")
        }
      ],
      position: {
        width: 390,
        height: "auto"
      }
    });
    dialog = this;
    this.actor = actor;
    this.targetToken = targetToken;
    this.targetActor = targetToken?.actor ?? null;
    this.originEvent = originEvent;
    this.availableWeaponIds = Array.from(weapons, weapon => String(weapon?.id ?? "")).filter(Boolean);
    const readied = getReadiedWeapon(actor);
    this.weapon = weapons.find(weapon => weapon?.id === readied?.id) ?? weapons[0] ?? null;
    this.damageTypeSelections = new Map();
    if (weaponDamageType(this.weapon).key === "ct" && this.weapon?.id) {
      this.damageTypeSelections.set(this.weapon.id, "i");
    }
  }

  /**
   * Open one singleton attack dialog for the actor and exactly one user target.
   *
   * @param {Actor|null|undefined} actor Acting actor.
   * @param {Event|null} [originEvent=null] Source UI event.
   * @returns {Promise<AttackRollDialog|null>}
   */
  static async show({ actor, originEvent = null } = {}) {
    if (!actor) {
      ui.notifications.warn(game.i18n.localize("AOV_SKJALDBORG.Warnings.ActorUnavailable"));
      return null;
    }

    const targets = Array.from(game.user?.targets ?? []);
    if (!targets.length) {
      ui.notifications.warn(game.i18n.localize("AOV_SKJALDBORG.Warnings.AttackTargetRequired"));
      return null;
    }
    if (targets.length !== 1) {
      ui.notifications.warn(game.i18n.localize("AOV_SKJALDBORG.Warnings.SingleAttackTargetRequired"));
      return null;
    }

    const targetToken = targets[0];
    if (!targetToken?.actor) {
      ui.notifications.warn(game.i18n.localize("AOV_SKJALDBORG.Warnings.AttackTargetUnavailable"));
      return null;
    }
    const weapons = await getAttackWeapons(actor);
    if (!weapons.length) {
      ui.notifications.warn(game.i18n.format("AOV_SKJALDBORG.Warnings.NoAttackWeapons", {
        actor: actor.name ?? game.i18n.localize("AOV_SKJALDBORG.Warnings.ActorUnavailable")
      }));
      return null;
    }

    if (this.current) await this.current.close({ force: true });
    this.current = new AttackRollDialog({ actor, targetToken, weapons, originEvent });
    await this.current.render({ force: true });
    return this.current;
  }

  /** @override */
  async close(options = {}) {
    const result = await super.close(options);
    if (AttackRollDialog.current === this) AttackRollDialog.current = null;
    return result;
  }

  /**
   * Render the custom attack form from the current document state.
   *
   * @returns {Promise<string>}
   * @override
   */
  async _renderHTML(_context, _options) {
    return foundry.applications.handlebars.renderTemplate(
      "modules/aov-skjaldborg/templates/attack-roll-dialog.hbs",
      this._prepareDialogContext()
    );
  }

  /** @override */
  _replaceHTML(result, content, _options) {
    content.innerHTML = result;
  }

  /**
   * Bind local preview controls after DialogV2 inserts the form.
   *
   * @override
   */
  _onRender(context, options) {
    super._onRender(context, options);
    const form = this.element.querySelector("form.window-content")
      ?? this.element.querySelector("form");
    if (!(form instanceof HTMLFormElement) || form.dataset.skjAttackConfigured === "true") return;
    form.dataset.skjAttackConfigured = "true";
    form.addEventListener("change", event => this._onFormChange(event, form));
    form.addEventListener("input", event => this._onFormChange(event, form));
    form.addEventListener("click", event => {
      const control = event.target instanceof Element
        ? event.target.closest("[data-damage-type-control]")
        : null;
      if (control) this._onDamageTypeToggle(event, form, control);
    });
    this._syncDamageTypeInput(form);
    this._updateAugmentDetails(form);
    this._updatePreview(form);
  }

  /**
   * Resolve the current per-weapon damage selection, defaulting cut-and-thrust
   * weapons to Impaling to match the AoV core damage dialog.
   *
   * @param {Item|object|null|undefined} weapon Weapon Item.
   * @returns {ReturnType<attackDamageSelection>}
   */
  _damageSelectionForWeapon(weapon) {
    const requestedKey = weapon?.id ? this.damageTypeSelections.get(weapon.id) ?? "" : "";
    return attackDamageSelection(weapon, requestedKey);
  }

  /**
   * Keep the hidden form value aligned with the attack-scoped selection.
   *
   * @param {HTMLFormElement} form Dialog form.
   * @param {Item|object|null|undefined} [weapon=this.weapon] Weapon Item.
   * @returns {ReturnType<attackDamageSelection>}
   */
  _syncDamageTypeInput(form, weapon = this.weapon) {
    const selection = this._damageSelectionForWeapon(weapon);
    const input = form.querySelector("[data-selected-damage-type]");
    if (input instanceof HTMLInputElement) input.value = selection.effective.key;
    return selection;
  }

  /**
   * Toggle one cut-and-thrust weapon between its RAW Impaling and Slashing
   * attack modes. The Item itself is not mutated; the choice belongs only to
   * this attack request.
   *
   * @param {Event} event Click event.
   * @param {HTMLFormElement} form Dialog form.
   * @param {Element} control Damage-type control.
   * @returns {void}
   */
  _onDamageTypeToggle(event, form, control) {
    event.preventDefault();
    const state = this._readFormState(form);
    if (!state.damageSelection.selectable || !state.weapon?.id) return;

    const nextKey = state.damageSelection.next?.key === "s" ? "s" : "i";
    this.damageTypeSelections.set(state.weapon.id, nextKey);
    this._syncDamageTypeInput(form, state.weapon);
    this._updatePreview(form);

    const updated = this._readFormState(form);
    Hooks.callAll("aovSkjaldborgAttackDamageTypeChanged", {
      app: this,
      actor: this.actor,
      actorUuid: this.actor?.uuid ?? null,
      targetToken: this.targetToken,
      targetTokenUuid: this.targetToken?.document?.uuid ?? null,
      targetActor: this.targetActor,
      targetActorUuid: this.targetActor?.uuid ?? null,
      weapon: updated.weapon,
      weaponUuid: updated.weapon?.uuid ?? null,
      sourceDamageType: updated.sourceDamageType,
      damageType: updated.damageType,
      damageProfile: updated.damageProfile,
      control
    });
  }

  /**
   * Resolve the attack options captured when the dialog opened against the
   * actor's current embedded Item collection. This prevents stale/deleted Item
   * references from being submitted without broadening the availability rule.
   *
   * @returns {Item[]}
   */
  _getAvailableWeapons() {
    const actorItems = Array.from(this.actor?.items ?? []);
    return this.availableWeaponIds
      .map(id => this.actor?.items?.get?.(id)
        ?? actorItems.find(item => item?.id === id)
        ?? null)
      .filter(Boolean);
  }

  /**
   * Resolve one currently available attack option by embedded Item id.
   *
   * @param {string} itemId Owned Item id.
   * @returns {Item|null}
   */
  _getAvailableWeapon(itemId) {
    return this._getAvailableWeapons().find(item => item?.id === itemId) ?? null;
  }

  /**
   * Build one serializable choice list for an AoV actor-owned Item type.
   *
   * @param {string} type Item type.
   * @returns {{id: string, label: string, value: number}[]}
   */
  _prepareSourceChoices(type) {
    return itemsOfType(this.actor, type).map(item => {
      const value = itemTotal(item);
      return {
        id: item.id,
        label: `${item.name} (${value}%)`,
        value
      };
    });
  }

  /**
   * Prepare the Handlebars model while preserving the Mythras dialog's broad
   * visual structure: source identity, percentage card, modifier row,
   * augmentation segments, conditional details, and footer action.
   *
   * @returns {object}
   */
  _prepareDialogContext() {
    const weapons = this._getAvailableWeapons();
    if (!weapons.some(item => item.id === this.weapon?.id)) this.weapon = weapons[0] ?? null;
    const baseChance = itemTotal(this.weapon);
    const skills = this._prepareSourceChoices("skill");
    const passions = this._prepareSourceChoices("passion");
    const devotions = this._prepareSourceChoices("devotion");
    const targetImg = this.targetToken?.document?.texture?.src ?? this.targetActor?.img ?? "";
    const damageSelection = this._damageSelectionForWeapon(this.weapon);

    return {
      actorName: this.actor?.name ?? "",
      targetName: this.targetActor?.name ?? this.targetToken?.name ?? "",
      targetImg,
      targetImgIsVideo: isVideoTexture(targetImg),
      weaponName: this.weapon?.name ?? "",
      baseChance,
      targetNumber: baseChance,
      damage: String(this.weapon?.system?.damage ?? "—"),
      damageType: damageSelection.effective.abbreviation,
      damageTypeKey: damageSelection.effective.key,
      damageTypeLabel: damageSelection.effective.label,
      damageTypeTooltip: damageSelection.tooltip,
      damageTypeSelectable: damageSelection.selectable,
      weapons: weapons.map(item => ({
        id: item.id,
        label: `${item.name} (${itemTotal(item)}%)`,
        selected: item.id === this.weapon?.id
      })),
      modifiers: SITUATIONAL_MODIFIERS.map(entry => ({
        value: entry.value,
        label: game.i18n.localize(`AOV_SKJALDBORG.AttackDialog.Modifiers.${entry.key}`),
        selected: entry.value === 0
      })),
      skills,
      passions,
      devotions,
      hasSkills: skills.length > 0,
      hasPassions: passions.length > 0,
      hasDevotions: devotions.length > 0,
      initialSummary: this._formatSummary({ baseChance, situationalModifier: 0, augmentModifier: 0 })
    };
  }

  /**
   * Synchronize the selected weapon and preview-only controls.
   *
   * @param {Event} event Form event.
   * @param {HTMLFormElement} form Dialog form.
   * @returns {void}
   */
  _onFormChange(event, form) {
    const target = event.target;
    if (target instanceof HTMLSelectElement && target.name === "weaponId") {
      this.weapon = this._getAvailableWeapon(target.value) ?? this.weapon;
      if (weaponDamageType(this.weapon).key === "ct" && this.weapon?.id
        && !this.damageTypeSelections.has(this.weapon.id)) {
        this.damageTypeSelections.set(this.weapon.id, "i");
      }
      this._syncDamageTypeInput(form, this.weapon);
    }
    this._updateAugmentDetails(form);
    this._updatePreview(form);
  }

  /**
   * Show details only for currently selected augmentation scaffolds.
   *
   * @param {HTMLFormElement} form Dialog form.
   * @returns {void}
   */
  _updateAugmentDetails(form) {
    const selected = new Set(new FormData(form).getAll("augmentOptions").map(String));
    for (const detail of form.querySelectorAll("[data-augment-detail]")) {
      detail.hidden = !selected.has(detail.dataset.augmentDetail);
    }
  }

  /**
   * Parse current form state into a future-proof attack request.
   *
   * Skill, Passion, and Devotion sources are recorded but do not yet alter the
   * target percentage: their modifier depends on a separate result that later
   * automation will resolve. The Custom option is an explicit numeric preview.
   *
   * @param {HTMLFormElement} form Dialog form.
   * @returns {object}
   */
  _readFormState(form) {
    const data = new FormData(form);
    const weaponId = String(data.get("weaponId") ?? this.weapon?.id ?? "");
    const weapon = this._getAvailableWeapon(weaponId) ?? this.weapon;
    const augmentOptions = new Set(data.getAll("augmentOptions").map(String));
    const baseChance = itemTotal(weapon);
    const situationalModifier = Number(data.get("situationalModifier")) || 0;
    const augmentModifier = augmentOptions.has("custom")
      ? (Number(data.get("customAugmentValue")) || 0)
      : 0;
    const damageSelection = this._damageSelectionForWeapon(weapon);
    const damageProfile = buildDamageProfile(this.actor, weapon, damageSelection);

    return {
      weapon,
      weaponId: weapon?.id ?? weaponId,
      damage: String(weapon?.system?.damage ?? "—"),
      sourceDamageType: damageSelection.source,
      damageType: damageSelection.effective,
      damageSelection,
      damageProfile,
      baseChance,
      situationalModifier,
      augmentModifier,
      targetNumber: baseChance + situationalModifier + augmentModifier,
      augmentations: {
        skillId: augmentOptions.has("skill") ? String(data.get("skillId") ?? "") : "",
        passionId: augmentOptions.has("passion") ? String(data.get("passionId") ?? "") : "",
        devotionId: augmentOptions.has("devotion") ? String(data.get("devotionId") ?? "") : "",
        custom: augmentOptions.has("custom")
          ? {
              reason: String(data.get("customAugmentReason") ?? "").trim(),
              value: augmentModifier
            }
          : null
      }
    };
  }

  /**
   * Refresh displayed chance, source metadata, and modifier summary.
   *
   * @param {HTMLFormElement} form Dialog form.
   * @returns {void}
   */
  _updatePreview(form) {
    const state = this._readFormState(form);
    this.weapon = state.weapon;
    const targetNumber = form.querySelector("[data-target-number]");
    if (targetNumber) targetNumber.textContent = `${state.targetNumber}%`;
    const chanceLabel = form.querySelector("[data-target-caption]");
    if (chanceLabel) {
      const select = form.elements.namedItem("situationalModifier");
      const option = select instanceof HTMLSelectElement ? select.selectedOptions[0] : null;
      chanceLabel.textContent = option?.textContent?.trim()
        ?? game.i18n.localize("AOV_SKJALDBORG.AttackDialog.Modifiers.Standard");
    }
    const damageTypeControl = form.querySelector("[data-damage-type-control]");
    const damageLabel = form.querySelector("[data-weapon-damage-label]");
    if (damageLabel) damageLabel.textContent = state.damageType.label;
    const damageType = form.querySelector("[data-weapon-damage-type]");
    if (damageType) damageType.textContent = `[${state.damageType.abbreviation}]`;
    const damageFormula = form.querySelector("[data-weapon-damage-formula]");
    if (damageFormula) damageFormula.textContent = state.damage;
    if (damageTypeControl) {
      damageTypeControl.removeAttribute("title");
      damageTypeControl.setAttribute("data-tooltip", state.damageSelection.tooltip);
      damageTypeControl.setAttribute("aria-label", state.damageSelection.tooltip);
      damageTypeControl.setAttribute("aria-disabled", String(!state.damageSelection.selectable));
      damageTypeControl.classList.toggle("is-switchable", state.damageSelection.selectable);
      damageTypeControl.classList.toggle("is-fixed", !state.damageSelection.selectable);
    }
    const hiddenDamageType = form.querySelector("[data-selected-damage-type]");
    if (hiddenDamageType instanceof HTMLInputElement) hiddenDamageType.value = state.damageType.key;
    const summary = form.querySelector("[data-modifier-summary]");
    if (summary) summary.textContent = this._formatSummary(state);
  }

  /**
   * Produce the compact modifier explanation displayed in the footer.
   *
   * @param {{baseChance: number, situationalModifier: number, augmentModifier: number}} state Preview state.
   * @returns {string}
   */
  _formatSummary(state) {
    return game.i18n.format("AOV_SKJALDBORG.AttackDialog.Summary", {
      base: state.baseChance,
      situation: signed(state.situationalModifier),
      augment: signed(state.augmentModifier)
    });
  }

  /**
   * Publish the first stable Attack request payload without resolving a roll.
   *
   * @param {HTMLFormElement} form Dialog form.
   * @returns {Promise<object|null>}
   */
  async _submit(form) {
    if (!(form instanceof HTMLFormElement)) return null;
    try {
      const state = this._readFormState(form);
      const damageContext = {
        app: this,
        actor: this.actor,
        actorUuid: this.actor?.uuid ?? null,
        targetToken: this.targetToken,
        targetTokenUuid: this.targetToken?.document?.uuid ?? null,
        targetActor: this.targetActor,
        targetActorUuid: this.targetActor?.uuid ?? null,
        weapon: state.weapon,
        weaponUuid: state.weapon?.uuid ?? null,
        sourceDamageType: { ...state.sourceDamageType },
        damageType: { ...state.damageType },
        damageProfile: foundry.utils.deepClone(state.damageProfile)
      };
      Hooks.callAll("aovSkjaldborgPrepareAttackDamage", damageContext);

      const payload = {
        app: this,
        actor: this.actor,
        actorUuid: this.actor?.uuid ?? null,
        targetToken: this.targetToken,
        targetTokenUuid: this.targetToken?.document?.uuid ?? null,
        targetActor: this.targetActor,
        targetActorUuid: this.targetActor?.uuid ?? null,
        weapon: state.weapon,
        weaponUuid: state.weapon?.uuid ?? null,
        damage: state.damage,
        sourceDamageType: damageContext.sourceDamageType,
        damageType: damageContext.damageType,
        damageProfile: damageContext.damageProfile,
        baseChance: state.baseChance,
        situationalModifier: state.situationalModifier,
        augmentModifier: state.augmentModifier,
        targetNumber: state.targetNumber,
        augmentations: state.augmentations,
        originEvent: this.originEvent
      };
      Hooks.callAll("aovSkjaldborgAttackRollRequested", payload);
      ui.notifications.info(game.i18n.localize("AOV_SKJALDBORG.AttackDialog.WorkflowQueued"));
      await this.close();
      return payload;
    } catch (exception) {
      error("Failed to prepare the Skjaldborg attack workflow request.", exception);
      ui.notifications.error(game.i18n.localize("AOV_SKJALDBORG.Warnings.ActionFailed"));
      return null;
    }
  }

  /**
   * AppV2 action bridge for the internal Roll Attack button.
   *
   * @param {PointerEvent} event Pointer event.
   * @param {HTMLElement} target Action control.
   * @returns {Promise<object|null>}
   */
  async _onSubmitAttack(event, target) {
    event.preventDefault();
    const form = target.closest("form");
    return this._submit(form);
  }
}
