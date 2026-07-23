import {
  ENGAGEMENT_VISUAL_MODE_DEFAULT,
  ENGAGEMENT_VISUAL_MODES,
  MODULE_ID,
  MOVEMENT_PLAN_VISIBILITY,
  MOVEMENT_PLAN_VISIBILITY_DEFAULT,
  ROUNDING_POLICIES
} from "../constants.mjs";
import { normalizeNumberSetting } from "../utils/settings.mjs";
import { RenderCoordinator } from "../ui/render-coordinator.mjs";
import { ReachVisualizerSettings } from "./reach-visualizer-settings.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;


function parseDroppedDocumentReference(event) {
  const transfer = event?.dataTransfer;
  if (!transfer) return null;
  const raw = transfer.getData("text/plain")
    || transfer.getData("application/json")
    || transfer.getData("text/uri-list");
  if (!raw) return null;
  try {
    const data = JSON.parse(raw);
    const uuid = String(data?.uuid ?? data?.documentUuid ?? data?.document?.uuid ?? "").trim();
    if (uuid) return uuid;
    const pack = String(data?.pack ?? "").trim();
    const id = String(data?.id ?? data?._id ?? data?.documentId ?? "").trim();
    if (pack && id) return `Compendium.${pack}.RollTable.${id}`;
    if (String(data?.type ?? "") === "RollTable" && id) return `RollTable.${id}`;
  } catch (_exception) {
    return raw.trim();
  }
  return raw.trim();
}

function isLikelyRollTableReference(reference) {
  const value = String(reference ?? "").trim();
  if (!value) return false;
  if (value.startsWith("RollTable.")) return true;
  if (value.includes(".RollTable.")) return true;
  if (value.startsWith("rt.")) return true;
  return true;
}

const LIMITS = Object.freeze({
  movementTickDelayMs: Object.freeze({ min: 0, max: 1000, step: 50 })
});

/**
 * AppV2 world-settings submenu for combat-flow validation and movement rules.
 */
