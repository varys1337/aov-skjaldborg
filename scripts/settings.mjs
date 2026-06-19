import {
  ACTION_UI_DEFAULTS,
  ACTION_UI_LIMITS,
  ACTION_UI_MIGRATION_VERSION,
  ACTION_UI_THEMES,
  MODULE_ID,
  MOVEMENT_DEBUG_DEFAULT_CATEGORIES,
  MOVEMENT_DEBUG_LEVELS,
  PHASE_ORDER,
  PHASE_STRUCTURE_SETTING_KEYS,
  REPORT_DELIVERY,
  REPORT_PHASE_SETTING_KEYS,
  REPORT_RECIPIENTS,
  REPORT_SCOPE,
  ROUNDING_POLICIES
} from "./constants.mjs";
import { ActionUiSettings } from "./apps/action-ui-settings.mjs";
import { CombatTrackingSettings } from "./apps/combat-tracking-settings.mjs";
import { ReportSettings } from "./apps/report-settings.mjs";
import { PhaseStructureSettings } from "./apps/phase-structure-settings.mjs";
import { debug } from "./logger.mjs";

/**
 * Register all world and client settings used by the module.
 *
 * @returns {void}
 */
export function registerSettings() {
  game.settings.registerMenu(MODULE_ID, "actionUiConfiguration", {
    name: "AOV_SKJADLBORG.Settings.ActionUiMenu.Name",
    label: "AOV_SKJADLBORG.Settings.ActionUiMenu.Label",
    hint: "AOV_SKJADLBORG.Settings.ActionUiMenu.Hint",
    icon: "fa-solid fa-hand-fist",
    type: ActionUiSettings,
    restricted: false
  });

  game.settings.registerMenu(MODULE_ID, "combatTrackingConfiguration", {
    name: "AOV_SKJADLBORG.Settings.CombatTrackingMenu.Name",
    label: "AOV_SKJADLBORG.Settings.CombatTrackingMenu.Label",
    hint: "AOV_SKJADLBORG.Settings.CombatTrackingMenu.Hint",
    icon: "fa-solid fa-list-check",
    type: CombatTrackingSettings,
    restricted: true
  });

  game.settings.registerMenu(MODULE_ID, "phaseStructureConfiguration", {
    name: "AOV_SKJADLBORG.Settings.PhaseStructureMenu.Name",
    label: "AOV_SKJADLBORG.Settings.PhaseStructureMenu.Label",
    hint: "AOV_SKJADLBORG.Settings.PhaseStructureMenu.Hint",
    icon: "fa-solid fa-list-ol",
    type: PhaseStructureSettings,
    restricted: true
  });

  game.settings.register(MODULE_ID, "enableActionRing", {
    name: "AOV_SKJADLBORG.Settings.ActionRing.Name",
    hint: "AOV_SKJADLBORG.Settings.ActionRing.Hint",
    scope: "client",
    config: false,
    type: Boolean,
    default: ACTION_UI_DEFAULTS.enableActionRing,
    onChange: enabled => {
      if (!enabled) void game.aovSkjadlborg?.ui?.closeActionRing?.();
    }
  });

  game.settings.register(MODULE_ID, "actionRingMaxItems", {
    name: "AOV_SKJADLBORG.Settings.ActionRingMaxItems.Name",
    hint: "AOV_SKJADLBORG.Settings.ActionRingMaxItems.Hint",
    scope: "client",
    config: false,
    type: Number,
    range: ACTION_UI_LIMITS.actionRingMaxItems,
    default: ACTION_UI_DEFAULTS.actionRingMaxItems,
    onChange: () => {
      game.aovSkjadlborg?.ui?.refreshActorHotbar?.();
      game.aovSkjadlborg?.ui?.refreshActionRing?.();
    }
  });

  game.settings.register(MODULE_ID, "actionUiMigrationVersion", {
    name: "Action UI migration version",
    scope: "client",
    config: false,
    type: Number,
    default: 0
  });

  game.settings.register(MODULE_ID, "enableActorHotbar", {
    name: "AOV_SKJADLBORG.Settings.ActorHotbar.Name",
    hint: "AOV_SKJADLBORG.Settings.ActorHotbar.Hint",
    scope: "client",
    config: false,
    type: Boolean,
    default: ACTION_UI_DEFAULTS.enableActorHotbar,
    onChange: enabled => {
      if (enabled) game.aovSkjadlborg?.ui?.refreshActorHotbar?.();
      else void game.aovSkjadlborg?.ui?.closeActorHotbar?.();
    }
  });

  game.settings.register(MODULE_ID, "replaceCoreHotbar", {
    name: "AOV_SKJADLBORG.Settings.ReplaceCoreHotbar.Name",
    hint: "AOV_SKJADLBORG.Settings.ReplaceCoreHotbar.Hint",
    scope: "client",
    config: false,
    type: Boolean,
    default: ACTION_UI_DEFAULTS.replaceCoreHotbar,
    onChange: () => game.aovSkjadlborg?.ui?.refreshActorHotbar?.()
  });

  game.settings.register(MODULE_ID, "actorHotbarScale", {
    name: "AOV_SKJADLBORG.Settings.ActorHotbarScale.Name",
    hint: "AOV_SKJADLBORG.Settings.ActorHotbarScale.Hint",
    scope: "client",
    config: false,
    type: Number,
    range: ACTION_UI_LIMITS.actorHotbarScale,
    default: ACTION_UI_DEFAULTS.actorHotbarScale,
    onChange: () => game.aovSkjadlborg?.ui?.refreshActorHotbar?.()
  });

  game.settings.register(MODULE_ID, "actorHotbarActionWidth", {
    name: "AOV_SKJADLBORG.Settings.ActorHotbarActionWidth.Name",
    hint: "AOV_SKJADLBORG.Settings.ActorHotbarActionWidth.Hint",
    scope: "client",
    config: false,
    type: Number,
    range: ACTION_UI_LIMITS.actorHotbarActionWidth,
    default: ACTION_UI_DEFAULTS.actorHotbarActionWidth,
    onChange: () => game.aovSkjadlborg?.ui?.refreshActorHotbar?.()
  });


  game.settings.register(MODULE_ID, "actorHotbarOpacity", {
    name: "AOV_SKJADLBORG.Settings.ActorHotbarOpacity.Name",
    hint: "AOV_SKJADLBORG.Settings.ActorHotbarOpacity.Hint",
    scope: "client",
    config: false,
    type: Number,
    range: ACTION_UI_LIMITS.actorHotbarOpacity,
    default: ACTION_UI_DEFAULTS.actorHotbarOpacity,
    onChange: () => game.aovSkjadlborg?.ui?.refreshActorHotbar?.()
  });

  game.settings.register(MODULE_ID, "actionUiTheme", {
    name: "AOV_SKJADLBORG.Settings.ActionUiTheme.Name",
    hint: "AOV_SKJADLBORG.Settings.ActionUiTheme.Hint",
    scope: "client",
    config: false,
    type: String,
    choices: {
      [ACTION_UI_THEMES.AOV]: "AOV_SKJADLBORG.Settings.ActionUiTheme.Aov",
      [ACTION_UI_THEMES.CLASSIC]: "AOV_SKJADLBORG.Settings.ActionUiTheme.Classic"
    },
    default: ACTION_UI_DEFAULTS.actionUiTheme,
    onChange: () => {
      game.aovSkjadlborg?.ui?.refreshActorHotbar?.();
      game.aovSkjadlborg?.ui?.refreshActionRing?.();
    }
  });

  game.settings.register(MODULE_ID, "actorHotbarCollapsed", {
    name: "Actor hotbar collapsed",
    scope: "client",
    config: false,
    type: Boolean,
    default: ACTION_UI_DEFAULTS.actorHotbarCollapsed,
    onChange: () => game.aovSkjadlborg?.ui?.refreshActorHotbar?.()
  });

  game.settings.register(MODULE_ID, "actorHotbarPosition", {
    name: "Actor hotbar position",
    scope: "client",
    config: false,
    type: Object,
    default: ACTION_UI_DEFAULTS.actorHotbarPosition,
    onChange: position => {
      const hasPosition = Number.isFinite(Number(position?.left)) && Number.isFinite(Number(position?.top));
      if (hasPosition) game.aovSkjadlborg?.ui?.refreshActorHotbar?.();
      else game.aovSkjadlborg?.ui?.resetActorHotbarPosition?.();
    }
  });

  game.settings.register(MODULE_ID, "enabled", {
    name: "AOV_SKJADLBORG.Settings.Enabled.Name",
    hint: "AOV_SKJADLBORG.Settings.Enabled.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: false,
    onChange: () => {
      ui.combat?.render?.();
    }
  });

  game.settings.register(MODULE_ID, "requireAllCommit", {
    name: "AOV_SKJADLBORG.Settings.RequireAllCommit.Name",
    hint: "AOV_SKJADLBORG.Settings.RequireAllCommit.Hint",
    scope: "world",
    config: false,
    type: Boolean,
    default: false,
    onChange: value => {
      const combat = game.combat;
      if (game.user?.isGM && combat?.getFlag?.(MODULE_ID, "combatState")?.enabled) {
        void game.aovSkjadlborg?.phase?.synchronizeRequireAllCommit?.(combat, value === true);
      }
      ui.combat?.render?.();
    }
  });

  for (const phase of PHASE_ORDER) {
    game.settings.register(MODULE_ID, PHASE_STRUCTURE_SETTING_KEYS[phase], {
      name: `AOV_SKJADLBORG.Phases.${phase}`,
      scope: "world",
      config: false,
      type: Boolean,
      default: true,
      onChange: () => ui.combat?.render?.()
    });
  }

  game.settings.register(MODULE_ID, "movementRounding", {
    name: "AOV_SKJADLBORG.Settings.MovementRounding.Name",
    hint: "AOV_SKJADLBORG.Settings.MovementRounding.Hint",
    scope: "world",
    config: false,
    type: String,
    choices: {
      [ROUNDING_POLICIES.CEIL]: "AOV_SKJADLBORG.Settings.MovementRounding.Ceil",
      [ROUNDING_POLICIES.FLOOR]: "AOV_SKJADLBORG.Settings.MovementRounding.Floor",
      [ROUNDING_POLICIES.NEAREST]: "AOV_SKJADLBORG.Settings.MovementRounding.Nearest"
    },
    default: ROUNDING_POLICIES.CEIL
  });

  game.settings.register(MODULE_ID, "movementTickDelayMs", {
    name: "AOV_SKJADLBORG.Settings.MovementTickDelay.Name",
    hint: "AOV_SKJADLBORG.Settings.MovementTickDelay.Hint",
    scope: "world",
    config: false,
    type: Number,
    range: { min: 0, max: 1000, step: 50 },
    default: 250
  });

  game.settings.register(MODULE_ID, "shortReachGridUnits", {
    name: "AOV_SKJADLBORG.Settings.Reach.Short.Name",
    hint: "AOV_SKJADLBORG.Settings.Reach.Short.Hint",
    scope: "world",
    config: false,
    type: Number,
    range: { min: 0.5, max: 5, step: 0.5 },
    default: 1
  });

  game.settings.register(MODULE_ID, "mediumReachGridUnits", {
    name: "AOV_SKJADLBORG.Settings.Reach.Medium.Name",
    hint: "AOV_SKJADLBORG.Settings.Reach.Medium.Hint",
    scope: "world",
    config: false,
    type: Number,
    range: { min: 0.5, max: 5, step: 0.5 },
    default: 2
  });

  game.settings.register(MODULE_ID, "longReachGridUnits", {
    name: "AOV_SKJADLBORG.Settings.Reach.Long.Name",
    hint: "AOV_SKJADLBORG.Settings.Reach.Long.Hint",
    scope: "world",
    config: false,
    type: Number,
    range: { min: 0.5, max: 5, step: 0.5 },
    default: 3
  });

  game.settings.registerMenu(MODULE_ID, "reportConfiguration", {
    name: "AOV_SKJADLBORG.Settings.ReportMenu.Name",
    label: "AOV_SKJADLBORG.Settings.ReportMenu.Label",
    hint: "AOV_SKJADLBORG.Settings.ReportMenu.Hint",
    icon: "fa-solid fa-message-lines",
    type: ReportSettings,
    restricted: true
  });

  // Retained as a hidden migration source for worlds created before 0.1.9.
  game.settings.register(MODULE_ID, "chatReports", {
    name: "AOV_SKJADLBORG.Settings.ChatReports.Name",
    hint: "AOV_SKJADLBORG.Settings.ChatReports.Hint",
    scope: "world",
    config: false,
    type: Boolean,
    default: true
  });

  for (const phase of PHASE_ORDER) {
    game.settings.register(MODULE_ID, REPORT_PHASE_SETTING_KEYS[phase], {
      name: `AOV_SKJADLBORG.Phases.${phase}`,
      scope: "world",
      config: false,
      type: Boolean,
      default: true
    });
  }

  game.settings.register(MODULE_ID, "reportDelivery", {
    name: "AOV_SKJADLBORG.Settings.ReportMenu.Delivery.Name",
    scope: "world",
    config: false,
    type: String,
    choices: {
      [REPORT_DELIVERY.PUBLIC]: "AOV_SKJADLBORG.Settings.ReportMenu.Delivery.Public",
      [REPORT_DELIVERY.WHISPER]: "AOV_SKJADLBORG.Settings.ReportMenu.Delivery.Whisper"
    },
    default: REPORT_DELIVERY.WHISPER
  });

  game.settings.register(MODULE_ID, "reportWhisperRecipients", {
    name: "AOV_SKJADLBORG.Settings.ReportMenu.Recipients.Name",
    scope: "world",
    config: false,
    type: String,
    choices: {
      [REPORT_RECIPIENTS.GM]: "AOV_SKJADLBORG.Settings.ReportMenu.Recipients.Gm",
      [REPORT_RECIPIENTS.GM_AND_PLAYERS]: "AOV_SKJADLBORG.Settings.ReportMenu.Recipients.GmAndPlayers"
    },
    default: REPORT_RECIPIENTS.GM
  });

  game.settings.register(MODULE_ID, "reportCombatantScope", {
    name: "AOV_SKJADLBORG.Settings.ReportMenu.Scope.Name",
    scope: "world",
    config: false,
    type: String,
    choices: {
      [REPORT_SCOPE.ALL]: "AOV_SKJADLBORG.Settings.ReportMenu.Scope.All",
      [REPORT_SCOPE.PLAYER_OWNED]: "AOV_SKJADLBORG.Settings.ReportMenu.Scope.PlayerOwned"
    },
    default: REPORT_SCOPE.PLAYER_OWNED
  });

  game.settings.register(MODULE_ID, "reportSettingsMigrated", {
    name: "Phase report settings migrated",
    scope: "world",
    config: false,
    type: Boolean,
    default: false
  });

  game.settings.register(MODULE_ID, "debug", {
    name: "AOV_SKJADLBORG.Settings.Debug.Name",
    hint: "AOV_SKJADLBORG.Settings.Debug.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: false
  });

  game.settings.register(MODULE_ID, "movementDebugEnabled", {
    name: "AOV_SKJADLBORG.Settings.MovementDebugMenu.Enabled.Name",
    scope: "world",
    config: false,
    type: Boolean,
    default: false
  });

  game.settings.register(MODULE_ID, "movementDebugLevel", {
    name: "AOV_SKJADLBORG.Settings.MovementDebugMenu.Level.Name",
    scope: "world",
    config: false,
    type: String,
    choices: Object.fromEntries(Object.values(MOVEMENT_DEBUG_LEVELS).map(level => [
      level,
      `AOV_SKJADLBORG.Settings.MovementDebugMenu.Levels.${level}`
    ])),
    default: MOVEMENT_DEBUG_LEVELS.SUMMARY
  });

  game.settings.register(MODULE_ID, "movementDebugCategories", {
    name: "AOV_SKJADLBORG.Settings.MovementDebugMenu.Categories.Name",
    scope: "world",
    config: false,
    type: Object,
    default: MOVEMENT_DEBUG_DEFAULT_CATEGORIES
  });

  game.settings.register(MODULE_ID, "movementDebugLastRunId", {
    name: "Movement debug last run id",
    scope: "world",
    config: false,
    type: String,
    default: ""
  });

  game.settings.register(MODULE_ID, "combatTrackingMigrationVersion", {
    name: "Combat tracking migration version",
    scope: "world",
    config: false,
    type: Number,
    default: 0
  });

  game.settings.register(MODULE_ID, "debugSettingsMigrated", {
    name: "Debug settings migrated",
    scope: "world",
    config: false,
    type: Boolean,
    default: false
  });
}

