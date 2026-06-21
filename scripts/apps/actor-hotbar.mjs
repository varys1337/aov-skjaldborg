import { ACTION_CATEGORIES, INTENT_STATUS, MODULE_ID } from "../constants.mjs";
import { AoVAdapter } from "../adapter/aov-adapter.mjs";
import { getCombatState, getCombatantState } from "../combat/state.mjs";
import { error } from "../logger.mjs";
import { requestGm } from "../socket.mjs";
import { clearReadiedWeapon, getReadiedWeaponId, prepareReadiedWeaponState, setReadiedWeapon } from "../combat/weapon-state.mjs";
import { createModuleChatMessage } from "../compat/chat-message.mjs";
import { CombatHUD } from "./combat-hud.mjs";
import { performanceDiagnostics, measureAsync } from "../performance/performance-monitor.mjs";
import { RenderCoordinator } from "../ui/render-coordinator.mjs";
import { PresentationCache } from "../ui/presentation-cache.mjs";
import {
  actorHotbarPartsForActorChange,
  actorHotbarPartsForCombatantChange,
  actorHotbarPartsForCombatChange,
  actorHotbarPartsForItemChange
} from "../utils/changed-paths.mjs";
import {
  ACTOR_HOTBAR_QUICK_SLOT_CAPACITY,
  commitIntentCategory,
  cycleActorEquipmentStatus,
  executeActorItem,
  executeActorStat,
  executeMacro,
  getActorPreparedIntent,
  getQuickAccessCircleCount,
  isSkjaldborgCombatActive,
  openActorItem,
  persistActionOrder,
  persistActorQuickAccess,
  prepareActorActions,
  prepareActorQuickAccess,
  prepareActorEquipment,
  prepareActorHistoryFamily,
  prepareActorStats,
  prepareIntentActions,
  promptOtherIntentText,
  resolveActorCombatant,
  resolveActorToken,
  resolveHotbarActor,
  toggleActorItemXpCheck,
  updateActorEquipmentQuantity,
  updateActorWeaponHitPoints
} from "../ui/action-catalog.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

const QUICK_ACCESS_DRAG_TYPE = "AOVSkjaldborgActorHotbarAction";
const QUICK_ACCESS_DRAG_MIME = "application/x-aov-skjaldborg-action";
const QUICK_ACCESS_SLOT_SIZE = 42;
const QUICK_ACCESS_MIN_RADIUS = 75;
const QUICK_ACCESS_MIN_STAGE_SIZE = 192;
const QUICK_ACCESS_SLOT_GAP = 4;

const HOTBAR_DOCKS = Object.freeze({
  AUTO: "auto",
  LEFT: "left",
  RIGHT: "right",
  TOP: "top",
  BOTTOM: "bottom"
});
const EXPLICIT_HOTBAR_DOCKS = new Set([
  HOTBAR_DOCKS.LEFT,
  HOTBAR_DOCKS.RIGHT,
  HOTBAR_DOCKS.TOP,
  HOTBAR_DOCKS.BOTTOM
]);
const HOTBAR_DOCK_DRAG_THRESHOLD = 7;
const HOTBAR_VIEWPORT_MARGIN = 8;
const HOTBAR_MIN_RESPONSIVE_ACTION_WIDTH = 180;

/**
 * Calculate a single-circle portrait layout for six through twelve slots.
 *
 * @param {number} count Visible slot count.
 * @returns {{center: number, radius: number, size: number, stageSize: number}}
 */
function quickAccessGeometry(count) {
  const normalized = Math.max(1, Math.round(Number(count) || 1));
  const chordRadius = (QUICK_ACCESS_SLOT_SIZE + QUICK_ACCESS_SLOT_GAP)
    / (2 * Math.sin(Math.PI / normalized));
  const radius = Math.max(QUICK_ACCESS_MIN_RADIUS, Math.ceil(chordRadius));
  const stageSize = Math.max(
    QUICK_ACCESS_MIN_STAGE_SIZE,
    Math.ceil((radius + (QUICK_ACCESS_SLOT_SIZE / 2)) * 2)
  );
  return {
    center: stageSize / 2,
    radius,
    size: QUICK_ACCESS_SLOT_SIZE,
    stageSize
  };
}

