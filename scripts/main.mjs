import { MODULE_ID } from "./constants.mjs";
import {
  migrateActionUiSettings,
  migrateCombatTrackingSettings,
  migrateLegacyReportSettings,
  migrateUnifiedDebugSetting,
  migrateV14WorldState,
  registerSettings
} from "./settings.mjs";
import { registerSocket } from "./socket.mjs";
import { requestGm } from "./socket.mjs";
import { refreshCombatTrackerDecorations, registerTrackerHooks } from "./hooks/tracker.mjs";
import { registerCombatNavigationHooks } from "./hooks/combat-navigation.mjs";
import { registerCombatContextHooks } from "./hooks/combat-context.mjs";
import { ActionRing, registerActionRingHooks } from "./apps/action-ring.mjs";
import { ActorHotbar, registerActorHotbarHooks } from "./apps/actor-hotbar.mjs";
import { PhaseController } from "./combat/phase-controller.mjs";
import { getCombatState, getCombatantState } from "./combat/state.mjs";
import { AoVAdapter } from "./adapter/aov-adapter.mjs";
import { buildResolutionQueue } from "./combat/resolution-queue.mjs";
import { runDiagnostics } from "./diagnostics.mjs";
import { debug, warn } from "./logger.mjs";
import {
  getAdjustInitiativeIntegrationStatus,
  installAdjustInitiativeDismissGuard,
  installAdjustInitiativeWeaponIntegration
} from "./compat/aov-adjust-initiative.mjs";
import { registerChatReportHooks } from "./combat/chat-report.mjs";
import { registerDialogTargetQueueHooks } from "./combat/dialog-target-queue.mjs";
import { registerAimedBlowAutomationHooks } from "./combat/aimed-blow-automation.mjs";
import { registerProneDamageAutomationHooks } from "./combat/prone-damage-automation.mjs";
import { registerDisarmAutomationHooks } from "./combat/disarm-automation.mjs";
import { registerMissileAutomationHooks } from "./combat/missile-automation.mjs";
import { registerStunAutomationHooks } from "./combat/stun-automation.mjs";
import { registerKnockbackAutomationHooks } from "./combat/knockback-automation.mjs";
import { registerRunicMagicHooks } from "./combat/runic-magic.mjs";
import { registerDamageEffectStatusEffects, registerDamageEffectTrackingHooks } from "./combat/damage-effect-tracking.mjs";
import {
  getActorEvadingState,
  registerEvadingStatusEffect,
  registerEvadingStatusHooks,
  removeExpiredEvadingEffects
} from "./combat/evade-status.mjs";
import { reconcileReactionPenaltyEffectsForCombat, registerReactionPenaltyEffectHooks } from "./combat/reaction-penalty-effects.mjs";
import { registerGrappleAutomationHooks, registerGrappleStatusEffects } from "./combat/grapple-automation.mjs";
import { registerMovementHooks, startMovementPhase } from "./combat/movement-controller.mjs";
import { reconcileEngagedStatusEffects, refreshEngagementVisuals, registerEngagedStatusEffect, registerEngagedStatusHooks } from "./combat/engagement-status.mjs";
import { pruneStaleEngagements } from "./combat/engagement-reconciliation.mjs";
import {
  registerDisengagementHooks,
  registerDisengagementStatusEffects,
  resolveKnockbackDisengagement
} from "./combat/disengagement.mjs";
import { registerReadiedWeaponHooks } from "./combat/weapon-state.mjs";
import { logMovementDebugExport, logMovementDebugSnapshot, movementDebugExport, movementDebugSnapshot } from "./combat/movement-debugger.mjs";
import { registerTokenIntentIndicatorHooks, refreshTokenIntentIndicators } from "./canvas/intent-indicators.mjs";
import { registerMovementPlanPreviewHooks, refreshMovementPlanPreview } from "./canvas/movement-plan-preview.mjs";
import { registerEngagementIndicatorHooks } from "./canvas/engagement-indicators.mjs";
import { registerReachVisualizerHooks } from "./canvas/reach-visualizer.mjs";
import { captureExternalPlanningInitiativeChange } from "./combat/planning-initiative.mjs";
import { shouldTrackCurrentTurnForPhase } from "./combat/phase-structure.mjs";
import { registerPreparedIntentHooks } from "./combat/prepared-intent.mjs";
import {
  capabilityFailureSummary,
  capabilityWarningSummary,
  detectAoVApiCapabilities,
  detectV14Capabilities
} from "./compat/capabilities.mjs";
import {
  getAoVMessageModeCompatibilityStatus,
  installAoVMessageModeCompatibility
} from "./compat/aov-message-mode.mjs";
import { RenderCoordinator } from "./ui/render-coordinator.mjs";
import { performanceDiagnostics } from "./performance/performance-monitor.mjs";
import { refreshRuntimeSettings } from "./runtime-settings.mjs";
import { getFeatureRegistryReport, initializeRegisteredFeatures, registerFeature } from "./core/feature-registry.mjs";
import { isAuthoritativeGmClient } from "./utils/authority.mjs";
import {
  combatTrackerAffectedByCombatantChange,
  combatTrackerAffectedByCombatChange
} from "./utils/changed-paths.mjs";

