import {
  MINIMUM_AOV_VERSION,
  MINIMUM_FOUNDRY_VERSION,
  MODULE_ID,
  VERIFIED_FOUNDRY_VERSION
} from "../constants.mjs";

let lastCapabilityReport = null;

/**
 * Compare two dotted numeric versions without trusting undocumented helpers.
 *
 * @param {string|number|null|undefined} current Current version.
 * @param {string|number|null|undefined} minimum Required minimum.
 * @returns {boolean}
 */
function versionAtLeast(current, minimum) {
  const left = String(current ?? "").split(/[^0-9]+/).filter(Boolean).map(Number);
  const right = String(minimum ?? "").split(/[^0-9]+/).filter(Boolean).map(Number);
  if (!left.length || !right.length) return false;
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i += 1) {
    const a = Number(left[i] ?? 0);
    const b = Number(right[i] ?? 0);
    if (a > b) return true;
    if (a < b) return false;
  }
  return true;
}

/**
 * Push one capability label when its condition is false.
 *
 * @param {string[]} list Capability collector.
 * @param {string} label Human-readable label.
 * @param {boolean} ok Capability status.
 * @returns {void}
 */
function addIfMissing(list, label, ok) {
  if (!ok) list.push(label);
}

/**
 * Resolve the current status/effect capability mode.
 *
 * @param {object|null|undefined} statusEffects CONFIG.statusEffects value.
 * @param {object} capabilities Capability record under construction.
 * @returns {"native"|"module-fallback"|"disabled"}
 */
function statusEffectMode(statusEffects, capabilities) {
  if (capabilities.effects.statusEffectsObject && capabilities.effects.activeEffectClass) return "native";
  if (!statusEffects && capabilities.effects.activeEffectClass) return "module-fallback";
  return "disabled";
}

/**
 * Resolve the current Foundry version string from documented runtime data.
 *
 * @returns {string}
 */
function foundryVersion() {
  return String(game.release?.version ?? game.version ?? "");
}

/**
 * Detect the v14 AoV runtime surface this module needs before registering
 * feature hooks.
 *
 * @returns {object}
 */
