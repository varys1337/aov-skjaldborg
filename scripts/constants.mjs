/**
 * Constants shared by the Skjaldborg module.
 *
 * Keep this file dependency-free so other modules can import stable IDs and enum
 * values without triggering Foundry document or application work during init.
 */
export const MODULE_ID = "aov-skjaldborg";
export const SOCKET_NAME = `module.${MODULE_ID}`;

export const MODULE_VERSION = "0.5.5";
export const MINIMUM_FOUNDRY_VERSION = "14.363";
export const VERIFIED_FOUNDRY_VERSION = "14.364";
export const MINIMUM_AOV_VERSION = "14.4";
export const V14_MIGRATION_VERSION = 1;


export const ACTION_UI_THEMES = Object.freeze({
  CLASSIC: "classic",
  AOV: "aov"
});

export const ACTION_UI_MIGRATION_VERSION = 1;

export const MOVEMENT_PLAN_VISIBILITY = Object.freeze({
  EVERYONE: "everyone",
  PERMISSION: "permission",
  NONE: "none"
});

export const MOVEMENT_PLAN_VISIBILITY_DEFAULT = MOVEMENT_PLAN_VISIBILITY.PERMISSION;

export const REACH_VISUALIZER_VISIBILITY = Object.freeze({
  DYNAMIC: "dynamic",
  HOVER: "hover",
  ALWAYS: "always"
});

export const REACH_VISUALIZER_SHAPE = Object.freeze({
  GRID: "grid",
  CIRCLE: "circle"
});

export const REACH_VISUALIZER_DEFAULTS = Object.freeze({
  enabled: false,
  visibility: REACH_VISUALIZER_VISIBILITY.DYNAMIC,
  shape: REACH_VISUALIZER_SHAPE.GRID,
  opacity: 0.35,
  passiveOpacity: 0.2,
  activeOpacity: 0.8,
  lineWidth: 2
});

export const REACH_VISUALIZER_LIMITS = Object.freeze({
  opacity: Object.freeze({ min: 0.05, max: 1, step: 0.05 }),
  passiveOpacity: Object.freeze({ min: 0.05, max: 1, step: 0.05 }),
  activeOpacity: Object.freeze({ min: 0.05, max: 1, step: 0.05 }),
  lineWidth: Object.freeze({ min: 1, max: 12, step: 1 })
});

export const ACTION_UI_DEFAULTS = Object.freeze({
  enableActionRing: true,
  actionRingMaxItems: 6,
  enableActorHotbar: true,
  replaceCoreHotbar: true,
  actorHotbarScale: 1,
  actorHotbarActionWidth: 420,
  actorHotbarOpacity: 100,
  actionUiTheme: ACTION_UI_THEMES.AOV,
  actorHotbarCollapsed: false,
  actorHotbarPosition: {}
});

export const ACTION_UI_LIMITS = Object.freeze({
  actionRingMaxItems: Object.freeze({ min: 6, max: 12, step: 1 }),
  actorHotbarScale: Object.freeze({ min: 0.75, max: 1.4, step: 0.05 }),
  actorHotbarActionWidth: Object.freeze({ min: 240, max: 720, step: 20 }),
  actorHotbarOpacity: Object.freeze({ min: 0, max: 100, step: 5 })
});

export const PHASES = Object.freeze({
  INTENT: "intent",
  MOVEMENT: "movement",
  RESOLUTION: "resolution",
  BOOKKEEPING: "bookkeeping"
});

export const PHASE_ORDER = Object.freeze([
  PHASES.INTENT,
  PHASES.MOVEMENT,
  PHASES.RESOLUTION,
  PHASES.BOOKKEEPING
]);

export const PHASE_STRUCTURE_SETTING_KEYS = Object.freeze({
  [PHASES.INTENT]: "phaseIntentEnabled",
  [PHASES.MOVEMENT]: "phaseMovementEnabled",
  [PHASES.RESOLUTION]: "phaseResolutionEnabled",
  [PHASES.BOOKKEEPING]: "phaseBookkeepingEnabled"
});

export const PHASE_CURRENT_TURN_SETTING_KEYS = Object.freeze({
  [PHASES.INTENT]: "phaseIntentTrackCurrentTurn",
  [PHASES.MOVEMENT]: "phaseMovementTrackCurrentTurn",
  [PHASES.RESOLUTION]: "phaseResolutionTrackCurrentTurn",
  [PHASES.BOOKKEEPING]: "phaseBookkeepingTrackCurrentTurn"
});

export const PHASE_CURRENT_TURN_DEFAULTS = Object.freeze({
  [PHASES.INTENT]: false,
  [PHASES.MOVEMENT]: false,
  [PHASES.RESOLUTION]: true,
  [PHASES.BOOKKEEPING]: true
});

export const REPORT_DELIVERY = Object.freeze({
  PUBLIC: "public",
  WHISPER: "whisper"
});

