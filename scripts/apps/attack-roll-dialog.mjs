import { AoVAdapter } from "../adapter/aov-adapter.mjs";
import { getAttackWeapons, getCombatOptions, getReadiedWeapon, getReadiedWeaponList, isNaturalAttackWeapon } from "../combat/weapon-state.mjs";
import { mountedCapSummary, mountedWeaponCap } from "../combat/mounted-combat.mjs";
import { resolveNaturalWeaponSkill, resolveWeaponSkill } from "../combat/weapon-skill-resolver.mjs";
import { getCombatantState } from "../combat/state.mjs";
import { createCombatRuleContext, prepareAttackContext, prepareDamageContext } from "../combat/rule-kernel.mjs";
import {
  serializeProneAttackModifierContext,
  serializeProneDamageContext
} from "../combat/prone-automation.mjs";
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
  signed,
  SITUATIONAL_MODIFIERS,
  targetDialogChoiceState,
  updateModifierSummary,
  weaponDamageType
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
import { SkjDialogV2 } from "./base/dialog-v2.mjs";

const DISARM_PENALTIES = Object.freeze([0, -20, -40]);
const DISARM_MODES = Object.freeze(["strikeWeapon", "hitFlat", "entangle"]);
const STUN_PENALTY = -40;
const TARGET_OPTION_FIELDS = Object.freeze([
  "aimedLocationId",
  "aimedPenalty",
  "disarmTargetWeaponId",
  "disarmMode",
  "disarmTargetTwoHanded",
  "disarmPenalty",
  "stunLocationId"
]);

function weaponSkillTotal(actor, weapon) {
  return resolveWeaponSkill(actor, weapon).total;
}

function clampChance(value, fallback, max) {
  const number = Number(value);
  const chosen = Number.isFinite(number) && number > 0 ? number : fallback;
  return Math.max(0, Math.min(Math.round(chosen), Math.max(0, max)));
}

function allocatedTwoWeaponChance(options, weapon, fallback) {
  const id = String(weapon?.id ?? "");
  if (id && id === options.twoWeaponFighting?.primaryWeaponId) {
    return clampChance(options.twoWeaponFighting?.primaryChance, fallback, fallback);
  }
  if (id && id === options.twoWeaponFighting?.secondaryWeaponId) {
    return clampChance(options.twoWeaponFighting?.secondaryChance, fallback, fallback);
  }
  return fallback;
}

function halfChance(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return 0;
  return Math.ceil(number / 2);
}

/**
 * Clamp the disarm penalty to the explicitly supported UI options.
 *
 * @param {unknown} value Submitted penalty value.
 * @returns {0|-20|-40}
 */
function disarmPenalty(value) {
  const penalty = Number(value);
  return DISARM_PENALTIES.includes(penalty) ? penalty : -20;
}

/**
 * Clamp the Disarm mode to supported workflow branches.
 *
 * @param {unknown} value Submitted mode value.
 * @returns {"strikeWeapon"|"hitFlat"|"entangle"}
 */
function disarmMode(value) {
  const mode = String(value ?? "");
  return DISARM_MODES.includes(mode) ? mode : "strikeWeapon";
}

/**
 * Initial Attack workflow dialog.
 *
 * The application deliberately owns only selection and preview state in this
 * milestone. Submitting publishes a stable hook payload for later attack,
 * defence, damage, and chat-card automation; it does not alter Actor, Token,
 * Combat, or Item documents.
 */
