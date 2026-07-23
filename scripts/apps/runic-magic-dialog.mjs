import { AoVAdapter } from "../adapter/aov-adapter.mjs";
import { getCombatState, getCombatantState } from "../combat/state.mjs";
import {
  actorMagicItems,
  cleanTargetRefs,
  CRAFT_RUNE_MODES,
  firstRuneMagicSkill,
  firstSeidurMagicSkill,
  readWriteRunesSkill,
  RUNE_MAGIC_STATUSES,
  runeCraftChoices,
  runeMagicConsumesPrepared,
  runeScriptDetails,
  seidurDetails
} from "../combat/runic-magic-data.mjs";
import { appendMagicDetailsToMessage, createRunicResistanceCards } from "../combat/runic-magic-cards.mjs";
import { currentTargetSnapshots, serializeTargetSnapshot } from "./target-refresh-helpers.mjs";
import { requestGm } from "../socket.mjs";
import { RenderCoordinator } from "../ui/render-coordinator.mjs";
import { actionThemeClass, actorPortraitSource, isVideoSource } from "../ui/dom-utils.mjs";
import { error } from "../logger.mjs";
import { ensureDialogPartialsLoaded } from "./base/dialog-partials.mjs";
import { SkjDialogV2 } from "./base/dialog-v2.mjs";

function safeState(combatant) {
  return combatant ? getCombatantState(combatant) : { runeMagic: {}, updatedAt: 0 };
}

function safeCombatState(combat) {
  return combat ? getCombatState(combat) : { logicalRound: null };
}

function selectedMagicId(state, runescripts, seidurs) {
  const trackedId = String(state?.runeMagic?.itemId ?? "");
  if (trackedId && [...runescripts, ...seidurs].some(item => String(item.id) === trackedId)) return trackedId;
  return String(runescripts[0]?.id ?? seidurs[0]?.id ?? "");
}

function targetContext() {
  const targets = currentTargetSnapshots().map(serializeTargetSnapshot).filter(Boolean);
  return {
    targets,
    targetJson: JSON.stringify(targets),
    targetNames: targets.map(target => target.name).filter(Boolean).join(", "),
    hasTargets: targets.length > 0
  };
}

function runeRows(runescripts, selectedId) {
  return runescripts.map(item => {
    const details = runeScriptDetails(item);
    return {
      id: String(item.id),
      uuid: item.uuid ?? "",
      name: String(item.name ?? ""),
      prepared: item.system?.prepared === true,
      selected: String(item.id) === selectedId,
      summary: game.i18n.format("AOV_SKJALDBORG.RunicMagic.RuneSummary", {
        runes: details.runeCount,
        mp: details.mpCost,
        effects: details.maxEffects
      }),
      ...details
    };
  });
}

function seidurRows(seidurs, selectedId) {
  return seidurs.map(item => {
    const details = seidurDetails(item);
    return {
      id: String(item.id),
      uuid: item.uuid ?? "",
      name: String(item.name ?? ""),
      prepared: item.system?.prepared === true,
      selected: String(item.id) === selectedId,
      summary: game.i18n.format("AOV_SKJALDBORG.RunicMagic.SeidurSummary", {
        realm: details.realm || game.i18n.localize("AOV_SKJALDBORG.Chat.None"),
        mp: details.mpCost,
        locked: details.mpLocked,
        time: details.castTime
      }),
      ...details
    };
  });
}

function selectedOption(select) {
  return select instanceof HTMLSelectElement ? select.selectedOptions?.[0] ?? null : null;
}

function selectedMode(form) {
  return String(new FormData(form).get("magicMode") ?? "");
}

function firstAvailableCraftMode(craftChoices) {
  return craftChoices.find(choice => choice.available && choice.mode !== CRAFT_RUNE_MODES.CUSTOM)?.mode
    ?? CRAFT_RUNE_MODES.CUSTOM;
}

function magicModeControls(selectedMagicType) {
  return [
    {
      value: "runescript",
      label: game.i18n.localize("AOV_SKJALDBORG.RunicMagic.RuneScripts"),
      checked: selectedMagicType === "runescript"
    },
    {
      value: "seidur",
      label: game.i18n.localize("AOV_SKJALDBORG.RunicMagic.Seidur"),
      checked: selectedMagicType === "seidur"
    }
  ];
}