let adjustInitiativeIntegrationInstalled = false;
let messageModeCompatibilityInstalled = false;
let runtimeFeaturesRegistered = false;

RenderCoordinator.register("combatTracker", detail => {
  performanceDiagnostics.count("combatTracker.render.request", 1, detail);
  if (refreshCombatTrackerDecorations(detail)) return;
  ui.combat?.render?.();
});

function registerRuntimeFeatures() {
  if (runtimeFeaturesRegistered) return;
  runtimeFeaturesRegistered = true;
  [
    ["readied-weapons", "Readied Weapon Hooks", registerReadiedWeaponHooks],
    ["prepared-intent", "Prepared Intent Hooks", registerPreparedIntentHooks],
    ["combat-tracker", "Combat Tracker Decorations", registerTrackerHooks],
    ["combat-context", "Combat Tracker Context Hooks", registerCombatContextHooks],
    ["combat-navigation", "Combat Navigation Hooks", registerCombatNavigationHooks],
    ["movement", "Movement Hooks", hooks => registerMovementHooks(requestGm, hooks)],
    ["engagement-status", "Engagement Status Hooks", registerEngagedStatusHooks],
    ["disengagement", "Disengagement Hooks", registerDisengagementHooks],
    ["aimed-blow", "Aimed Blow Automation", registerAimedBlowAutomationHooks],
    ["prone-damage", "Prone Damage Automation", registerProneDamageAutomationHooks],
    ["disarm", "Disarm Automation", registerDisarmAutomationHooks],
    ["missile", "Missile Automation", registerMissileAutomationHooks],
    ["stun", "Stun Automation", registerStunAutomationHooks],
    ["knockback", "Knockback Automation", registerKnockbackAutomationHooks],
    ["runic-magic", "Runic Magic Hooks", registerRunicMagicHooks],
    ["damage-effects", "Damage Effect Tracking", registerDamageEffectTrackingHooks],
    ["grapple", "Grapple Automation", registerGrappleAutomationHooks],
    ["evade", "Evading Status Hooks", registerEvadingStatusHooks],
    ["reaction-penalties", "Reaction Penalty Hooks", registerReactionPenaltyEffectHooks],
    ["action-ring", "Action Ring Hooks", registerActionRingHooks],
    ["actor-hotbar", "Actor Hotbar Hooks", registerActorHotbarHooks],
    ["intent-indicators", "Token Intent Indicators", registerTokenIntentIndicatorHooks],
    ["movement-plan-preview", "Movement Plan Preview", registerMovementPlanPreviewHooks],
    ["engagement-indicators", "Engagement Indicators", registerEngagementIndicatorHooks],
    ["reach-visualizer", "Reach Visualizer", registerReachVisualizerHooks],
    ["chat-report", "Chat Report Hooks", registerChatReportHooks],
    ["dialog-target-queue", "Dialog Target Queue", registerDialogTargetQueueHooks]
  ].forEach(([id, label, initialize]) => registerFeature({ id, label, initialize }));
}

/**
 * Register settings as early as possible.
 */
Hooks.once("init", () => {
  registerSettings();
  registerEngagedStatusEffect();
  registerDisengagementStatusEffects();
  registerGrappleStatusEffects();
  registerEvadingStatusEffect();
  registerDamageEffectStatusEffects();
});

// AoV and other packages may complete CONFIG mutations later in init. Reapply
// the idempotent status registration before the v14 UI is constructed.
Hooks.once("setup", () => {
  refreshRuntimeSettings();
  registerEngagedStatusEffect();
  registerDisengagementStatusEffects();
  registerGrappleStatusEffects();
  registerEvadingStatusEffect();
  registerDamageEffectStatusEffects();
  if (!AoVAdapter.isAoVWorld()) return;
  messageModeCompatibilityInstalled = installAoVMessageModeCompatibility();
  adjustInitiativeIntegrationInstalled = installAdjustInitiativeWeaponIntegration();
});

/**
 * Register runtime integration only in AoV worlds.
 */