/**
 * Apply idempotent client-side migrations for the action interface.
 *
 * Version 1 repurposes the former 8-40 action-ring item limit as the shared
 * 6-12 quick-access circle count. Existing values are clamped so the previous
 * preference is retained as closely as possible without producing oversized
 * portrait or token rings.
 *
 * @returns {Promise<void>}
 */
export async function migrateActionUiSettings() {
  const appliedVersion = Number(game.settings.get(MODULE_ID, "actionUiMigrationVersion")) || 0;
  if (appliedVersion >= ACTION_UI_MIGRATION_VERSION) return;

  const limits = ACTION_UI_LIMITS.actionRingMaxItems;
  const current = Number(game.settings.get(MODULE_ID, "actionRingMaxItems"));
  const normalized = Number.isFinite(current)
    ? Math.min(limits.max, Math.max(limits.min, Math.round(current)))
    : ACTION_UI_DEFAULTS.actionRingMaxItems;

  if (current !== normalized) {
    await game.settings.set(MODULE_ID, "actionRingMaxItems", normalized);
  }
  await game.settings.set(MODULE_ID, "actionUiMigrationVersion", ACTION_UI_MIGRATION_VERSION);
  debug(`Migrated action UI settings to version ${ACTION_UI_MIGRATION_VERSION}.`);
}

