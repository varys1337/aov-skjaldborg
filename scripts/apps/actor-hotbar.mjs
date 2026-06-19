import { MODULE_ID } from "../constants.mjs";
import { AoVAdapter } from "../adapter/aov-adapter.mjs";
import { getCombatState, getCombatantState } from "../combat/state.mjs";
import { error } from "../logger.mjs";
import { requestGm } from "../socket.mjs";
import { clearReadiedWeapon, getReadiedWeaponId, prepareReadiedWeaponState, setReadiedWeapon } from "../combat/weapon-state.mjs";
import { CombatHUD } from "./combat-hud.mjs";
import {
  ACTOR_HOTBAR_QUICK_SLOT_CAPACITY,
  commitIntentCategory,
  cycleActorEquipmentStatus,
  executeActorItem,
  executeActorStat,
  executeMacro,
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
  resolveActorCombatant,
  resolveHotbarActor,
  toggleActorItemXpCheck,
  updateActorEquipmentQuantity
} from "../ui/action-catalog.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

const QUICK_ACCESS_DRAG_TYPE = "AOVSkjaldborgActorHotbarAction";
const QUICK_ACCESS_DRAG_MIME = "application/x-aov-skjadlborg-action";
const QUICK_ACCESS_SLOT_SIZE = 42;
const QUICK_ACCESS_MIN_RADIUS = 75;
const QUICK_ACCESS_MIN_STAGE_SIZE = 192;
const QUICK_ACCESS_SLOT_GAP = 4;

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
  "runescript",
  "seidur",
  "npcpower",
  "other"
]);

let hooksRegistered = false;
let scheduled = false;

const TURN_DISPOSITION_PALETTES = Object.freeze({
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
    color: "#7e8792",
    labelColor: "#b8c0ca",
    labelWeight: 800,
    glowSoft: "rgba(126, 135, 146, 0.38)",
    glowStrong: "rgba(126, 135, 146, 0.72)"
  })
});

/**
 * Resolve the active combatant Token disposition into the requested blue,
 * yellow, or red turn-highlight palette.
 *
 * @param {Combatant|null} combatant Current Actor's Combatant document.
 * @returns {{key: string, color: string, labelColor: string, labelWeight: number, glowSoft: string, glowStrong: string}}
 */
function resolveTurnDispositionPalette(combatant) {
  const disposition = Number(
    combatant?.token?.disposition
    ?? combatant?.token?.object?.document?.disposition
  );
  const dispositions = globalThis.CONST?.TOKEN_DISPOSITIONS ?? {};
  const friendly = Number(dispositions.FRIENDLY ?? 1);
  const neutral = Number(dispositions.NEUTRAL ?? 0);
  const secret = Number(dispositions.SECRET ?? -2);

  if (disposition === friendly) return TURN_DISPOSITION_PALETTES.friendly;
  if (disposition === neutral) return TURN_DISPOSITION_PALETTES.neutral;
  if (disposition === secret) return TURN_DISPOSITION_PALETTES.secret;
  return TURN_DISPOSITION_PALETTES.hostile;
}

/**
 * Localize an AoV skill category while retaining a readable fallback.
 *
 * @param {string} category AoV category id.
 * @returns {string}
 */