function runicOptionControls({ preparedDefault, customModifierEnabled }) {
  return [
    {
      type: "checkbox",
      name: "prepared",
      value: "on",
      label: game.i18n.localize("AOV_SKJALDBORG.RunicMagic.Prepared"),
      checked: preparedDefault,
      dataRuneOnly: true
    },
    {
      type: "checkbox",
      name: "resistance",
      value: "on",
      label: game.i18n.localize("AOV_SKJALDBORG.RunicMagic.Resistance"),
      dataRuneOnly: true
    },
    {
      type: "checkbox",
      name: "craftEnabled",
      value: "on",
      label: game.i18n.localize("AOV_SKJALDBORG.RunicMagic.CraftRune"),
      dataRuneOnly: true
    },
    {
      type: "checkbox",
      name: "customModifierEnabled",
      value: "on",
      label: game.i18n.localize("AOV_SKJALDBORG.RunicMagic.CustomModifier"),
      checked: customModifierEnabled
    }
  ];
}

function resultSucceeded(result) {
  if (result?.resultLevel === null || result?.resultLevel === undefined) return false;
  return Number(result.resultLevel) >= 2;
}

export class RunicMagicDialog extends SkjDialogV2 {
  static current = null;

  constructor({ actor, combatant = null, combat = game.combat } = {}) {
    let dialog;
    const themeClass = actionThemeClass();
    super({
      classes: ["aov-skjaldborg", "dialog", "skj-attack-roll-window", "skj-runic-magic-dialog-window", themeClass],
      window: {
        title: game.i18n.localize("AOV_SKJALDBORG.RunicMagic.Title"),
        contentTag: "form",
        contentClasses: ["aov-skjaldborg", "skj-attack-roll-content", themeClass]
      },
      buttons: [
        {
          action: "cast",
          label: game.i18n.localize("AOV_SKJALDBORG.RunicMagic.Submit"),
          default: true,
          callback: async (_event, button) => dialog._submit(button.form)
        }
      ],
      position: { width: 390, height: "auto" },
      modal: false,
      rejectClose: false
    });
    dialog = this;
    this.actor = actor;
    this.combat = combat?.started ? combat : null;
    this.combatant = combatant ?? AoVAdapter.getControlledCombatant(this.combat);
  }

  static async show({ actor, combatant, combat = game.combat } = {}) {
    if (!actor?.isOwner) {
      ui.notifications.warn(game.i18n.localize("AOV_SKJALDBORG.Warnings.NotOwner"));
      return null;
    }
    const activeCombat = combat?.started ? combat : null;
    const liveCombatant = combatant ?? AoVAdapter.getControlledCombatant(activeCombat);
    if (activeCombat && liveCombatant && !AoVAdapter.canUserControlCombatant(game.user, liveCombatant)) {
      ui.notifications.warn(game.i18n.localize("AOV_SKJALDBORG.Warnings.NotOwner"));
      return null;
    }

    if (this.current) await this.current.close({ force: true });
    this.current = new RunicMagicDialog({ actor, combatant: liveCombatant, combat: activeCombat });
    await this.current.render({ force: true });
    return this.current;
  }

  async close(options = {}) {
    const result = await super.close(options);
    if (RunicMagicDialog.current === this) RunicMagicDialog.current = null;
    return result;
  }

  async _renderHTML() {
    await ensureDialogPartialsLoaded();
    return foundry.applications.handlebars.renderTemplate(
      "modules/aov-skjaldborg/templates/runic-magic-dialog.hbs",
      this._prepareDialogContext()
    );
  }

  _replaceHTML(result, content) {
    content.innerHTML = result;
    this._activateControls(content);
  }