/**
 * Migrate the former single chat-report toggle into the phase checklist once.
 *
 * @returns {Promise<void>}
 */
export async function migrateLegacyReportSettings() {
  if (!game.user?.isGM) return;
  if (game.settings.get(MODULE_ID, "reportSettingsMigrated")) return;
  const enabled = game.settings.get(MODULE_ID, "chatReports");
  await Promise.all([
    ...PHASE_ORDER.map(phase => game.settings.set(MODULE_ID, REPORT_PHASE_SETTING_KEYS[phase], enabled)),
    game.settings.set(MODULE_ID, "reportSettingsMigrated", true)
  ]);
}


/**
 * Apply one-time world migrations for combat-tracking defaults.
 *
 * Version 1 changes the former mandatory all-intents gate to an opt-in rule.
 *
 * @returns {Promise<void>}
 */
export async function migrateCombatTrackingSettings() {
  if (!game.user?.isGM) return;
  const version = Number(game.settings.get(MODULE_ID, "combatTrackingMigrationVersion")) || 0;
  if (version >= 1) return;
  await Promise.all([
    game.settings.set(MODULE_ID, "requireAllCommit", false),
    game.settings.set(MODULE_ID, "combatTrackingMigrationVersion", 1)
  ]);
}

/**
 * Collapse the former generic and movement-specific debug switches into the
 * single visible Debug logging setting while preserving enabled legacy worlds.
 *
 * @returns {Promise<void>}
 */
export async function migrateUnifiedDebugSetting() {
  if (!game.user?.isGM) return;
  if (game.settings.get(MODULE_ID, "debugSettingsMigrated")) return;
  const enabled = game.settings.get(MODULE_ID, "debug") === true
    || game.settings.get(MODULE_ID, "movementDebugEnabled") === true;
  await Promise.all([
    game.settings.set(MODULE_ID, "debug", enabled),
    game.settings.set(MODULE_ID, "movementDebugEnabled", false),
    game.settings.set(MODULE_ID, "debugSettingsMigrated", true)
  ]);
}