export class CombatTrackingSettings extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    classes: ["aov-skjaldborg", "skj-combat-tracking-settings"],
    id: "aov-skjaldborg-combat-tracking-settings",
    actions: {
      reachVisualizer: CombatTrackingSettings.onReachVisualizer
    },
    form: {
      handler: CombatTrackingSettings.formHandler,
      closeOnSubmit: true,
      submitOnChange: false
    },
    position: {
      width: 640,
      height: "auto"
    },
    tag: "form",
    window: {
      title: "AOV_SKJALDBORG.Settings.CombatTrackingMenu.Title",
      contentClasses: ["standard-form", "skj-combat-tracking-settings-content"]
    }
  };

  static PARTS = {
    form: { template: "modules/aov-skjaldborg/templates/combat-tracking-settings.hbs" },
    footer: { template: "templates/generic/form-footer.hbs" }
  };

  get title() {
    return game.i18n.localize(this.options.window.title);
  }


  /**
   * Open the client-side reach visualizer settings from the combat submenu.
   *
   * @param {PointerEvent} event Click event.
   * @returns {Promise<void>}
   */
  static async onReachVisualizer(event) {
    event.preventDefault();
    await new ReachVisualizerSettings().render({ force: true });
  }

  /** @override */
  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const currentRounding = game.settings.get(MODULE_ID, "movementRounding");
    const currentMovementPlanVisibility = game.settings.get(MODULE_ID, "movementPlanVisibility");
    const currentEngagementVisualMode = game.settings.get(MODULE_ID, "engagementVisualMode");
    return {
      ...context,
      dynamicPlanningInitiative: game.settings.get(MODULE_ID, "dynamicPlanningInitiative") === true,
      requireAllCommit: game.settings.get(MODULE_ID, "requireAllCommit") === true,
      movementRounding: currentRounding,
      movementTickDelayMs: game.settings.get(MODULE_ID, "movementTickDelayMs"),
      movementPlanVisibility: currentMovementPlanVisibility,
      engagementVisualMode: currentEngagementVisualMode,
      evadeFightingDefensively: game.settings.get(MODULE_ID, "evadeFightingDefensively") === true,
      autoIncrementReactions: game.settings.get(MODULE_ID, "autoIncrementReactions") === true,
      knockbackFumbleTableReference: game.settings.get(MODULE_ID, "knockbackFumbleTableReference"),
      roundingChoices: [
        ROUNDING_POLICIES.CEIL,
        ROUNDING_POLICIES.FLOOR,
        ROUNDING_POLICIES.NEAREST
      ].map(value => ({
        value,
        label: game.i18n.localize(`AOV_SKJALDBORG.Settings.MovementRounding.${{
          [ROUNDING_POLICIES.CEIL]: "Ceil",
          [ROUNDING_POLICIES.FLOOR]: "Floor",
          [ROUNDING_POLICIES.NEAREST]: "Nearest"
        }[value]}`),
        selected: currentRounding === value
      })),
      engagementVisualModeChoices: Object.values(ENGAGEMENT_VISUAL_MODES).map(value => ({
        value,
        label: game.i18n.localize(`AOV_SKJALDBORG.Settings.EngagementVisualMode.${{
          [ENGAGEMENT_VISUAL_MODES.ACTIVE_EFFECT]: "ActiveEffect",
          [ENGAGEMENT_VISUAL_MODES.OVERLAY]: "Overlay",
          [ENGAGEMENT_VISUAL_MODES.BOTH]: "Both"
        }[value]}`),
        selected: currentEngagementVisualMode === value
      })),
      movementPlanVisibilityChoices: Object.values(MOVEMENT_PLAN_VISIBILITY).map(value => ({
        value,
        label: game.i18n.localize(`AOV_SKJALDBORG.Settings.MovementPlanVisibility.${{
          [MOVEMENT_PLAN_VISIBILITY.EVERYONE]: "Everyone",
          [MOVEMENT_PLAN_VISIBILITY.PERMISSION]: "Permission",
          [MOVEMENT_PLAN_VISIBILITY.NONE]: "None"
        }[value]}`),
        selected: currentMovementPlanVisibility === value
      })),
      limits: LIMITS,
      buttons: [
        { type: "submit", icon: "fa-solid fa-save", label: "SETTINGS.Save" }
      ]
    };
  }

  /** @override */
  async _onRender(context, options) {
    await super._onRender(context, options);
    const dropZone = this.element.querySelector("[data-skj-rolltable-drop]");
    const input = this.element.querySelector('input[name="knockbackFumbleTableReference"]');
    if (!dropZone || !(input instanceof HTMLInputElement)) return;

    dropZone.addEventListener("dragover", event => {
      event.preventDefault();
      dropZone.classList.add("drop-target");
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    });
    dropZone.addEventListener("dragleave", () => dropZone.classList.remove("drop-target"));
    dropZone.addEventListener("drop", event => {
      event.preventDefault();
      dropZone.classList.remove("drop-target");
      const reference = parseDroppedDocumentReference(event);
      if (!isLikelyRollTableReference(reference)) return;
      input.value = reference;
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
  }

  /**
   * Persist the complete combat-tracking settings form.
   *
   * @param {SubmitEvent} event Submit event.
   * @param {HTMLFormElement} form Form element.
   * @param {FormDataExtended} formData Foundry form data.
   * @returns {Promise<void>}
   */
  static async formHandler(event, form, formData) {
    event.preventDefault();
    const data = foundry.utils.expandObject(formData.object ?? {});
    const rounding = Object.values(ROUNDING_POLICIES).includes(data.movementRounding)
      ? data.movementRounding
      : ROUNDING_POLICIES.CEIL;
    const movementPlanVisibility = Object.values(MOVEMENT_PLAN_VISIBILITY).includes(data.movementPlanVisibility)
      ? data.movementPlanVisibility
      : MOVEMENT_PLAN_VISIBILITY_DEFAULT;
    const engagementVisualMode = Object.values(ENGAGEMENT_VISUAL_MODES).includes(data.engagementVisualMode)
      ? data.engagementVisualMode
      : ENGAGEMENT_VISUAL_MODE_DEFAULT;
    const values = {
      dynamicPlanningInitiative: data.dynamicPlanningInitiative === true,
      requireAllCommit: data.requireAllCommit === true,
      movementRounding: rounding,
      movementTickDelayMs: normalizeNumberSetting(data.movementTickDelayMs, 250, LIMITS.movementTickDelayMs),
      movementPlanVisibility,
      engagementVisualMode,
      evadeFightingDefensively: data.evadeFightingDefensively === true,
      autoIncrementReactions: data.autoIncrementReactions === true,
      knockbackFumbleTableReference: String(data.knockbackFumbleTableReference ?? "").trim()
    };

    await Promise.all(Object.entries(values).map(([key, value]) => (
      game.settings.set(MODULE_ID, key, value)
    )));
    RenderCoordinator.invalidateCombatTracker("combat-tracking-settings");
  }
}