Hooks.once("ready", async () => {
  refreshRuntimeSettings();
  registerEngagedStatusEffect();
  registerDisengagementStatusEffects();
  registerGrappleStatusEffects();
  registerEvadingStatusEffect();
  registerDamageEffectStatusEffects();
  if (!AoVAdapter.isAoVWorld()) {
    warn("Loaded outside the Age of Vikings system; module remains idle.");
    return;
  }
  if (!messageModeCompatibilityInstalled) {
    messageModeCompatibilityInstalled = installAoVMessageModeCompatibility();
  }
  const capabilities = detectV14Capabilities();
  if (!capabilities.runtimeEnabled) {
    const blockers = capabilityFailureSummary(capabilities);
    warn(`Foundry v14/AoV hard capability check failed; Skjaldborg runtime integrations remain disabled. Missing: ${blockers}`);
    ui.notifications?.warn?.(`Skjaldborg is disabled for this world. Missing required v14/AoV capability: ${blockers}`);
    game.aovSkjaldborg = {
      adapter: AoVAdapter,
      diagnostics: {
        run: runDiagnostics,
        performance: performanceDiagnostics,
        features: getFeatureRegistryReport
      },
      capabilities
    };
    return;
  }
  await detectAoVApiCapabilities(capabilities);
  const warnings = capabilityWarningSummary(capabilities);
  if (warnings) {
    warn(`Skjaldborg is loading with degraded v14/AoV capabilities: ${warnings}`);
  }
  await migrateV14WorldState();
  await migrateActionUiSettings();
  await migrateLegacyReportSettings();
  await migrateCombatTrackingSettings();
  await migrateUnifiedDebugSetting();
  registerSocket();
  if (!adjustInitiativeIntegrationInstalled) {
    adjustInitiativeIntegrationInstalled = installAdjustInitiativeWeaponIntegration();
  }
  if (!adjustInitiativeIntegrationInstalled) {
    installAdjustInitiativeDismissGuard();
    warn("AoV Adjust Initiative weapon integration was unavailable; installed only the dismissal guard.");
  }
  capabilities.compatibility = {
    messageMode: getAoVMessageModeCompatibilityStatus(),
    adjustInitiative: getAdjustInitiativeIntegrationStatus()
  };
  registerRuntimeFeatures();
  const initializedFeatures = initializeRegisteredFeatures();
  const reachVisualizer = initializedFeatures.get("reach-visualizer")?.result ?? null;
  await reconcileEngagedStatusEffects(game.combat);
  await reconcileReactionPenaltyEffectsForCombat(game.combat, { reason: "ready" });
  game.aovSkjaldborg = {
    adapter: AoVAdapter,
    capabilities,
    phase: PhaseController,
    disengagement: {
      resolveKnockback: resolveKnockbackDisengagement
    },
    engagement: {
      pruneStale: pruneStaleEngagements,
      redrawVisuals: refreshEngagementVisuals
    },
    grapple: {
      registerStatusEffects: registerGrappleStatusEffects
    },
    evade: {
      registerStatusEffect: registerEvadingStatusEffect,
      getActorState: getActorEvadingState,
      removeExpiredEffects: removeExpiredEvadingEffects
    },
    movement: {
      startMovementPhase,
      debugSnapshot: movementDebugSnapshot,
      debugExport: movementDebugExport,
      logDebugSnapshot: logMovementDebugSnapshot,
      logDebugExport: logMovementDebugExport
    },
    reachVisualizer,
    getCombatState,
    getCombatantState,
    buildResolutionQueue,
    ui: {
      closeActionRing: () => ActionRing.closeAll(),
      refreshActionRing: () => ActionRing.current?.render(false),
      refreshActorHotbar: () => ActorHotbar.scheduleRender(),
      resetActorHotbarPosition: () => ActorHotbar.resetPosition(),
      closeActorHotbar: () => ActorHotbar.closeCurrent(),
      refreshTokenIntentIndicators,
      refreshMovementPlanPreview
    },
    diagnostics: {
      run: runDiagnostics,
      performance: performanceDiagnostics,
      features: getFeatureRegistryReport
    }
  };
  debug("ready");
});

/**
 * Keep the tracker synchronized when Combat flags or round/turn state changes.
 */
Hooks.on("updateCombat", (combat, changed = {}) => {
  if (!combat?.getFlag?.(MODULE_ID, "combatState")?.enabled) return;
  if (!combatTrackerAffectedByCombatChange(changed)) return;
  RenderCoordinator.invalidate("combatTracker", { reason: "combat-update", full: true, parts: ["phase", "rows"] });
});

/**
 * Keep the tracker synchronized when Combatant flags or initiative state changes.
 */
Hooks.on("updateCombatant", (combatant, changed, options = {}) => {
  if (!combatant?.parent?.getFlag?.(MODULE_ID, "combatState")?.enabled) return;
  const planningOptions = options?.[MODULE_ID] ?? {};
  if (
    isAuthoritativeGmClient()
    && Object.prototype.hasOwnProperty.call(changed ?? {}, "initiative")
    && planningOptions.planningProjection !== true
    && planningOptions.movementDexProjection !== true
    && planningOptions.planningExternalHandled !== true
  ) {
    void captureExternalPlanningInitiativeChange(combatant, changed, options)
      .then(ledger => {
        const phase = getCombatState(combatant.parent).phase;
        return ledger && !shouldTrackCurrentTurnForPhase(phase)
          ? PhaseController.clearCurrentTurn(combatant.parent, "planning-initiative-update")
          : undefined;
      })
      .catch(cause => warn(cause));
  }
  if (combatTrackerAffectedByCombatantChange(changed)) {
    RenderCoordinator.invalidate("combatTracker", {
      reason: "combatant-update",
      combatantIds: [combatant.id].filter(Boolean),
      parts: ["rows"]
    });
  }
});