export class AttackRollDialog extends SkjDialogV2 {
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
   * @param {{actor: Actor, targetToken?: Token|null, targets?: object[], weapons: Item[], originEvent?: Event|null, forcedSplitAttack?: object|null}} config Dialog source.
   */
  constructor({ actor, targetToken = null, targets = [], weapons = [], originEvent = null, forcedSplitAttack = null }) {
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
    this.targetSnapshots = targets.length ? targets : currentTargetSnapshots();
    if (!this.targetSnapshots.length && targetToken) {
      this.targetSnapshots = currentTargetSnapshots().filter(target => target.token === targetToken || target.tokenDocument === targetToken?.document);
    }
    this.activeTargetKey = this.targetSnapshots[0]?.key ?? "";
    this.targetToken = this.targetSnapshots[0]?.token ?? null;
    this.targetActor = this.targetSnapshots[0]?.actor ?? null;
    this.originEvent = originEvent;
    this.forcedSplitAttack = forcedSplitAttack;
    this.formValues = {};
    this.targetOptionValues = new Map();
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
  static async show({ actor, originEvent = null, forcedSplitAttack = null } = {}) {
    if (!actor) {
      ui.notifications.warn(game.i18n.localize("AOV_SKJALDBORG.Warnings.ActorUnavailable"));
      return null;
    }

    const targets = currentTargetSnapshots();
    if (!targets.length) {
      ui.notifications.warn(game.i18n.localize("AOV_SKJALDBORG.Warnings.AttackTargetRequired"));
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
    this.current = new AttackRollDialog({ actor, targets, weapons, originEvent, forcedSplitAttack });
    await this.current.render({ force: true });
    return this.current;
  }

  /** @override */
  async close(options = {}) {
    unregisterTargetRefresh(this);
    const result = await super.close(options);
    if (AttackRollDialog.current === this) AttackRollDialog.current = null;
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
        void this.render({ force: true }).catch(exception => {
          error("Failed to change the active target in the attack dialog.", exception);
        });
      }
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
    return attackDamageSelection(weapon, requestedKey, {
      workflow: "melee",
      forceMeleeMissileHandToHand: true
    });
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
    this._setActiveTarget(this._activeTarget());
    const weapons = this._getAvailableWeapons();
    if (!weapons.some(item => item.id === this.weapon?.id)) this.weapon = weapons[0] ?? null;
    const mountedCap = mountedWeaponCap(this.actor, weaponSkillTotal(this.actor, this.weapon));
    const splitState = this._prepareSplitAttackState(this.weapon, mountedCap.baseChance);
    const baseChance = this.forcedSplitAttack ? Number(this.forcedSplitAttack.baseChance) || mountedCap.baseChance : mountedCap.baseChance;
    const targetChoices = targetDialogChoiceState(this.targetActor);
    const aimedTargets = targetChoices.aimedTargets;
    const stunState = targetChoices.stunState;
    const disarmWeapons = targetChoices.equippedWeapons;
    const targetImg = actorPortraitSource(this.targetActor, this.targetToken);
    const damageSelection = this._damageSelectionForWeapon(this.weapon);
    const twoWeaponState = this._prepareTwoWeaponState();

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
      damage: String(this.weapon?.system?.damage ?? "—"),
      damageType: damageSelection.effective.abbreviation,
      damageTypeKey: damageSelection.effective.key,
      damageTypeLabel: damageSelection.effective.label,
      damageTypeTooltip: damageSelection.tooltip,
      damageTypeSelectable: damageSelection.selectable,
      weapons: weapons.map(item => ({
        id: item.id,
        label: `${item.name} (${mountedWeaponCap(this.actor, weaponSkillTotal(this.actor, item)).baseChance}%)`,
        selected: item.id === this.weapon?.id
      })),
      twoWeapon: twoWeaponState,
      splitAttack: splitState,
      modifiers: SITUATIONAL_MODIFIERS.map(entry => ({
        value: entry.value,
        label: game.i18n.localize(`AOV_SKJALDBORG.AttackDialog.Modifiers.${entry.key}`),
        selected: entry.value === 0
      })),
      aimedLocations: aimedTargets,
      aimedNoLocationsTooltip: aimedTargets.length
        ? ""
        : game.i18n.localize("AOV_SKJALDBORG.AttackDialog.AimedNoLocations"),
      stunLocations: stunState.locations.map(location => ({
        ...location,
        selected: location.id === stunState.selectedId
      })),
      stunNoHeadTooltip: stunState.locations.length
        ? ""
        : game.i18n.localize("AOV_SKJALDBORG.AttackDialog.StunNoHead"),
      stunPenaltyLabel: game.i18n.localize("AOV_SKJALDBORG.AttackDialog.StunPenaltyHead"),
      disarmWeapons,
      disarmNoWeaponsTooltip: disarmWeapons.length
        ? ""
        : game.i18n.localize("AOV_SKJALDBORG.AttackDialog.DisarmNoWeapons"),
      disarmModes: [
        {
          value: "strikeWeapon",
          label: game.i18n.localize("AOV_SKJALDBORG.AttackDialog.DisarmModeStrikeWeapon"),
          selected: true
        },
        {
          value: "hitFlat",
          label: game.i18n.localize("AOV_SKJALDBORG.AttackDialog.DisarmModeHitFlat"),
          selected: false
        },
        {
          value: "entangle",
          label: game.i18n.localize("AOV_SKJALDBORG.AttackDialog.DisarmModeEntangle"),
          selected: false
        }
      ],
      disarmPenalties: [
        {
          value: 0,
          label: game.i18n.localize("AOV_SKJALDBORG.AttackDialog.DisarmPenaltyNone"),
          selected: false
        },
        {
          value: -20,
          label: game.i18n.localize("AOV_SKJALDBORG.AttackDialog.DisarmPenaltyAverage"),
          selected: true
        },
        {
          value: -40,
          label: game.i18n.localize("AOV_SKJALDBORG.AttackDialog.DisarmPenaltyHard"),
          selected: false
        }
      ],
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
      hasAimedLocations: aimedTargets.length > 0,
      hasDisarmWeapons: disarmWeapons.length > 0,
      hasStunHead: stunState.locations.length > 0,
      initialSummary: this._formatSummary({ baseChance, mountedCap, targetNumber: baseChance, situationalModifier: 0, aimedModifier: 0, disarmModifier: 0, stunModifier: 0, augmentModifier: 0, proneModifier: 0 })
    };
  }

