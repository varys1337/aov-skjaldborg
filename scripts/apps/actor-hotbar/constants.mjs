export const QUICK_ACCESS_DRAG_TYPE = "AOVSkjaldborgActorHotbarAction";
export const QUICK_ACCESS_DRAG_MIME = "application/x-aov-skjaldborg-action";
export const QUICK_ACCESS_SLOT_SIZE = 42;
export const QUICK_ACCESS_MIN_RADIUS = 75;
export const QUICK_ACCESS_MIN_STAGE_SIZE = 192;
export const QUICK_ACCESS_SLOT_GAP = 4;

export const HOTBAR_DOCKS = Object.freeze({
  AUTO: "auto",
  LEFT: "left",
  RIGHT: "right",
  TOP: "top",
  BOTTOM: "bottom"
});
export const EXPLICIT_HOTBAR_DOCKS = new Set([
  HOTBAR_DOCKS.LEFT,
  HOTBAR_DOCKS.RIGHT,
  HOTBAR_DOCKS.TOP,
  HOTBAR_DOCKS.BOTTOM
]);
export const HOTBAR_DOCK_DRAG_THRESHOLD = 7;
export const HOTBAR_VIEWPORT_MARGIN = 8;
export const HOTBAR_MIN_RESPONSIVE_ACTION_WIDTH = 180;

export const HOTBAR_PARTS = Object.freeze({
  SHELL: "shell"
});
export const HOTBAR_REGIONS = Object.freeze({
  RESOURCES: "resources",
  PORTRAIT_QUICK_ACCESS: "portraitQuickAccess",
  HEADER_EFFECTS: "headerEffects",
  COMBAT_WORKFLOW: "combatWorkflow",
  TAB_BODY: "tabBody"
});
export const HOTBAR_RENDER_REGIONS = new Set(Object.values(HOTBAR_REGIONS));
export const HOTBAR_TAB_BODY_CATEGORIES = new Set([
  "equipment",
  "historyFamily",
  "magic",
  "macros",
  "skills",
  "stats",
  "wellbeing"
]);
export const HOTBAR_REGION_TEMPLATES = Object.freeze({
  [HOTBAR_REGIONS.RESOURCES]: "modules/aov-skjaldborg/templates/actor-hotbar/resources.hbs",
  [HOTBAR_REGIONS.PORTRAIT_QUICK_ACCESS]: "modules/aov-skjaldborg/templates/actor-hotbar/portrait-quick-access.hbs",
  [HOTBAR_REGIONS.HEADER_EFFECTS]: "modules/aov-skjaldborg/templates/actor-hotbar/header-effects.hbs",
  [HOTBAR_REGIONS.COMBAT_WORKFLOW]: "modules/aov-skjaldborg/templates/actor-hotbar/combat-workflow.hbs",
  [HOTBAR_REGIONS.TAB_BODY]: "modules/aov-skjaldborg/templates/actor-hotbar/tab-body.hbs"
});
export const HOTBAR_TEMPLATE_PATHS = Object.freeze([
  "modules/aov-skjaldborg/templates/actor-hotbar.hbs",
  ...Object.values(HOTBAR_REGION_TEMPLATES),
  "modules/aov-skjaldborg/templates/actor-hotbar/equipment-controls.hbs"
]);

export const SKILL_CATEGORY_ORDER = Object.freeze([
  "agi",
  "cbt",
  "com",
  "knw",
  "man",
  "myt",
  "per",
  "ste",
  "zzz",
  "other"
]);

export const MAGIC_TYPE_ORDER = Object.freeze([
  "rune",
  "runescript",
  "seidur",
  "npcpower",
  "other"
]);

export const DISPOSITION_PALETTES = Object.freeze({
  friendly: Object.freeze({
    key: "friendly",
    color: "#3399ff",
    labelColor: "#73c2ff",
    labelWeight: 800,
    glowSoft: "rgba(51, 153, 255, 0.42)",
    glowStrong: "rgba(51, 153, 255, 0.82)"
  }),
  neutral: Object.freeze({
    key: "neutral",
    color: "#e7bd32",
    labelColor: "#ffd54d",
    labelWeight: 900,
    glowSoft: "rgba(231, 189, 50, 0.42)",
    glowStrong: "rgba(231, 189, 50, 0.82)"
  }),
  hostile: Object.freeze({
    key: "hostile",
    color: "#e53935",
    labelColor: "#ff766d",
    labelWeight: 800,
    glowSoft: "rgba(229, 57, 53, 0.42)",
    glowStrong: "rgba(229, 57, 53, 0.82)"
  }),
  secret: Object.freeze({
    key: "secret",
    color: "#9256d9",
    labelColor: "#c79cff",
    labelWeight: 800,
    glowSoft: "rgba(146, 86, 217, 0.42)",
    glowStrong: "rgba(146, 86, 217, 0.82)"
  })
});
