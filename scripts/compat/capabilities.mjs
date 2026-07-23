import {
  MINIMUM_AOV_VERSION,
  MINIMUM_FOUNDRY_VERSION,
  MODULE_ID,
  VERIFIED_AOV_VERSION,
  VERIFIED_FOUNDRY_VERSION
} from "../constants.mjs";
import { AOV_IMPORTS, importAoVModule } from "../adapter/aov-contract.mjs";

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
  if (capabilities.effects.statusEffectsMap && capabilities.effects.activeEffectClass) return "native";
  if (capabilities.effects.statusEffectsArray && capabilities.effects.activeEffectClass) return "module-fallback";
  if (!statusEffects && capabilities.effects.activeEffectClass) return "module-fallback";
  return "disabled";
}

function dataModelHasSystemField(itemType, fieldName) {
  const models = [
    game.system?.model?.Item?.[itemType],
    CONFIG?.Item?.dataModels?.[itemType],
    CONFIG?.Item?.documentClass?.metadata?.types?.[itemType]
  ].filter(Boolean);
  for (const model of models) {
    const system = model.system ?? model.schema?.fields?.system ?? model.schema?.fields ?? model;
    if (system && Object.prototype.hasOwnProperty.call(system, fieldName)) return true;
  }
  return models.length ? false : null;
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
  const applicationApi = foundry.applications?.api ?? {};
  const applicationSheets = foundry.applications?.sheets ?? {};
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
      aovMinimum: MINIMUM_AOV_VERSION,
      aovVerified: VERIFIED_AOV_VERSION
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
      versionOk: versionAtLeast(aovVersion, MINIMUM_AOV_VERSION),
      verifiedVersion: VERIFIED_AOV_VERSION,
      verified: aovVersion === VERIFIED_AOV_VERSION
    },
    applications: {
      applicationV2: typeof applicationApi.ApplicationV2 === "function",
      documentSheetV2: typeof applicationApi.DocumentSheetV2 === "function",
      handlebarsMixin: typeof applicationApi.HandlebarsApplicationMixin === "function",
      dialogV2: typeof applicationApi.DialogV2 === "function",
      handlebarsRender: typeof foundry.applications?.handlebars?.renderTemplate === "function"
    },
    sheets: {
      documentSheetV2: typeof applicationApi.DocumentSheetV2 === "function",
      actorSheetV2: typeof applicationApi.ActorSheetV2 === "function"
        || typeof applicationSheets.ActorSheetV2 === "function",
      itemSheetV2: typeof applicationApi.ItemSheetV2 === "function"
        || typeof applicationSheets.ItemSheetV2 === "function",
      integrationsUsed: false
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
      statusEffectsArray: Array.isArray(statusEffects),
      statusEffectsMap: typeof statusEffects?.set === "function",
      activeEffectClass: typeof CONFIG?.ActiveEffect?.documentClass === "function",
      activeEffectFromStatusEffect: typeof CONFIG?.ActiveEffect?.documentClass?.fromStatusEffect === "function"
        || typeof foundry.documents?.ActiveEffect?.fromStatusEffect === "function"
        || typeof globalThis.ActiveEffect?.fromStatusEffect === "function",
      actorToggleStatusEffect: typeof CONFIG?.Actor?.documentClass?.prototype?.toggleStatusEffect === "function"
    },
    sockets: {
      available: typeof game.socket?.on === "function" && typeof game.socket?.emit === "function"
    },
    aovApi: {
      routeResolvedImports: typeof foundry.utils?.getRoute === "function",
      checkApiImport: null,
      trigger: null,
      successLevel: null,
      rollType: null,
      cardType: null,
      rollTypesImport: null,
      aovRollType: null
    },
    dataModels: {
      skillCritMult: dataModelHasSystemField("skill", "critMult"),
      skillFumbleMult: dataModelHasSystemField("skill", "fumbleMult"),
      passionCritMult: dataModelHasSystemField("passion", "critMult"),
      passionFumbleMult: dataModelHasSystemField("passion", "fumbleMult")
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
  // ApplicationV2 is required by ActionRing, ActorHotbar, and settings applications.
  addIfMissing(hardBlockers, "ApplicationV2", capabilities.applications.applicationV2);
  // HandlebarsApplicationMixin is required by the module's AppV2 Handlebars surfaces.
  addIfMissing(hardBlockers, "HandlebarsApplicationMixin", capabilities.applications.handlebarsMixin);
  // DialogV2 is required by combat workflow dialogs, utility dialogs, and Runic/Seidur dialogs.
  addIfMissing(hardBlockers, "DialogV2", capabilities.applications.dialogV2);
  // renderTemplate is required by AppV2 contexts, dialog content, and chat report rendering.
  addIfMissing(hardBlockers, "Handlebars renderTemplate", capabilities.applications.handlebarsRender);
  // Combat documents and tracker hooks are required for phase, intent, and movement workflows.
  addIfMissing(hardBlockers, "Combat document class", capabilities.combat.combatClass);
  addIfMissing(hardBlockers, "CombatTracker class", capabilities.combat.trackerClass);
  // Token movement and preMoveToken support are required by engagement and movement capture.
  addIfMissing(hardBlockers, "TokenDocument#move", capabilities.movement.tokenMove);
  addIfMissing(hardBlockers, "preMoveToken hook support", capabilities.movement.hooksAvailable);
  // The module delegates authoritative combat writes through its registered socket.
  addIfMissing(hardBlockers, "module socket", capabilities.sockets.available);

  const warnings = capabilities.warnings;
  addIfMissing(warnings, `Foundry patch ${MINIMUM_FOUNDRY_VERSION}+ not confirmed`, capabilities.foundry.versionOk);
  addIfMissing(warnings, `AoV version ${MINIMUM_AOV_VERSION}+ not confirmed`, capabilities.system.versionOk);
  addIfMissing(warnings, "AoV Combat class name not recognized", capabilities.combat.aovCombatClass);
  addIfMissing(warnings, "AoV CombatTracker class name not recognized", capabilities.combat.aovTrackerClass);
  addIfMissing(warnings, "AoV tracker adjustInit unavailable", capabilities.combat.trackerAdjustInit);
  addIfMissing(warnings, "AoV tracker adjDex unavailable", capabilities.combat.trackerAdjDex);
  addIfMissing(warnings, "Foundry route-resolved import support unavailable", capabilities.aovApi.routeResolvedImports);
  if (capabilities.dataModels.skillCritMult === false || capabilities.dataModels.skillFumbleMult === false) {
    warnings.push("AoV skill data model does not expose critMult/fumbleMult");
  }
  if (capabilities.dataModels.passionCritMult === false || capabilities.dataModels.passionFumbleMult === false) {
    warnings.push("AoV passion data model does not expose critMult/fumbleMult");
  }
  addIfMissing(warnings, "TokenDocument#getCompleteMovementPath unavailable", capabilities.movement.completeMovementPath);
  addIfMissing(warnings, "Scene#moveTokens unavailable; per-token movement fallback will be used", capabilities.movement.sceneMoveTokens);
  addIfMissing(warnings, "ActiveEffect document class unavailable; engagement visual mirroring disabled", capabilities.effects.activeEffectClass);
  addIfMissing(warnings, "ActiveEffect.fromStatusEffect unavailable; explicit status data fallback required", capabilities.effects.activeEffectFromStatusEffect);
  addIfMissing(warnings, "Actor#toggleStatusEffect unavailable; status creation fallback required", capabilities.effects.actorToggleStatusEffect);

  const degraded = capabilities.degradedFeatures;
  if (!capabilities.movement.sceneMoveTokens) degraded.push("scene-move-tokens");
  if (!capabilities.movement.completeMovementPath) degraded.push("complete-movement-path");
  if (!capabilities.combat.trackerAdjustInit || !capabilities.combat.trackerAdjDex) degraded.push("adjust-initiative-integration");
  if (!capabilities.effects.activeEffectFromStatusEffect) degraded.push("active-effect-from-status-fallback");
  capabilities.statusEffectMode = statusEffectMode(statusEffects, capabilities);
  if (!capabilities.effects.statusEffectsObject && !capabilities.effects.statusEffectsMap && capabilities.effects.activeEffectClass) {
    degraded.push("engagement-status-catalog-fallback");
  }
  if (!capabilities.effects.activeEffectClass) degraded.push("engagement-status-effects");
  capabilities.runtimeEnabled = hardBlockers.length === 0;
  capabilities.supported = capabilities.runtimeEnabled && warnings.length === 0;
  capabilities.missing = hardBlockers;
  lastCapabilityReport = capabilities;
  return capabilities;
}