  _twoWeaponEligibleWeapons() {
    if (getCombatOptions(this.actor).twoWeaponFighting.enabled !== true) return [];
    return getReadiedWeaponList(this.actor)
      .filter(item => item?.type === "weapon" && !isNaturalAttackWeapon(item) && weaponSkillTotal(this.actor, item) >= 100);
  }

  _resolveTwoWeaponSecondary(weapon, combatOptions = getCombatOptions(this.actor)) {
    const eligible = this._twoWeaponEligibleWeapons();
    if (eligible.length < 2 || !weapon?.id) return null;

    const weaponId = String(weapon.id);
    if (!eligible.some(item => String(item?.id ?? "") === weaponId)) return null;

    const primaryId = String(combatOptions.twoWeaponFighting?.primaryWeaponId ?? "");
    const secondaryId = String(combatOptions.twoWeaponFighting?.secondaryWeaponId ?? "");
    let secondary = null;

    if (weaponId === primaryId && secondaryId) {
      secondary = eligible.find(item => String(item?.id ?? "") === secondaryId) ?? null;
    } else if (weaponId === secondaryId && primaryId) {
      secondary = eligible.find(item => String(item?.id ?? "") === primaryId) ?? null;
    }

    return secondary ?? eligible.find(item => String(item?.id ?? "") !== weaponId) ?? null;
  }

