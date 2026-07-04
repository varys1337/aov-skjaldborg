import { getReadiedWeapon } from "../combat/weapon-state.mjs";
import { mountedCapSummary, mountedWeaponCap } from "../combat/mounted-combat.mjs";
import { resolveNaturalWeaponSkill } from "../combat/weapon-skill-resolver.mjs";
import { startDialogCombatWorkflowBatch } from "../socket.mjs";
import { createSplitAttackPrompt } from "../combat/dialog-target-queue.mjs";
import { error } from "../logger.mjs";
import { actionThemeClass, actorPortraitSource, isVideoSource } from "../ui/dom-utils.mjs";
import {
  aimedPenalty,
  attackDamageSelection,
  buildDamageProfile,
  itemTotal,
  itemsOfType,
  normalizeDescriptor,
  signed,
  SITUATIONAL_MODIFIERS,
  targetDialogChoiceState,
  updateModifierSummary,
  weaponDamageType,
  weaponType
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

const RANGE_BANDS = Object.freeze(["medium", "long"]);
const MISSILE_WEAPON_TYPES = Object.freeze(new Set(["missile", "thrown"]));
const AMMUNITION_CATEGORY_DESCRIPTORS = Object.freeze(new Set([
  "bow",
  "bows",
  "selfbow",
  "selfbows",
  "crossbow",
  "crossbows",
  "sling",
  "slings",
  "ranged",
  "rangedweapon",
  "rangedweapons",
  "missile",
  "missileweapon",
  "missileweapons"
]));
const AMMUNITION_NAME_PATTERN = /\b(arrow|arrows|bolt|bolts|round|rounds)\b/i;
const TARGET_OPTION_FIELDS = Object.freeze(["aimedLocationId", "aimedPenalty"]);

/**
 * Whether an owned Item is immediately eligible for the Missile action.
 *
 * RAW missile actions require an actually readied missile or thrown weapon.
 * The category/name fallback supports manually-authored Bow, Crossbow, Sling,
 * and Ranged categories which may not exist in the shipped compendium yet.
 *
 * @param {Item|object|null|undefined} weapon Candidate weapon.
 * @returns {boolean}
 */
function isMissileActionWeapon(weapon) {
  if (weapon?.type !== "weapon") return false;
  const type = weaponType(weapon);
  if (MISSILE_WEAPON_TYPES.has(type)) return true;
  const descriptors = [weapon?.name, weapon?.system?.weaponCat, weapon?.system?.weaponCatName]
    .map(normalizeDescriptor)
    .filter(Boolean);
  return descriptors.some(descriptor => AMMUNITION_CATEGORY_DESCRIPTORS.has(descriptor));
}

/**
 * Whether this readied missile weapon is a projectile weapon eligible for
 * medium/long range adjustments.
 *
 * @param {Item|object|null|undefined} weapon Candidate weapon.
 * @returns {boolean}
 */
function isProjectileWeapon(weapon) {
  if (!weapon) return false;
  if (weaponType(weapon) === "thrown") return false;
  if (weaponType(weapon) === "missile") return true;
  const descriptors = [weapon?.name, weapon?.system?.weaponCat, weapon?.system?.weaponCatName, weapon?.system?.skillCID]
    .map(normalizeDescriptor)
    .filter(Boolean);
  return descriptors.some(descriptor => AMMUNITION_CATEGORY_DESCRIPTORS.has(descriptor));
}

/**
 * Resolve the human-readable Category/CID name for a weapon when possible.
 *
 * @param {Item|object|null|undefined} weapon Candidate weapon.
 * @returns {Promise<string[]>}
 */
async function weaponCategoryDescriptors(weapon) {
  const descriptors = [
    weapon?.name,
    weapon?.system?.weaponCat,
    weapon?.system?.weaponCatName,
    weapon?.system?.skillCID
  ];
  const categoryCid = String(weapon?.system?.weaponCat ?? "").trim();
  const resolver = globalThis.game?.aov?.cid?.fromCID;
  if (categoryCid && typeof resolver === "function") {
    try {
      const resolved = await resolver.call(globalThis.game.aov.cid, categoryCid);
      for (const category of (Array.isArray(resolved) ? resolved : [resolved])) {
        descriptors.push(
          category?.name,
          category?.system?.name,
          category?.flags?.aov?.cidFlag?.id
        );
      }
    } catch (_exception) {
      // Resolution is best-effort; local authored fields above remain valid.
    }
  }
  return descriptors.map(normalizeDescriptor).filter(Boolean);
}

/**
 * Return the readied weapon if it is a legal Missile action weapon.
 *
 * @param {Actor|object|null|undefined} actor Actor document.
 * @returns {Item|object|null}
 */
function getReadiedMissileWeapon(actor) {
  const readied = getReadiedWeapon(actor);
  return isMissileActionWeapon(readied) ? readied : null;
}

/**
 * Whether this weapon should consume actor ammunition when fired.
 *
 * @param {Item|object|null|undefined} weapon Candidate weapon.
 * @returns {Promise<boolean>}
 */
async function requiresAmmunition(weapon) {
  if (!weapon) return false;
  if (weaponType(weapon) === "thrown") return false;
  if (weaponType(weapon) === "missile") return true;
  const descriptors = await weaponCategoryDescriptors(weapon);
  return descriptors.some(descriptor => AMMUNITION_CATEGORY_DESCRIPTORS.has(descriptor));
}

/**
 * Read an AoV gear quantity as a non-negative integer.
 *
 * @param {Item|object|null|undefined} item Gear Item.
 * @returns {number}
 */
function itemQuantity(item) {
  const value = Number(item?.system?.quantity);
  return Math.max(0, Number.isFinite(value) ? Math.trunc(value) : 0);
}

/**
 * Return actor gear that can serve as ammunition.
 *
 * @param {Actor|object|null|undefined} actor Actor document.
 * @returns {Item[]}
 */
function getAmmunition(actor) {
  return Array.from(actor?.items ?? [])
    .filter(item => item?.type === "gear")
    .filter(item => AMMUNITION_NAME_PATTERN.test(String(item.name ?? "")))
    .filter(item => itemQuantity(item) > 0)
    .sort((a, b) => String(a.name ?? "").localeCompare(String(b.name ?? ""), game.i18n.lang));
}

/**
 * Clamp a combatant count for Shooting into Melee.
 *
 * @param {unknown} value Submitted count.
 * @returns {number}
 */
function meleeCombatantCount(value) {
  const count = Math.trunc(Number(value));
  return Number.isFinite(count) ? Math.max(2, count) : 2;
}

/**
 * Clamp the missile range band.
 *
 * @param {unknown} value Submitted range band.
 * @returns {"medium"|"long"}
 */
function missileRangeBand(value) {
  const band = String(value ?? "");
  return RANGE_BANDS.includes(band) ? band : "medium";
}

/**
 * Convert a range band into its RAW hit-chance multiplier.
 *
 * @param {"medium"|"long"} band Range band.
 * @returns {0.5|0.25}
 */
function missileRangeMultiplier(band) {
  return band === "long" ? 0.25 : 0.5;
}

/**
 * Missile workflow dialog with ammunition selection and quantity consumption.
 */
export class MissileRollDialog extends DialogV2 {
  static current = null;

  static DEFAULT_OPTIONS = {
    ...super.DEFAULT_OPTIONS,
    classes: ["aov-skjaldborg", "dialog", "skj-attack-roll-window", "skj-missile-roll-window"],
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
      submitMissile: function (event, target) {
        return this._onSubmitMissile(event, target);
      }
    }
  };

  /**
   * @param {{actor: Actor, targetToken?: Token|null, targets?: object[], weapon: Item, ammunition: Item[], ammunitionRequired: boolean, originEvent?: Event|null, forcedSplitAttack?: object|null}} config Dialog source.
   */
  constructor({ actor, targetToken = null, targets = [], weapon, ammunition = [], ammunitionRequired = false, originEvent = null, forcedSplitAttack = null }) {
    let dialog;
    const themeClass = actionThemeClass();
    super({
      classes: ["aov-skjaldborg", "dialog", "skj-attack-roll-window", "skj-missile-roll-window", themeClass],
      window: {
        title: game.i18n.localize("AOV_SKJALDBORG.MissileDialog.Title"),
        contentTag: "form",
        contentClasses: ["aov-skjaldborg", "skj-attack-roll-content", themeClass]
      },
      buttons: [
        {
          action: "roll",
          icon: '<i class="fa-solid fa-dice"></i>',
          label: game.i18n.localize("AOV_SKJALDBORG.MissileDialog.RollMissile"),
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
    this.targetSnapshots = targets.length ? targets : currentTargetSnapshots();
    this.activeTargetKey = this.targetSnapshots[0]?.key ?? "";
    this.targetToken = this.targetSnapshots[0]?.token ?? targetToken ?? null;
    this.targetActor = this.targetSnapshots[0]?.actor ?? targetToken?.actor ?? null;
    this.originEvent = originEvent;
    this.forcedSplitAttack = forcedSplitAttack;
    this.formValues = {};
    this.targetOptionValues = new Map();
    this.weaponId = String(weapon?.id ?? "");
    this.weapon = weapon ?? null;
    this.ammunitionIds = Array.from(ammunition, item => String(item?.id ?? "")).filter(Boolean);
    this.ammunitionRequired = Boolean(ammunitionRequired);
    this.damageTypeSelections = new Map();
    if (weaponDamageType(this.weapon).key === "ct" && this.weapon?.id) {
      this.damageTypeSelections.set(this.weapon.id, "i");
    }
  }

  /**
   * Open one singleton missile dialog for the actor and exactly one user target.
   *
   * @param {Actor|null|undefined} actor Acting actor.
   * @param {Event|null} [originEvent=null] Source UI event.
   * @returns {Promise<MissileRollDialog|null>}
   */
  static async show({ actor, originEvent = null, forcedSplitAttack = null } = {}) {
    if (!actor) {
      ui.notifications.warn(game.i18n.localize("AOV_SKJALDBORG.Warnings.ActorUnavailable"));
      return null;
    }

    const targets = currentTargetSnapshots();
    if (!targets.length) {
      ui.notifications.warn(game.i18n.localize("AOV_SKJALDBORG.Warnings.MissileTargetRequired"));
      return null;
    }
    const weapon = getReadiedMissileWeapon(actor);
    if (!weapon) {
      ui.notifications.warn(game.i18n.format("AOV_SKJALDBORG.Warnings.NoMissileWeapons", {
        actor: actor.name ?? game.i18n.localize("AOV_SKJALDBORG.Warnings.ActorUnavailable")
      }));
      return null;
    }

    const ammunitionRequired = await requiresAmmunition(weapon);
    const ammunition = getAmmunition(actor);
    if (ammunitionRequired && !ammunition.length) {
      ui.notifications.warn(game.i18n.format("AOV_SKJALDBORG.Warnings.NoMissileAmmunition", {
        actor: actor.name ?? game.i18n.localize("AOV_SKJALDBORG.Warnings.ActorUnavailable"),
        weapon: weapon.name ?? game.i18n.localize("AOV_SKJALDBORG.MissileDialog.Weapon")
      }));
    }

    if (this.current) await this.current.close({ force: true });
    this.current = new MissileRollDialog({ actor, targets, weapon, ammunition, ammunitionRequired, originEvent, forcedSplitAttack });
    await this.current.render({ force: true });
    return this.current;
  }

  /** @override */
  async close(options = {}) {
    unregisterTargetRefresh(this);
    const result = await super.close(options);
    if (MissileRollDialog.current === this) MissileRollDialog.current = null;
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

  /** @override */
  async _renderHTML(_context, _options) {
    return foundry.applications.handlebars.renderTemplate(
      "modules/aov-skjaldborg/templates/missile-roll-dialog.hbs",
      this._prepareDialogContext()
    );
  }

  /** @override */
  _replaceHTML(result, content, _options) {
    content.innerHTML = result;
  }

  /** @override */
  _onRender(context, options) {
    super._onRender(context, options);
    const form = this.element.querySelector("form.window-content")
      ?? this.element.querySelector("form");
    if (!(form instanceof HTMLFormElement) || form.dataset.skjMissileConfigured === "true") return;
    form.dataset.skjMissileConfigured = "true";
    registerTargetRefresh(this, () => this._refreshTargets());
    this._restoreForm(form);
    form.addEventListener("change", event => this._onFormChange(event, form));
    form.addEventListener("input", event => this._onFormChange(event, form));
    form.addEventListener("click", event => {
      const control = event.target instanceof Element
        ? event.target.closest("[data-damage-type-control]")
        : null;
      if (control) this._onDamageTypeToggle(event, form, control);
      const targetControl = event.target instanceof Element
        ? event.target.closest("[data-target-key]")
        : null;
      if (targetControl) {
        event.preventDefault();
        this._captureForm(form);
        this.activeTargetKey = String(targetControl.dataset.targetKey ?? "");
        this._setActiveTarget(this._activeTarget());
        void this.render({ force: true });
      }
    });
    this._syncDamageTypeInput(form);
    this._updateAugmentDetails(form);
    this._updatePreview(form);
  }

  /**
   * @param {Item|object|null|undefined} weapon Weapon Item.
   * @returns {ReturnType<attackDamageSelection>}
   */
  _damageSelectionForWeapon(weapon) {
    const requestedKey = weapon?.id ? this.damageTypeSelections.get(weapon.id) ?? "" : "";
    return attackDamageSelection(weapon, requestedKey, { workflow: "missile" });
  }

  /**
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
    Hooks.callAll("aovSkjaldborgMissileDamageTypeChanged", {
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
   * Resolve the still-readied missile weapon against current Actor state.
   *
   * @returns {Item|null}
   */
  _getAvailableWeapon() {
    const current = getReadiedMissileWeapon(this.actor);
    return current?.id === this.weaponId ? current : null;
  }

  /**
   * @param {string} itemId Owned gear Item id.
   * @returns {Item|null}
   */
  _getAmmunition(itemId) {
    if (!itemId) return null;
    const actorItems = Array.from(this.actor?.items ?? []);
    const item = this.actor?.items?.get?.(itemId)
      ?? actorItems.find(candidate => candidate?.id === itemId)
      ?? null;
    if (!item || item.type !== "gear") return null;
    if (!AMMUNITION_NAME_PATTERN.test(String(item.name ?? ""))) return null;
    return itemQuantity(item) > 0 ? item : null;
  }

  /**
   * @returns {Item[]}
   */
  _getAvailableAmmunition() {
    return this.ammunitionIds
      .map(id => this._getAmmunition(id))
      .filter(Boolean);
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

  _prepareSplitAttackState(weapon, fallbackChance) {
    const natural = resolveNaturalWeaponSkill(this.actor, weapon);
    const naturalSkill = Number(natural.total);
    const eligible = !this.forcedSplitAttack && Number.isFinite(naturalSkill) && naturalSkill >= 100;
    const first = eligible ? Math.ceil(naturalSkill / 2) : Math.max(0, Number(fallbackChance) || 0);
    const second = eligible ? naturalSkill - first : 0;
    return {
      available: eligible,
      forced: !!this.forcedSplitAttack,
      naturalSkill: eligible ? naturalSkill : 0,
      first,
      second,
      unavailableHint: game.i18n.localize("AOV_SKJALDBORG.SplitAttack.Unavailable"),
      forcedLabel: this.forcedSplitAttack
        ? game.i18n.format("AOV_SKJALDBORG.SplitAttack.ForcedLabel", { chance: Number(this.forcedSplitAttack.baseChance) || 0 })
        : ""
    };
  }

  _readSplitAttackState(data, weapon, baseChance) {
    if (this.forcedSplitAttack) {
      const forcedChance = Math.max(0, Math.round(Number(this.forcedSplitAttack.baseChance) || baseChance));
      return {
        enabled: false,
        forced: true,
        firstChance: forcedChance,
        secondChance: 0,
        naturalSkill: 0,
        secondDexRank: 0,
        valid: true,
        message: ""
      };
    }
    const enabled = data.get("splitAttackEnabled") === "on";
    if (!enabled) {
      return {
        enabled: false,
        forced: false,
        firstChance: baseChance,
        secondChance: 0,
        naturalSkill: 0,
        secondDexRank: 0,
        valid: true,
        message: ""
      };
    }
    const naturalSkill = Number(resolveNaturalWeaponSkill(this.actor, weapon).total);
    const firstChance = Math.round(Number(data.get("splitFirstChance")) || 0);
    const secondChance = Math.round(Number(data.get("splitSecondChance")) || 0);
    const secondDexRank = Math.ceil(Math.max(1, this._currentDexRank()) / 2);
    const valid = Number.isFinite(naturalSkill)
      && naturalSkill >= 100
      && firstChance >= 50
      && secondChance >= 50
      && (firstChance + secondChance) <= naturalSkill;
    return {
      enabled,
      forced: false,
      firstChance,
      secondChance,
      naturalSkill: Number.isFinite(naturalSkill) ? naturalSkill : 0,
      secondDexRank,
      valid,
      message: valid ? "" : game.i18n.localize("AOV_SKJALDBORG.SplitAttack.Invalid")
    };
  }

  _currentDexRank() {
    const combat = game.combat ?? null;
    const combatant = combat?.combatants?.find?.(candidate => candidate.actor?.id === this.actor?.id) ?? null;
    const initiative = Number(combatant?.initiative);
    if (Number.isFinite(initiative) && initiative > 0) return Math.trunc(initiative);
    return Number(this.actor?.system?.abilities?.dex?.total ?? this.actor?.system?.abilities?.dex?.value ?? 0) || 1;
  }

  /**
   * @returns {object}
   */
  _prepareDialogContext() {
    this._setActiveTarget(this._activeTarget());
    const weapon = this._getAvailableWeapon();
    if (weapon) this.weapon = weapon;
    const mountedCap = mountedWeaponCap(this.actor, itemTotal(weapon ?? this.weapon));
    const splitState = this._prepareSplitAttackState(weapon ?? this.weapon, mountedCap.baseChance);
    const baseChance = this.forcedSplitAttack ? Number(this.forcedSplitAttack.baseChance) || mountedCap.baseChance : mountedCap.baseChance;
    const targetChoices = targetDialogChoiceState(this.targetActor);
    const aimedTargets = targetChoices.aimedTargets;
    const rangeAvailable = isProjectileWeapon(weapon ?? this.weapon);
    const targetImg = actorPortraitSource(this.targetActor, this.targetToken);
    const damageSelection = this._damageSelectionForWeapon(weapon ?? this.weapon);
    const ammunition = this._getAvailableAmmunition();

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
      weaponName: (weapon ?? this.weapon)?.name ?? "",
      weaponId: (weapon ?? this.weapon)?.id ?? this.weaponId,
      baseChance,
      targetNumber: baseChance,
      damage: String((weapon ?? this.weapon)?.system?.damage ?? "—"),
      damageType: damageSelection.effective.abbreviation,
      damageTypeKey: damageSelection.effective.key,
      damageTypeLabel: damageSelection.effective.label,
      damageTypeTooltip: damageSelection.tooltip,
      damageTypeSelectable: damageSelection.selectable,
      ammunitionRequired: this.ammunitionRequired,
      splitAttack: splitState,
      ammunitionAvailable: ammunition.length > 0,
      ammunition: ammunition.map((item, index) => ({
        id: item.id,
        label: `${item.name} (${itemQuantity(item)})`,
        selected: index === 0
      })),
      noAmmunitionLabel: game.i18n.localize("AOV_SKJALDBORG.MissileDialog.NoAmmunition"),
      modifiers: SITUATIONAL_MODIFIERS.map(entry => ({
        value: entry.value,
        label: game.i18n.localize(`AOV_SKJALDBORG.AttackDialog.Modifiers.${entry.key}`),
        selected: entry.value === 0
      })),
      aimedLocations: aimedTargets,
      aimedNoLocationsTooltip: aimedTargets.length
        ? ""
        : game.i18n.localize("AOV_SKJALDBORG.MissileDialog.AimedNoLocations"),
      aimedPenalties: [
        {
          value: -20,
          label: game.i18n.localize("AOV_SKJALDBORG.AttackDialog.AimedPenaltyLimb"),
          selected: true
        },
        {
          value: -40,
          label: game.i18n.localize("AOV_SKJALDBORG.AttackDialog.AimedPenaltyTorso"),
          selected: false
        }
      ],
      rangeNoProjectileTooltip: rangeAvailable
        ? ""
        : game.i18n.localize("AOV_SKJALDBORG.MissileDialog.RangeProjectileOnly"),
      rangeBands: [
        {
          value: "medium",
          label: game.i18n.localize("AOV_SKJALDBORG.MissileDialog.RangeMedium"),
          selected: true
        },
        {
          value: "long",
          label: game.i18n.localize("AOV_SKJALDBORG.MissileDialog.RangeLong"),
          selected: false
        }
      ],
      hasAimedLocations: aimedTargets.length > 0,
      hasRange: rangeAvailable,
      initialSummary: this._formatSummary({
        baseChance,
        targetNumber: baseChance,
        situationalModifier: 0,
        aimedModifier: 0,
        rangeLabel: game.i18n.localize("AOV_SKJALDBORG.MissileDialog.RangeNone"),
        intoMeleeLabel: game.i18n.localize("AOV_SKJALDBORG.MissileDialog.IntoMeleeNone"),
        augmentModifier: 0,
        mountedCap
      })
    };
  }

  /**
   * @param {Event} _event Form event.
   * @param {HTMLFormElement} form Dialog form.
   * @returns {void}
   */
  _onFormChange(_event, form) {
    this._updateAugmentDetails(form);
    this._syncAimedPenaltyControls(form);
    this._updatePreview(form);
  }

  /**
   * Equipment Aimed attacks use the errata fixed -20% modifier.
   *
   * @param {HTMLFormElement} form Dialog form.
   * @returns {void}
   */
  _syncAimedPenaltyControls(form) {
    const selected = form.querySelector("select[name='aimedLocationId'] option:checked");
    const equipmentTarget = selected?.dataset?.targetKind === "equipment";
    const radios = Array.from(form.querySelectorAll("input[name='aimedPenalty']"));
    for (const radio of radios) {
      if (!(radio instanceof HTMLInputElement)) continue;
      const isDefault = Number(radio.value) === -20;
      radio.disabled = equipmentTarget && !isDefault;
      if (equipmentTarget && isDefault) radio.checked = true;
    }
  }

  /**
   * @param {HTMLFormElement} form Dialog form.
   * @returns {void}
   */
  _updateAugmentDetails(form) {
    const selected = new Set(new FormData(form).getAll("augmentOptions").map(String));
    for (const detail of form.querySelectorAll("[data-augment-detail]")) {
      detail.hidden = !selected.has(detail.dataset.augmentDetail);
    }
    const splitEnabled = form.elements.splitAttackEnabled?.checked === true;
    const splitFields = form.querySelector("[data-split-attack-fields]");
    if (splitFields) splitFields.hidden = !splitEnabled;
  }

  /**
   * @param {HTMLFormElement} form Dialog form.
   * @returns {object}
   */
  _readFormState(form, targetSnapshot = this._activeTarget()) {
    const data = new FormData(form);
    const weapon = this._getAvailableWeapon();
    const targetActor = targetSnapshot?.actor ?? this.targetActor;
    const targetToken = targetSnapshot?.token ?? this.targetToken;
    const storedTargetOptions = this.targetOptionValues.get(targetSnapshot?.key ?? "") ?? {};
    const targetValue = (name, fallback = "") => {
      const direct = data.get(name);
      if (targetSnapshot?.key === this.activeTargetKey && direct !== null) return direct;
      return storedTargetOptions[name]?.at?.(-1) ?? fallback;
    };
    const ammunitionId = String(data.get("ammunitionId") ?? "");
    const ammunition = this.ammunitionRequired ? this._getAmmunition(ammunitionId) : null;
    const augmentOptions = new Set(data.getAll("augmentOptions").map(String));
    const mountedCap = mountedWeaponCap(this.actor, itemTotal(weapon ?? this.weapon));
    const baseChanceSource = mountedCap.baseChance;
    const splitAttack = this._readSplitAttackState(data, weapon ?? this.weapon, baseChanceSource);
    const baseChance = splitAttack.enabled || splitAttack.forced ? splitAttack.firstChance : baseChanceSource;
    const situationalModifier = Number(data.get("situationalModifier")) || 0;
    const targetChoices = targetDialogChoiceState(targetActor);
    const aimedLocations = targetChoices.aimedTargets;
    const aimedEnabled = augmentOptions.has("aimed") && aimedLocations.length > 0;
    const aimedLocationId = aimedEnabled ? validChoiceValue(targetValue("aimedLocationId"), aimedLocations) : "";
    const aimedLocation = aimedLocations.find(location => location.value === aimedLocationId) ?? aimedLocations[0] ?? null;
    const aimedModifier = aimedEnabled && aimedLocation?.targetKind === "equipment" ? -20 : aimedEnabled ? aimedPenalty(targetValue("aimedPenalty")) : 0;
    const augmentModifier = augmentOptions.has("custom")
      ? (Number(data.get("customAugmentValue")) || 0)
      : 0;
    const preMultiplierChance = baseChance + situationalModifier + aimedModifier + augmentModifier;
    const rangeEnabled = augmentOptions.has("range") && isProjectileWeapon(weapon ?? this.weapon);
    const selectedRangeBand = missileRangeBand(data.get("missileRangeBand"));
    const rangeMultiplier = rangeEnabled ? missileRangeMultiplier(selectedRangeBand) : 1;
    const rangedChance = Math.floor(preMultiplierChance * rangeMultiplier);
    const intoMeleeEnabled = augmentOptions.has("intoMelee");
    const combatantCount = meleeCombatantCount(data.get("combatantCount"));
    const targetNumber = intoMeleeEnabled
      ? Math.floor(rangedChance / combatantCount)
      : rangedChance;
    const damageSelection = this._damageSelectionForWeapon(weapon ?? this.weapon);
    const damageProfile = buildDamageProfile(this.actor, weapon ?? this.weapon, damageSelection);

    return {
      weapon,
      weaponId: weapon?.id ?? this.weaponId,
      ammunition,
      ammunitionId,
      ammunitionRequired: this.ammunitionRequired,
      damage: String((weapon ?? this.weapon)?.system?.damage ?? "—"),
      sourceDamageType: damageSelection.source,
      damageType: damageSelection.effective,
      damageSelection,
      damageProfile,
      damageOverride: damageSelection.override ?? null,
      workflowType: damageSelection.workflow ?? "missile",
      baseChance,
      mountedCap,
      targetSnapshot,
      targetToken,
      targetActor,
      situationalModifier,
      aimedModifier,
      rangeModifier: rangedChance - preMultiplierChance,
      intoMeleeModifier: targetNumber - rangedChance,
      augmentModifier,
      targetNumber,
      splitAttack,
      normalChance: rangedChance,
      aimedBlow: aimedEnabled && aimedLocation
        ? {
            enabled: true,
            targetKind: aimedLocation.targetKind,
            hitLocationId: aimedLocation.targetKind === "hitLocation" ? aimedLocation.id : "",
            hitLocationName: aimedLocation.targetKind === "hitLocation" ? aimedLocation.name : "",
            rollLabel: aimedLocation.targetKind === "hitLocation" ? aimedLocation.rollLabel : "",
            penalty: aimedModifier,
            targetWeaponId: aimedLocation.targetWeaponId ?? "",
            targetWeaponName: aimedLocation.targetWeaponName ?? "",
            targetWeaponUuid: aimedLocation.targetWeaponUuid ?? null,
            targetWeaponCurrentHp: aimedLocation.targetWeaponCurrentHp ?? 0,
            targetWeaponMaximumHp: aimedLocation.targetWeaponMaximumHp ?? 0
          }
        : {
            enabled: false,
            targetKind: "hitLocation",
            hitLocationId: "",
            hitLocationName: "",
            rollLabel: "",
            penalty: 0,
            targetWeaponId: "",
            targetWeaponName: "",
            targetWeaponUuid: null,
            targetWeaponCurrentHp: 0,
            targetWeaponMaximumHp: 0
          },
      missileIntoMelee: intoMeleeEnabled
        ? {
            enabled: true,
            combatantCount,
            normalChance: rangedChance,
            adjustedChance: targetNumber
          }
        : {
            enabled: false,
            combatantCount,
            normalChance: rangedChance,
            adjustedChance: targetNumber
          },
      missileRange: rangeEnabled
        ? {
            enabled: true,
            band: selectedRangeBand,
            multiplier: rangeMultiplier
          }
        : {
            enabled: false,
            band: "effective",
            multiplier: 1
          },
      rangeLabel: rangeEnabled
        ? (selectedRangeBand === "long"
            ? game.i18n.localize("AOV_SKJALDBORG.MissileDialog.RangeLong")
            : game.i18n.localize("AOV_SKJALDBORG.MissileDialog.RangeMedium"))
        : game.i18n.localize("AOV_SKJALDBORG.MissileDialog.RangeNone"),
      intoMeleeLabel: intoMeleeEnabled
        ? game.i18n.format("AOV_SKJALDBORG.MissileDialog.IntoMeleeSummary", { count: combatantCount })
        : game.i18n.localize("AOV_SKJALDBORG.MissileDialog.IntoMeleeNone"),
      augmentations: {
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
   * @param {HTMLFormElement} form Dialog form.
   * @returns {void}
   */
  _updatePreview(form) {
    const state = this._readFormState(form);
    if (state.weapon) this.weapon = state.weapon;
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
    const submit = form.querySelector("[data-action='submitMissile']");
    if (submit instanceof HTMLButtonElement) {
      submit.disabled = !this.targetSnapshots.length || !state.splitAttack.valid || (this.ammunitionRequired && !state.ammunition);
    }
    updateModifierSummary(form, state, this._formatSummary(state));
  }

  /**
   * @param {{baseChance: number, mountedCap?: object, situationalModifier: number, aimedModifier: number, rangeLabel: string, intoMeleeLabel: string, augmentModifier: number}} state Preview state.
   * @returns {string}
   */
  _formatSummary(state) {
    const summary = game.i18n.format("AOV_SKJALDBORG.MissileDialog.Summary", {
      base: state.baseChance,
      situation: signed(state.situationalModifier),
      aimed: signed(state.aimedModifier),
      range: state.rangeLabel,
      intoMelee: state.intoMeleeLabel,
      augment: signed(state.augmentModifier)
    });
    const mounted = mountedCapSummary(state.mountedCap);
    return mounted ? `${summary} · ${mounted}` : summary;
  }

  _buildDamageContext(state, ammunitionChange = null) {
    const damageContext = {
      app: this,
      actor: this.actor,
      actorUuid: this.actor?.uuid ?? null,
      targetToken: state.targetToken,
      targetTokenUuid: state.targetToken?.document?.uuid ?? state.targetSnapshot?.tokenUuid ?? null,
      targetActor: state.targetActor,
      targetActorUuid: state.targetActor?.uuid ?? state.targetSnapshot?.actorUuid ?? null,
      weapon: state.weapon,
      weaponUuid: state.weapon?.uuid ?? null,
      ammunition: state.ammunition,
      ammunitionUuid: state.ammunition?.uuid ?? null,
      ammunitionRequired: this.ammunitionRequired,
      ammunitionChange,
      sourceDamageType: { ...state.sourceDamageType },
      damageType: { ...state.damageType },
      workflowType: state.workflowType,
      damageOverride: state.damageOverride ? foundry.utils.deepClone(state.damageOverride) : null,
      damageProfile: foundry.utils.deepClone(state.damageProfile)
    };
    Hooks.callAll("aovSkjaldborgPrepareMissileDamage", damageContext);
    return damageContext;
  }

  _buildPayload(state, damageContext, ammunitionChange = null) {
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
      ammunition: state.ammunition,
      ammunitionUuid: state.ammunition?.uuid ?? null,
      ammunitionRequired: this.ammunitionRequired,
      ammunitionChange,
      damage: state.damage,
      sourceDamageType: damageContext.sourceDamageType,
      damageType: damageContext.damageType,
      workflowType: damageContext.workflowType,
      damageOverride: damageContext.damageOverride,
      damageProfile: damageContext.damageProfile,
      baseChance: state.baseChance,
      situationalModifier: state.situationalModifier,
      aimedModifier: state.aimedModifier,
      rangeModifier: state.rangeModifier,
      intoMeleeModifier: state.intoMeleeModifier,
      augmentModifier: state.augmentModifier,
      targetNumber: state.targetNumber,
      aimedBlow: state.aimedBlow,
      missileIntoMelee: state.missileIntoMelee,
      missileRange: state.missileRange,
      augmentations: state.augmentations,
      splitAttack: state.splitAttack,
      targets: this.targetSnapshots.map(serializeTargetSnapshot).filter(Boolean),
      targetOptionsByTokenUuid: Object.fromEntries(this.targetOptionValues),
      originEvent: this.originEvent
    };
  }

  /**
   * @param {Item} ammunition Gear Item.
   * @returns {Promise<object>}
   */
  async _deductAmmunition(ammunition, count = 1) {
    const before = itemQuantity(ammunition);
    const amount = Math.max(1, Math.trunc(Number(count) || 1));
    if (before < amount) {
      throw new Error(game.i18n.localize("AOV_SKJALDBORG.Warnings.AmmunitionDepleted"));
    }
    const after = Math.max(0, before - amount);
    await ammunition.update({ "system.quantity": after });
    return { before, after, count: amount };
  }

  /**
   * Publish the Missile request payload and deduct one ammunition Item when required.
   *
   * @param {HTMLFormElement} form Dialog form.
   * @returns {Promise<object|null>}
   */
  async _submit(form) {
    if (!(form instanceof HTMLFormElement)) return null;
    try {
      this._captureForm(form);
      if (!this.targetSnapshots.length) {
        ui.notifications.warn(game.i18n.localize("AOV_SKJALDBORG.Warnings.MissileTargetRequired"));
        return null;
      }
      const state = this._readFormState(form, this._activeTarget());
      if (!state.splitAttack.valid) {
        ui.notifications.warn(state.splitAttack.message);
        return null;
      }
      if (!state.weapon) {
        ui.notifications.warn(game.i18n.localize("AOV_SKJALDBORG.Warnings.NoReadiedMissileWeapon"));
        return null;
      }
      if (this.ammunitionRequired && !state.ammunition) {
        ui.notifications.warn(game.i18n.localize("AOV_SKJALDBORG.Warnings.AmmunitionRequired"));
        return null;
      }

      if (this.ammunitionRequired && itemQuantity(state.ammunition) < this.targetSnapshots.length) {
        ui.notifications.warn(game.i18n.localize("AOV_SKJALDBORG.Warnings.AmmunitionDepleted"));
        return null;
      }

      const damageContext = this._buildDamageContext(state, null);
      const payload = this._buildPayload(state, damageContext, null);
      const payloads = [payload, ...this.targetSnapshots.slice(1).map(target => {
        const queuedState = this._readFormState(form, target);
        const queuedContext = this._buildDamageContext(queuedState, null);
        return this._buildPayload(queuedState, queuedContext, null);
      })].map((requestPayload, index) => {
        return {
          ...requestPayload,
          batchIndex: index,
          batchSize: this.targetSnapshots.length
        };
      });
      for (const requestPayload of payloads) Hooks.callAll("aovSkjaldborgMissileRollRequested", requestPayload);
      const workflowResults = await startDialogCombatWorkflowBatch(payloads, {
        beforeCreate: async promptedPayloads => {
          if (!this.ammunitionRequired) return true;
          const ammunitionChange = await this._deductAmmunition(state.ammunition, promptedPayloads.length);
          for (const requestPayload of promptedPayloads) {
            requestPayload.ammunitionChange = ammunitionChange;
          }
          return true;
        }
      });
      if (!workflowResults.some(result => result?.started)) return null;
      payload.workflowResult = workflowResults[0] ?? null;
      payload.workflowResults = workflowResults;
      if (state.splitAttack.enabled) {
        await createSplitAttackPrompt({
          actor: this.actor,
          actorUuid: this.actor?.uuid ?? null,
          actorName: this.actor?.name ?? "",
          weaponUuid: state.weapon?.uuid ?? null,
          weaponName: state.weapon?.name ?? "",
          secondChance: state.splitAttack.secondChance,
          naturalSkill: state.splitAttack.naturalSkill,
          secondDexRank: state.splitAttack.secondDexRank,
          sourceWorkflow: "missile"
        });
      }
      ui.notifications.info(game.i18n.localize("AOV_SKJALDBORG.MissileDialog.WorkflowQueued"));
      await this.close();
      return payload;
    } catch (exception) {
      error("Failed to prepare the Skjaldborg missile workflow request.", exception);
      ui.notifications.error(game.i18n.localize("AOV_SKJALDBORG.Warnings.AmmunitionDeductFailed"));
      return null;
    }
  }

  /**
   * AppV2 action bridge for the internal Roll Missile button.
   *
   * @param {PointerEvent} event Pointer event.
   * @param {HTMLElement} target Action control.
   * @returns {Promise<object|null>}
   */
  async _onSubmitMissile(event, target) {
    event.preventDefault();
    const form = target.closest("form");
    return this._submit(form);
  }
}