/**
 * Probe dynamically imported AoV APIs which are not exposed as stable globals.
 *
 * @param {object} [capabilities=detectV14Capabilities()] Existing capability report.
 * @returns {Promise<object>}
 */
export async function detectAoVApiCapabilities(capabilities = detectV14Capabilities()) {
  if (!capabilities?.system?.idOk) return capabilities;

  try {
    const checks = await importAoVModule(AOV_IMPORTS.CHECKS);
    capabilities.aovApi.checkApiImport = true;
    capabilities.aovApi.trigger = typeof checks.AOVCheck?._trigger === "function";
    capabilities.aovApi.successLevel = typeof checks.AOVCheck?.successLevel === "function";
    capabilities.aovApi.rollType = !!checks.RollType;
    capabilities.aovApi.cardType = !!checks.CardType;
  } catch (_exception) {
    capabilities.aovApi.checkApiImport = false;
    capabilities.aovApi.trigger = false;
    capabilities.aovApi.successLevel = false;
    capabilities.aovApi.rollType = false;
    capabilities.aovApi.cardType = false;
  }

  try {
    const rollTypes = await importAoVModule(AOV_IMPORTS.ROLL_TYPES);
    capabilities.aovApi.rollTypesImport = true;
    capabilities.aovApi.aovRollType = typeof rollTypes.AOVRollType?._onDetermineCheck === "function";
  } catch (_exception) {
    capabilities.aovApi.rollTypesImport = false;
    capabilities.aovApi.aovRollType = false;
  }

  const warnings = capabilities.warnings ?? [];
  addIfMissing(warnings, "AoV check API import unavailable", capabilities.aovApi.checkApiImport);
  addIfMissing(warnings, "AoV AOVCheck._trigger unavailable", capabilities.aovApi.trigger);
  addIfMissing(warnings, "AoV AOVCheck.successLevel unavailable", capabilities.aovApi.successLevel);
  addIfMissing(warnings, "AoV RollType unavailable", capabilities.aovApi.rollType);
  addIfMissing(warnings, "AoV CardType unavailable", capabilities.aovApi.cardType);
  addIfMissing(warnings, "AoV roll-types import unavailable", capabilities.aovApi.rollTypesImport);
  addIfMissing(warnings, "AoV AOVRollType._onDetermineCheck unavailable", capabilities.aovApi.aovRollType);
  capabilities.degradedFeatures = Array.from(new Set(capabilities.degradedFeatures ?? []));
  if (!capabilities.aovApi.checkApiImport || !capabilities.aovApi.trigger || !capabilities.aovApi.successLevel) {
    capabilities.degradedFeatures.push("aov-check-api");
  }
  if (!capabilities.aovApi.rollTypesImport || !capabilities.aovApi.aovRollType) {
    capabilities.degradedFeatures.push("aov-roll-type-router");
  }
  capabilities.supported = capabilities.runtimeEnabled && warnings.length === 0;
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

/**
 * Summarize engagement status-effect capability in user-facing diagnostics.
 *
 * @param {object} capabilities Capability report.
 * @returns {string}
 */
export function statusEffectCapabilityDetail(capabilities) {
  const mode = capabilities?.statusEffectMode ?? "disabled";
  if (mode === "native") return "native catalog integration";
  if (mode === "module-fallback") {
    return "module fallback mode; engagement flags remain authoritative and visual catalog integration is limited";
  }
  return "disabled; engagement flags remain authoritative but visual mirroring is unavailable";
}