  _prepareDialogContext() {
    const actor = this.actor;
    const state = safeState(this.combatant);
    const combatState = safeCombatState(this.combat);
    const { runescripts, seidurs } = actorMagicItems(actor);
    const selectedId = selectedMagicId(state, runescripts, seidurs);
    const runescriptRows = runeRows(runescripts, selectedId);
    const seidurEntries = seidurRows(seidurs, selectedId);
    const selectedRune = runescriptRows.find(row => row.selected) ?? runescriptRows[0] ?? null;
    const selectedSeidur = seidurEntries.find(row => row.selected) ?? seidurEntries[0] ?? null;
    const selectedMagicType = selectedRune?.selected ? "runescript" : selectedSeidur ? "seidur" : "runescript";
    const targets = targetContext();
    const portrait = actorPortraitSource(actor);
    const runeSkill = firstRuneMagicSkill(actor);
    const seidurSkill = firstSeidurMagicSkill(actor);
    const craftChoices = runeCraftChoices(actor);
    const readWriteRunes = readWriteRunesSkill(actor);
    const tracked = state.runeMagic ?? {};
    const currentRound = Number(combatState.logicalRound ?? 1);
    const ready = [RUNE_MAGIC_STATUSES.READY, RUNE_MAGIC_STATUSES.CARVING].includes(tracked.status)
      && (!tracked.readyRound || Number(tracked.readyRound) <= currentRound);
    const selectedCraftMode = craftChoices.some(choice => String(choice.mode) === String(tracked.craftMode))
      ? tracked.craftMode
      : firstAvailableCraftMode(craftChoices);

    const preparedDefault = ready || selectedRune?.prepared === true;
    const customModifierEnabled = Number(tracked.flatMod ?? 0) !== 0 || !!tracked.customModifierReason;
    return {
      actorName: actor.name ?? "",
      actorInitial: String(actor.name ?? "?").trim().charAt(0).toUpperCase() || "?",
      actorImg: portrait,
      actorImgIsVideo: isVideoSource(portrait),
      combatId: this.combat?.id ?? "",
      combatantId: this.combatant?.id ?? "",
      hasCombatant: !!this.combatant,
      expectedCombatantUpdatedAt: state.updatedAt ?? 0,
      logicalRound: this.combat ? currentRound : game.i18n.localize("AOV_SKJALDBORG.RunicMagic.NoCombatRound"),
      runescripts: runescriptRows,
      seidurs: seidurEntries,
      hasMagic: !!(runescriptRows.length || seidurEntries.length),
      hasRunescripts: !!runescriptRows.length,
      hasSeidurs: !!seidurEntries.length,
      showModeSelector: !!(runescriptRows.length && seidurEntries.length),
      selectedMagicType,
      selectedRuneMode: selectedMagicType === "runescript",
      selectedSeidurMode: selectedMagicType === "seidur",
      selectedRune,
      selectedSeidur,
      magicModeControls: magicModeControls(selectedMagicType),
      dexPenalty: Math.max(1, Number(tracked.dexPenalty || selectedRune?.dexPenalty || 1)),
      flatMod: Number(tracked.flatMod ?? 0) || 0,
      customModifierEnabled,
      customModifierReason: String(tracked.customModifierReason ?? ""),
      customModifierRow: {
        class: "skj-runic-magic-dialog__detail--custom",
        detailName: "custom",
        hidden: !customModifierEnabled,
        label: game.i18n.localize("AOV_SKJALDBORG.RunicMagic.FlatMod"),
        reasonName: "customModifierReason",
        reasonValue: String(tracked.customModifierReason ?? ""),
        reasonPlaceholder: game.i18n.localize("AOV_SKJALDBORG.AttackDialog.CustomReason"),
        valueName: "flatMod",
        value: Number(tracked.flatMod ?? 0) || 0,
        min: -200,
        max: 200,
        step: 1
      },
      runicOptionControls: runicOptionControls({ preparedDefault, customModifierEnabled }),
      craftChoices: craftChoices.map(choice => ({
        ...choice,
        selected: choice.mode === selectedCraftMode
      })),
      selectedCraftMode,
      readWriteRunes,
      hasReadWriteRunes: !!readWriteRunes,
      customCraftTarget: Math.max(1, Number(tracked.customCraftTarget ?? 50) || 50),
      runeMagicSkillName: runeSkill?.name ?? game.i18n.localize("AOV_SKJALDBORG.RunicMagic.RuneMagicSkillMissing"),
      seidurMagicSkillName: seidurSkill?.name ?? game.i18n.localize("AOV_SKJALDBORG.RunicMagic.SeidurMagicSkillMissing"),
      tracked,
      isReady: ready,
      preparedDefault,
      isCarving: tracked.status === RUNE_MAGIC_STATUSES.CARVING && !ready,
      isFailed: tracked.status === RUNE_MAGIC_STATUSES.FAILED,
      isDisrupted: tracked.status === RUNE_MAGIC_STATUSES.DISRUPTED,
      targets
    };
  }