  _prepareTwoWeaponState() {
    const combatOptions = getCombatOptions(this.actor);
    const secondary = this._resolveTwoWeaponSecondary(this.weapon, combatOptions);
    return {
      enabled: !!secondary,
      halfSkillTooltip: game.i18n.localize("AOV_SKJALDBORG.AttackDialog.TwoWeaponHalfSkillTooltip")
    };
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

  _readSplitAttackState(data, baseChance) {
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
    const naturalSkill = Number(resolveNaturalWeaponSkill(this.actor, this.weapon).total);
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
    const state = combatant ? getCombatantState(combatant) : null;
    const ledgerDex = Number(state?.dexLedger?.finalDex);
    if (Number.isFinite(ledgerDex) && ledgerDex > 0) return ledgerDex;
    const initiative = Number(combatant?.initiative);
    if (Number.isFinite(initiative) && initiative > 0) return Math.trunc(initiative);
    return AoVAdapter.getDex(this.actor);
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
    this._syncAimedPenaltyControls(form);
    this._updatePreview(form);
    if (["augmentOptions", "splitAttackEnabled"].includes(String(target?.name ?? ""))) {
      this.requestContentRefit();
    }
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
    const splitEnabled = form.elements.splitAttackEnabled?.checked === true;
    const splitFields = form.querySelector("[data-split-attack-fields]");
    if (splitFields) splitFields.hidden = !splitEnabled;
  }

  /**
   * Parse current form state into a future-proof attack request.
   *
   * Aimed, Disarm, Stun, and Custom apply explicit numeric preview modifiers.
   *
   * @param {HTMLFormElement} form Dialog form.
   * @returns {object}
   */
  _readFormState(form, targetSnapshot = this._activeTarget()) {
    const data = new FormData(form);
    const weaponId = String(data.get("weaponId") ?? this.weapon?.id ?? "");
    const weapon = this._getAvailableWeapon(weaponId) ?? this.weapon;
    this.weapon = weapon;
    const targetActor = targetSnapshot?.actor ?? this.targetActor;
    const targetToken = targetSnapshot?.token ?? this.targetToken;
    const storedTargetOptions = this.targetOptionValues.get(targetSnapshot?.key ?? "") ?? {};
    const targetValue = (name, fallback = "") => {
      const direct = data.get(name);
      if (targetSnapshot?.key === this.activeTargetKey && direct !== null) return direct;
      return storedTargetOptions[name]?.at?.(-1) ?? fallback;
    };
    const targetValues = (name) => {
      if (targetSnapshot?.key === this.activeTargetKey) return data.getAll(name).map(String);
      return storedTargetOptions[name] ?? [];
    };
    const augmentOptions = new Set(data.getAll("augmentOptions").map(String));
    const combatOptions = getCombatOptions(this.actor);
    const secondWeapon = this._resolveTwoWeaponSecondary(weapon, combatOptions);
    const useHalfSkillTwoWeapon = !!secondWeapon && data.get("twoWeaponHalfSkill") === "on";
    const primaryWeaponTotal = weaponSkillTotal(this.actor, weapon);
    const secondaryWeaponTotal = secondWeapon ? weaponSkillTotal(this.actor, secondWeapon) : 0;
    const primaryMountedCap = mountedWeaponCap(this.actor, primaryWeaponTotal);
    const secondaryMountedCap = secondWeapon ? mountedWeaponCap(this.actor, secondaryWeaponTotal) : null;
    const primaryAllocatedChance = allocatedTwoWeaponChance(combatOptions, weapon, primaryMountedCap.baseChance);
    const secondaryAllocatedChance = secondWeapon
      ? allocatedTwoWeaponChance(combatOptions, secondWeapon, secondaryMountedCap.baseChance)
      : 0;
    const primaryWeaponChance = useHalfSkillTwoWeapon ? halfChance(primaryAllocatedChance) : primaryAllocatedChance;
    const secondaryWeaponChance = useHalfSkillTwoWeapon ? halfChance(secondaryAllocatedChance) : secondaryAllocatedChance;
    const baseChanceSource = secondWeapon ? primaryWeaponChance : primaryMountedCap.baseChance;
    const splitAttack = this._readSplitAttackState(data, baseChanceSource);
    const baseChance = splitAttack.enabled || splitAttack.forced ? splitAttack.firstChance : baseChanceSource;
    const situationalModifier = Number(data.get("situationalModifier")) || 0;
    const targetChoices = targetDialogChoiceState(targetActor);
    const aimedLocations = targetChoices.aimedTargets;
    const aimedEnabled = augmentOptions.has("aimed") && aimedLocations.length > 0;
    const aimedLocationId = aimedEnabled ? validChoiceValue(targetValue("aimedLocationId"), aimedLocations) : "";
    const aimedLocation = aimedLocations.find(location => location.value === aimedLocationId) ?? aimedLocations[0] ?? null;
    const aimedModifier = aimedEnabled && aimedLocation?.targetKind === "equipment" ? -20 : aimedEnabled ? aimedPenalty(targetValue("aimedPenalty")) : 0;
    const stunState = targetChoices.stunState;
    const stunEnabled = augmentOptions.has("stun") && stunState.locations.length > 0;
    const stunLocationId = stunEnabled ? validChoiceValue(targetValue("stunLocationId", stunState.selectedId), stunState.locations, "id") : "";
    const stunLocation = stunState.locations.find(location => location.id === stunLocationId) ?? stunState.locations[0] ?? null;
    const stunModifier = stunEnabled ? STUN_PENALTY : 0;
    const disarmWeapons = targetChoices.equippedWeapons;
    const disarmEnabled = augmentOptions.has("disarm") && disarmWeapons.length > 0;
    const disarmTargetWeaponId = disarmEnabled ? validChoiceValue(targetValue("disarmTargetWeaponId"), disarmWeapons, "id") : "";
    const disarmTargetWeapon = disarmWeapons.find(weaponChoice => weaponChoice.id === disarmTargetWeaponId) ?? disarmWeapons[0] ?? null;
    const disarmModifier = disarmEnabled ? disarmPenalty(targetValue("disarmPenalty")) : 0;
    const selectedDisarmMode = disarmMode(targetValue("disarmMode"));
    const augmentModifier = augmentOptions.has("custom")
      ? (Number(data.get("customAugmentValue")) || 0)
      : 0;
    const damageSelection = this._damageSelectionForWeapon(weapon);
    const damageProfile = buildDamageProfile(this.actor, weapon, damageSelection);
    const attackerToken = AoVAdapter.resolveActorTokenDocument(this.actor, null);
    const ruleContext = prepareDamageContext(prepareAttackContext(createCombatRuleContext({
      attackerActor: this.actor,
      attackerToken,
      targetActor,
      targetToken,
      weapon,
      aimed: aimedEnabled
    })));
    const proneRules = ruleContext.proneRules ?? null;
    const proneModifier = Number(proneRules?.total) || 0;
    const proneDamageRules = ruleContext.proneDamageRules ?? null;

    return {
      weapon,
      weaponId: weapon?.id ?? weaponId,
      damage: String(weapon?.system?.damage ?? "—"),
      sourceDamageType: damageSelection.source,
      damageType: damageSelection.effective,
      damageSelection,
      damageProfile,
      damageOverride: damageSelection.override ?? null,
      workflowType: damageSelection.workflow ?? "melee",
      baseChance,
      mountedCap: primaryMountedCap,
      situationalModifier,
      aimedModifier,
      disarmModifier,
      stunModifier,
      augmentModifier,
      proneModifier,
      proneRules,
      proneDamageRules,
      targetNumber: baseChance + situationalModifier + aimedModifier + disarmModifier + stunModifier + augmentModifier + proneModifier,
      targetSnapshot,
      targetToken,
      targetActor,
      splitAttack,
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
      stun: stunEnabled && stunLocation
        ? {
            enabled: true,
            hitLocationId: stunLocation.id,
            hitLocationName: stunLocation.name,
            rollLabel: stunLocation.rollLabel,
            penalty: STUN_PENALTY
          }
        : {
            enabled: false,
            hitLocationId: "",
            hitLocationName: "",
            rollLabel: "",
            penalty: 0
          },
      disarm: disarmEnabled && disarmTargetWeapon
        ? {
            enabled: true,
            mode: selectedDisarmMode,
            targetWeaponId: disarmTargetWeapon.id,
            targetWeaponName: disarmTargetWeapon.name,
            targetWeaponUuid: disarmTargetWeapon.uuid,
            targetTwoHanded: targetValues("disarmTargetTwoHanded").includes("on"),
            penalty: disarmModifier
          }
        : {
            enabled: false,
            mode: "strikeWeapon",
            targetWeaponId: "",
            targetWeaponName: "",
            targetWeaponUuid: null,
            targetTwoHanded: false,
            penalty: 0
          },
      augmentations: {
        custom: augmentOptions.has("custom")
          ? {
              reason: String(data.get("customAugmentReason") ?? "").trim(),
              value: augmentModifier
            }
          : null
      },
      twoWeapon: secondWeapon
        ? {
            enabled: true,
            mode: useHalfSkillTwoWeapon ? "multi-target-half-skill" : "same-target-full-skill",
            primaryWeaponUuid: weapon?.uuid ?? null,
            primaryWeaponId: weapon?.id ?? "",
            primaryWeaponTotal,
            primarySkill: primaryWeaponTotal,
            primaryWeaponChance,
            secondaryWeaponUuid: secondWeapon.uuid ?? null,
            secondaryWeaponId: secondWeapon.id,
            secondaryWeaponName: secondWeapon.name,
            secondaryWeaponTotal,
            secondarySkill: secondaryWeaponTotal,
            secondaryWeaponChance,
            secondaryDexRank: Math.ceil(Math.max(1, this._currentDexRank()) / 2)
          }
        : {
            enabled: false,
            mode: "",
            primaryWeaponUuid: weapon?.uuid ?? null,
            primaryWeaponId: weapon?.id ?? "",
            primaryWeaponTotal,
            primarySkill: primaryWeaponTotal,
            primaryWeaponChance: primaryAllocatedChance,
            secondaryWeaponUuid: null,
            secondaryWeaponId: "",
            secondaryWeaponName: "",
            secondaryWeaponTotal: 0,
            secondarySkill: 0,
            secondaryWeaponChance: 0,
            secondaryDexRank: 0
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
    const submit = form.querySelector("[data-action='submitAttack']");
    if (submit instanceof HTMLButtonElement) {
      submit.disabled = !this.targetSnapshots.length || !state.splitAttack.valid;
    }
    updateModifierSummary(form, state, this._formatSummary(state));
  }

  /**
   * Produce the compact modifier explanation displayed in the footer.
   *
   * @param {{baseChance: number, mountedCap?: object, situationalModifier: number, aimedModifier: number, disarmModifier: number, stunModifier: number, augmentModifier: number, proneModifier?: number}} state Preview state.
   * @returns {string}
   */
  _formatSummary(state) {
    const summary = game.i18n.format("AOV_SKJALDBORG.AttackDialog.Summary", {
      base: state.baseChance,
      situation: signed(state.situationalModifier),
      aimed: signed(state.aimedModifier),
      disarm: signed(state.disarmModifier),
      stun: signed(state.stunModifier),
      augment: signed(state.augmentModifier)
    });
    const proneModifier = Number(state.proneModifier) || 0;
    const prone = proneModifier
      ? ` · ${game.i18n.format("AOV_SKJALDBORG.AttackDialog.ProneSummary", { prone: signed(proneModifier) })}`
      : "";
    const mounted = mountedCapSummary(state.mountedCap);
    return `${summary}${prone}${mounted ? ` · ${mounted}` : ""}`;
  }

  _buildDamageContext(state) {
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
      sourceDamageType: { ...state.sourceDamageType },
      damageType: { ...state.damageType },
      workflowType: state.workflowType,
      damageOverride: state.damageOverride ? foundry.utils.deepClone(state.damageOverride) : null,
      damageProfile: foundry.utils.deepClone(state.damageProfile)
    };
    Hooks.callAll("aovSkjaldborgPrepareAttackDamage", damageContext);
    return damageContext;
  }

  _buildPayload(state, damageContext) {
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
      damage: state.damage,
      sourceDamageType: damageContext.sourceDamageType,
      damageType: damageContext.damageType,
      workflowType: damageContext.workflowType,
      damageOverride: damageContext.damageOverride,
      damageProfile: damageContext.damageProfile,
      baseChance: state.baseChance,
      situationalModifier: state.situationalModifier,
      aimedModifier: state.aimedModifier,
      disarmModifier: state.disarmModifier,
      stunModifier: state.stunModifier,
      augmentModifier: state.augmentModifier,
      proneModifier: state.proneModifier,
      proneRules: serializeProneAttackModifierContext(state.proneRules),
      proneDamageRules: serializeProneDamageContext(state.proneDamageRules),
      targetNumber: state.targetNumber,
      twoWeapon: state.twoWeapon,
      aimedBlow: state.aimedBlow,
      disarm: state.disarm,
      stun: state.stun,
      augmentations: state.augmentations,
      splitAttack: state.splitAttack,
      targets: this.targetSnapshots.map(serializeTargetSnapshot).filter(Boolean),
      targetOptionsByTokenUuid: Object.fromEntries(this.targetOptionValues),
      originEvent: this.originEvent
    };
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
      this._captureForm(form);
      if (!this.targetSnapshots.length) {
        ui.notifications.warn(game.i18n.localize("AOV_SKJALDBORG.Warnings.AttackTargetRequired"));
        return null;
      }
      const activeState = this._readFormState(form, this._activeTarget());
      if (!activeState.splitAttack.valid) {
        ui.notifications.warn(activeState.splitAttack.message);
        return null;
      }
      const payloads = this.targetSnapshots.map((target, index) => {
        const state = this._readFormState(form, target);
        const damageContext = this._buildDamageContext(state);
        return {
          ...this._buildPayload(state, damageContext),
          batchIndex: index,
          batchSize: this.targetSnapshots.length
        };
      });
      const payload = payloads[0];
      for (const requestPayload of payloads) Hooks.callAll("aovSkjaldborgAttackRollRequested", requestPayload);
      const workflowResults = await startDialogCombatWorkflowBatch(payloads);
      if (!workflowResults.some(result => result?.started)) return null;
      payload.workflowResult = workflowResults[0] ?? null;
      payload.workflowResults = workflowResults;
      if (activeState.splitAttack.enabled) {
        await createSplitAttackPrompt({
          actor: this.actor,
          actorUuid: this.actor?.uuid ?? null,
          actorName: this.actor?.name ?? "",
          weaponUuid: activeState.weapon?.uuid ?? null,
          weaponName: activeState.weapon?.name ?? "",
          secondChance: activeState.splitAttack.secondChance,
          naturalSkill: activeState.splitAttack.naturalSkill,
          secondDexRank: activeState.splitAttack.secondDexRank,
          sourceWorkflow: "attack"
        });
      }
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
