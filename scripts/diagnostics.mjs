import { MODULE_ID, SOCKET_NAME } from "./constants.mjs";
import { AoVAdapter } from "./adapter/aov-adapter.mjs";
import { getCombatState } from "./combat/state.mjs";
import { detectV14Capabilities, getLastCapabilityReport, statusEffectCapabilityDetail } from "./compat/capabilities.mjs";
import { getEngagedStatusEffectMode } from "./combat/engagement-status.mjs";
import {
  getAoVMessageModeCompatibilityStatus,
  isAoVMessageModeCompatible
} from "./compat/aov-message-mode.mjs";
import { getAdjustInitiativeIntegrationStatus } from "./compat/aov-adjust-initiative.mjs";

/**
 * Build a diagnostic row.
 *
 * @param {string} id Check id.
 * @param {boolean} ok Whether the check passed.
 * @param {string} [detail=""] Extra detail for console output.
 * @returns {{id: string, ok: boolean, detail: string}}
 */
function check(id, ok, detail = "") {
  return { id, ok: !!ok, detail };
}

/**
 * Build a diagnostic row for contextual checks that are informative but not
 * installation failures.
 *
 * @param {string} id Check id.
 * @param {string} detail Detail for console output.
 * @returns {{id: string, ok: boolean, detail: string, optional: boolean}}
 */
function optionalCheck(id, detail = "") {
  return { id, ok: true, detail, optional: true };
}

/**
 * Confirm a Handlebars template can be rendered.
 *
 * @param {string} path Foundry template path.
 * @returns {Promise<boolean>}
 */
async function canRenderTemplate(path) {
  try {
    await foundry.applications.handlebars.renderTemplate(path, {});
    return true;
  }
  catch (_err) {
    return false;
  }
}

/**
 * Run in-world diagnostics for installation and runtime assumptions.
 *
 * Exposed as `game.aovSkjaldborg.diagnostics.run()` after ready.
 *
 * @returns {Promise<{id: string, ok: boolean, detail: string}[]>}
 */