  _activateControls(root) {
    const form = root instanceof HTMLFormElement ? root : root.querySelector("form");
    if (!(form instanceof HTMLFormElement)) return;

    const update = () => {
      const mode = selectedMode(form);
      const runeMode = mode === "runescript";
      const runePanel = form.querySelector("[data-rune-panel]");
      const seidurPanel = form.querySelector("[data-seidur-panel]");
      if (runePanel instanceof HTMLElement) runePanel.hidden = !runeMode;
      if (seidurPanel instanceof HTMLElement) seidurPanel.hidden = runeMode;

      for (const element of form.querySelectorAll("[data-rune-only]")) {
        if (!(element instanceof HTMLElement)) continue;
        element.hidden = !runeMode;
        for (const control of element.querySelectorAll("input, select, button, textarea")) {
          control.disabled = !runeMode;
        }
      }

      const runeOption = selectedOption(form.elements.runescriptId);
      const dexInput = form.elements.dexPenalty;
      if (dexInput instanceof HTMLInputElement && runeOption?.dataset.runeCount && !dexInput.dataset.userEdited) {
        dexInput.value = String(Math.max(1, Number(runeOption.dataset.runeCount) || 1));
      }
      const preparedInput = form.elements.prepared;
      if (preparedInput instanceof HTMLInputElement && runeMode && !preparedInput.dataset.userEdited) {
        preparedInput.checked = runeOption?.dataset.prepared === "true" || preparedInput.defaultChecked;
      }

      const craftEnabled = runeMode && form.elements.craftEnabled?.checked === true;
      const customModifierEnabled = form.elements.customModifierEnabled?.checked === true;
      for (const element of form.querySelectorAll("[data-runic-detail='craft']")) {
        if (!(element instanceof HTMLElement)) continue;
        const shouldHide = !craftEnabled;
        element.hidden = shouldHide;
        for (const control of element.querySelectorAll("input, select, button, textarea")) {
          control.disabled = shouldHide;
        }
      }
      const readWriteWarning = form.querySelector("[data-requires-read-write-runes]");
      if (readWriteWarning instanceof HTMLElement) {
        readWriteWarning.hidden = !craftEnabled || readWriteWarning.dataset.hasReadWriteRunes === "true";
      }

      const customCraft = form.querySelector("[data-custom-craft-target]");
      const craftMode = String(form.elements.craftMode?.value ?? "");
      if (customCraft instanceof HTMLElement) {
        const hideCustomCraft = !craftEnabled || craftMode !== CRAFT_RUNE_MODES.CUSTOM;
        customCraft.hidden = hideCustomCraft;
        for (const control of customCraft.querySelectorAll("input, select, button, textarea")) control.disabled = hideCustomCraft;
      }

      for (const element of form.querySelectorAll("[data-runic-detail='custom']")) {
        if (!(element instanceof HTMLElement)) continue;
        element.hidden = !customModifierEnabled;
        for (const control of element.querySelectorAll("input, select, button, textarea")) {
          control.disabled = !customModifierEnabled;
        }
      }

      const runeSkillNote = form.querySelector("[data-rune-skill-note]");
      const seidurSkillNote = form.querySelector("[data-seidur-skill-note]");
      if (runeSkillNote instanceof HTMLElement) runeSkillNote.hidden = !runeMode;
      if (seidurSkillNote instanceof HTMLElement) seidurSkillNote.hidden = runeMode;

      const submit = form.querySelector("[data-action='runicMagicSubmit']");
      if (submit instanceof HTMLElement) {
        submit.textContent = mode === "seidur"
          ? game.i18n.localize("AOV_SKJALDBORG.RunicMagic.TrackRitual")
          : game.i18n.localize("AOV_SKJALDBORG.RunicMagic.Submit");
      }
      this.requestContentRefit();
    };

    form.addEventListener("change", event => {
      if (event.target?.name === "prepared") {
        event.target.dataset.userEdited = "true";
        void this._setPreparedFromForm(form).then(update).catch(exception => {
          error("Failed to update Rune Script prepared state from Runic Magic dialog.", exception);
          ui.notifications.error(game.i18n.localize("AOV_SKJALDBORG.Warnings.ActionFailed"));
          update();
        });
        return;
      }
      update();
    });
    form.elements.dexPenalty?.addEventListener?.("input", event => {
      event.currentTarget.dataset.userEdited = "true";
    });
    for (const button of form.querySelectorAll("[data-runic-mod-step]")) {
      button.addEventListener("click", event => {
        event.preventDefault();
        const input = form.elements.flatMod;
        if (!(input instanceof HTMLInputElement)) return;
        const step = Number(button.dataset.runicModStep) || 0;
        input.value = String((Number(input.value) || 0) + step);
      });
    }
    const submit = form.querySelector("[data-action='runicMagicSubmit']");
    submit?.addEventListener?.("click", event => {
      event.preventDefault();
      void this._submit(form);
    });
    update();
  }