const SKILL_CATEGORY_ORDER = Object.freeze([
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

const MAGIC_TYPE_ORDER = Object.freeze([
  "rune",
  "runescript",
  "seidur",
  "npcpower",
  "other"
]);

let hooksRegistered = false;

const DISPOSITION_PALETTES = Object.freeze({
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

/**
 * Resolve the selected actor's authoritative Token disposition.
 *
 * The active Combatant Token is preferred during combat. Outside combat, the
 * currently controlled Token, a synthetic Token, the first active Token, and
 * finally the Actor prototype Token are considered in that order.
 *
 * @param {Actor|null} actor Current actor document.
 * @param {Combatant|null} combatant Current actor Combatant document.
 * @returns {{key: string, color: string, labelColor: string, labelWeight: number, glowSoft: string, glowStrong: string}}
 */
function resolveDispositionPalette(actor, combatant) {
  const controlled = canvas?.tokens?.controlled?.find(token => {
    const tokenActor = token.actor;
    return tokenActor?.id === actor?.id || tokenActor?.baseActor?.id === actor?.id;
  }) ?? null;
  const activeToken = actor?.getActiveTokens?.(false, true)?.[0] ?? null;
  const tokenDocument = combatant?.token?.document
    ?? combatant?.token
    ?? controlled?.document
    ?? actor?.token
    ?? activeToken?.document
    ?? activeToken
    ?? actor?.prototypeToken
    ?? null;
  const disposition = Number(tokenDocument?.disposition);
  const dispositions = globalThis.CONST?.TOKEN_DISPOSITIONS ?? {};
  const friendly = Number(dispositions.FRIENDLY ?? 1);
  const neutral = Number(dispositions.NEUTRAL ?? 0);
  const hostile = Number(dispositions.HOSTILE ?? -1);
  const secret = Number(dispositions.SECRET ?? -2);

  if (disposition === friendly) return DISPOSITION_PALETTES.friendly;
  if (disposition === hostile) return DISPOSITION_PALETTES.hostile;
  if (disposition === secret) return DISPOSITION_PALETTES.secret;
  if (disposition === neutral) return DISPOSITION_PALETTES.neutral;
  return DISPOSITION_PALETTES.neutral;
}

/**
 * Localize an AoV skill category while retaining a readable fallback.
 *
 * @param {string} category AoV category id.
 * @returns {string}
 */
function localizeSkillCategory(category) {
  if (category === "other") return game.i18n.localize("AOV_SKJALDBORG.ActorHotbar.Groups.OtherSkills");
  const key = `AOV.skillCat.${category}`;
  const localized = game.i18n.localize(key);
  return localized === key ? category.toLocaleUpperCase(game.i18n.lang) : localized;
}

/**
 * Localize an AoV magic or power Item type.
 *
 * @param {string} itemType AoV Item type.
 * @returns {string}
 */
function localizeMagicType(itemType) {
  if (itemType === "other") return game.i18n.localize("AOV_SKJALDBORG.ActorHotbar.Groups.OtherMagic");
  const key = `TYPES.Item.${itemType}`;
  const localized = game.i18n.localize(key);
  return localized === key ? itemType : localized;
}

/**
 * Lazy-load the Attack Roll dialog only when the Attack intent is invoked.
 *
 * @param {object} context Dialog context.
 * @returns {Promise<unknown>}
 */
async function openAttackRollDialog(context) {
  return measureAsync("attackDialog.open", async () => {
    const { AttackRollDialog } = await import("./attack-roll-dialog.mjs");
    return AttackRollDialog.show(context);
  });
}

/**
 * Normalize a configured Token bar attribute to an Actor document path.
 *
 * Foundry Token configuration stores system-relative values such as `hp`,
 * while TokenDocument#getBarAttribute may return either that value or the
 * expanded `system.hp` path depending on the tracked attribute type.
 *
 * @param {unknown} attribute Configured or resolved Token bar attribute.
 * @returns {string}
 */
function normalizeTrackedResourcePath(attribute) {
  let path = String(attribute ?? "").trim();
  if (!path) return "";
  if (path.startsWith("actor.")) path = path.slice("actor.".length);
  if (!path.startsWith("system.")) path = `system.${path}`;
  return path;
}

/**
 * Identify AoV resources that require system-specific write semantics.
 *
 * @param {string} attribute Normalized Actor path.
 * @returns {"hp"|"mp"|"generic"}
 */
function trackedResourceKind(attribute) {
  const relative = String(attribute ?? "")
    .replace(/^system\./, "")
    .replace(/\.value$/, "");
  if (relative === "hp") return "hp";
  if (relative === "mp") return "mp";
  return "generic";
}

/**
 * Produce a readable label for an arbitrary Token bar resource.
 *
 * @param {string} attribute Normalized Actor path.
 * @param {string} barName Token bar slot name.
 * @returns {string}
 */
function trackedResourceLabel(attribute, barName) {
  const kind = trackedResourceKind(attribute);
  if (kind === "hp") return game.i18n.localize("AOV_SKJALDBORG.ActorHotbar.HitPoints");
  if (kind === "mp") return game.i18n.localize("AOV_SKJALDBORG.ActorHotbar.MagicPoints");

  const segments = String(attribute ?? "")
    .replace(/^system\./, "")
    .replace(/\.value$/, "")
    .split(".")
    .filter(Boolean);
  const leaf = segments.at(-1) ?? barName;
  const localizationKey = `AOV.${leaf}`;
  const localized = game.i18n.localize(localizationKey);
  if (localized !== localizationKey) return localized;
  return leaf
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, character => character.toLocaleUpperCase(game.i18n.lang));
}

/**
 * Convert an unknown Token bar number to a finite display value.
 *
 * @param {unknown} value Candidate number.
 * @param {number} [fallback=0] Fallback number.
 * @returns {number}
 */
function finiteResourceNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

/**
 * Build Token Action HUD-style named groups from actor-owned actions.
 *
 * @param {object[]} actions Prepared action descriptors.
 * @param {"skills"|"magic"} type Grouping strategy.
 * @returns {{id: string, label: string, actions: object[]}[]}
 */
function prepareNamedGroups(actions, type) {
  const order = type === "skills" ? SKILL_CATEGORY_ORDER : MAGIC_TYPE_ORDER;
  const grouped = new Map();

  for (const action of actions) {
    const key = type === "skills"
      ? (action.category || "other")
      : (MAGIC_TYPE_ORDER.includes(action.itemType) ? action.itemType : "other");
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push({ ...action, reorderable: true, section: key });
  }

  return order
    .filter(key => grouped.has(key))
    .map(key => ({
      id: key,
      label: type === "skills" ? localizeSkillCategory(key) : localizeMagicType(key),
      actions: grouped.get(key)
    }));
}

/**
 * Frame-less selected-actor hotbar adapted to Age of Vikings and Skjaldborg.
 *
 * The surface is a viewport overlay anchored on the actor portrait. Position is
 * client-scoped and persisted. All action and resource state is derived from
 * Actor, Item, ActiveEffect, Combat, and Combatant documents.
 */
export class ActorHotbar extends HandlebarsApplicationMixin(ApplicationV2) {
  static current = null;

  static DEFAULT_OPTIONS = {
    id: "aov-skjaldborg-actor-hotbar",
    classes: ["aov-skjaldborg", "skj-actor-hotbar"],
    window: {
      frame: false
    },
    actions: {
      activate: ActorHotbar.onActivate,
      incrementReaction: ActorHotbar.onIncrementReaction,
      openActor: ActorHotbar.onOpenActor,
      openCombatHud: ActorHotbar.onOpenCombatHud,
      createWound: ActorHotbar.onCreateWound,
      deleteWound: ActorHotbar.onDeleteWound,
      openEquipment: ActorHotbar.onOpenEquipment,
      openItem: ActorHotbar.onOpenItem,
      openUuid: ActorHotbar.onOpenUuid,
      rollSelectedWeapon: ActorHotbar.onRollSelectedWeapon,
      rollWeaponAttack: ActorHotbar.onRollWeaponAttack,
      rollWeaponDamage: ActorHotbar.onRollWeaponDamage,
      toggleReadiedWeapon: ActorHotbar.onToggleReadiedWeapon,
      dropReadiedWeapon: ActorHotbar.onDropReadiedWeapon,
      toggleEquipment: ActorHotbar.onToggleEquipment,
      toggleCollapse: ActorHotbar.onToggleCollapse,
      toggleWoundTreated: ActorHotbar.onToggleWoundTreated,
      toggleXp: ActorHotbar.onToggleXp,
      toggleMagicPrepared: ActorHotbar.onToggleMagicPrepared
    }
  };

  static PARTS = {
    hotbar: {
      template: "modules/aov-skjaldborg/templates/actor-hotbar.hbs"
    }
  };

  static TABS = {
    sheet: {
      tabs: [
        { id: "combat", label: "AOV_SKJALDBORG.ActorHotbar.Tabs.Combat" },
        { id: "wellbeing", label: "AOV_SKJALDBORG.ActorHotbar.Tabs.Wellbeing" },
        { id: "stats", label: "AOV_SKJALDBORG.ActorHotbar.Tabs.Stats" },
        { id: "skills", label: "AOV_SKJALDBORG.ActorHotbar.Tabs.Skills" },
        { id: "equip", label: "AOV_SKJALDBORG.ActorHotbar.Tabs.Equip" },
        { id: "magic", label: "AOV_SKJALDBORG.ActorHotbar.Tabs.Magic" },
        { id: "historyFamily", label: "AOV_SKJALDBORG.ActorHotbar.Tabs.HistoryFamily" },
        { id: "macros", label: "AOV_SKJALDBORG.ActorHotbar.Tabs.Macros" }
      ],
      initial: "combat"
    }
  };

  constructor(options = {}) {
    super(options);
    this.actor = null;
    this.combatant = null;
    this._dragData = null;
    this._quickDragData = null;
    this._positionInitialized = false;
    this._positionDragAbort = null;
    this._dockDragAbort = null;
    this._dockPreference = HOTBAR_DOCKS.AUTO;
    this._hotbarDock = HOTBAR_DOCKS.RIGHT;
    this._suppressCollapseClick = false;
    this._resourceUpdatePending = false;
    this._resourceBindings = new Map();
    this._equipmentUpdatePending = false;
    this._weaponHpUpdatesPending = new Set();
    this._wellbeingUpdatesPending = new Set();
    this._weaponActionPending = false;
    this._quickAccessUpdatePending = false;
    this._xpUpdatePending = false;
    this._magicPreparationUpdatesPending = new Set();
    this._reactionUpdateQueue = Promise.resolve();
    this._scrollPositions = new Map();
    this._renderedActorKey = null;
  }

  /**
   * Ensure the singleton is rendered when the client setting is enabled.
   *
   * @returns {Promise<ActorHotbar|null>}
   */
  static async ensureRendered() {
    if (!game.settings.get(MODULE_ID, "enableActorHotbar")) {
      await this.closeCurrent();
      return null;
    }

    if (!resolveHotbarActor()) {
      await this.closeCurrent();
      return null;
    }

    if (!this.current) this.current = new ActorHotbar();
    await this.current.render(!this.current.rendered);
    return this.current;
  }

  /**
   * Debounce document-hook refreshes into one render pass.
   *
   * @param {object} [detail={}] Optional invalidation detail.
   * @returns {void}
   */
  static scheduleRender(detail = {}) {
    for (const part of detail.parts ?? []) {
      performanceDiagnostics.count(`actorHotbar.invalidate.${part}`, 1, detail.reason ?? "actor-hotbar");
    }
    RenderCoordinator.invalidate("actorHotbar", {
      parts: detail.parts ?? [],
      reason: detail.reason ?? "actor-hotbar",
      full: detail.full === true
    });
  }

  /**
   * Render the hotbar after the shared render coordinator flushes.
   *
   * AppV2 part-aware invalidation is preserved in the detail payload for
   * diagnostics and future part splitting. Unknown or shell-affecting changes
   * continue to use a full safe render.
   *
   * @param {object} [detail={}] Merged invalidation detail.
   * @returns {Promise<ActorHotbar|null>}
   */
  static async renderInvalidated(detail = {}) {
    performanceDiagnostics.count("actorHotbar.render.request", 1, detail);
    return performanceDiagnostics.measureAsync("actorHotbar.render.complete", () => this.ensureRendered(), () => detail);
  }

  /**
   * Close the hotbar and restore the core macro bar.
   *
   * @returns {Promise<void>}
   */
  static async closeCurrent() {
    const current = this.current;
    this.current = null;
    document.querySelector("#hotbar")?.classList.remove("skj-core-hotbar-hidden");
    if (current?.rendered) await current.close({ animate: false });
  }

  /**
   * Return the rendered singleton to its default core-hotbar anchor.
   *
   * @returns {void}
   */
  static resetPosition() {
    if (!this.current?.rendered) return;
    this.current._positionInitialized = false;
    this.current._dockPreference = HOTBAR_DOCKS.AUTO;
    const position = this.current._positionAboveCoreHotbar();
    this.current._positionInitialized = true;
    if (position) {
      void game.settings.set(MODULE_ID, "actorHotbarPosition", {
        ...position,
        dock: HOTBAR_DOCKS.AUTO
      });
    }
  }

  /** @inheritdoc */
  _insertElement(element) {
    // Keep the overlay independent from the core hotbar/sidebar layout. Its
    // viewport-fixed position is managed explicitly through setPosition().
    document.body.append(element);
  }

  /** @inheritdoc */
  async _prepareContext(options) {
    const measureId = performanceDiagnostics.markStart("actorHotbar.context");
    try {
    const context = await super._prepareContext(options);
    this.actor = resolveHotbarActor();
    this.combatant = resolveActorCombatant(this.actor, game.combat);
    if (!this.actor) return { ...context, actor: null };

    const prepared = PresentationCache.get(this.actor, "actions", () => prepareActorActions(this.actor));
    const combat = game.combat ?? null;
    const workflowActive = isSkjaldborgCombatActive(combat) && !!this.combatant;
    const canControlCombatant = this.combatant
      ? AoVAdapter.canUserControlCombatant(game.user, this.combatant)
      : false;
    const canDeclareIntent = this.actor.isOwner && (!this.combatant || canControlCombatant);
    const combatantState = this.combatant ? getCombatantState(this.combatant) : null;
    const combatState = workflowActive ? getCombatState(combat) : null;
    const preparedIntent = getActorPreparedIntent(this.actor);
    const committedIntent = workflowActive
      && [INTENT_STATUS.COMMITTED, INTENT_STATUS.HELD].includes(combatantState?.intent?.status);
    const displayedIntent = committedIntent ? combatantState.intent : preparedIntent;
    const intentActions = canDeclareIntent
      ? prepareIntentActions({
        selectedCategory: displayedIntent?.actionCategory ?? null,
        otherText: displayedIntent?.publicText ?? ""
      })
      : [];
    const showMacroTab = game.settings.get(MODULE_ID, "replaceCoreHotbar");
    const equipmentGroups = PresentationCache.get(this.actor, "equipment", () => prepareActorEquipment(this.actor));
    const weaponState = PresentationCache.get(this.actor, "weapons", () => prepareReadiedWeaponState(this.actor));
    const canManageWeapons = this.actor.isOwner
      && (!this.combatant || AoVAdapter.canUserControlCombatant(game.user, this.combatant));
    const showEquipTab = equipmentGroups.length > 0;
    const historyFamily = await PresentationCache.getAsync(this.actor, "historyFamily", () => prepareActorHistoryFamily(this.actor));
    const showHistoryFamilyTab = this.actor.type === "character" || historyFamily.hasContent;
    const wellbeing = AoVAdapter.prepareActorWellbeing(this.actor);
    const showWellbeingTab = wellbeing.supported;
    const magicGroups = PresentationCache.get(this.actor, "magic", () => prepareNamedGroups(prepared.magic, "magic"));
    const showMagicTab = magicGroups.length > 0;
    const resources = await this._prepareResources();

    const activeTab = this.tabGroups?.sheet;
    const hiddenActiveTab = (!showMacroTab && activeTab === "macros")
      || (!showEquipTab && activeTab === "equip")
      || (!showMagicTab && activeTab === "magic")
      || (!showWellbeingTab && activeTab === "wellbeing")
      || (!showHistoryFamilyTab && activeTab === "historyFamily");
    if (hiddenActiveTab) {
      this.tabGroups.sheet = "combat";
      context.tabs[activeTab].cssClass = context.tabs[activeTab].cssClass.replace("active", "").trim();
      context.tabs.combat.cssClass = [context.tabs.combat.cssClass, "active"].filter(Boolean).join(" ");
    }

    const statGroups = PresentationCache.get(this.actor, "stats", () => prepareActorStats(this.actor));
    const skillGroups = PresentationCache.get(this.actor, "skills", () => prepareNamedGroups(prepared.skills, "skills"));
    const macroSlots = showMacroTab ? this._prepareMacroSlots() : [];
    const quickAccess = this._prepareQuickAccessSlots({
      prepared,
      statGroups
    });

    return {
      ...context,
      actor: {
        id: this.actor.id,
        uuid: this.actor.uuid,
        name: this.actor.name,
        img: this.actor.img
      },
      resources,
      singleResource: resources.length === 1,
      quickAccessSlots: quickAccess.slots,
      quickAccessStageSize: quickAccess.stageSize,
      effects: this._prepareEffects(),
      combatActions: intentActions,
      weaponState: {
        ...weaponState,
        currentLabel: weaponState.name || game.i18n.localize("AOV_SKJALDBORG.Weapons.None"),
        canManage: canManageWeapons,
        canRoll: canManageWeapons && weaponState.carriedWeapons.length > 0,
        selectedIsReadied: !!weaponState.id && weaponState.carriedWeapons.some(weapon => weapon.selected && weapon.id === weaponState.id),
        toggleDisabled: !canManageWeapons || !weaponState.canDraw,
        dropDisabled: !canManageWeapons || !weaponState.canSheathe
      },
      statGroups,
      skillGroups,
      magicGroups,
      equipmentGroups,
      historyFamily,
      wellbeing,
      macroSlots,
      showMacroTab,
      showEquipTab,
      showMagicTab,
      showWellbeingTab,
      showHistoryFamilyTab,
      workflow: this._prepareWorkflow(combat, combatState, combatantState),
      hasCombatActions: intentActions.length > 0,
      hasStatActions: statGroups.length > 0,
      hasSkillActions: skillGroups.length > 0,
      hasMagicActions: magicGroups.length > 0,
      hasEquipment: equipmentGroups.length > 0,
      hasHistoryFamily: historyFamily.hasDisplayContent,
      collapsed: !!game.settings.get(MODULE_ID, "actorHotbarCollapsed"),
      dock: this._hotbarDock
    };
    } finally {
      performanceDiagnostics.markEnd(measureId, {
        actorId: this.actor?.id ?? null,
        combatantId: this.combatant?.id ?? null
      });
    }
  }

  /**
   * Resolve the Token document whose configured bars drive the resource pills.
   *
   * A controlled canvas Token is authoritative. Combat, synthetic, active, and
   * prototype Token documents provide deterministic fallbacks when the actor is
   * not currently controlled on the canvas.
   *
   * @returns {TokenDocument|null}
   */
  _resolveResourceTokenDocument() {
    const canvasToken = resolveActorToken(this.actor);
    return canvasToken?.document
      ?? this.combatant?.token?.document
      ?? this.combatant?.token
      ?? this.actor?.token
      ?? this.actor?.prototypeToken
      ?? null;
  }

  /**
   * Determine the Actor update path represented by a resolved Token bar.
   *
   * @param {string} attribute Normalized Actor path.
   * @param {object} barData TokenDocument#getBarAttribute result.
   * @returns {string}
   */
  _trackedResourceUpdatePath(attribute, barData) {
    if (!attribute) return "";
    if (attribute.endsWith(".value")) return attribute;
    const resolved = foundry.utils.getProperty(this.actor, attribute);
    if (barData?.type === "bar" || (resolved && typeof resolved === "object" && "value" in resolved)) {
      return `${attribute}.value`;
    }
    return attribute;
  }

  /**
   * Prepare resource cards from the selected Token's configured bar1/bar2 data.
   *
   * HP and MP keep AoV-specific derived-value and write behaviour. In
   * particular, MP is shown against its currently available maximum while the
   * locked and total values remain available as secondary information.
   *
   * @returns {Promise<object[]>}
   */
  async _prepareResources() {
    this._resourceBindings = new Map();
    const tokenDocument = this._resolveResourceTokenDocument();
    if (!tokenDocument || typeof tokenDocument.getBarAttribute !== "function") return [];

    const slots = [
      { barName: "bar1", fallbackAccent: "#e22b32" },
      { barName: "bar2", fallbackAccent: "#704cff" }
    ];
    const resourceFill = (value, maximum) => {
      if (!(maximum > 0)) return 0;
      return Math.min(100, Math.max(0, (value / maximum) * 100));
    };
    let magicPoints = null;
    const resources = [];

    for (const slot of slots) {
      const configuredAttribute = String(tokenDocument?.[slot.barName]?.attribute ?? "").trim();
      if (!configuredAttribute) continue;

      let barData = null;
      try {
        barData = tokenDocument.getBarAttribute(slot.barName);
      } catch (exception) {
        error(`Failed to resolve ${slot.barName} for the actor hotbar.`, exception);
      }
      if (!barData) continue;

      const attribute = normalizeTrackedResourcePath(barData.attribute ?? configuredAttribute);
      if (!attribute) continue;
      const kind = trackedResourceKind(attribute);
      const hasResolvedMaximum = barData.max !== null
        && barData.max !== undefined
        && barData.max !== ""
        && Number.isFinite(Number(barData.max));
      let value = finiteResourceNumber(barData.value, 0);
      let maximum = hasResolvedMaximum ? Math.max(0, finiteResourceNumber(barData.max, 0)) : null;
      let secondary = "";

      if (kind === "hp") {
        const hp = AoVAdapter.prepareActorHitPoints(this.actor);
        value = finiteResourceNumber(hp.value, value);
        maximum = Math.max(0, finiteResourceNumber(hp.maximum, maximum ?? 0));
      } else if (kind === "mp") {
        magicPoints ??= await AoVAdapter.prepareActorMagicPoints(this.actor);
        value = magicPoints.value;
        maximum = magicPoints.available;
        secondary = magicPoints.locked > 0
          ? game.i18n.format("AOV_SKJALDBORG.ActorHotbar.LockedMagic", {
            locked: magicPoints.locked,
            max: magicPoints.total
          })
          : "";
      }

      const hasMaximum = Number.isFinite(maximum);
      const editable = this.actor.isOwner && (kind === "hp" || kind === "mp" || barData.editable !== false);
      const updatePath = this._trackedResourceUpdatePath(attribute, barData);
      const accent = kind === "hp"
        ? "#e22b32"
        : kind === "mp"
          ? "#704cff"
          : slot.fallbackAccent;

      this._resourceBindings.set(slot.barName, {
        kind,
        attribute,
        updatePath,
        editable,
        maximum: hasMaximum ? maximum : null
      });

      resources.push({
        id: slot.barName,
        label: trackedResourceLabel(attribute, slot.barName),
        value,
        max: hasMaximum ? maximum : null,
        hasMaximum,
        fillPercent: resourceFill(value, maximum).toFixed(2),
        accent,
        secondary,
        editable,
        step: kind === "generic" ? "any" : "1"
      });
    }

    return resources;
  }

  /**
   * Prepare the configured quick-access circles around the actor portrait.
   *
   * Action resolution is shared with the token ring so both surfaces display
   * the same actor-backed selections. The geometry expands only for eleven or
   * twelve circles, keeping the six-through-ten layout at its established size.
   *
   * @param {object} options Prepared action sources.
   * @param {object} options.prepared Prepared actor item actions.
   * @param {object[]} options.statGroups Prepared statistic groups.
   * @returns {{slots: object[], stageSize: number}}
   */
  _prepareQuickAccessSlots({ prepared, statGroups }) {
    const quickAccess = prepareActorQuickAccess(this.actor, { prepared, statGroups });
    const metrics = quickAccessGeometry(quickAccess.count);
    const slots = quickAccess.slots.map(({ index, entry, action }) => {
      const angle = ((index / quickAccess.count) * Math.PI * 2) - (Math.PI / 2);
      const left = metrics.center + (Math.cos(angle) * metrics.radius) - (metrics.size / 2);
      const top = metrics.center + (Math.sin(angle) * metrics.radius) - (metrics.size / 2);
      const style = `left: ${left}px; top: ${top}px;`;

      if (!entry || !action) {
        return {
          index,
          style,
          empty: true,
          name: game.i18n.localize("AOV_SKJALDBORG.ActorHotbar.QuickAccess.Empty"),
          tooltip: game.i18n.localize("AOV_SKJALDBORG.ActorHotbar.QuickAccess.DropHint")
        };
      }

      return {
        ...action,
        index,
        style,
        empty: false,
        kind: entry.kind,
        tooltip: `${action.name} - ${game.i18n.localize("AOV_SKJALDBORG.ActorHotbar.QuickAccess.RemoveHint")}`
      };
    });
    return { slots, stageSize: metrics.stageSize };
  }

  /**
   * Prepare active effect icons without serializing ActiveEffect documents.
   *
   * @returns {object[]}
   */
  _prepareEffects() {
    return Array.from(this.actor.effects ?? [])
      .filter(effect => !effect.disabled && !effect.isSuppressed)
      .slice(0, 10)
      .map(effect => ({
        id: effect.id,
        name: effect.name,
        img: effect.img ?? effect.icon ?? "icons/svg/aura.svg"
      }));
  }

  /**
   * Prepare the current user's ten macro slots.
   *
   * @returns {object[]}
   */
  _prepareMacroSlots() {
    const hotbar = game.user?.hotbar ?? {};
    return Array.from({ length: 10 }, (_, index) => {
      const slot = index + 1;
      const macroId = hotbar[slot] ?? hotbar[String(slot)] ?? null;
      const macro = macroId ? game.macros?.get(macroId) : null;
      return {
        slot,
        key: slot === 10 ? "0" : String(slot),
        macroId: macro?.id ?? "",
        name: macro?.name ?? game.i18n.format("AOV_SKJALDBORG.ActorHotbar.EmptyMacro", { slot }),
        img: macro?.img ?? "",
        empty: !macro
      };
    });
  }

  /**
   * Prepare phase, declaration, DEX, and reaction indicators.
   *
   * @param {Combat|null} combat Combat document.
   * @param {object|null} combatState Module combat state.
   * @param {object|null} combatantState Module combatant state.
   * @returns {object}
   */
  _prepareWorkflow(combat, combatState, combatantState) {
    const active = !!combatState?.enabled && !!this.combatant;
    const finalDex = combatantState?.ledger?.finalDex
      ?? combatantState?.dexLedger?.finalDex
      ?? AoVAdapter.getDex(this.actor);
    const category = combatantState?.intent?.actionCategory ?? "attack";
    const status = combatantState?.intent?.status ?? "uncommitted";
    const currentCombatantId = combat?.combatant?.id ?? combat?.current?.combatantId ?? null;
    const myTurn = active && currentCombatantId === this.combatant?.id;
    const dispositionPalette = resolveDispositionPalette(this.actor, this.combatant);
    return {
      active,
      myTurn,
      dispositionKey: dispositionPalette.key,
      dispositionColor: dispositionPalette.color,
      dispositionLabelColor: dispositionPalette.labelColor,
      dispositionLabelWeight: dispositionPalette.labelWeight,
      dispositionGlowSoft: dispositionPalette.glowSoft,
      dispositionGlowStrong: dispositionPalette.glowStrong,
      phase: active ? game.i18n.localize(`AOV_SKJALDBORG.Phases.${combatState.phase}`) : "",
      category: active ? game.i18n.localize(`AOV_SKJALDBORG.ActionCategories.${category}`) : "",
      status,
      statusLabel: active ? game.i18n.localize(`AOV_SKJALDBORG.IntentStatus.${status}`) : "",
      dex: Number(finalDex ?? 0),
      reactions: Number(combatantState?.reactionCount ?? 0)
    };
  }

  /** @inheritdoc */
  async _preRender(context, options) {
    this._captureScrollPositions();
    await super._preRender(context, options);
  }

  /** @inheritdoc */
  async _onRender(context, options) {
    await super._onRender(context, options);
    this._syncCoreHotbarVisibility();
    this._applyClientDimensions();
    this._applyThemeClass();
    this._applyOverlayPositioning();
    this._restoreOrInitializePosition();
    this._activateDockDragging();
    this._activatePositionDragging();
    this._activateResourceEditing();
    this._activateWellbeingEditing();
    this._activateEquipmentEditing();
    this._activateWeaponControls();
    this._activateContextMenus();
    this._activateCombatInteractions();
    this._activateActionDragging();
    this._activateXpToggleDragGuards();
    this._activateQuickAccessSlots();
    this._restoreScrollPositions();
  }

  /** @inheritdoc */
  _onClose(options) {
    this._cancelDockDrag();
    this._cancelPositionDrag();
    document.querySelector("#hotbar")?.classList.remove("skj-core-hotbar-hidden");
    if (ActorHotbar.current === this) ActorHotbar.current = null;
    return super._onClose(options);
  }

  /**
   * Capture every tab body's scroll position before AppV2 replaces the HTML.
   *
   * @returns {void}
   */
  _captureScrollPositions() {
    let root = null;
    try {
      root = this.element;
    } catch (_exception) {
      return;
    }
    if (!(root instanceof HTMLElement)) return;
    const actorKey = this._renderedActorKey ?? this._actorScrollKey();
    if (!actorKey) return;
    for (const element of root.querySelectorAll("[data-scroll-state]")) {
      const id = element.dataset.scrollState;
      if (!id) continue;
      this._scrollPositions.set(`${actorKey}:${id}`, {
        top: element.scrollTop,
        left: element.scrollLeft
      });
    }
  }

  /**
   * Restore and continuously track scroll positions for the rendered actor.
   *
   * @returns {void}
   */
  _restoreScrollPositions() {
    const actorKey = this._actorScrollKey();
    if (!actorKey) return;
    this._renderedActorKey = actorKey;

    let root = null;
    try {
      root = this.element;
    } catch (_exception) {
      return;
    }
    if (!(root instanceof HTMLElement)) return;

    const tracked = [];
    for (const element of root.querySelectorAll("[data-scroll-state]")) {
      const id = element.dataset.scrollState;
      if (!id) continue;
      const key = `${actorKey}:${id}`;
      const restore = () => {
        const saved = this._scrollPositions.get(key);
        if (!saved) return;
        element.scrollTop = saved.top;
        element.scrollLeft = saved.left;
      };

      restore();
      element.addEventListener("scroll", () => {
        this._scrollPositions.set(key, {
          top: element.scrollTop,
          left: element.scrollLeft
        });
      }, { passive: true });
      tracked.push(restore);
    }

    requestAnimationFrame(() => {
      if (!root.isConnected) return;
      for (const restore of tracked) restore();
    });
  }

  /**
   * Resolve a stable in-memory key for actor-specific view state.
   *
   * @param {Actor|null|undefined} [actor=this.actor] Actor document.
   * @returns {string|null}
   */
  _actorScrollKey(actor = this.actor) {
    const key = actor?.uuid ?? actor?.id;
    return key ? String(key) : null;
  }

  /**
   * Apply client scale and maximum action-list width as CSS variables.
   *
   * @returns {void}
   */
  _applyClientDimensions() {
    const scale = Number(game.settings.get(MODULE_ID, "actorHotbarScale")) || 1;
    const maxWidth = Number(game.settings.get(MODULE_ID, "actorHotbarActionWidth")) || 420;
    const opacityPercent = Math.min(100, Math.max(0, Number(game.settings.get(MODULE_ID, "actorHotbarOpacity")) || 0));
    this.element.style.setProperty("--skj-hotbar-scale", String(scale));
    this.element.style.setProperty("--skj-hotbar-action-width", `${maxWidth}px`);
    this.element.style.setProperty("--skj-hotbar-rest-opacity", String(opacityPercent / 100));
  }

  /**
   * Apply the selected action-interface visual theme to this AppV2 root.
   *
   * @returns {void}
   */
  _applyThemeClass() {
    const theme = game.settings.get(MODULE_ID, "actionUiTheme");
    this.element.classList.toggle("skj-theme-aov", theme === "aov");
    this.element.classList.toggle("skj-theme-classic", theme !== "aov");
  }

  /**
   * Force a viewport overlay positioning context independent of Foundry UI flow.
   *
   * @returns {void}
   */
  _applyOverlayPositioning() {
    this.element.style.setProperty("position", "fixed", "important");
    this.element.style.setProperty("margin", "0", "important");
  }

  /**
   * Read the current client-side scale setting.
   *
   * @returns {number}
   */
  _hotbarScale() {
    const scale = Number(game.settings.get(MODULE_ID, "actorHotbarScale")) || 1;
    return Math.max(0.1, scale);
  }

  /**
   * Measure the hotbar components in transformed viewport pixels.
   *
   * Measurements are kept independent from the current dock direction so the
   * actor-art anchor can be translated reliably between all four layouts.
   *
   * @returns {{scale: number, collapsed: boolean, coreWidth: number, coreHeight: number, actionWidth: number, actionHeight: number, railThickness: number, railLength: number, gap: number}}
   */
  _layoutMetrics() {
    const scale = this._hotbarScale();
    const layout = this.element?.querySelector(".skj-hotbar-layout");
    const core = this.element?.querySelector(".skj-actor-core");
    const actions = this.element?.querySelector(".skj-actor-actions");
    const collapsed = this.element?.querySelector(".skj-hotbar-inner")?.classList.contains("skj-hotbar-collapsed")
      || !!game.settings.get(MODULE_ID, "actorHotbarCollapsed");
    const computed = layout ? getComputedStyle(layout) : null;
    const gap = Math.max(0, Number.parseFloat(computed?.gap ?? computed?.columnGap ?? "2") || 2) * scale;
    const stageSize = Number.parseFloat(computed?.getPropertyValue("--skj-quick-stage-size") ?? "192") || 192;
    const configuredActionWidth = Number.parseFloat(
      this.element?.style.getPropertyValue("--skj-hotbar-effective-action-width")
      || this.element?.style.getPropertyValue("--skj-hotbar-action-width")
      || ""
    ) || Number(game.settings.get(MODULE_ID, "actorHotbarActionWidth")) || 420;
    const coreRect = core?.getBoundingClientRect?.();
    const actionRect = actions?.getBoundingClientRect?.();
    return {
      scale,
      collapsed,
      coreWidth: coreRect?.width || stageSize * scale,
      coreHeight: coreRect?.height || (stageSize + 64) * scale,
      actionWidth: actionRect?.width || configuredActionWidth * scale,
      actionHeight: actionRect?.height || (stageSize + 42) * scale,
      railThickness: 10 * scale,
      railLength: 42 * scale,
      gap
    };
  }

  /**
   * Hide the core macro hotbar without collapsing its layout anchor.
   *
   * @returns {void}
   */
  _syncCoreHotbarVisibility() {
    const coreHotbar = ui.hotbar?.element ?? document.querySelector("#hotbar");
    const replace = !!this.actor && game.settings.get(MODULE_ID, "replaceCoreHotbar");
    coreHotbar?.classList.toggle("skj-core-hotbar-hidden", replace);
  }

  /**
   * Restore the saved client position and dock, or establish the default anchor.
   *
   * @returns {void}
   */
  _restoreOrInitializePosition() {
    if (!this.element || !this.actor) return;
    const saved = game.settings.get(MODULE_ID, "actorHotbarPosition") ?? {};
    const savedDock = EXPLICIT_HOTBAR_DOCKS.has(saved.dock) ? saved.dock : HOTBAR_DOCKS.AUTO;
    this._dockPreference = savedDock;

    if (Number.isFinite(Number(saved.left)) && Number.isFinite(Number(saved.top))) {
      this._setPositionFromAnchor({
        left: Number(saved.left),
        top: Number(saved.top)
      }, { dockPreference: savedDock });
      this._positionInitialized = true;
      return;
    }

    if (!this._positionInitialized) {
      this._positionAboveCoreHotbar();
      this._positionInitialized = true;
      return;
    }
    this._clampCurrentPosition();
  }

  /**
   * Position the custom surface directly above the core hotbar anchor.
   *
   * @returns {{left: number, top: number}|null}
   */
  _positionAboveCoreHotbar() {
    if (!this.element || !this.actor) return null;
    const coreHotbar = ui.hotbar?.element ?? document.querySelector("#hotbar");
    const core = this.element.querySelector(".skj-actor-core");
    const coreRect = core?.getBoundingClientRect?.() ?? this.element.getBoundingClientRect();
    const anchorRect = coreHotbar?.getBoundingClientRect?.();
    const desiredLeft = anchorRect?.width ? anchorRect.left : 16;
    const desiredTop = anchorRect?.width
      ? anchorRect.top - coreRect.height - 10
      : window.innerHeight - coreRect.height - 16;
    return this._setPositionFromAnchor(
      { left: desiredLeft, top: desiredTop },
      { dockPreference: HOTBAR_DOCKS.AUTO }
    );
  }

  /**
   * Restrict the action-panel width to the space available for the chosen dock.
   *
   * Vertical layouts can use the viewport width, while horizontal layouts
   * reserve room for the actor art and the collapse rail.
   *
   * @param {"left"|"right"|"top"|"bottom"} dock Resolved dock.
   * @returns {void}
   */
  _applyResponsiveActionWidth(dock) {
    const scale = this._hotbarScale();
    const configured = Number(game.settings.get(MODULE_ID, "actorHotbarActionWidth")) || 420;
    const core = this.element?.querySelector(".skj-actor-core");
    const coreWidth = core?.getBoundingClientRect?.().width || 192 * scale;
    const gap = 2 * scale;
    const rail = 10 * scale;
    const viewportWidth = Math.max(0, window.innerWidth - (HOTBAR_VIEWPORT_MARGIN * 2));
    const availablePixels = dock === HOTBAR_DOCKS.TOP || dock === HOTBAR_DOCKS.BOTTOM
      ? viewportWidth
      : viewportWidth - coreWidth - rail - (gap * 2);
    const responsive = Math.min(configured, Math.max(1, availablePixels / scale));
    this.element.style.setProperty("--skj-hotbar-effective-action-width", `${responsive}px`);
  }

  /**
   * Choose a responsive automatic dock around the actor art.
   *
   * Horizontal placement remains preferred on normal desktop canvases. When
   * neither side can accommodate a usable action panel, the larger vertical
   * side is selected instead.
   *
   * @param {{left: number, top: number}} anchor Actor-core anchor.
   * @returns {"left"|"right"|"top"|"bottom"}
   */
  _preferredDock(anchor) {
    const metrics = this._layoutMetrics();
    const margin = HOTBAR_VIEWPORT_MARGIN;
    const minimumPanel = (Math.min(
      Number(game.settings.get(MODULE_ID, "actorHotbarActionWidth")) || 420,
      HOTBAR_MIN_RESPONSIVE_ACTION_WIDTH
    ) * metrics.scale) + metrics.railThickness + (metrics.gap * 2);
    const rightSpace = window.innerWidth - margin - (anchor.left + metrics.coreWidth);
    const leftSpace = anchor.left - margin;
    if (rightSpace >= minimumPanel) return HOTBAR_DOCKS.RIGHT;
    if (leftSpace >= minimumPanel) return HOTBAR_DOCKS.LEFT;

    const verticalPanel = metrics.actionHeight + metrics.railThickness + (metrics.gap * 2);
    const bottomSpace = window.innerHeight - margin - (anchor.top + metrics.coreHeight);
    const topSpace = anchor.top - margin;
    if (bottomSpace >= verticalPanel || topSpace >= verticalPanel) {
      return bottomSpace >= topSpace ? HOTBAR_DOCKS.BOTTOM : HOTBAR_DOCKS.TOP;
    }

    const horizontalBest = Math.max(leftSpace, rightSpace) / Math.max(1, minimumPanel);
    const verticalBest = Math.max(topSpace, bottomSpace) / Math.max(1, verticalPanel);
    if (verticalBest > horizontalBest) {
      return bottomSpace >= topSpace ? HOTBAR_DOCKS.BOTTOM : HOTBAR_DOCKS.TOP;
    }
    return rightSpace >= leftSpace ? HOTBAR_DOCKS.RIGHT : HOTBAR_DOCKS.LEFT;
  }

  /**
   * Apply orientation classes used by CSS to arrange the three hotbar regions.
   *
   * @param {"left"|"right"|"top"|"bottom"} dock Resolved dock.
   * @returns {void}
   */
  _applyDockClass(dock) {
    this._hotbarDock = dock;
    for (const value of EXPLICIT_HOTBAR_DOCKS) {
      this.element.classList.toggle(`skj-hotbar-dock-${value}`, dock === value);
    }
    // Retain the former side classes for selectors and third-party styling
    // which predate four-way docking.
    this.element.classList.toggle("skj-hotbar-side-left", dock === HOTBAR_DOCKS.LEFT);
    this.element.classList.toggle("skj-hotbar-side-right", dock === HOTBAR_DOCKS.RIGHT);
    this.element.dataset.hotbarDock = dock;
  }

  /**
   * Calculate the full visible footprint relative to the actor-core anchor.
   *
   * @param {"left"|"right"|"top"|"bottom"} dock Resolved dock.
   * @param {boolean} fitExpanded Include the action panel even when collapsed.
   * @returns {{minX: number, maxX: number, minY: number, maxY: number}}
   */
  _layoutOffsets(dock, fitExpanded) {
    const metrics = this._layoutMetrics();
    const showActions = fitExpanded || !metrics.collapsed;

    if (dock === HOTBAR_DOCKS.LEFT || dock === HOTBAR_DOCKS.RIGHT) {
      const sideSpan = metrics.gap + metrics.railThickness
        + (showActions ? metrics.gap + metrics.actionWidth : 0);
      const height = Math.max(
        metrics.coreHeight,
        metrics.railLength,
        showActions ? metrics.actionHeight : 0
      );
      return dock === HOTBAR_DOCKS.LEFT
        ? { minX: -sideSpan, maxX: metrics.coreWidth, minY: 0, maxY: height }
        : { minX: 0, maxX: metrics.coreWidth + sideSpan, minY: 0, maxY: height };
    }

    const width = Math.max(
      metrics.coreWidth,
      metrics.railLength,
      showActions ? metrics.actionWidth : 0
    );
    const horizontalOverflow = Math.max(0, width - metrics.coreWidth) / 2;
    const verticalSpan = metrics.gap + metrics.railThickness
      + (showActions ? metrics.gap + metrics.actionHeight : 0);
    return dock === HOTBAR_DOCKS.TOP
      ? {
        minX: -horizontalOverflow,
        maxX: metrics.coreWidth + horizontalOverflow,
        minY: -verticalSpan,
        maxY: metrics.coreHeight
      }
      : {
        minX: -horizontalOverflow,
        maxX: metrics.coreWidth + horizontalOverflow,
        minY: 0,
        maxY: metrics.coreHeight + verticalSpan
      };
  }

  /**
   * Clamp a proposed actor-core anchor inside the viewport.
   *
   * @param {number} left Proposed left coordinate.
   * @param {number} top Proposed top coordinate.
   * @param {"left"|"right"|"top"|"bottom"} dock Resolved dock.
   * @param {{fitExpanded?: boolean}} [options={}] Clamp against expanded or visible footprint.
   * @returns {{left: number, top: number}}
   */
  _clampAnchor(left, top, dock, options = {}) {
    const fitExpanded = options.fitExpanded ?? !this._layoutMetrics().collapsed;
    const offsets = this._layoutOffsets(dock, fitExpanded);
    const margin = HOTBAR_VIEWPORT_MARGIN;
    const minLeft = margin - offsets.minX;
    const maxLeft = Math.max(minLeft, window.innerWidth - margin - offsets.maxX);
    const minTop = margin - offsets.minY;
    const maxTop = Math.max(minTop, window.innerHeight - margin - offsets.maxY);
    return {
      left: Math.round(Math.max(minLeft, Math.min(Number(left) || 0, maxLeft))),
      top: Math.round(Math.max(minTop, Math.min(Number(top) || 0, maxTop)))
    };
  }

  /**
   * Place the AppV2 root from the actor-core anchor and chosen dock.
   *
   * Foundry v14's public ApplicationV2#setPosition API remains the sole writer
   * of the application root coordinates.
   *
   * @param {{left: number, top: number}} anchor Actor-core anchor.
   * @param {{dockPreference?: string, fitExpanded?: boolean}} [options={}] Placement options.
   * @returns {{left: number, top: number}} Persistable actor-core anchor.
   */
  _setPositionFromAnchor(anchor, options = {}) {
    const preference = options.dockPreference ?? this._dockPreference ?? HOTBAR_DOCKS.AUTO;
    const dock = EXPLICIT_HOTBAR_DOCKS.has(preference) ? preference : this._preferredDock(anchor);
    this._applyDockClass(dock);
    this._applyResponsiveActionWidth(dock);

    const metrics = this._layoutMetrics();
    const fitExpanded = options.fitExpanded ?? !metrics.collapsed;
    const clamped = this._clampAnchor(anchor.left, anchor.top, dock, { fitExpanded });
    const offsets = this._layoutOffsets(dock, fitExpanded);
    super.setPosition({
      left: Math.round(clamped.left + offsets.minX),
      top: Math.round(clamped.top + offsets.minY)
    });
    return clamped;
  }

  /**
   * Read the current actor-core anchor from the rendered layout.
   *
   * @returns {{left: number, top: number}}
   */
  _currentAnchorPosition() {
    const core = this.element?.querySelector(".skj-actor-core");
    const rect = core?.getBoundingClientRect?.() ?? this.element?.getBoundingClientRect?.() ?? { left: 8, top: 8 };
    return {
      left: rect.left,
      top: rect.top
    };
  }

  /**
   * Keep the current hotbar position and dimensions inside a resized viewport.
   *
   * @returns {void}
   */
  _clampCurrentPosition() {
    if (!this.element?.isConnected) return;
    this._setPositionFromAnchor(this._currentAnchorPosition(), {
      dockPreference: this._dockPreference
    });
  }

  /**
   * Bind primary-pointer dragging of the collapse rail to four-way docking.
   *
   * A normal click still toggles collapsed state. Once the pointer crosses the
   * drag threshold, the next synthetic click is consumed and the selected dock
   * is persisted with the actor-core anchor.
   *
   * @returns {void}
   */
  _activateDockDragging() {
    const handle = this.element.querySelector(".skj-hotbar-collapse-toggle");
    if (!handle) return;
    handle.addEventListener("pointerdown", event => this._beginDockDrag(event));
    handle.addEventListener("click", event => {
      if (!this._suppressCollapseClick) return;
      this._suppressCollapseClick = false;
      event.preventDefault();
      event.stopImmediatePropagation();
    }, { capture: true });
  }

  /**
   * Begin dragging the collapse rail around the actor-art anchor.
   *
   * @param {PointerEvent} event Pointer-down event.
   * @returns {void}
   */
  _beginDockDrag(event) {
    if (event.button !== 0) return;
    this._cancelDockDrag();
    const startX = event.clientX;
    const startY = event.clientY;
    let dragged = false;
    const abort = new AbortController();
    this._dockDragAbort = abort;

    const move = moveEvent => {
      const distance = Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY);
      if (!dragged && distance < HOTBAR_DOCK_DRAG_THRESHOLD) return;
      if (!dragged) {
        dragged = true;
        this.element.classList.add("skj-dock-dragging");
      }
      moveEvent.preventDefault();
      moveEvent.stopPropagation();
      const dock = this._dockFromPointer(moveEvent.clientX, moveEvent.clientY);
      if (dock === this._dockPreference && dock === this._hotbarDock) return;
      const anchor = this._currentAnchorPosition();
      this._dockPreference = dock;
      this._setPositionFromAnchor(anchor, { dockPreference: dock });
    };

    const finish = async upEvent => {
      if (dragged) {
        upEvent?.preventDefault?.();
        upEvent?.stopPropagation?.();
        this._suppressCollapseClick = true;
        window.setTimeout(() => {
          this._suppressCollapseClick = false;
        }, 250);
        const position = this._setPositionFromAnchor(this._currentAnchorPosition(), {
          dockPreference: this._dockPreference
        });
        this._cancelDockDrag();
        await game.settings.set(MODULE_ID, "actorHotbarPosition", {
          ...position,
          dock: this._dockPreference
        });
        return;
      }
      this._cancelDockDrag();
    };

    window.addEventListener("pointermove", move, { signal: abort.signal });
    window.addEventListener("pointerup", finish, { once: true, signal: abort.signal });
    window.addEventListener("pointercancel", finish, { once: true, signal: abort.signal });
  }

  /**
   * Resolve the nearest cardinal dock from a pointer around the actor art.
   *
   * @param {number} clientX Pointer viewport X.
   * @param {number} clientY Pointer viewport Y.
   * @returns {"left"|"right"|"top"|"bottom"}
   */
  _dockFromPointer(clientX, clientY) {
    const core = this.element?.querySelector(".skj-actor-core");
    const rect = core?.getBoundingClientRect?.() ?? {
      left: 0,
      top: 0,
      width: 1,
      height: 1
    };
    const dx = clientX - (rect.left + (rect.width / 2));
    const dy = clientY - (rect.top + (rect.height / 2));
    if (Math.abs(dx) >= Math.abs(dy)) {
      return dx < 0 ? HOTBAR_DOCKS.LEFT : HOTBAR_DOCKS.RIGHT;
    }
    return dy < 0 ? HOTBAR_DOCKS.TOP : HOTBAR_DOCKS.BOTTOM;
  }

  /**
   * Cancel collapse-rail pointer listeners and visual drag state.
   *
   * @returns {void}
   */
  _cancelDockDrag() {
    this._dockDragAbort?.abort();
    this._dockDragAbort = null;
    this.element?.classList.remove("skj-dock-dragging");
  }

  /**
   * Bind pointer-based hotbar repositioning to right-drag on the portrait.
   *
   * @returns {void}
   */
  _activatePositionDragging() {
    const handle = this.element.querySelector(".skj-avatar-button");
    if (!handle) return;
    handle.addEventListener("pointerdown", event => this._beginPositionDrag(event));
    handle.addEventListener("contextmenu", event => {
      event.preventDefault();
      event.stopPropagation();
    });
  }

  /**
   * Start one pointer drag operation.
   *
   * @param {PointerEvent} event Pointer-down event.
   * @returns {void}
   */
  _beginPositionDrag(event) {
    if (event.button !== 2) return;
    event.preventDefault();
    event.stopPropagation();
    this._cancelPositionDrag();

    const anchor = this._currentAnchorPosition();
    const start = {
      pointerX: event.clientX,
      pointerY: event.clientY,
      left: anchor.left,
      top: anchor.top
    };
    const abort = new AbortController();
    this._positionDragAbort = abort;
    this.element.classList.add("skj-position-dragging");

    const move = moveEvent => {
      moveEvent.preventDefault();
      this._setPositionFromAnchor({
        left: start.left + (moveEvent.clientX - start.pointerX),
        top: start.top + (moveEvent.clientY - start.pointerY)
      }, { dockPreference: this._dockPreference });
    };

    const finish = async upEvent => {
      upEvent?.preventDefault?.();
      const position = this._setPositionFromAnchor(this._currentAnchorPosition(), {
        dockPreference: this._dockPreference
      });
      this._cancelPositionDrag();
      await game.settings.set(MODULE_ID, "actorHotbarPosition", {
        ...position,
        dock: this._dockPreference
      });
    };

    window.addEventListener("pointermove", move, { signal: abort.signal });
    window.addEventListener("pointerup", finish, { once: true, signal: abort.signal });
    window.addEventListener("pointercancel", finish, { once: true, signal: abort.signal });
  }

  /**
   * Cancel active pointer listeners and visual drag state.
   *
   * @returns {void}
   */
  _cancelPositionDrag() {
    this._positionDragAbort?.abort();
    this._positionDragAbort = null;
    this.element?.classList.remove("skj-position-dragging");
  }

  /**
   * Bind deterministic resource input commits.
   *
   * @returns {void}
   */
  _activateResourceEditing() {
    for (const input of this.element.querySelectorAll("[data-resource-input]")) {
      input.addEventListener("keydown", event => {
        if (event.key === "Enter") {
          event.preventDefault();
          input.blur();
        } else if (event.key === "Escape") {
          event.preventDefault();
          input.value = input.dataset.originalValue ?? input.defaultValue;
          input.blur();
        }
      });
      input.addEventListener("change", event => void this._commitResourceInput(event));
    }
  }

  /**
   * Persist one configured Token resource edit.
   *
   * HP and MP continue through the AoV adapter because both values can be
   * derived from wound or prepared-magic state. Other tracked attributes are
   * written directly to their resolved Actor data path.
   *
   * @param {Event} event Input change event.
   * @returns {Promise<void>}
   */
  async _commitResourceInput(event) {
    const input = event.currentTarget;
    const resourceId = String(input.dataset.resourceInput ?? "");
    const binding = this._resourceBindings.get(resourceId);
    if (!this.actor || this._resourceUpdatePending || !binding?.editable) return;

    const original = input.dataset.originalValue ?? input.defaultValue;
    this._resourceUpdatePending = true;
    input.disabled = true;
    try {
      if (binding.kind === "hp" || binding.kind === "mp") {
        await AoVAdapter.updateActorResource(this.actor, binding.kind, input.value);
      } else {
        const requested = Number(input.value);
        if (!Number.isFinite(requested) || !binding.updatePath) throw new Error("Invalid tracked resource value or path.");
        const hasMaximum = binding.maximum !== null && Number.isFinite(Number(binding.maximum));
        const maximum = hasMaximum ? Number(binding.maximum) : null;
        const target = hasMaximum
          ? Math.min(Math.max(0, requested), maximum)
          : requested;
        await this.actor.update({ [binding.updatePath]: target });
      }
    } catch (exception) {
      input.value = original;
      error(`Failed to update ${resourceId} from the actor hotbar.`, exception);
      ui.notifications.error(game.i18n.localize("AOV_SKJALDBORG.Warnings.ResourceUpdateFailed"));
    } finally {
      this._resourceUpdatePending = false;
      if (input.isConnected) input.disabled = !binding.editable;
    }
  }

  /**
   * Bind deterministic damage commits for character Wounds and NPC Hit Locations.
   *
   * @returns {void}
   */
  _activateWellbeingEditing() {
    for (const input of this.element.querySelectorAll("[data-wellbeing-damage]")) {
      input.addEventListener("keydown", event => {
        if (event.key === "Enter") {
          event.preventDefault();
          input.blur();
        } else if (event.key === "Escape") {
          event.preventDefault();
          input.value = input.dataset.originalValue ?? input.defaultValue;
          input.blur();
        }
      });
      input.addEventListener("change", event => void this._commitWellbeingDamage(event));
    }
  }

  /**
   * Persist one wellbeing damage edit through the AoV adapter.
   *
   * @param {Event} event Input change event.
   * @returns {Promise<void>}
   */
  async _commitWellbeingDamage(event) {
    const input = event.currentTarget;
    const itemId = String(input.dataset.wellbeingDamage ?? "");
    if (!this.actor || !itemId || this._wellbeingUpdatesPending.has(itemId)) return;

    const original = input.dataset.originalValue ?? input.defaultValue;
    this._wellbeingUpdatesPending.add(itemId);
    input.disabled = true;
    try {
      await AoVAdapter.updateActorWellbeingDamage(this.actor, itemId, input.value);
    } catch (exception) {
      input.value = original;
      error(`Failed to update wellbeing damage for Item ${itemId}.`, exception);
      ui.notifications.error(game.i18n.localize("AOV_SKJALDBORG.Warnings.WellbeingUpdateFailed"));
    } finally {
      this._wellbeingUpdatesPending.delete(itemId);
      if (input.isConnected) input.disabled = false;
    }
  }


  /**
   * Bind quantity commits for gear rows in the Equip tab.
   *
   * @returns {void}
   */
  _activateEquipmentEditing() {
    const bindCommitInput = (input, commit) => {
      input.addEventListener("keydown", event => {
        if (event.key === "Enter") {
          event.preventDefault();
          input.blur();
        } else if (event.key === "Escape") {
          event.preventDefault();
          input.value = input.dataset.originalValue ?? input.defaultValue;
          input.blur();
        }
      });
      input.addEventListener("change", event => void commit.call(this, event));
    };

    for (const input of this.element.querySelectorAll("[data-equipment-quantity]")) {
      bindCommitInput(input, this._commitEquipmentQuantity);
    }
    for (const input of this.element.querySelectorAll("[data-weapon-hp]")) {
      bindCommitInput(input, this._commitWeaponHitPoints);
    }
  }

  /**
   * Keep the readied-weapon toggle label aligned with the selected weapon.
   *
   * @returns {void}
   */
  _activateWeaponControls() {
    const select = this.element.querySelector("[data-readied-weapon-select]");
    const toggle = this.element.querySelector("[data-readied-weapon-toggle]");
    if (!select || !toggle) return;
    const update = () => this._syncWeaponToggle(toggle, select);
    select.addEventListener("change", update);
    update();
  }

  /**
   * Update the draw/sheathe toggle without persisting UI state.
   *
   * @param {HTMLElement} toggle Toggle button.
   * @param {HTMLSelectElement} select Weapon selector.
   * @returns {void}
   */
  _syncWeaponToggle(toggle, select) {
    const selectedWeaponId = String(select?.value ?? "");
    const currentWeaponId = String(getReadiedWeaponId(this.actor) ?? "");
    const isReadiedSelection = !!selectedWeaponId && selectedWeaponId === currentWeaponId;
    const labelKey = isReadiedSelection ? "AOV_SKJALDBORG.Weapons.Sheathe" : "AOV_SKJALDBORG.Weapons.Draw";
    const hintKey = isReadiedSelection ? "AOV_SKJALDBORG.Weapons.SheatheHint" : "AOV_SKJALDBORG.Weapons.DrawHint";
    const icon = toggle.querySelector("i");
    const label = toggle.querySelector("span");
    icon?.classList.toggle("fa-hand", isReadiedSelection);
    icon?.classList.toggle("fa-swords", !isReadiedSelection);
    if (label) label.textContent = game.i18n.localize(labelKey);
    toggle.dataset.tooltip = hintKey;
    toggle.classList.toggle("is-sheathe", isReadiedSelection);
    toggle.classList.toggle("is-draw", !isReadiedSelection);
  }

  /**
   * Persist one gear quantity through the actor embedded Item collection.
   *
   * @param {Event} event Input change event.
   * @returns {Promise<void>}
   */
  async _commitEquipmentQuantity(event) {
    const input = event.currentTarget;
    const itemId = input.dataset.equipmentQuantity;
    if (!this.actor || !itemId || this._equipmentUpdatePending) return;

    const original = input.dataset.originalValue ?? input.defaultValue;
    this._equipmentUpdatePending = true;
    input.disabled = true;
    try {
      const result = await updateActorEquipmentQuantity(this.actor, itemId, input.value);
      if (!result) input.value = original;
    } catch (exception) {
      input.value = original;
      error(`Failed to update equipment quantity from the actor hotbar.`, exception);
      ui.notifications.error(game.i18n.localize("AOV_SKJALDBORG.Warnings.ActionFailed"));
    } finally {
      this._equipmentUpdatePending = false;
      if (input.isConnected) input.disabled = false;
    }
  }

  /**
   * Persist current HP for one owned weapon Item.
   *
   * @param {Event} event Input change event.
   * @returns {Promise<void>}
   */
  async _commitWeaponHitPoints(event) {
    const input = event.currentTarget;
    const itemId = String(input.dataset.weaponHp ?? "");
    if (!this.actor || !itemId || this._weaponHpUpdatesPending.has(itemId)) return;

    const original = input.dataset.originalValue ?? input.defaultValue;
    this._weaponHpUpdatesPending.add(itemId);
    input.disabled = true;
    try {
      const result = await updateActorWeaponHitPoints(this.actor, itemId, input.value);
      if (!result) input.value = original;
    } catch (exception) {
      input.value = original;
      error(`Failed to update weapon hit points from the actor hotbar.`, exception);
      ui.notifications.error(game.i18n.localize("AOV_SKJALDBORG.Warnings.ActionFailed"));
    } finally {
      this._weaponHpUpdatesPending.delete(itemId);
      if (input.isConnected) input.disabled = false;
    }
  }

  /**
   * Bind right-click behavior for actor-owned Items.
   *
   * Magic and equipment cards publish their Description-tab content to chat.
   * Other item controls retain the existing right-click-to-open-sheet behavior.
   * Native form-field context menus are preserved for editable inputs.
   *
   * @returns {void}
   */
  _activateContextMenus() {
    for (const control of this.element.querySelectorAll("[data-post-item-description]")) {
      control.addEventListener("contextmenu", event => {
        if (event.target instanceof Element && event.target.closest("input, textarea, select")) return;
        event.preventDefault();
        event.stopPropagation();
        void this._postItemDescriptionToChat(control.dataset.postItemDescription);
      });
    }

    for (const control of this.element.querySelectorAll('[data-action-kind="item"]:not([data-quick-slot-index])')) {
      if (control.closest("[data-post-item-description]")) continue;
      control.addEventListener("contextmenu", event => {
        event.preventDefault();
        event.stopPropagation();
        void openActorItem(this.actor, control.dataset.actionId);
      });
    }
  }

  /**
   * Bind the asymmetric combat-control interactions used as scaffolding for
   * later action-resolution workflows.
   *
   * Combat-tab intent controls reserve primary click for future configuration
   * and integration hooks. Their existing declaration behavior is moved to
   * right click. The existing reaction pill remains the only visual control:
   * primary click adds one reaction and right click removes one.
   *
   * @returns {void}
   */
  _activateCombatInteractions() {
    for (const control of this.element.querySelectorAll("[data-intent-action-control]")) {
      control.addEventListener("contextmenu", event => {
        event.preventDefault();
        event.stopPropagation();
        void this._commitIntentAction(control.dataset.actionId);
      });
    }

    for (const control of this.element.querySelectorAll("[data-reaction-control]")) {
      control.addEventListener("contextmenu", event => {
        event.preventDefault();
        event.stopPropagation();
        void this._queueReactionChange("decrementReaction");
      });
    }
  }

  /**
   * Publish one actor-owned Item's Description-tab content to chat.
   *
   * The rich text is enriched relative to the Item so document links, embeds,
   * and inline rolls use the same data context as the core Item sheet.
   *
   * @param {string|undefined} itemId Owned Item id.
   * @returns {Promise<ChatMessage|null>}
   */
  async _postItemDescriptionToChat(itemId) {
    const item = this.actor?.items?.get(String(itemId ?? "")) ?? null;
    if (!item) {
      ui.notifications.warn(game.i18n.localize("AOV_SKJALDBORG.Warnings.ItemUnavailable"));
      return null;
    }

    const rawDescription = typeof item.system?.description === "string"
      ? item.system.description
      : (typeof item.system?.description?.value === "string" ? item.system.description.value : "");
    if (!rawDescription.trim()) {
      ui.notifications.warn(game.i18n.format("AOV_SKJALDBORG.Warnings.NoItemDescription", { item: item.name }));
      return null;
    }

    try {
      const TextEditor = foundry.applications.ux.TextEditor.implementation;
      const content = await TextEditor.enrichHTML(rawDescription, {
        documents: true,
        embeds: true,
        links: true,
        relativeTo: item,
        rollData: item.getRollData?.() ?? this.actor?.getRollData?.() ?? {},
        rolls: true,
        secrets: Boolean(item.isOwner)
      });
      const typeKey = `TYPES.Item.${item.type}`;
      const localizedType = game.i18n.localize(typeKey);
      const typeLabel = localizedType === typeKey ? item.type : localizedType;

      return await createModuleChatMessage({
        speaker: ChatMessage.getSpeaker({ actor: this.actor }),
        flavor: `[${typeLabel}] ${item.name}`,
        content
      });
    } catch (exception) {
      error(`Failed to publish Item ${itemId} to chat from the actor hotbar.`, exception);
      ui.notifications.error(game.i18n.localize("AOV_SKJALDBORG.Warnings.ActionFailed"));
      return null;
    }
  }

  /**
   * Temporarily disable a draggable row while a nested state toggle is pressed.
   *
   * Native dragstart targets the nearest draggable ancestor rather than
   * necessarily the nested button which initiated the pointer gesture. The
   * temporary attribute change therefore prevents XP and magic preparation
   * clicks from becoming row drags while preserving row reordering elsewhere.
   *
   * @returns {void}
   */
  _activateXpToggleDragGuards() {
    for (const toggle of this.element.querySelectorAll("[data-xp-toggle], [data-magic-prepared-toggle]")) {
      toggle.addEventListener("pointerdown", () => {
        const source = toggle.closest('[draggable="true"]');
        if (!(source instanceof HTMLElement)) return;

        source.draggable = false;
        const abort = new AbortController();
        const restore = () => {
          if (source.isConnected) source.draggable = true;
          abort.abort();
        };
        window.addEventListener("pointerup", restore, { once: true, signal: abort.signal });
        window.addEventListener("pointercancel", restore, { once: true, signal: abort.signal });
      });
    }
  }

  /**
   * Bind native drag/drop reordering for actor item groups.
   *
   * @returns {void}
   */
  _activateActionDragging() {
    const selector = "[data-quick-source][draggable=true], [data-drag-group][draggable=true], .skj-quick-slot[draggable=true]";
    for (const control of this.element.querySelectorAll(selector)) {
      control.addEventListener("dragstart", event => {
        if (event.target instanceof Element && event.target.closest("[data-xp-toggle], [data-magic-prepared-toggle]")) {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        const kind = control.dataset.quickKind ?? control.dataset.actionKind ?? "";
        const id = control.dataset.quickId ?? control.dataset.actionId ?? "";
        const sourceSlot = control.dataset.quickSlotIndex;
        this._dragData = control.dataset.dragGroup ? {
          id,
          group: control.dataset.dragGroup,
          section: control.dataset.actionSection ?? ""
        } : null;

        const payload = {
          type: QUICK_ACCESS_DRAG_TYPE,
          module: MODULE_ID,
          actorId: this.actor?.id ?? "",
          kind,
          id
        };
        if (sourceSlot !== undefined) payload.sourceSlot = Number(sourceSlot);

        event.dataTransfer.effectAllowed = sourceSlot !== undefined ? "move" : "copyMove";
        this._quickDragData = payload;
        this.element.classList.add("skj-quick-drag-active");
        const serialized = JSON.stringify(payload);
        event.dataTransfer.setData(QUICK_ACCESS_DRAG_MIME, serialized);
        event.dataTransfer.setData("text/plain", serialized);
        control.classList.add("dragging");
      });
      control.addEventListener("dragend", () => {
        this._dragData = null;
        this._quickDragData = null;
        this.element.classList.remove("skj-quick-drag-active");
        this.element.querySelectorAll(".dragging, .drop-target, .quick-drop-target, .quick-auto-preview").forEach(element => {
          element.classList.remove("dragging", "drop-target", "quick-drop-target", "quick-auto-preview");
        });
      });
      control.addEventListener("dragover", event => {
        const sameGroup = this._dragData?.group === control.dataset.dragGroup;
        const sameSection = (this._dragData?.section ?? "") === (control.dataset.actionSection ?? "");
        if (!sameGroup || !sameSection) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        control.classList.add("drop-target");
      });
      control.addEventListener("dragleave", () => control.classList.remove("drop-target"));
      control.addEventListener("drop", event => {
        event.preventDefault();
        control.classList.remove("drop-target");
        void this._dropAction(control);
      });
    }
  }

  /**
   * Bind portrait and slot drop targets plus right-click removal.
   *
   * Empty circles remain visually hidden. The central portrait is therefore a
   * large catch-all target which assigns a dragged action to the first empty
   * slot. Direct drops on visible or temporarily revealed slot circles retain
   * deterministic replacement and swap behavior.
   *
   * @returns {void}
   */
  _activateQuickAccessSlots() {
    for (const slot of this.element.querySelectorAll("[data-quick-slot-index]")) {
      slot.addEventListener("dragover", event => {
        const payload = this._readQuickAccessDragData(event);
        if (!payload) return;
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = Number.isInteger(payload.sourceSlot) ? "move" : "copy";
        slot.classList.add("quick-drop-target");
      });
      slot.addEventListener("dragleave", () => slot.classList.remove("quick-drop-target"));
      slot.addEventListener("drop", event => void this._dropQuickAccessAction(event, slot));
      slot.addEventListener("contextmenu", event => {
        event.preventDefault();
        event.stopImmediatePropagation();
        void this._removeQuickAccessAction(Number(slot.dataset.quickSlotIndex));
      });
    }

    const portraitTarget = this.element.querySelector("[data-quick-auto-target]");
    if (!portraitTarget) return;
    portraitTarget.addEventListener("dragover", event => {
      const payload = this._readQuickAccessDragData(event);
      if (!payload) return;
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = Number.isInteger(payload.sourceSlot) ? "move" : "copy";
      portraitTarget.classList.add("quick-drop-target");
      portraitTarget.parentElement?.classList.add("quick-drop-target");
      this.element.querySelectorAll(".skj-quick-slot.empty").forEach(slot => slot.classList.add("quick-auto-preview"));
    });
    portraitTarget.addEventListener("dragleave", event => {
      if (event.relatedTarget instanceof Node && portraitTarget.contains(event.relatedTarget)) return;
      portraitTarget.classList.remove("quick-drop-target");
      portraitTarget.parentElement?.classList.remove("quick-drop-target");
      this.element.querySelectorAll(".skj-quick-slot.quick-auto-preview").forEach(slot => slot.classList.remove("quick-auto-preview"));
    });
    portraitTarget.addEventListener("drop", event => void this._dropQuickAccessActionOnPortrait(event, portraitTarget));
  }

  /**
   * Parse a module-owned hotbar action drag payload.
   *
   * @param {DragEvent} event Drag event.
   * @returns {{kind: string, id: string, actorId: string, sourceSlot?: number}|null}
   */
  _readQuickAccessDragData(event) {
    let data = this._quickDragData;
    const transfer = event.dataTransfer;
    if (!data && transfer) {
      const serialized = transfer.getData(QUICK_ACCESS_DRAG_MIME) || transfer.getData("text/plain");
      if (serialized) {
        try {
          data = JSON.parse(serialized);
        } catch (_exception) {
          data = null;
        }
      }
    }
    if (data?.type !== QUICK_ACCESS_DRAG_TYPE || data?.module !== MODULE_ID) return null;
    if (data.actorId !== this.actor?.id) return null;
    if (!["item", "stat", "intent", "macro"].includes(data.kind) || !data.id) return null;
    return {
      kind: data.kind,
      id: String(data.id),
      actorId: String(data.actorId),
      ...(Number.isInteger(Number(data.sourceSlot)) ? { sourceSlot: Number(data.sourceSlot) } : {})
    };
  }

  /**
   * Assign or move an action into one portrait quick-access slot.
   *
   * @param {DragEvent} event Drop event.
   * @param {HTMLElement} slot Target slot.
   * @returns {Promise<void>}
   */
  async _dropQuickAccessAction(event, slot) {
    event.preventDefault();
    event.stopPropagation();
    slot.classList.remove("quick-drop-target");
    this.element.classList.remove("skj-quick-drag-active");
    const payload = this._readQuickAccessDragData(event);
    const targetIndex = Number(slot.dataset.quickSlotIndex);
    if (!payload || !Number.isInteger(targetIndex) || this._quickAccessUpdatePending || !this.actor) return;
    await this._assignQuickAccessPayload(payload, targetIndex);
  }

  /**
   * Assign an action dropped on the central portrait to the first empty slot.
   *
   * @param {DragEvent} event Drop event.
   * @param {HTMLElement} portraitTarget Portrait drop target.
   * @returns {Promise<void>}
   */
  async _dropQuickAccessActionOnPortrait(event, portraitTarget) {
    event.preventDefault();
    event.stopImmediatePropagation();
    portraitTarget.classList.remove("quick-drop-target");
    portraitTarget.parentElement?.classList.remove("quick-drop-target");
    this.element.classList.remove("skj-quick-drag-active");
    this.element.querySelectorAll(".skj-quick-slot.quick-auto-preview").forEach(slot => slot.classList.remove("quick-auto-preview"));

    const payload = this._readQuickAccessDragData(event);
    if (!payload || this._quickAccessUpdatePending || !this.actor) return;
    const current = this._getEditableQuickAccessEntries();
    const visibleCount = getQuickAccessCircleCount();
    const targetIndex = current.slice(0, visibleCount).findIndex(entry => !entry);
    if (targetIndex < 0) {
      ui.notifications.warn(game.i18n.localize("AOV_SKJALDBORG.ActorHotbar.QuickAccess.Full"));
      return;
    }
    await this._assignQuickAccessPayload(payload, targetIndex, current);
  }

  /**
   * Apply one quick-access payload to a target slot and persist the result.
   *
   * @param {{kind: string, id: string, sourceSlot?: number}} payload Drag payload.
   * @param {number} targetIndex Target slot index.
   * @param {({kind: string, id: string}|null)[]} [entries] Existing entries.
   * @returns {Promise<void>}
   */
  async _assignQuickAccessPayload(payload, targetIndex, entries = null) {
    const visibleCount = getQuickAccessCircleCount();
    if (!Number.isInteger(targetIndex) || targetIndex < 0 || targetIndex >= visibleCount) return;
    const current = entries ?? this._getEditableQuickAccessEntries();
    const entry = { kind: payload.kind, id: payload.id };
    if (Number.isInteger(payload.sourceSlot) && payload.sourceSlot !== targetIndex) {
      const displaced = current[targetIndex] ?? null;
      current[targetIndex] = entry;
      current[payload.sourceSlot] = displaced;
    } else {
      const duplicateIndex = current.findIndex((candidate, index) =>
        index !== targetIndex && candidate?.kind === entry.kind && candidate?.id === entry.id
      );
      if (duplicateIndex >= 0) current[duplicateIndex] = null;
      current[targetIndex] = entry;
    }
    this._quickDragData = null;
    await this._persistQuickAccessEntries(current);
  }

  /**
   * Remove one portrait quick-access assignment.
   *
   * @param {number} index Slot index.
   * @returns {Promise<void>}
   */
  async _removeQuickAccessAction(index) {
    const visibleCount = getQuickAccessCircleCount();
    if (!Number.isInteger(index) || index < 0 || index >= visibleCount || this._quickAccessUpdatePending || !this.actor) return;
    const current = this._getEditableQuickAccessEntries();
    if (!current[index]) return;
    current[index] = null;
    await this._persistQuickAccessEntries(current);
  }

  /**
   * Return a mutable full-capacity quick-access array.
   *
   * @returns {({kind: string, id: string}|null)[]}
   */
  _getEditableQuickAccessEntries() {
    const quickAccess = prepareActorQuickAccess(this.actor, { count: getQuickAccessCircleCount() });
    return Array.from({ length: ACTOR_HOTBAR_QUICK_SLOT_CAPACITY }, (_, index) => {
      const entry = quickAccess.entries[index];
      return entry ? { ...entry } : null;
    });
  }

  /**
   * Persist quick-access assignments and refresh the hotbar.
   *
   * @param {unknown[]} entries Slot entries.
   * @returns {Promise<void>}
   */
  async _persistQuickAccessEntries(entries) {
    this._quickAccessUpdatePending = true;
    try {
      await persistActorQuickAccess(this.actor, entries);
      ActorHotbar.scheduleRender({ parts: ["quickAccess"], reason: "quick-access-update" });
    } catch (exception) {
      error("Failed to update actor-hotbar quick access.", exception);
      ui.notifications.error(game.i18n.localize("AOV_SKJALDBORG.Warnings.ActionFailed"));
    } finally {
      this._quickAccessUpdatePending = false;
    }
  }

  /**
   * Persist one drag/drop reorder.
   *
   * @param {HTMLElement} target Drop target.
   * @returns {Promise<void>}
   */
  async _dropAction(target) {
    const source = this._dragData;
    const group = target.dataset.dragGroup;
    const section = target.dataset.actionSection ?? "";
    const targetId = target.dataset.actionId;
    if (!source || source.group !== group || source.section !== section || source.id === targetId || !this.actor) return;

    const controls = Array.from(this.element.querySelectorAll(`[data-drag-group="${group}"]`));
    const order = controls.map(control => control.dataset.actionId).filter(Boolean);
    const sourceIndex = order.indexOf(source.id);
    const targetIndex = order.indexOf(targetId);
    if (sourceIndex < 0 || targetIndex < 0) return;
    order.splice(sourceIndex, 1);
    order.splice(targetIndex, 0, source.id);
    await persistActionOrder(this.actor, group, order);
    this._dragData = null;
    ActorHotbar.scheduleRender({ parts: ["tabBody"], reason: "action-order-update" });
  }


  /**
   * Execute Draw Weapon or Sheathe Weapon from the compact actor hotbar.
   *
   * In combat, both the weapon-state change and the 5 DEX adjustment are sent
   * through the module's GM-authoritative socket. Outside combat the owned
   * Actor flag is updated directly without inventing an initiative document.
   *
   * @param {"draw"|"sheathe"} action Weapon action.
   * @param {string|null} weaponId Selected carried weapon id.
   * @returns {Promise<unknown|null>} Completed document operation.
   */
  async _performWeaponAction(action, weaponId = null) {
    if (!this.actor || this._weaponActionPending) return null;
    this._weaponActionPending = true;
    try {
      let result;
      if (this.combatant && game.combat) {
        result = await requestGm("adjustInitiative", {
          combatId: game.combat.id,
          combatantId: this.combatant.id,
          amount: 5,
          weaponAction: action,
          weaponId
        });
      } else if (action === "draw") {
        result = await setReadiedWeapon(this.actor, weaponId);
      } else {
        result = await clearReadiedWeapon(this.actor);
      }
      ActorHotbar.scheduleRender({ parts: ["workflow", "weaponControls"], reason: "weapon-action" });
      RenderCoordinator.invalidate("combatTracker", { reason: "weapon-action" });
      return result;
    } catch (exception) {
      error(`Failed to ${action} weapon from the actor hotbar.`, exception);
      ui.notifications.error(game.i18n.localize("AOV_SKJALDBORG.Warnings.ActionFailed"));
      return null;
    } finally {
      this._weaponActionPending = false;
    }
  }

  /**
   * Execute an item, intent, macro, or effect action.
   *
   * @param {PointerEvent} event Interaction event.
   * @param {HTMLElement} target Action target.
   * @returns {Promise<unknown|null>}
   */
  static async onActivate(event, target) {
    event.preventDefault();
    const kind = target.dataset.actionKind;
    const actionId = target.dataset.actionId;

    if (kind === "item") return executeActorItem(this.actor, actionId, event);
    if (kind === "stat") return executeActorStat(this.actor, actionId, event);
    if (kind === "macro") return executeMacro(actionId);
    if (kind === "effect") {
      const effect = this.actor?.effects?.get(actionId) ?? null;
      return effect?.sheet?.render?.(true) ?? null;
    }
    if (kind === "intent") {
      if (target.hasAttribute("data-intent-action-control")) {
        Hooks.callAll("aovSkjaldborgIntentAction", {
          app: this,
          actor: this.actor,
          combat: game.combat ?? null,
          combatant: this.combatant,
          actionCategory: actionId,
          interaction: "primary",
          event,
          target
        });
        if (actionId === ACTION_CATEGORIES.ATTACK) {
          return openAttackRollDialog({ actor: this.actor, originEvent: event });
        }
        return null;
      }
      return this._commitIntentAction(actionId);
    }
    return null;
  }

  /**
   * Commit one intent category using the declaration behavior formerly bound
   * to primary click in the Combat tab.
   *
   * @param {string|undefined} actionId Intent action category.
   * @returns {Promise<unknown|null>}
   */
  async _commitIntentAction(actionId) {
    const combat = game.combat ?? null;
    let publicText = "";
    if (actionId === ACTION_CATEGORIES.OTHER) {
      const activeText = isSkjaldborgCombatActive(combat) && this.combatant
        ? getCombatantState(this.combatant).intent?.publicText
        : getActorPreparedIntent(this.actor)?.publicText;
      const entered = await promptOtherIntentText(activeText ?? "");
      if (entered === null) return null;
      publicText = entered;
    }
    const result = await commitIntentCategory(
      this.actor,
      this.combatant,
      combat,
      actionId,
      { publicText }
    );
    ActorHotbar.scheduleRender({ parts: ["workflow"], reason: "intent-commit" });
    return result;
  }

  /**
   * Serialize one relative reaction-counter operation through the existing
   * GM-authoritative socket path.
   *
   * Relative increments deliberately do not submit an optimistic timestamp:
   * the authoritative write queue re-reads the latest reaction count for every
   * operation, so rapid clicks cannot overwrite one another with stale values.
   *
   * @param {"incrementReaction"|"decrementReaction"} action Socket action.
   * @returns {Promise<unknown|null>}
   */
  _queueReactionChange(action) {
    const actor = this.actor;
    const combat = game.combat ?? null;
    const combatant = resolveActorCombatant(actor, combat) ?? this.combatant;
    const execute = async () => {
      if (!isSkjaldborgCombatActive(combat) || !combatant) return null;

      const control = this.element?.querySelector?.("[data-reaction-control]");
      const previousHtml = control?.innerHTML ?? "";
      if (control instanceof HTMLElement) {
        const current = Number(getCombatantState(combatant).reactionCount ?? 0);
        const next = Math.max(0, current + (action === "incrementReaction" ? 1 : -1));
        control.classList.add("pending");
        control.setAttribute("aria-busy", "true");
        control.innerHTML = `<i class="fa-solid fa-shield" inert></i> ${next}`;
      }

      try {
        const result = await requestGm(action, {
          combatId: combat.id,
          combatantId: combatant.id
        });
        ActorHotbar.scheduleRender({ parts: ["workflow"], reason: action });
        RenderCoordinator.invalidate("combatTracker", { reason: action });
        return result;
      } catch (exception) {
        error(`Failed to ${action === "incrementReaction" ? "increment" : "decrement"} reactions from the actor hotbar.`, exception);
        ui.notifications.error(game.i18n.localize("AOV_SKJALDBORG.Warnings.ActionFailed"));
        if (control instanceof HTMLElement) control.innerHTML = previousHtml;
        return null;
      } finally {
        if (control instanceof HTMLElement) {
          control.classList.remove("pending");
          control.removeAttribute("aria-busy");
        }
      }
    };

    const pending = this._reactionUpdateQueue.then(execute, execute);
    this._reactionUpdateQueue = pending.catch(() => null);
    return pending;
  }

  /**
   * Add one reaction from the existing workflow pill.
   *
   * @param {PointerEvent} event Interaction event.
   * @returns {Promise<unknown|null>}
   */
  static onIncrementReaction(event) {
    event.preventDefault();
    event.stopPropagation();
    return this._queueReactionChange("incrementReaction");
  }


  /**
   * Roll the weapon currently selected in the combat strip.
   *
   * @param {PointerEvent} event Interaction event.
   * @returns {Promise<unknown|null>}
   */
  static async onRollSelectedWeapon(event) {
    event.preventDefault();
    const select = this.element?.querySelector?.("[data-readied-weapon-select]");
    const weaponId = String(select?.value ?? "");
    if (!weaponId) {
      ui.notifications.warn(game.i18n.localize("AOV_SKJALDBORG.Warnings.SelectWeapon"));
      return null;
    }
    return this._rollWeapon(weaponId, "combat", event);
  }

  /**
   * Roll one weapon attack from the Equipment table.
   *
   * @param {PointerEvent} event Interaction event.
   * @param {HTMLElement} target Action target.
   * @returns {Promise<unknown|null>}
   */
  static async onRollWeaponAttack(event, target) {
    event.preventDefault();
    return this._rollWeapon(String(target.dataset.weaponId ?? ""), "combat", event);
  }

  /**
   * Roll one weapon's damage through the AoV core damage workflow.
   *
   * @param {PointerEvent} event Interaction event.
   * @param {HTMLElement} target Action target.
   * @returns {Promise<unknown|null>}
   */
  static async onRollWeaponDamage(event, target) {
    event.preventDefault();
    return this._rollWeapon(String(target.dataset.weaponId ?? ""), "damage", event);
  }

  /**
   * Execute an AoV weapon check with consistent failure reporting.
   *
   * @param {string} weaponId Owned weapon Item id.
   * @param {"combat"|"damage"} property AoV check property.
   * @param {Event} event Originating event.
   * @returns {Promise<unknown|null>}
   */
  async _rollWeapon(weaponId, property, event) {
    if (!this.actor || !weaponId) {
      ui.notifications.warn(game.i18n.localize("AOV_SKJALDBORG.Warnings.ItemUnavailable"));
      return null;
    }
    try {
      return await AoVAdapter.rollActorWeapon(this.actor, weaponId, event, property);
    } catch (exception) {
      error(`Failed to roll ${property} for weapon ${weaponId}.`, exception);
      ui.notifications.error(game.i18n.localize("AOV_SKJALDBORG.Warnings.ActionFailed"));
      return null;
    }
  }

  /**
   * Toggle the selected carried weapon between draw and sheathe.
   *
   * @param {PointerEvent} event Interaction event.
   * @returns {Promise<unknown|null>} Completed operation.
   */
  static async onToggleReadiedWeapon(event) {
    event.preventDefault();
    const select = this.element?.querySelector?.("[data-readied-weapon-select]");
    const weaponId = String(select?.value ?? "");
    if (!weaponId) {
      ui.notifications.warn(game.i18n.localize("AOV_SKJALDBORG.Warnings.SelectCarriedWeapon"));
      return null;
    }
    const currentWeaponId = String(getReadiedWeaponId(this.actor) ?? "");
    return this._performWeaponAction(weaponId === currentWeaponId ? "sheathe" : "draw", weaponId);
  }

  /**
   * Clear the current readied weapon without adjusting initiative.
   *
   * @param {PointerEvent} event Interaction event.
   * @returns {Promise<unknown|null>} Completed operation.
   */
  static async onDropReadiedWeapon(event) {
    event.preventDefault();
    if (!this.actor || this._weaponActionPending) return null;
    this._weaponActionPending = true;
    try {
      const result = await clearReadiedWeapon(this.actor);
      ActorHotbar.scheduleRender({ parts: ["workflow", "weaponControls"], reason: "drop-readied-weapon" });
      RenderCoordinator.invalidate("combatTracker", { reason: "drop-readied-weapon" });
      return result;
    } catch (exception) {
      error("Failed to drop readied weapon from the actor hotbar.", exception);
      ui.notifications.error(game.i18n.localize("AOV_SKJALDBORG.Warnings.ActionFailed"));
      return null;
    } finally {
      this._weaponActionPending = false;
    }
  }

  /**
   * Toggle a Passion or Skill XP check without starting row drag behavior.
   *
   * @param {PointerEvent} event Interaction event.
   * @param {HTMLElement} target Action target.
   * @returns {Promise<unknown|null>}
   */
  static async onToggleXp(event, target) {
    event.preventDefault();
    event.stopImmediatePropagation();
    if (this._xpUpdatePending) return null;

    this._xpUpdatePending = true;
    target.disabled = true;
    target.setAttribute("aria-busy", "true");
    try {
      const result = await toggleActorItemXpCheck(this.actor, target.dataset.itemId);
      ActorHotbar.scheduleRender({ parts: ["tabBody"], reason: "xp-toggle" });
      return result;
    } finally {
      this._xpUpdatePending = false;
    }
  }

  /**
   * Toggle a Rune Script or Seiðr Spell preparation state and immediately
   * refresh the Magic Point maximum shown by the hotbar.
   *
   * @param {PointerEvent} event Interaction event.
   * @param {HTMLElement} target Preparation control.
   * @returns {Promise<unknown|null>}
   */
  static async onToggleMagicPrepared(event, target) {
    event.preventDefault();
    event.stopImmediatePropagation();
    const itemId = String(target.dataset.itemId ?? "");
    if (!this.actor || !itemId || this._magicPreparationUpdatesPending.has(itemId)) return null;

    this._magicPreparationUpdatesPending.add(itemId);
    target.disabled = true;
    target.setAttribute("aria-busy", "true");
    try {
      const result = await AoVAdapter.toggleActorMagicPrepared(this.actor, itemId);
      ActorHotbar.scheduleRender({ parts: ["resources", "tabBody"], reason: "magic-prepared-toggle" });
      return result;
    } catch (exception) {
      error(`Failed to toggle magic preparation for Item ${itemId}.`, exception);
      ui.notifications.error(game.i18n.localize("AOV_SKJALDBORG.Warnings.MagicPreparationFailed"));
      return null;
    } finally {
      this._magicPreparationUpdatesPending.delete(itemId);
    }
  }

  /** @returns {Promise<unknown|null>} */
  static onOpenActor() {
    return this.actor?.sheet?.render?.(true) ?? null;
  }

  /**
   * Collapse or restore the main action header and content stage.
   *
   * @param {PointerEvent} event Interaction event.
   * @returns {Promise<void>}
   */
  static async onToggleCollapse(event) {
    event.preventDefault();
    event.stopPropagation();
    const collapsed = !!game.settings.get(MODULE_ID, "actorHotbarCollapsed");
    await game.settings.set(MODULE_ID, "actorHotbarCollapsed", !collapsed);
  }

  /**
   * Open one actor-owned informational or action Item sheet.
   *
   * @param {PointerEvent} event Interaction event.
   * @param {HTMLElement} target Action target.
   * @returns {Promise<unknown|null>}
   */
  static onOpenItem(event, target) {
    event.preventDefault();
    return openActorItem(this.actor, target.dataset.itemId ?? target.dataset.actionId);
  }

  /**
   * Create an unassigned character Wound Item or add native `npcDmg` to a
   * selected NPC Hit Location.
   *
   * @param {PointerEvent} event Interaction event.
   * @returns {Promise<Item|Document[]|null>}
   */
  static async onCreateWound(event) {
    event.preventDefault();
    try {
      if (this.actor?.type !== "npc") return await AoVAdapter.createActorWound(this.actor);

      const wellbeing = AoVAdapter.prepareActorWellbeing(this.actor);
      const locations = wellbeing.locationList.filter(location => location.id);
      if (!locations.length) {
        ui.notifications.warn(game.i18n.localize("AOV_SKJALDBORG.ActorHotbar.NoHitLocations"));
        return null;
      }

      const content = await foundry.applications.handlebars.renderTemplate(
        "modules/aov-skjaldborg/templates/npc-wound-dialog.hbs",
        { locations }
      );
      const result = await foundry.applications.api.DialogV2.input({
        classes: ["aov", "aov-skjaldborg", "skj-npc-wound-dialog-window"],
        window: { title: game.i18n.localize("AOV_SKJALDBORG.ActorHotbar.AddNpcWound") },
        content,
        rejectClose: false,
        ok: { label: game.i18n.localize("AOV.confirm") }
      });
      if (!result) return null;
      return await AoVAdapter.addActorNpcDamage(this.actor, String(result.locationId ?? ""), result.damage);
    } catch (exception) {
      error("Failed to create a wound from the actor hotbar.", exception);
      ui.notifications.error(game.i18n.localize("AOV_SKJALDBORG.Warnings.WellbeingUpdateFailed"));
      return null;
    }
  }

  /**
   * Toggle whether a character wound has been treated.
   *
   * @param {PointerEvent} event Interaction event.
   * @param {HTMLElement} target Action target.
   * @returns {Promise<Document[]|null>}
   */
  static async onToggleWoundTreated(event, target) {
    event.preventDefault();
    try {
      return await AoVAdapter.toggleActorWoundTreated(this.actor, target.dataset.woundId);
    } catch (exception) {
      error("Failed to toggle wound treatment from the actor hotbar.", exception);
      ui.notifications.error(game.i18n.localize("AOV_SKJALDBORG.Warnings.WellbeingUpdateFailed"));
      return null;
    }
  }

  /**
   * Delete a wound on double click, matching the Age of Vikings actor sheet.
   *
   * @param {PointerEvent} event Interaction event.
   * @param {HTMLElement} target Action target.
   * @returns {Promise<Document[]|null>}
   */
  static async onDeleteWound(event, target) {
    event.preventDefault();
    if (event.detail !== 2) return null;
    try {
      return await AoVAdapter.deleteActorWound(this.actor, target.dataset.woundId);
    } catch (exception) {
      error("Failed to delete a wound from the actor hotbar.", exception);
      ui.notifications.error(game.i18n.localize("AOV_SKJALDBORG.Warnings.WellbeingUpdateFailed"));
      return null;
    }
  }

  /**
   * Open a Farm Actor or embedded Thrall Item resolved by UUID.
   *
   * @param {PointerEvent} event Interaction event.
   * @param {HTMLElement} target Action target.
   * @returns {Promise<unknown|null>}
   */
  static async onOpenUuid(event, target) {
    event.preventDefault();
    const uuid = target.dataset.documentUuid;
    if (!uuid || typeof globalThis.fromUuid !== "function") return null;
    try {
      const document = await globalThis.fromUuid(uuid);
      return document?.sheet?.render?.(true) ?? null;
    } catch (exception) {
      error(`Failed to open hotbar document ${uuid}.`, exception);
      ui.notifications.error(game.i18n.localize("AOV_SKJALDBORG.Warnings.ActionFailed"));
      return null;
    }
  }

  /**
   * Open one equipment Item sheet.
   *
   * @param {PointerEvent} event Interaction event.
   * @param {HTMLElement} target Action target.
   * @returns {Promise<unknown|null>}
   */
  static onOpenEquipment(event, target) {
    event.preventDefault();
    return openActorItem(this.actor, target.dataset.equipmentId);
  }

  /**
   * Cycle an equipment row through carried, packed, and stored.
   *
   * @param {PointerEvent} event Interaction event.
   * @param {HTMLElement} target Action target.
   * @returns {Promise<unknown|null>}
   */
  static async onToggleEquipment(event, target) {
    event.preventDefault();
    const result = await cycleActorEquipmentStatus(this.actor, target.dataset.equipmentId);
    ActorHotbar.scheduleRender({ parts: ["tabBody", "weaponControls"], reason: "equipment-toggle" });
    return result;
  }

  /** @returns {Promise<CombatHUD|null>} */
  static onOpenCombatHud() {
    if (!this.combatant || !game.combat) {
      ui.notifications.warn(game.i18n.localize("AOV_SKJALDBORG.Warnings.NoCombatant"));
      return null;
    }
    return CombatHUD.showForCombatant(this.combatant, game.combat);
  }
}

/**
 * Test whether a TokenDocument represents the actor shown by the hotbar.
 *
 * @param {TokenDocument|null|undefined} token Token document.
 * @returns {boolean}
 */
function tokenBelongsToCurrentHotbarActor(token) {
  const currentActor = ActorHotbar.current?.actor;
  const currentActorId = currentActor?.id ?? currentHotbarActorId();
  if (!currentActorId) return false;
  const tokenActor = token?.actor ?? null;
  const baseActor = token?.baseActor ?? tokenActor?.baseActor ?? null;
  return tokenActor?.id === currentActorId
    || baseActor?.id === currentActorId
    || token?.actorId === currentActorId
    || currentActor?.token?.id === token?.id;
}

/**
 * Resolve the actor id currently represented, or about to be represented, by
 * the actor hotbar.
 *
 * @returns {string|null}
 */
function currentHotbarActorId() {
  return ActorHotbar.current?.actor?.id ?? resolveHotbarActor()?.id ?? null;
}

/**
 * Resolve the owning Actor id for Actor, Item, ActiveEffect, and nested
 * embedded-document hook payloads.
 *
 * @param {Document|null|undefined} document Candidate Foundry document.
 * @returns {string|null}
 */
function documentActorId(document) {
  if (!document) return null;
  if (document.documentName === "Actor") return document.id ?? null;
  if (document.actor?.id) return document.actor.id;
  const parent = document.parent ?? null;
  if (parent?.documentName === "Actor") return parent.id ?? null;
  if (parent?.actor?.id) return parent.actor.id;
  if (parent?.parent?.documentName === "Actor") return parent.parent.id ?? null;
  return null;
}

/**
 * Test whether a document hook payload affects the selected actor.
 *
 * @param {Document|null|undefined} document Candidate Foundry document.
 * @returns {boolean}
 */
function documentBelongsToCurrentHotbarActor(document) {
  const currentActorId = currentHotbarActorId();
  if (!currentActorId) return false;
  return documentActorId(document) === currentActorId;
}

/**
 * Test whether a Combat document may affect visible hotbar data.
 *
 * @param {Combat|null|undefined} combat Candidate Combat document.
 * @returns {boolean}
 */
function combatAffectsCurrentHotbar(combat) {
  const current = ActorHotbar.current;
  const currentActorId = currentHotbarActorId();
  if (!currentActorId) return false;
  const combatId = combat?.id ?? null;
  const currentCombatId = current?.combatant?.parent?.id ?? game.combat?.id ?? null;
  return !combatId || !currentCombatId || combatId === currentCombatId;
}

/**
 * Test whether a Combatant document may affect visible hotbar data.
 *
 * @param {Combatant|null|undefined} combatant Candidate Combatant document.
 * @returns {boolean}
 */
function combatantAffectsCurrentHotbar(combatant) {
  const current = ActorHotbar.current;
  const currentActorId = currentHotbarActorId();
  if (!currentActorId || !combatant) return false;
  return combatant.id === current?.combatant?.id
    || combatant.actor?.id === currentActorId
    || combatant.token?.actor?.id === currentActorId;
}

/**
 * Invalidate cached presentation data affected by hotbar render parts.
 *
 * @param {Actor|null|undefined} actor Actor document.
 * @param {Set<string>|string[]} parts Affected hotbar regions.
 * @returns {void}
 */
function invalidatePresentationForHotbarParts(actor, parts) {
  const affected = new Set(parts ?? []);
  const categories = new Set();
  if (affected.has("resources")) categories.add("resources");
  if (affected.has("weaponControls")) {
    categories.add("weapons");
    categories.add("equipment");
  }
  if (affected.has("quickAccess")) {
    categories.add("actions");
    categories.add("stats");
  }
  if (affected.has("tabBody")) {
    categories.add("actions");
    categories.add("equipment");
    categories.add("stats");
    categories.add("skills");
    categories.add("magic");
    categories.add("historyFamily");
  }
  if (!categories.size || affected.has("shell")) PresentationCache.invalidate(actor);
  else PresentationCache.invalidate(actor, categories);
}

/**
 * Schedule a part-aware hotbar refresh.
 *
 * @param {Set<string>|string[]} parts Affected hotbar regions.
 * @param {string} reason Diagnostic reason.
 * @param {Actor|null|undefined} [actor=ActorHotbar.current?.actor] Actor whose cache should be invalidated.
 * @returns {void}
 */
function invalidateActorHotbar(parts, reason, actor = ActorHotbar.current?.actor) {
  const affected = new Set(parts ?? []);
  if (!affected.size) return;
  invalidatePresentationForHotbarParts(actor, affected);
  ActorHotbar.scheduleRender({
    parts: affected,
    reason,
    full: affected.has("shell")
  });
}

/**
 * Register actor-hotbar render hooks once.
 *
 * @returns {void}
 */
export function registerActorHotbarHooks() {
  if (hooksRegistered) return;
  hooksRegistered = true;

  RenderCoordinator.register("actorHotbar", detail => ActorHotbar.renderInvalidated(detail));

  Hooks.on("controlToken", () => invalidateActorHotbar(["shell"], "control-token"));
  Hooks.on("canvasReady", () => invalidateActorHotbar(["shell"], "canvas-ready"));
  Hooks.on("canvasTearDown", () => invalidateActorHotbar(["shell"], "canvas-teardown"));
  Hooks.on("renderHotbar", () => invalidateActorHotbar(["shell"], "core-hotbar-render"));
  Hooks.on("createToken", token => {
    if (tokenBelongsToCurrentHotbarActor(token)) invalidateActorHotbar(["shell"], "token-create");
  });
  Hooks.on("deleteToken", token => {
    if (tokenBelongsToCurrentHotbarActor(token)) invalidateActorHotbar(["shell"], "token-delete");
  });
  Hooks.on("updateToken", (token, changes) => {
    const changedKeys = Object.keys(changes ?? {});
    const dispositionChanged = Object.prototype.hasOwnProperty.call(changes ?? {}, "disposition");
    const actorChanged = ["actorId", "actorLink"].some(key => Object.prototype.hasOwnProperty.call(changes ?? {}, key));
    const resourceBarsChanged = changedKeys.some(key => key === "bar1" || key === "bar2" || key.startsWith("bar1.") || key.startsWith("bar2."));
    if ((dispositionChanged || actorChanged || resourceBarsChanged) && tokenBelongsToCurrentHotbarActor(token)) {
      invalidateActorHotbar(["shell", "resources"], "token-update");
    }
  });
  Hooks.on("updateActor", (actor, changed) => {
    const current = ActorHotbar.current;
    if (current?._xpUpdatePending && current.actor?.id === actor.id) return;
    if (!documentBelongsToCurrentHotbarActor(actor)) return;
    invalidateActorHotbar(actorHotbarPartsForActorChange(changed), "actor-update", actor);
  });
  Hooks.on("updateItem", (item, changed) => {
    const current = ActorHotbar.current;
    const sameActor = documentBelongsToCurrentHotbarActor(item);
    if (sameActor && (current?._xpUpdatePending || current?._magicPreparationUpdatesPending?.size > 0)) return;
    if (sameActor) invalidateActorHotbar(actorHotbarPartsForItemChange(changed), "item-update", item.actor);
  });
  Hooks.on("createItem", item => {
    if (documentBelongsToCurrentHotbarActor(item)) invalidateActorHotbar(["shell"], "item-create", item.actor);
  });
  Hooks.on("deleteItem", item => {
    if (documentBelongsToCurrentHotbarActor(item)) invalidateActorHotbar(["shell"], "item-delete", item.actor);
  });
  Hooks.on("createActiveEffect", effect => {
    if (documentBelongsToCurrentHotbarActor(effect)) invalidateActorHotbar(["shell"], "effect-create", effect.parent);
  });
  Hooks.on("updateActiveEffect", (effect, changed) => {
    if (!documentBelongsToCurrentHotbarActor(effect)) return;
    if (!Object.keys(changed ?? {}).length) return;
    invalidateActorHotbar(["shell"], "effect-update", effect.parent);
  });
  Hooks.on("deleteActiveEffect", effect => {
    if (documentBelongsToCurrentHotbarActor(effect)) invalidateActorHotbar(["shell"], "effect-delete", effect.parent);
  });
  Hooks.on("updateCombat", (combat, changed) => {
    if (combatAffectsCurrentHotbar(combat)) invalidateActorHotbar(actorHotbarPartsForCombatChange(changed), "combat-update");
  });
  Hooks.on("updateCombatant", (combatant, changed) => {
    if (combatantAffectsCurrentHotbar(combatant)) invalidateActorHotbar(actorHotbarPartsForCombatantChange(changed), "combatant-update", combatant.actor);
  });

  window.addEventListener("resize", () => ActorHotbar.current?._clampCurrentPosition());
  ActorHotbar.scheduleRender({ parts: ["shell"], reason: "register-hooks", full: true });
}