export async function runDiagnostics() {
  const results = [];
  const combat = game.combat ?? null;
  const capabilities = detectV14Capabilities();
  const messageModeStatus = getAoVMessageModeCompatibilityStatus();
  const adjustInitiativeStatus = getAdjustInitiativeIntegrationStatus();
  const hardBlockers = capabilities.hardBlockers ?? capabilities.missing ?? [];
  const warnings = capabilities.warnings ?? [];
  const degradedFeatures = capabilities.degradedFeatures ?? [];
  const engagementStatusMode = getEngagedStatusEffectMode();
  results.push(check("foundry-generation", capabilities.foundry.generationOk, `generation=${capabilities.foundry.generation}`));
  results.push(check(
    "foundry-version",
    capabilities.foundry.versionOk,
    `detected=${capabilities.foundry.version}; minimum=${capabilities.target.foundryMinimum}; verified=${capabilities.target.foundryVerified}`
  ));
  results.push(check(
    "aov-version",
    capabilities.system.idOk && capabilities.system.versionOk,
    `id=${capabilities.system.id}; detected=${capabilities.system.version}; minimum=${capabilities.target.aovMinimum}; verified=${capabilities.target.aovVerified}`
  ));
  results.push(check("runtime-enabled", capabilities.runtimeEnabled, hardBlockers.join(", ")));
  results.push(check("hard-blockers", hardBlockers.length === 0, hardBlockers.join(", ")));
  results.push(check("feature-warnings", true, warnings.join(", ")));
  results.push(check("degraded-features", true, degradedFeatures.join(", ")));
  results.push(check("system", AoVAdapter.isAoVWorld(), `game.system.id=${game.system?.id ?? "unknown"}`));
  results.push(check("setting-enabled", typeof game.settings.get(MODULE_ID, "enabled") === "boolean"));
  results.push(check("action-ring-setting", typeof game.settings.get(MODULE_ID, "enableActionRing") === "boolean"));
  results.push(check("actor-hotbar-setting", typeof game.settings.get(MODULE_ID, "enableActorHotbar") === "boolean"));
  results.push(check("appv2", capabilities.applications.applicationV2));
  results.push(optionalCheck(
    "appv2-refit",
    capabilities.applications.refit ? "native Foundry 14.365 content refitting" : "unavailable; guarded compatibility path"
  ));
  results.push(check("dialogv2", capabilities.applications.dialogV2));
  results.push(optionalCheck(
    "chat-presentation-options",
    capabilities.chat.messagePresentationOptions ? "notify and scroll options available" : "default chat presentation behavior"
  ));
  results.push(check("scene-move-tokens", true, capabilities.movement.sceneMoveTokens ? "native" : "per-token fallback"));
  results.push(check("token-move", capabilities.movement.tokenMove));
  results.push(check("token-complete-movement-path", true, capabilities.movement.completeMovementPath ? "native" : "fallback expansion"));
  results.push(check("status-effects-v14", true, capabilities.effects.statusEffectsMap
    ? "Map-like catalog present"
    : capabilities.effects.statusEffectsArray
      ? "array catalog present"
      : capabilities.effects.statusEffectsObject
        ? "object catalog present"
        : "catalog unavailable; module fallback active when ActiveEffect is available"));
  results.push(check("status-effect-mode", true, `${engagementStatusMode}; ${statusEffectCapabilityDetail({ ...capabilities, statusEffectMode: engagementStatusMode })}`));
  results.push(check("active-effect-class", true, String(capabilities.effects.activeEffectClass)));
  results.push(optionalCheck(
    "active-effect-should-apply-change",
    String(capabilities.effects.shouldApplyChange)
  ));
  results.push(check("active-effect-from-status", true, String(capabilities.effects.activeEffectFromStatusEffect)));
  results.push(check("aov-combat-class", capabilities.combat.combatClass, `${capabilities.combat.className}; name recognized=${capabilities.combat.aovCombatClass}`));
  results.push(check("message-mode-compatibility", isAoVMessageModeCompatible(), "Combat#rollInitiative does not access core.rollMode"));
  results.push(check(
    "message-mode-status",
    messageModeStatus.compatible,
    `${messageModeStatus.status}; patched=${messageModeStatus.patched}; deprecated-roll-mode=${messageModeStatus.usesDeprecatedRollMode}`
  ));
  results.push(check("aov-tracker-class", capabilities.combat.trackerClass, `${capabilities.combat.trackerClassName}; name recognized=${capabilities.combat.aovTrackerClass}`));
  results.push(check("adjust-init-method", adjustInitiativeStatus.hasAdjustInit, `status=${adjustInitiativeStatus.status}`));
  results.push(check("adjust-init-dialog", adjustInitiativeStatus.hasAdjDex, `status=${adjustInitiativeStatus.status}`));
  results.push(check(
    "adjust-init-patch",
    adjustInitiativeStatus.weaponPatchInstalled,
    `weaponPatch=${adjustInitiativeStatus.weaponPatchInstalled}; dismissGuard=${adjustInitiativeStatus.dismissGuardInstalled}`
  ));
  results.push(check("socket-name", SOCKET_NAME === `module.${MODULE_ID}`, SOCKET_NAME));
  results.push(check("socket-api", capabilities.sockets.available));
  results.push(check("v14-migration-version", Number(game.settings.get(MODULE_ID, "v14MigrationVersion")) >= 1, String(game.settings.get(MODULE_ID, "v14MigrationVersion"))));
  results.push(check("v14-migration-last-run", true, String(game.settings.get(MODULE_ID, "v14MigrationLastRun") ?? "")));
  results.push(check("combat-class-preserved", CONFIG.Combat?.documentClass?.name !== "SkjaldborgCombat", CONFIG.Combat?.documentClass?.name));
  results.push(check("tracker-class-preserved", CONFIG.ui?.combat?.name !== "SkjaldborgCombatTracker", CONFIG.ui?.combat?.name));
  results.push(combat
    ? check("active-combat", true, combat.id ?? "")
    : optionalCheck("active-combat", "not active; combat-state checks skipped"));
  if (combat) {
    const state = getCombatState(combat);
    results.push(check("combat-state-readable", !!state && typeof state.phase === "string", state.phase));
  }
  results.push(check("phase-report-template", await canRenderTemplate("modules/aov-skjaldborg/templates/phase-report.hbs")));
  results.push(check("action-ring-template", await canRenderTemplate("modules/aov-skjaldborg/templates/action-ring.hbs")));
  results.push(check("actor-hotbar-template", await canRenderTemplate("modules/aov-skjaldborg/templates/actor-hotbar.hbs")));

  const failed = results.filter(r => !r.ok);
  console.table(results);
  if (failed.length) {
    ui.notifications.warn(game.i18n.format("AOV_SKJALDBORG.Diagnostics.Failed", { count: failed.length }));
  }
  else {
    ui.notifications.info(game.i18n.localize("AOV_SKJALDBORG.Diagnostics.Passed"));
  }
  game.aovSkjaldborg ??= {};
  game.aovSkjaldborg.capabilities = getLastCapabilityReport();
  return results;
}