  async _setPreparedFromForm(form) {
    const mode = selectedMode(form);
    if (mode !== "runescript") return null;
    const itemId = String(new FormData(form).get("runescriptId") ?? "");
    const prepared = form.elements.prepared?.checked === true;
    const item = await AoVAdapter.setActorMagicPrepared(this.actor, itemId, prepared);
    const option = selectedOption(form.elements.runescriptId);
    if (option) option.dataset.prepared = item.system?.prepared === true ? "true" : "false";
    return item;
  }

  _payloadFromForm(form) {
    const data = new FormData(form);
    const magicMode = String(data.get("magicMode") ?? "");
    const itemId = magicMode === "seidur" ? String(data.get("seidurId") ?? "") : String(data.get("runescriptId") ?? "");
    const runeOption = selectedOption(form.elements.runescriptId);
    const craftOption = selectedOption(form.elements.craftMode);
    const targetRefs = cleanTargetRefs(JSON.parse(String(data.get("targetRefs") || "[]")));
    const craftEnabled = data.get("craftEnabled") === "on";
    const prepared = data.get("prepared") === "on";
    const customModifierEnabled = data.get("customModifierEnabled") === "on";
    return {
      combatId: String(data.get("combatId") ?? ""),
      combatantId: String(data.get("combatantId") ?? ""),
      expectedCombatantUpdatedAt: Number(data.get("expectedCombatantUpdatedAt") ?? 0) || 0,
      magicMode,
      itemId,
      itemType: magicMode,
      dexPenalty: Math.max(1, Number(data.get("dexPenalty") ?? runeOption?.dataset.runeCount ?? 1) || 1),
      flatMod: customModifierEnabled ? Math.round(Number(data.get("flatMod") ?? 0) || 0) : 0,
      customModifierReason: customModifierEnabled ? String(data.get("customModifierReason") ?? "").trim().slice(0, 120) : "",
      craftEnabled,
      craftMode: craftEnabled ? String(data.get("craftMode") ?? "") : "",
      craftSkillId: craftEnabled ? String(craftOption?.dataset.skillId ?? "") : "",
      customCraftTarget: Math.max(1, Math.round(Number(data.get("customCraftTarget") ?? 0) || 0)),
      prepared,
      alreadyCarved: prepared,
      resistance: data.get("resistance") === "on",
      casterTokenUuid: this.combatant?.token?.uuid
        ?? AoVAdapter.resolveActorTokenDocument(this.actor, null)?.uuid
        ?? "",
      targetRefs
    };
  }