function localizeSkillCategory(category) {
  if (category === "other") return game.i18n.localize("AOV_SKJADLBORG.ActorHotbar.Groups.OtherSkills");
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
  if (itemType === "other") return game.i18n.localize("AOV_SKJADLBORG.ActorHotbar.Groups.OtherMagic");
  const key = `TYPES.Item.${itemType}`;
  const localized = game.i18n.localize(key);
  return localized === key ? itemType : localized;
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
    id: "aov-skjadlborg-actor-hotbar",
    classes: ["aov-skjadlborg", "skj-actor-hotbar"],
    window: {
      frame: false
    },
    actions: {
      activate: ActorHotbar.onActivate,
      openActor: ActorHotbar.onOpenActor,
      openCombatHud: ActorHotbar.onOpenCombatHud,
      openEquipment: ActorHotbar.onOpenEquipment,
      openItem: ActorHotbar.onOpenItem,
      openUuid: ActorHotbar.onOpenUuid,
      toggleReadiedWeapon: ActorHotbar.onToggleReadiedWeapon,
      dropReadiedWeapon: ActorHotbar.onDropReadiedWeapon,
      toggleEquipment: ActorHotbar.onToggleEquipment,
      toggleCollapse: ActorHotbar.onToggleCollapse,
      toggleXp: ActorHotbar.onToggleXp
    }
  };

  static PARTS = {
    hotbar: {
      template: "modules/aov-skjadlborg/templates/actor-hotbar.hbs"
    }
  };

  static TABS = {
    sheet: {
      tabs: [
        { id: "combat", label: "AOV_SKJADLBORG.ActorHotbar.Tabs.Combat" },
        { id: "stats", label: "AOV_SKJADLBORG.ActorHotbar.Tabs.Stats" },
        { id: "skills", label: "AOV_SKJADLBORG.ActorHotbar.Tabs.Skills" },
        { id: "equip", label: "AOV_SKJADLBORG.ActorHotbar.Tabs.Equip" },
        { id: "magic", label: "AOV_SKJADLBORG.ActorHotbar.Tabs.Magic" },
        { id: "historyFamily", label: "AOV_SKJADLBORG.ActorHotbar.Tabs.HistoryFamily" },
        { id: "macros", label: "AOV_SKJADLBORG.ActorHotbar.Tabs.Macros" }
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
    this._resourceUpdatePending = false;
    this._equipmentUpdatePending = false;
    this._weaponActionPending = false;
    this._quickAccessUpdatePending = false;
    this._xpUpdatePending = false;
    this._scrollPositions = new Map();
    this._renderedActorKey = null;
    this._hotbarSide = "right";
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
   * @returns {void}
   */
  static scheduleRender() {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      void this.ensureRendered();
    });
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
    this.current._positionAboveCoreHotbar();
    this.current._positionInitialized = true;
  }

  /** @inheritdoc */
  _insertElement(element) {
    // Keep the overlay independent from the core hotbar/sidebar layout. Its
    // viewport-fixed position is managed explicitly through setPosition().
    document.body.append(element);
  }

  /** @inheritdoc */
  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    this.actor = resolveHotbarActor();
    this.combatant = resolveActorCombatant(this.actor, game.combat);
    if (!this.actor) return { ...context, actor: null };

    const prepared = prepareActorActions(this.actor);
    const combat = game.combat ?? null;
    const workflowActive = isSkjaldborgCombatActive(combat) && !!this.combatant;
    const canControlCombatant = workflowActive
      ? AoVAdapter.canUserControlCombatant(game.user, this.combatant)
      : false;
    const combatantState = this.combatant ? getCombatantState(this.combatant) : null;
    const combatState = workflowActive ? getCombatState(combat) : null;
    const intentActions = canControlCombatant ? prepareIntentActions() : [];
    const showMacroTab = game.settings.get(MODULE_ID, "replaceCoreHotbar");
    const equipmentGroups = prepareActorEquipment(this.actor);
    const weaponState = prepareReadiedWeaponState(this.actor);
    const canManageWeapons = this.actor.isOwner
      && (!this.combatant || AoVAdapter.canUserControlCombatant(game.user, this.combatant));
    const showEquipTab = equipmentGroups.length > 0;
    const historyFamily = await prepareActorHistoryFamily(this.actor);
    const showHistoryFamilyTab = this.actor.type === "character" || historyFamily.hasContent;

    const activeTab = this.tabGroups?.sheet;
    const hiddenActiveTab = (!showMacroTab && activeTab === "macros")
      || (!showEquipTab && activeTab === "equip")
      || (!showHistoryFamilyTab && activeTab === "historyFamily");
    if (hiddenActiveTab) {
      this.tabGroups.sheet = "combat";
      context.tabs[activeTab].cssClass = context.tabs[activeTab].cssClass.replace("active", "").trim();
      context.tabs.combat.cssClass = [context.tabs.combat.cssClass, "active"].filter(Boolean).join(" ");
    }

    const statGroups = prepareActorStats(this.actor);
    const skillGroups = prepareNamedGroups(prepared.skills, "skills");
    const magicGroups = prepareNamedGroups(prepared.magic, "magic");
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
      resources: this._prepareResources(),
      quickAccessSlots: quickAccess.slots,
      quickAccessStageSize: quickAccess.stageSize,
      effects: this._prepareEffects(),
      combatActions: intentActions,
      weaponState: {
        ...weaponState,
        currentLabel: weaponState.name || game.i18n.localize("AOV_SKJADLBORG.Weapons.None"),
        canManage: canManageWeapons,
        selectedIsReadied: !!weaponState.id && weaponState.carriedWeapons.some(weapon => weapon.selected && weapon.id === weaponState.id),
        toggleDisabled: !canManageWeapons || !weaponState.canDraw,
        dropDisabled: !canManageWeapons || !weaponState.canSheathe
      },
      statGroups,
      skillGroups,
      magicGroups,
      equipmentGroups,
      historyFamily,
      macroSlots,
      showMacroTab,
      showEquipTab,
      showHistoryFamilyTab,
      workflow: this._prepareWorkflow(combat, combatState, combatantState),
      hasCombatActions: intentActions.length > 0,
      hasStatActions: statGroups.length > 0,
      hasSkillActions: skillGroups.length > 0,
      hasMagicActions: magicGroups.length > 0,
      hasEquipment: equipmentGroups.length > 0,
      hasHistoryFamily: historyFamily.hasContent,
      collapsed: !!game.settings.get(MODULE_ID, "actorHotbarCollapsed")
    };
  }

  /**
   * Prepare editable HP and MP resource cards from actor document data.
   *
   * @returns {object[]}
   */
  _prepareResources() {
    const hp = this.actor.system?.hp ?? {};
    const mp = this.actor.system?.mp ?? {};
    const mpMax = Number(mp.max ?? 0);
    const mpAvailable = Number(mp.availMax ?? mpMax);
    const locked = Math.max(0, mpMax - mpAvailable);
    return [
      {
        id: "hp",
        label: game.i18n.localize("AOV_SKJADLBORG.ActorHotbar.HitPoints"),
        value: Number(hp.value ?? 0),
        max: Number(hp.max ?? 0),
        accent: "#e22b32",
        secondary: ""
      },
      {
        id: "mp",
        label: game.i18n.localize("AOV_SKJADLBORG.ActorHotbar.MagicPoints"),
        value: Number(mp.value ?? 0),
        max: mpAvailable,
        accent: "#704cff",
        secondary: locked > 0
          ? game.i18n.format("AOV_SKJADLBORG.ActorHotbar.LockedMagic", { locked, max: mpMax })
          : ""
      }
    ];
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
          name: game.i18n.localize("AOV_SKJADLBORG.ActorHotbar.QuickAccess.Empty"),
          tooltip: game.i18n.localize("AOV_SKJADLBORG.ActorHotbar.QuickAccess.DropHint")
        };
      }

      return {
        ...action,
        index,
        style,
        empty: false,
        kind: entry.kind,
        tooltip: `${action.name} - ${game.i18n.localize("AOV_SKJADLBORG.ActorHotbar.QuickAccess.RemoveHint")}`
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
        name: macro?.name ?? game.i18n.format("AOV_SKJADLBORG.ActorHotbar.EmptyMacro", { slot }),
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
    const dispositionPalette = this.combatant
      ? resolveTurnDispositionPalette(this.combatant)
      : TURN_DISPOSITION_PALETTES.secret;
    return {
      active,
      myTurn,
      dispositionKey: dispositionPalette.key,
      dispositionLabelColor: dispositionPalette.labelColor,
      dispositionLabelWeight: dispositionPalette.labelWeight,
      turnColor: myTurn ? dispositionPalette.color : "",
      turnGlowSoft: myTurn ? dispositionPalette.glowSoft : "",
      turnGlowStrong: myTurn ? dispositionPalette.glowStrong : "",
      phase: active ? game.i18n.localize(`AOV_SKJADLBORG.Phases.${combatState.phase}`) : "",
      category: active ? game.i18n.localize(`AOV_SKJADLBORG.ActionCategories.${category}`) : "",
      status,
      statusLabel: active ? game.i18n.localize(`AOV_SKJADLBORG.IntentStatus.${status}`) : "",
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
    this._activatePositionDragging();
    this._activateResourceEditing();
    this._activateEquipmentEditing();
    this._activateWeaponControls();
    this._activateContextMenus();
    this._activateActionDragging();
    this._activateXpToggleDragGuards();
    this._activateQuickAccessSlots();
    this._restoreScrollPositions();
  }

  /** @inheritdoc */
  _onClose(options) {
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
   * Measure the hotbar columns in transformed viewport pixels.
   *
   * @returns {{scale: number, collapsed: boolean, coreWidth: number, actionWidth: number, collapseWidth: number, gap: number, panelSpan: number, visiblePanelSpan: number, totalWidth: number, visibleWidth: number, height: number}}
   */
  _layoutMetrics() {
    const scale = this._hotbarScale();
    const layout = this.element?.querySelector(".skj-hotbar-layout");
    const core = this.element?.querySelector(".skj-actor-core");
    const actions = this.element?.querySelector(".skj-actor-actions");
    const collapse = this.element?.querySelector(".skj-hotbar-collapse-toggle");
    const collapsed = this.element?.classList.contains("skj-hotbar-collapsed")
      || !!game.settings.get(MODULE_ID, "actorHotbarCollapsed");
    const computed = layout ? getComputedStyle(layout) : null;
    const gap = Math.max(0, Number.parseFloat(computed?.columnGap ?? "2") || 2) * scale;
    const coreWidth = core?.getBoundingClientRect?.().width
      || (Number.parseFloat(computed?.getPropertyValue("--skj-quick-stage-size") ?? "192") || 192) * scale;
    const configuredActionWidth = Number(game.settings.get(MODULE_ID, "actorHotbarActionWidth")) || 420;
    const actionWidth = actions?.getBoundingClientRect?.().width || configuredActionWidth * scale;
    const collapseWidth = collapse?.getBoundingClientRect?.().width || 10 * scale;
    const rect = this.element?.getBoundingClientRect?.() ?? { height: 0 };
    const height = rect.height || layout?.getBoundingClientRect?.().height || core?.getBoundingClientRect?.().height || 0;
    const panelSpan = actionWidth + collapseWidth + (gap * 2);
    const visiblePanelSpan = collapsed ? collapseWidth + gap : panelSpan;
    return {
      scale,
      collapsed,
      coreWidth,
      actionWidth,
      collapseWidth,
      gap,
      panelSpan,
      visiblePanelSpan,
      totalWidth: coreWidth + panelSpan,
      visibleWidth: coreWidth + visiblePanelSpan,
      height
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
   * Restore the saved client position or establish the default anchor once.
   *
   * @returns {void}
   */
  _restoreOrInitializePosition() {
    if (!this.element || !this.actor) return;
    const saved = game.settings.get(MODULE_ID, "actorHotbarPosition") ?? {};
    if (Number.isFinite(Number(saved.left)) && Number.isFinite(Number(saved.top))) {
      this._setPositionFromAnchor({
        left: Number(saved.left),
        top: Number(saved.top)
      });
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
   * @returns {void}
   */
  _positionAboveCoreHotbar() {
    if (!this.element || !this.actor) return;
    const coreHotbar = ui.hotbar?.element ?? document.querySelector("#hotbar");
    const elementRect = this.element.getBoundingClientRect();
    const anchorRect = coreHotbar?.getBoundingClientRect?.();
    const desiredLeft = anchorRect?.width ? anchorRect.left : 16;
    const desiredTop = anchorRect?.width
      ? anchorRect.top - elementRect.height - 10
      : window.innerHeight - elementRect.height - 16;
    this._setPositionFromAnchor({ left: desiredLeft, top: desiredTop });
  }

  /**
   * Clamp a proposed actor-core anchor inside the viewport.
   *
   * @param {number} left Proposed left coordinate.
   * @param {number} top Proposed top coordinate.
   * @param {"left"|"right"|null} [side=null] Expansion side, when known.
   * @param {{fitExpanded?: boolean}} [options={}] Clamp against expanded or currently visible footprint.
   * @returns {{left: number, top: number}}
   */
  _clampAnchor(left, top, side = null, options = {}) {
    const margin = 8;
    const metrics = this._layoutMetrics();
    const fitExpanded = options.fitExpanded ?? !metrics.collapsed;
    const panelSpan = fitExpanded ? metrics.panelSpan : metrics.visiblePanelSpan;
    const totalWidth = metrics.coreWidth + panelSpan;
    let minLeft = margin;
    let maxLeft = Math.max(margin, window.innerWidth - metrics.coreWidth - margin);
    if (side === "right") {
      maxLeft = Math.max(margin, window.innerWidth - totalWidth - margin);
    } else if (side === "left") {
      minLeft = Math.min(maxLeft, margin + panelSpan);
    }
    const maxTop = Math.max(margin, window.innerHeight - Math.min(metrics.height, window.innerHeight - (margin * 2)) - margin);
    return {
      left: Math.round(Math.max(margin, Math.min(left, maxLeft))),
      top: Math.round(Math.max(margin, Math.min(top, maxTop)))
    };
  }

  /**
   * Choose the action-panel side from available horizontal viewport space.
   *
   * @param {{left: number, top: number}} anchor Actor-core anchor.
   * @returns {"left"|"right"}
   */
  _preferredSide(anchor) {
    const margin = 8;
    const metrics = this._layoutMetrics();
    const rightEdge = anchor.left + metrics.totalWidth;
    const leftEdge = anchor.left - metrics.panelSpan;
    if (rightEdge <= window.innerWidth - margin) return "right";
    if (leftEdge >= margin) return "left";
    const rightSpace = window.innerWidth - margin - (anchor.left + metrics.coreWidth);
    const leftSpace = anchor.left - margin;
    return leftSpace > rightSpace ? "left" : "right";
  }

  /**
   * Apply side classes used by CSS to mirror the action panel.
   *
   * @param {"left"|"right"} side Expansion side.
   * @returns {void}
   */
  _applySideClass(side) {
    this._hotbarSide = side;
    this.element.classList.toggle("skj-hotbar-side-left", side === "left");
    this.element.classList.toggle("skj-hotbar-side-right", side !== "left");
  }

  /**
   * Place the AppV2 root from the actor-core anchor and selected side.
   *
   * @param {{left: number, top: number}} anchor Actor-core anchor.
   * @returns {{left: number, top: number}}
   */
  _setPositionFromAnchor(anchor) {
    const metrics = this._layoutMetrics();
    const fitExpanded = !metrics.collapsed;
    const coreClamped = this._clampAnchor(anchor.left, anchor.top, null, { fitExpanded: false });
    const side = this._preferredSide(coreClamped);
    const clamped = this._clampAnchor(coreClamped.left, coreClamped.top, side, { fitExpanded });
    this._applySideClass(side);
    const sideSpan = fitExpanded ? metrics.panelSpan : metrics.visiblePanelSpan;
    const rootLeft = side === "left" ? clamped.left - sideSpan : clamped.left;
    super.setPosition({
      left: Math.round(rootLeft),
      top: clamped.top
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
   * Keep the current hotbar position inside the resized viewport.
   *
   * @returns {void}
   */
  _clampCurrentPosition() {
    if (!this.element?.isConnected) return;
    this._setPositionFromAnchor(this._currentAnchorPosition());
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
      });
    };

    const finish = async upEvent => {
      upEvent?.preventDefault?.();
      const position = this._setPositionFromAnchor(this._currentAnchorPosition());
      this._cancelPositionDrag();
      await game.settings.set(MODULE_ID, "actorHotbarPosition", position);
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
   * Persist one HP or MP edit through the AoV adapter.
   *
   * @param {Event} event Input change event.
   * @returns {Promise<void>}
   */
  async _commitResourceInput(event) {
    const input = event.currentTarget;
    const resource = input.dataset.resourceInput;
    if (!this.actor || this._resourceUpdatePending || !["hp", "mp"].includes(resource)) return;

    const original = input.dataset.originalValue ?? input.defaultValue;
    this._resourceUpdatePending = true;
    input.disabled = true;
    try {
      await AoVAdapter.updateActorResource(this.actor, resource, input.value);
    } catch (exception) {
      input.value = original;
      error(`Failed to update ${resource} from the actor hotbar.`, exception);
      ui.notifications.error(game.i18n.localize("AOV_SKJADLBORG.Warnings.ResourceUpdateFailed"));
    } finally {
      this._resourceUpdatePending = false;
      if (input.isConnected) input.disabled = false;
    }
  }


  /**
   * Bind quantity commits for gear rows in the Equip tab.
   *
   * @returns {void}
   */
  _activateEquipmentEditing() {
    for (const input of this.element.querySelectorAll("[data-equipment-quantity]")) {
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
      input.addEventListener("change", event => void this._commitEquipmentQuantity(event));
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
    const labelKey = isReadiedSelection ? "AOV_SKJADLBORG.Weapons.Sheathe" : "AOV_SKJADLBORG.Weapons.Draw";
    const hintKey = isReadiedSelection ? "AOV_SKJADLBORG.Weapons.SheatheHint" : "AOV_SKJADLBORG.Weapons.DrawHint";
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
      ui.notifications.error(game.i18n.localize("AOV_SKJADLBORG.Warnings.ActionFailed"));
    } finally {
      this._equipmentUpdatePending = false;
      if (input.isConnected) input.disabled = false;
    }
  }

  /**
   * Bind right-click item-sheet behavior to item controls.
   *
   * @returns {void}
   */
  _activateContextMenus() {
    for (const control of this.element.querySelectorAll('[data-action-kind="item"]:not([data-quick-slot-index])')) {
      control.addEventListener("contextmenu", event => {
        event.preventDefault();
        event.stopPropagation();
        void openActorItem(this.actor, control.dataset.actionId);
      });
    }
  }

  /**
   * Temporarily disable the draggable row while an XP control is pressed.
   *
   * Native dragstart targets the nearest draggable ancestor rather than
   * necessarily the nested button which initiated the pointer gesture. The
   * temporary attribute change therefore prevents an XP click from becoming a
   * row drag while leaving the rest of the row available for reordering and
   * quick-access assignment.
   *
   * @returns {void}
   */
  _activateXpToggleDragGuards() {
    for (const toggle of this.element.querySelectorAll("[data-xp-toggle]")) {
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
        if (event.target instanceof Element && event.target.closest("[data-xp-toggle]")) {
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
      ui.notifications.warn(game.i18n.localize("AOV_SKJADLBORG.ActorHotbar.QuickAccess.Full"));
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
      await this.render(false);
    } catch (exception) {
      error("Failed to update actor-hotbar quick access.", exception);
      ui.notifications.error(game.i18n.localize("AOV_SKJADLBORG.Warnings.ActionFailed"));
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
    await this.render(false);
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
      await this.render(false);
      ui.combat?.render?.();
      return result;
    } catch (exception) {
      error(`Failed to ${action} weapon from the actor hotbar.`, exception);
      ui.notifications.error(game.i18n.localize("AOV_SKJADLBORG.Warnings.ActionFailed"));
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
      if (!this.combatant || !game.combat) return null;
      if (event.shiftKey || ["wait", "delay"].includes(actionId)) {
        return CombatHUD.showForCombatant(this.combatant, game.combat, { initialActionCategory: actionId });
      }
      const result = await commitIntentCategory(this.combatant, game.combat, actionId);
      this.render(false);
      return result;
    }
    return null;
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
      ui.notifications.warn(game.i18n.localize("AOV_SKJADLBORG.Warnings.SelectCarriedWeapon"));
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
      await this.render(false);
      ui.combat?.render?.();
      return result;
    } catch (exception) {
      error("Failed to drop readied weapon from the actor hotbar.", exception);
      ui.notifications.error(game.i18n.localize("AOV_SKJADLBORG.Warnings.ActionFailed"));
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
      await this.render(false);
      return result;
    } finally {
      this._xpUpdatePending = false;
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
      ui.notifications.error(game.i18n.localize("AOV_SKJADLBORG.Warnings.ActionFailed"));
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
    await this.render(false);
    return result;
  }

  /** @returns {Promise<CombatHUD|null>} */
  static onOpenCombatHud() {
    if (!this.combatant || !game.combat) {
      ui.notifications.warn(game.i18n.localize("AOV_SKJADLBORG.Warnings.NoCombatant"));
      return null;
    }
    return CombatHUD.showForCombatant(this.combatant, game.combat);
  }
}

/**
 * Register actor-hotbar render hooks once.
 *
 * @returns {void}
 */
export function registerActorHotbarHooks() {
  if (hooksRegistered) return;
  hooksRegistered = true;

  Hooks.on("controlToken", () => ActorHotbar.scheduleRender());
  Hooks.on("canvasReady", () => ActorHotbar.scheduleRender());
  Hooks.on("canvasTearDown", () => ActorHotbar.scheduleRender());
  Hooks.on("renderHotbar", () => ActorHotbar.scheduleRender());
  Hooks.on("updateActor", actor => {
    const current = ActorHotbar.current;
    if (current?._xpUpdatePending && current.actor?.id === actor.id) return;
    if (!current?.actor || current.actor.id === actor.id) ActorHotbar.scheduleRender();
  });
  Hooks.on("updateItem", item => {
    const current = ActorHotbar.current;
    if (current?._xpUpdatePending && current.actor?.id === item.parent?.id) return;
    if (!current?.actor || current.actor.id === item.parent?.id) ActorHotbar.scheduleRender();
  });
  Hooks.on("createItem", item => {
    if (!ActorHotbar.current?.actor || ActorHotbar.current.actor.id === item.parent?.id) ActorHotbar.scheduleRender();
  });
  Hooks.on("deleteItem", item => {
    if (!ActorHotbar.current?.actor || ActorHotbar.current.actor.id === item.parent?.id) ActorHotbar.scheduleRender();
  });
  Hooks.on("createActiveEffect", effect => {
    if (!ActorHotbar.current?.actor || ActorHotbar.current.actor.id === effect.parent?.id) ActorHotbar.scheduleRender();
  });
  Hooks.on("updateActiveEffect", effect => {
    if (!ActorHotbar.current?.actor || ActorHotbar.current.actor.id === effect.parent?.id) ActorHotbar.scheduleRender();
  });
  Hooks.on("deleteActiveEffect", effect => {
    if (!ActorHotbar.current?.actor || ActorHotbar.current.actor.id === effect.parent?.id) ActorHotbar.scheduleRender();
  });
  Hooks.on("updateCombat", () => ActorHotbar.scheduleRender());
  Hooks.on("updateCombatant", () => ActorHotbar.scheduleRender());

  window.addEventListener("resize", () => ActorHotbar.current?._clampCurrentPosition());
  ActorHotbar.scheduleRender();
}
