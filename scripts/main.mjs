import { MODULE_ID } from "./constants.mjs";
import {
  migrateActionUiSettings,
  migrateCombatTrackingSettings,
  migrateLegacyReportSettings,
  migrateUnifiedDebugSetting,
  registerSettings
} from "./settings.mjs";
import { registerSocket } from "./socket.mjs";
import { requestGm } from "./socket.mjs";
import { registerTrackerHooks } from "./hooks/tracker.mjs";
import { registerCombatNavigationHooks } from "./hooks/combat-navigation.mjs";
import { ActionRing, registerActionRingHooks } from "./apps/action-ring.mjs";
import { ActorHotbar, registerActorHotbarHooks } from "./apps/actor-hotbar.mjs";
import { CombatHUD } from "./apps/combat-hud.mjs";
import { PhaseController } from "./combat/phase-controller.mjs";
import { getCombatState, getCombatantState } from "./combat/state.mjs";
import { AoVAdapter } from "./adapter/aov-adapter.mjs";
import { buildResolutionQueue } from "./combat/resolution-queue.mjs";
import { runDiagnostics } from "./diagnostics.mjs";
import { debug, warn } from "./logger.mjs";
import {
  installAdjustInitiativeDismissGuard,
  installAdjustInitiativeWeaponIntegration
} from "./compat/aov-adjust-initiative.mjs";
import { registerChatReportHooks } from "./combat/chat-report.mjs";
import { registerMovementHooks, startMovementPhase } from "./combat/movement-controller.mjs";
import { reconcileEngagedStatusEffects, registerEngagedStatusEffect, registerEngagedStatusHooks } from "./combat/engagement-status.mjs";
import { registerReadiedWeaponHooks } from "./combat/weapon-state.mjs";
import { logMovementDebugExport, logMovementDebugSnapshot, movementDebugExport, movementDebugSnapshot } from "./combat/movement-debugger.mjs";
import { registerTokenIntentIndicatorHooks, refreshTokenIntentIndicators } from "./canvas/intent-indicators.mjs";

let adjustInitiativeIntegrationInstalled = false;

/**
 * Register settings as early as possible.
 */
Hooks.once("init", () => {
  registerSettings();
  registerEngagedStatusEffect();
});

// AoV and other packages may complete CONFIG mutations later in init. Reapply
// the idempotent status registration before the v13 UI is constructed.
Hooks.once("setup", () => {
  registerEngagedStatusEffect();
  if (!AoVAdapter.isAoVWorld()) return;
  adjustInitiativeIntegrationInstalled = installAdjustInitiativeWeaponIntegration();
});

/**
 * Register runtime integration only in AoV worlds.
 */
Hooks.once("ready", async () => {
  registerEngagedStatusEffect();
  if (!AoVAdapter.isAoVWorld()) {
    warn("Loaded outside the Age of Vikings system; module remains idle.");
    return;
  }
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
  registerReadiedWeaponHooks();
  registerTrackerHooks();
  registerCombatNavigationHooks();
  registerMovementHooks(requestGm);
  registerEngagedStatusHooks();
  registerActionRingHooks();
  registerActorHotbarHooks();
  registerTokenIntentIndicatorHooks();
  registerChatReportHooks();
  await reconcileEngagedStatusEffects(game.combat);
  game.aovSkjadlborg = {
    adapter: AoVAdapter,
    phase: PhaseController,
    movement: {
      startMovementPhase,
      debugSnapshot: movementDebugSnapshot,
      debugExport: movementDebugExport,
      logDebugSnapshot: logMovementDebugSnapshot,
      logDebugExport: logMovementDebugExport
    },
    getCombatState,
    getCombatantState,
    buildResolutionQueue,
    ui: {
      openCombatHud: (combatant = AoVAdapter.getControlledCombatant(game.combat), combat = game.combat) => CombatHUD.showForCombatant(combatant, combat),
      closeActionRing: () => ActionRing.closeAll(),
      refreshActionRing: () => ActionRing.current?.render(false),
      refreshActorHotbar: () => ActorHotbar.scheduleRender(),
      resetActorHotbarPosition: () => ActorHotbar.resetPosition(),
      closeActorHotbar: () => ActorHotbar.closeCurrent(),
      refreshTokenIntentIndicators
    },
    diagnostics: {
      run: runDiagnostics
    }
  };
  debug("ready");
});

/**
 * Keep the tracker synchronized when Combat flags or round/turn state changes.
 */
Hooks.on("updateCombat", combat => {
  if (!combat?.getFlag?.(MODULE_ID, "combatState")?.enabled) return;
  ui.combat?.render?.();
});

/**
 * Keep the tracker synchronized when Combatant flags or initiative state changes.
 */
Hooks.on("updateCombatant", combatant => {
  if (!combatant?.parent?.getFlag?.(MODULE_ID, "combatState")?.enabled) return;
  ui.combat?.render?.();
});