  async _submitLocal(payload) {
    const actor = this.actor;
    const item = actor.items?.get?.(payload.itemId);
    if (!item) throw new Error(game.i18n.localize("AOV_SKJALDBORG.Warnings.ItemUnavailable"));
    if (payload.itemType === "seidur") {
      const skill = firstSeidurMagicSkill(actor);
      if (!skill) throw new Error(game.i18n.localize("AOV_SKJALDBORG.RunicMagic.SeidurMagicSkillMissing"));
      const result = await AoVAdapter.rollActorSkill(actor, skill.id, null, { cardType: "unopposed", flatMod: payload.flatMod });
      await appendMagicDetailsToMessage(result, item, { itemType: "seidur", resultLevel: result?.resultLevel });
      return result;
    }

    if (payload.craftEnabled && !payload.prepared) {
      if (payload.craftMode !== CRAFT_RUNE_MODES.CUSTOM) {
        const craftResult = await AoVAdapter.rollActorSkill(actor, payload.craftSkillId, null, { cardType: "unopposed", flatMod: payload.flatMod });
        if (resultSucceeded(craftResult)) await AoVAdapter.setActorMagicPrepared(actor, item.id, true);
        return craftResult;
      }
      ui.notifications.info?.(game.i18n.format("AOV_SKJALDBORG.RunicMagic.CustomCraftManual", { target: payload.customCraftTarget }));
      return null;
    }

    const runeSkill = firstRuneMagicSkill(actor);
    if (!runeSkill) throw new Error(game.i18n.localize("AOV_SKJALDBORG.RunicMagic.RuneMagicSkillMissing"));
    const castResult = await AoVAdapter.rollActorSkill(actor, runeSkill.id, null, { cardType: "unopposed", flatMod: payload.flatMod });
    await appendMagicDetailsToMessage(castResult, item, { itemType: "runescript", resultLevel: castResult?.resultLevel });
    const manifests = runeMagicConsumesPrepared(castResult?.resultLevel);
    if (item.system?.prepared === true && manifests) {
      await AoVAdapter.setActorMagicPrepared(actor, item.id, false);
    }
    if (payload.resistance && payload.targetRefs.length && manifests) {
      const messages = await createRunicResistanceCards({
        actor,
        casterTokenUuid: payload.casterTokenUuid,
        targetRefs: payload.targetRefs,
        item
      });
      return { ...castResult, resistanceMessageIds: messages.map(message => message.id) };
    }
    return castResult;
  }

  async _submit(form) {
    if (!(form instanceof HTMLFormElement)) return null;
    const payload = this._payloadFromForm(form);
    if (!payload.itemId) {
      ui.notifications.warn(game.i18n.localize("AOV_SKJALDBORG.RunicMagic.NoMagic"));
      return null;
    }
    try {
      if (payload.itemType === "runescript") {
        const item = this.actor.items?.get?.(payload.itemId);
        if (item?.system?.prepared !== payload.prepared) {
          await AoVAdapter.setActorMagicPrepared(this.actor, payload.itemId, payload.prepared);
        }
      }
      let result;
      if (!this.combat || !this.combatant) {
        result = await this._submitLocal(payload);
      } else {
        const state = safeState(this.combatant).runeMagic ?? {};
        let action = "startRuneCarving";
        if (payload.itemType === "seidur") action = "trackSeidurRitual";
        else if (
          payload.prepared
          || state.status === RUNE_MAGIC_STATUSES.READY
          || (state.status === RUNE_MAGIC_STATUSES.CARVING && Number(state.readyRound ?? 0) <= Number(safeCombatState(this.combat).logicalRound ?? 1))
        ) action = "castRuneScript";
        result = await requestGm(action, payload);
        RenderCoordinator.invalidateCombatTracker(`runic-magic-${action}`, {
          combatantIds: [this.combatant.id],
          parts: ["rows"]
        });
      }
      await this.close();
      return result;
    } catch (exception) {
      error("Failed to submit runic magic workflow.", exception);
      ui.notifications.error(game.i18n.localize("AOV_SKJALDBORG.Warnings.ActionFailed"));
      return null;
    }
  }
}

export const __test = {
  selectedMagicId,
  resultSucceeded
};