export function detectV14Capabilities() {
  const releaseGeneration = Number(game.release?.generation ?? 0);
  const fvttVersion = foundryVersion();
  const aovVersion = String(game.system?.version ?? "");
  const tokenDocumentPrototype = globalThis.TokenDocument?.prototype
    ?? foundry.documents?.TokenDocument?.prototype
    ?? CONFIG.Token?.documentClass?.prototype
    ?? null;
  const scenePrototype = foundry.documents?.Scene?.prototype
    ?? globalThis.Scene?.prototype
    ?? CONFIG.Scene?.documentClass?.prototype
    ?? null;
  const statusEffects = CONFIG?.statusEffects;
  const trackerClass = CONFIG?.ui?.combat;
  const combatClass = CONFIG?.Combat?.documentClass;

  const capabilities = {
    moduleId: MODULE_ID,
    target: {
      foundryMinimum: MINIMUM_FOUNDRY_VERSION,
      foundryVerified: VERIFIED_FOUNDRY_VERSION,
      aovMinimum: MINIMUM_AOV_VERSION
    },
    foundry: {
      generation: releaseGeneration,
      version: fvttVersion,
      generationOk: releaseGeneration >= 14,
      versionOk: versionAtLeast(fvttVersion, MINIMUM_FOUNDRY_VERSION)
    },
    system: {
      id: game.system?.id ?? "",
      version: aovVersion,
      idOk: game.system?.id === "aov",
      versionOk: versionAtLeast(aovVersion, MINIMUM_AOV_VERSION)
    },
    applications: {
      applicationV2: typeof foundry.applications?.api?.ApplicationV2 === "function",
      handlebarsMixin: typeof foundry.applications?.api?.HandlebarsApplicationMixin === "function",
      dialogV2: typeof foundry.applications?.api?.DialogV2 === "function",
      handlebarsRender: typeof foundry.applications?.handlebars?.renderTemplate === "function"
    },
    combat: {
      className: combatClass?.name ?? "",
      trackerClassName: trackerClass?.name ?? "",
      combatClass: typeof combatClass === "function",
      aovCombatClass: /aov/i.test(combatClass?.name ?? ""),
      trackerClass: typeof trackerClass === "function",
      aovTrackerClass: /aov/i.test(trackerClass?.name ?? ""),
      trackerAdjustInit: typeof trackerClass?.prototype?.adjustInit === "function",
      trackerAdjDex: typeof trackerClass?.adjDex === "function"
    },
    movement: {
      tokenMove: typeof tokenDocumentPrototype?.move === "function",
      completeMovementPath: typeof tokenDocumentPrototype?.getCompleteMovementPath === "function",
      sceneMoveTokens: typeof scenePrototype?.moveTokens === "function",
      hooksAvailable: typeof Hooks?.on === "function"
    },
    effects: {
      statusEffectsObject: !!statusEffects && typeof statusEffects === "object" && !Array.isArray(statusEffects),
      activeEffectClass: typeof CONFIG?.ActiveEffect?.documentClass === "function",
      actorToggleStatusEffect: typeof CONFIG?.Actor?.documentClass?.prototype?.toggleStatusEffect === "function"
    },
    sockets: {
      available: typeof game.socket?.on === "function" && typeof game.socket?.emit === "function"
    },
    hardBlockers: [],
    warnings: [],
    degradedFeatures: [],
    statusEffectMode: "disabled",
    runtimeEnabled: false,
    missing: [],
    supported: false
  };

  const hardBlockers = capabilities.hardBlockers;
  addIfMissing(hardBlockers, "Foundry generation 14", capabilities.foundry.generationOk);
  addIfMissing(hardBlockers, "Age of Vikings system id", capabilities.system.idOk);
  addIfMissing(hardBlockers, "ApplicationV2", capabilities.applications.applicationV2);
  addIfMissing(hardBlockers, "HandlebarsApplicationMixin", capabilities.applications.handlebarsMixin);
  addIfMissing(hardBlockers, "DialogV2", capabilities.applications.dialogV2);
  addIfMissing(hardBlockers, "Handlebars renderTemplate", capabilities.applications.handlebarsRender);
  addIfMissing(hardBlockers, "Combat document class", capabilities.combat.combatClass);
  addIfMissing(hardBlockers, "CombatTracker class", capabilities.combat.trackerClass);
  addIfMissing(hardBlockers, "TokenDocument#move", capabilities.movement.tokenMove);
  addIfMissing(hardBlockers, "preMoveToken hook support", capabilities.movement.hooksAvailable);
  addIfMissing(hardBlockers, "module socket", capabilities.sockets.available);

  const warnings = capabilities.warnings;
  addIfMissing(warnings, `Foundry patch ${MINIMUM_FOUNDRY_VERSION}+ not confirmed`, capabilities.foundry.versionOk);
  addIfMissing(warnings, `AoV version ${MINIMUM_AOV_VERSION}+ not confirmed`, capabilities.system.versionOk);
  addIfMissing(warnings, "AoV Combat class name not recognized", capabilities.combat.aovCombatClass);
  addIfMissing(warnings, "AoV CombatTracker class name not recognized", capabilities.combat.aovTrackerClass);
  addIfMissing(warnings, "AoV tracker adjustInit unavailable", capabilities.combat.trackerAdjustInit);
  addIfMissing(warnings, "AoV tracker adjDex unavailable", capabilities.combat.trackerAdjDex);
  addIfMissing(warnings, "TokenDocument#getCompleteMovementPath unavailable", capabilities.movement.completeMovementPath);
  addIfMissing(warnings, "Scene#moveTokens unavailable; per-token movement fallback will be used", capabilities.movement.sceneMoveTokens);
  addIfMissing(warnings, "CONFIG.statusEffects unavailable; engagement status will use fallback or flag-only mode", capabilities.effects.statusEffectsObject);
  addIfMissing(warnings, "ActiveEffect document class unavailable; engagement visual mirroring disabled", capabilities.effects.activeEffectClass);
  addIfMissing(warnings, "Actor#toggleStatusEffect unavailable; status creation fallback required", capabilities.effects.actorToggleStatusEffect);

  const degraded = capabilities.degradedFeatures;
  if (!capabilities.movement.sceneMoveTokens) degraded.push("scene-move-tokens");
  if (!capabilities.movement.completeMovementPath) degraded.push("complete-movement-path");
  if (!capabilities.combat.trackerAdjustInit || !capabilities.combat.trackerAdjDex) degraded.push("adjust-initiative-integration");
  if (!capabilities.effects.statusEffectsObject || !capabilities.effects.activeEffectClass) degraded.push("engagement-status-effects");

  capabilities.statusEffectMode = statusEffectMode(statusEffects, capabilities);
  capabilities.runtimeEnabled = hardBlockers.length === 0;
  capabilities.supported = capabilities.runtimeEnabled && warnings.length === 0;
  capabilities.missing = hardBlockers;
  lastCapabilityReport = capabilities;
  return capabilities;
}

/**
 * Return the latest capability report, computing it lazily when needed.
 *
 * @returns {object}
 */
export function getLastCapabilityReport() {
  return lastCapabilityReport ?? detectV14Capabilities();
}

/**
 * Summarize capability failures for user-facing warnings.
 *
 * @param {object} capabilities Capability report.
 * @returns {string}
 */
export function capabilityFailureSummary(capabilities) {
  const hardBlockers = capabilities?.hardBlockers ?? capabilities?.missing ?? [];
  return hardBlockers.length ? hardBlockers.join(", ") : "";
}

/**
 * Summarize non-fatal capability warnings.
 *
 * @param {object} capabilities Capability report.
 * @returns {string}
 */
export function capabilityWarningSummary(capabilities) {
  const warnings = capabilities?.warnings ?? [];
  return warnings.length ? warnings.join(", ") : "";
}