export const REPORT_RECIPIENTS = Object.freeze({
  GM: "gm",
  GM_AND_PLAYERS: "gm-and-players"
});

export const REPORT_SCOPE = Object.freeze({
  ALL: "all",
  PLAYER_OWNED: "player-owned"
});

export const REPORT_PHASE_SETTING_KEYS = Object.freeze({
  [PHASES.INTENT]: "reportPhaseIntent",
  [PHASES.MOVEMENT]: "reportPhaseMovement",
  [PHASES.RESOLUTION]: "reportPhaseResolution",
  [PHASES.BOOKKEEPING]: "reportPhaseBookkeeping"
});

export const ACTION_CATEGORIES = Object.freeze({
  ATTACK: "attack",
  MISSILE: "missile",
  KNOCKBACK: "knockback",
  GRAPPLE: "grapple",
  DEFEND: "defend",
  MAGIC: "magic",
  RETREAT: "retreat",
  WAIT: "wait",
  DELAY: "delay",
  OTHER: "other"
});

export const UTILITY_ACTION_ID = "utility";

export const INTENT_STATUS = Object.freeze({
  UNCOMMITTED: "uncommitted",
  COMMITTED: "committed",
  HELD: "held"
});

export const RESOLUTION_STATUS = Object.freeze({
  PENDING: "pending",
  ACTIVE: "active",
  RESOLVED: "resolved",
  SKIPPED: "skipped",
  CARRYOVER: "carryover"
});

export const ROUNDING_POLICIES = Object.freeze({
  CEIL: "ceil",
  FLOOR: "floor",
  NEAREST: "nearest"
});

export const MOVEMENT_DEBUG_LEVELS = Object.freeze({
  SUMMARY: "summary",
  VERBOSE: "verbose",
  TRACE: "trace"
});

export const MOVEMENT_DEBUG_CATEGORIES = Object.freeze({
  CAPTURE: "capture",
  SOCKET: "socket",
  ROUTE: "route",
  EXPANSION: "expansion",
  RUN: "run",
  SCHEDULER: "scheduler",
  COLLISION: "collision",
  ENGAGEMENT: "engagement",
  STOP: "stop",
  STATUS: "status",
  DEX: "dex"
});

export const MOVEMENT_DEBUG_DEFAULT_CATEGORIES = Object.freeze(Object.fromEntries(
  Object.values(MOVEMENT_DEBUG_CATEGORIES).map(category => [category, true])
));

export const MOVEMENT_PLAN_STATUS = Object.freeze({
  NONE: "none",
  PLANNED: "planned",
  EXECUTING: "executing",
  COMPLETED: "completed",
  STOPPED: "stopped",
  FAILED: "failed"
});

export const ENGAGEMENT_STATUS = Object.freeze({
  NONE: "none",
  ENGAGED: "engaged"
});

export const ENGAGEMENT_VISUAL_MODES = Object.freeze({
  ACTIVE_EFFECT: "activeEffect",
  OVERLAY: "overlay",
  BOTH: "both"
});

export const ENGAGEMENT_VISUAL_MODE_DEFAULT = ENGAGEMENT_VISUAL_MODES.ACTIVE_EFFECT;

export const ENGAGED_STATUS_ID = `${MODULE_ID}-engaged`;
export const MOUNTED_STATUS_ID = `${MODULE_ID}-mounted`;
export const DISENGAGING_STATUS_ID = `${MODULE_ID}-disengaging`;
export const GRAPPLED_STATUS_ID = `${MODULE_ID}-grappled`;
export const IMMOBILIZED_STATUS_ID = `${MODULE_ID}-immobilized`;
export const EVADING_STATUS_ID = `${MODULE_ID}-evading`;
export const IMPALED_STATUS_ID = `${MODULE_ID}-impaled`;
export const INJURY_STATUS_ID = `${MODULE_ID}-injury`;
export const DAMAGE_EFFECT_SOURCE_FLAG = "damageEffectSource";
export const DAMAGE_EFFECT_TRACKING_FLAG = "damageEffectTracking";

export const DISENGAGEMENT_METHODS = Object.freeze({
  NONE: "none",
  RETREAT: "retreat",
  FLEE: "flee",
  KNOCKBACK: "knockback"
});

export const DISENGAGEMENT_STATUS = Object.freeze({
  NONE: "none",
  DECLARED: "declared",
  COMPLETE: "complete",
  INTERRUPTED: "interrupted"
});

export const DEX_MODIFIERS = Object.freeze({
  DRAW_WEAPON: -5,
  SHEATHE_WEAPON: -5,
  SURPRISED: -5
});

export const DEFENSE_REACTION_STEP = -20;

export const FLAG_KEYS = Object.freeze({
  COMBAT_STATE: "combatState",
  COMBATANT_STATE: "combatantState"
});
