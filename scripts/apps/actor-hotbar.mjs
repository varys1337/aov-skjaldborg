import {
  ACTION_CATEGORIES,
  INTENT_STATUS,
  MODULE_ID,
  UTILITY_ACTION_ID
} from "../constants.mjs";
import { AoVAdapter } from "../adapter/aov-adapter.mjs";
import { getCombatState, getCombatantState } from "../combat/state.mjs";
import { debug, error } from "../logger.mjs";
import { requestGm } from "../socket.mjs";
import { clearReadiedWeapon, clearReadiedWeaponInHand, getReadiedWeaponIds, prepareReadiedWeaponState, setReadiedWeaponInHand } from "../combat/weapon-state.mjs";
import { createModuleChatMessage } from "../compat/chat-message.mjs";
import { hotbarVisibleEffects, openEffectSheet } from "../compat/active-effects.mjs";
import { performanceDiagnostics } from "../performance/performance-monitor.mjs";
import { RenderCoordinator } from "../ui/render-coordinator.mjs";
import { PresentationCache } from "../ui/presentation-cache.mjs";
import { handleCommitInputKeydown } from "../ui/dom-utils.mjs";
import { reactionPenaltyForCount } from "../combat/reaction-penalty-effects.mjs";
import {
  ACTOR_HOTBAR_QUICK_SLOT_CAPACITY,
  commitIntentCategory,
  cycleActorEquipmentStatus,
  executeActorItem,
  executeActorStat,
  executeEvadeIntent,
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
  resolveActorCombatant,
  resolveActorToken,
  resolveHotbarActor,
  toggleIntentCategory,
  toggleActorItemXpCheck,
  updateActorEquipmentQuantity,
  updateActorWeaponHitPoints
} from "../ui/action-catalog.mjs";
import {
  EXPLICIT_HOTBAR_DOCKS,
  HOTBAR_DOCK_DRAG_THRESHOLD,
  HOTBAR_DOCKS,
  HOTBAR_MIN_RESPONSIVE_ACTION_WIDTH,
  HOTBAR_PARTS,
  HOTBAR_REGION_TEMPLATES,
  HOTBAR_REGIONS,
  HOTBAR_TEMPLATE_PATHS,
  HOTBAR_VIEWPORT_MARGIN,
  QUICK_ACCESS_DRAG_MIME,
  QUICK_ACCESS_DRAG_TYPE
} from "./actor-hotbar/constants.mjs";
import { resolveDispositionPalette } from "./actor-hotbar/effects.mjs";
import { quickAccessGeometry } from "./actor-hotbar/quick-access.mjs";
import { regionsForInvalidation } from "./actor-hotbar/regions.mjs";
import {
  finiteResourceNumber,
  normalizeTrackedResourcePath,
  trackedResourceKind
} from "./actor-hotbar/resources.mjs";
import {
  openAttackRollDialog,
  openDelayDialog,
  openDisengageDialog,
  openGrappleRollDialog,
  openKnockbackRollDialog,
  openMissileRollDialog,
  openRunicMagicDialog,
  openUtilityDialog
} from "./actor-hotbar/actions.mjs";
import {
  intentDisplayLabel,
  measureHotbarContextPart,
  measureHotbarContextPartAsync,
  prepareNamedGroups,
  trackedResourceLabel
} from "./actor-hotbar/context.mjs";
import {
  actorHotbarPartsForActiveEffect,
  registerActorHotbarHooks as registerActorHotbarHookRegistry
} from "./actor-hotbar/hooks.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/**
 * Frame-less selected-actor hotbar adapted to Age of Vikings and Skjaldborg.
 *
 * The surface is a viewport overlay anchored on the actor portrait. Position is
 * client-scoped and persisted. All action and resource state is derived from
 * Actor, Item, ActiveEffect, Combat, and Combatant documents.
 */
export class ActorHotbar extends HandlebarsApplicationMixin(ApplicationV2) {
  static current = null;
  static #templatesLoaded = null;
  static #renderQueue = Promise.resolve();

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
    [HOTBAR_PARTS.SHELL]: {
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
    this._delegatedControlsAbort = null;
    this._delegatedControlsRoot = null;
    this._intentUpdatePending = false;
    this._scrollPositions = new Map();
    this._renderedActorKey = null;
  }

  /**
   * Preload the hotbar shell and nested partial templates before first render.
   *
   * @returns {Promise<void>}
   */
  static async preloadTemplates() {
    if (!this.#templatesLoaded) {
      const loadTemplates = foundry.applications?.handlebars?.loadTemplates;
      this.#templatesLoaded = typeof loadTemplates === "function"
        ? loadTemplates(HOTBAR_TEMPLATE_PATHS)
        : Promise.resolve();
    }
    await this.#templatesLoaded;
  }

  /**
   * Ensure the singleton is rendered when the client setting is enabled.
   *
   * @returns {Promise<ActorHotbar|null>}
   */
  static async ensureRendered(renderOptions = {}) {
    return this.#enqueueRender(() => this.#ensureRenderedNow(renderOptions));
  }

  /**
   * Serialize one hotbar render or internal refresh operation.
   *
   * @param {Function} operation Operation to execute after prior render work.
   * @returns {Promise<unknown>}
   */
  static #enqueueRender(operation) {
    const nextRender = this.#renderQueue
      .catch(() => null)
      .then(operation);
    this.#renderQueue = nextRender.catch(() => null);
    return nextRender;
  }

  /**
   * Render the singleton after any previous hotbar render has settled.
   *
   * @param {object} [renderOptions={}] AppV2 render options.
   * @returns {Promise<ActorHotbar|null>}
   */
  static async #ensureRenderedNow(renderOptions = {}) {
    if (!game.settings.get(MODULE_ID, "enableActorHotbar")) {
      await this.#closeCurrentNow();
      return null;
    }

    if (!resolveHotbarActor()) {
      await this.#closeCurrentNow();
      return null;
    }

    if (this.current?.rendered && !this.#currentElement()?.isConnected) await this.#closeCurrentNow();
    if (!this.current) this.current = new ActorHotbar();
    this.pruneStaleRoots(this.#currentElement());
    await this.preloadTemplates();
    const force = renderOptions.force === true || renderOptions.full === true || !this.current.rendered;
    if (force) await this.current.render({ ...renderOptions, force: true, parts: [HOTBAR_PARTS.SHELL] });
    this.pruneStaleRoots(this.#currentElement());
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
   * Render or internally refresh the hotbar after the coordinator flushes.
   *
   * @param {object} [detail={}] Merged invalidation detail.
   * @returns {Promise<ActorHotbar|null>}
   */
  static async renderInvalidated(detail = {}) {
    performanceDiagnostics.count("actorHotbar.render.request", 1, detail);
    const parts = new Set(detail.parts ?? []);
    const regions = this._regionsForInvalidation(parts);
    const full = detail.full === true
      || parts.has(HOTBAR_PARTS.SHELL)
      || parts.has("portrait")
      || !parts.size
      || (!regions.size && parts.size > 0);
    performanceDiagnostics.count(full ? "actorHotbar.render.fullRequest" : "actorHotbar.render.targetedRequest", 1, {
      parts: Array.from(parts),
      regions,
      reason: detail.reason ?? null
    });
    return performanceDiagnostics.measureAsync(
      "actorHotbar.render.complete",
      () => this.#enqueueRender(async () => {
        if (full) return this.#ensureRenderedNow({ full: true });
        const current = await this.#ensureRenderedNow();
        if (!current) return null;
        await current.refreshRegions(regions, detail);
        return current;
      }),
      () => ({ ...detail, regions })
    );
  }

  /**
   * Convert invalidation categories into non-overlapping internal hotbar regions.
   *
   * @param {Set<string>} parts Invalidation parts and cache categories.
   * @returns {string[]} Renderable internal hotbar regions.
   */
  static _regionsForInvalidation(parts) {
    return regionsForInvalidation(parts);
  }

  /**
   * Close the hotbar and restore the core macro bar.
   *
   * @returns {Promise<void>}
   */
  static async closeCurrent() {
    return this.#enqueueRender(() => this.#closeCurrentNow());
  }

  /**
   * Close the current singleton without enqueueing another render operation.
   *
   * @returns {Promise<void>}
   */
  static async #closeCurrentNow() {
    const current = this.current;
    this.current = null;
    document.querySelector("#hotbar")?.classList.remove("skj-core-hotbar-hidden");
    if (current?.rendered) await current.close({ animate: false });
    this.pruneStaleRoots(null);
  }

  /**
   * Return the currently rendered root when AppV2 exposes one.
   *
   * @returns {HTMLElement|null}
   */
  static #currentElement() {
    try {
      const element = this.current?.element ?? null;
      return element instanceof HTMLElement ? element : null;
    } catch (_exception) {
      return null;
    }
  }

  /**
   * Remove stale frame-less hotbar roots left behind by overlapping renders.
   *
   * @param {HTMLElement|null} [currentElement=null] Root that must be preserved.
   * @returns {number} Number of removed roots.
   */
  static pruneStaleRoots(currentElement = null) {
    if (typeof document === "undefined") return 0;
    const currentRoot = currentElement instanceof HTMLElement ? currentElement : null;
    const roots = new Set([
      ...document.querySelectorAll("#aov-skjaldborg-actor-hotbar"),
      ...document.querySelectorAll(".skj-actor-hotbar.application")
    ]);
    let removed = 0;
    for (const root of roots) {
      if (!(root instanceof HTMLElement) || root === currentRoot) continue;
      root.remove();
      removed += 1;
    }
    if (removed) performanceDiagnostics.count("actorHotbar.dom.staleRootsPruned", removed, { removed });
    return removed;
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
    ActorHotbar.pruneStaleRoots(element);
    document.body.append(element);
    ActorHotbar.pruneStaleRoots(element);
  }

  /** @inheritdoc */
  _configureRenderOptions(options) {
    super._configureRenderOptions(options);
    options.parts = [HOTBAR_PARTS.SHELL];
  }

  /** @inheritdoc */
  async _prepareContext(options) {
    const measureId = performanceDiagnostics.markStart("actorHotbar.context");
    try {
      const context = await super._prepareContext(options);
      this.actor = resolveHotbarActor();
      this.combatant = resolveActorCombatant(this.actor, game.combat);
      if (!this.actor) return { ...context, actor: null };
      return {
        ...context,
        ...this._prepareActorIdentityContext(),
        collapsed: !!game.settings.get(MODULE_ID, "actorHotbarCollapsed"),
        dock: this._hotbarDock
      };
    } finally {
      performanceDiagnostics.markEnd(measureId, {
        actorId: this.actor?.id ?? null,
        combatantId: this.combatant?.id ?? null,
        parts: options.parts ?? []
      });
    }
  }

  /** @inheritdoc */
  async _preparePartContext(partId, context, options) {
    context = await super._preparePartContext(partId, context, options);
    if (!this.actor) return context;
    const measureId = performanceDiagnostics.markStart(`actorHotbar.part.${partId}`);
    try {
      if (partId === HOTBAR_PARTS.SHELL) return this._prepareShellPartContext(context);
      return context;
    } finally {
      performanceDiagnostics.markEnd(measureId, {
        part: partId,
        actorId: this.actor?.id ?? null,
        combatantId: this.combatant?.id ?? null
      });
    }
  }

  /**
   * Refresh non-overlapping internal hotbar regions without invoking AppV2 part rendering.
   *
   * @param {string[]} regions Internal region ids.
   * @param {object} [detail={}] Invalidation detail for diagnostics.
   * @returns {Promise<boolean>} Whether the targeted refresh completed.
   */
  async refreshRegions(regions, detail = {}) {
    const requested = new Set(regions ?? []);
    if (!this.rendered || !this.element || !requested.size) return false;
    if (!this.actor) {
      await ActorHotbar.#ensureRenderedNow({ full: true });
      return false;
    }

    this._captureScrollPositions();
    const baseContext = await this._prepareContext({
      parts: [HOTBAR_PARTS.SHELL],
      regions: Array.from(requested)
    });
    if (!baseContext.actor) {
      await ActorHotbar.#ensureRenderedNow({ full: true });
      return false;
    }

    for (const region of requested) {
      const template = HOTBAR_REGION_TEMPLATES[region];
      if (!template) {
        await ActorHotbar.#ensureRenderedNow({ full: true });
        return false;
      }
      const current = this._currentRegionElement(region);
      if (!(current instanceof HTMLElement)) {
        await ActorHotbar.#ensureRenderedNow({ full: true });
        return false;
      }

      const context = await this._prepareRegionContext(region, baseContext);
      const html = await foundry.applications.handlebars.renderTemplate(template, context);
      const replacement = this._regionElementFromHtml(html);
      if (!(replacement instanceof HTMLElement)) {
        await ActorHotbar.#ensureRenderedNow({ full: true });
        return false;
      }

      current.replaceWith(replacement);
      performanceDiagnostics.count("actorHotbar.region.replace", 1, {
        region,
        reason: detail.reason ?? null
      });
    }

    ActorHotbar.pruneStaleRoots(this.element);
    this._syncRenderedWeaponControls();
    this._restoreScrollPositions();
    this._assertHotbarInvariants();
    return true;
  }

  /**
   * Prepare a render context for a single internal region.
   *
   * @param {string} region Internal region id.
   * @param {object} context Base render context.
   * @returns {Promise<object>}
   */
  async _prepareRegionContext(region, context) {
    const measureId = performanceDiagnostics.markStart(`actorHotbar.region.${region}`);
    try {
      if (region === HOTBAR_REGIONS.RESOURCES) return await this._prepareResourcesPartContext(context);
      if (region === HOTBAR_REGIONS.PORTRAIT_QUICK_ACCESS) return this._preparePortraitQuickAccessPartContext(context);
      if (region === HOTBAR_REGIONS.HEADER_EFFECTS) return this._prepareHeaderEffectsPartContext(context);
      if (region === HOTBAR_REGIONS.COMBAT_WORKFLOW) return this._prepareCombatWorkflowPartContext(context);
      if (region === HOTBAR_REGIONS.TAB_BODY) return await this._prepareTabBodyPartContext(context);
      return context;
    } finally {
      performanceDiagnostics.markEnd(measureId, {
        region,
        actorId: this.actor?.id ?? null,
        combatantId: this.combatant?.id ?? null
      });
    }
  }

  /**
   * Resolve the current DOM root for one internal hotbar region.
   *
   * @param {string} region Internal region id.
   * @returns {HTMLElement|null}
   */
  _currentRegionElement(region) {
    const selector = `[data-hotbar-region="${region}"], [data-hotbar-part="${region}"]`;
    const element = this.element?.querySelector?.(selector);
    return element instanceof HTMLElement ? element : null;
  }

  /**
   * Convert rendered region HTML into exactly one element.
   *
   * @param {string|HTMLElement} html Rendered region output.
   * @returns {HTMLElement|null}
   */
  _regionElementFromHtml(html) {
    if (html instanceof HTMLElement) return html;
    const template = document.createElement("template");
    template.innerHTML = String(html ?? "").trim();
    const element = template.content.firstElementChild;
    return element instanceof HTMLElement ? element : null;
  }

  /**
   * Emit debug-only structural counts for the singleton and nested workflow UI.
   *
   * @returns {void}
   */
  _assertHotbarInvariants() {
    if (!game.settings.get(MODULE_ID, "debug")) return;
    const rootCount = document.querySelectorAll("#aov-skjaldborg-actor-hotbar").length;
    const combatStageCount = this.element?.querySelectorAll?.(".skj-combat-stage").length ?? 0;
    const weaponControlCount = this.element?.querySelectorAll?.(".skj-weapon-control-stack").length ?? 0;
    if (rootCount === 1 && combatStageCount <= 1 && weaponControlCount <= 1) return;
    debug("Actor hotbar invariant check failed.", {
      roots: rootCount,
      combatStages: combatStageCount,
      weaponControls: weaponControlCount
    });
  }

  /**
   * Prepare stable actor identity fields shared by every hotbar part.
   *
   * @returns {object}
   */
  _prepareActorIdentityContext() {
    return {
      actor: {
        id: this.actor.id,
        uuid: this.actor.uuid,
        name: this.actor.name,
        img: this.actor.img
      }
    };
  }

  /**
   * Prepare all data needed by the full hotbar shell.
   *
   * @param {object} context Base render context.
   * @returns {Promise<object>}
   */
  async _prepareShellPartContext(context) {
    return this._prepareTabBodyPartContext(
      this._prepareHeaderEffectsPartContext(
        await this._prepareResourcesPartContext(
          this._preparePortraitQuickAccessPartContext(context)
        )
      )
    );
  }

  /**
   * Prepare only the resource pill data.
   *
   * @param {object} context Base render context.
   * @returns {Promise<object>}
   */
  async _prepareResourcesPartContext(context) {
    const resources = await measureHotbarContextPartAsync("resources", () => this._prepareResources());
    return {
      ...context,
      resources,
      singleResource: resources.length === 1
    };
  }

  /**
   * Prepare quick-access portrait data.
   *
   * @param {object} context Base render context.
   * @returns {object}
   */
  _preparePortraitQuickAccessPartContext(context) {
    const prepared = measureHotbarContextPart("actions", () =>
      PresentationCache.get(this.actor, "actions", () => prepareActorActions(this.actor))
    );
    const statGroups = measureHotbarContextPart("stats", () =>
      PresentationCache.get(this.actor, "stats", () => prepareActorStats(this.actor))
    );
    const quickAccess = measureHotbarContextPart("quickAccess", () => this._prepareQuickAccessSlots({
      prepared,
      statGroups
    }));
    const combatData = this._prepareCombatData();
    return {
      ...context,
      quickAccessSlots: quickAccess.slots,
      quickAccessStageSize: quickAccess.stageSize,
      workflow: this._prepareWorkflow(combatData.combat, combatData.combatState, combatData.combatantState)
    };
  }

  /**
   * Prepare active effect icons.
   *
   * @param {object} context Base render context.
   * @returns {object}
   */
  _prepareHeaderEffectsPartContext(context) {
    return {
      ...context,
      effects: measureHotbarContextPart("effects", () => this._prepareEffects())
    };
  }

  /**
   * Prepare intent and workflow controls.
   *
   * @param {object} context Base render context.
   * @returns {object}
   */
  _prepareCombatWorkflowPartContext(context) {
    const combatData = this._prepareCombatData();
    const intentActions = this._prepareIntentActions(combatData);
    return {
      ...this._prepareEquipmentControlsPartContext(context),
      combatActions: intentActions,
      workflow: this._prepareWorkflow(combatData.combat, combatData.combatState, combatData.combatantState),
      hasCombatActions: intentActions.length > 0
    };
  }

  /**
   * Prepare compact weapon controls.
   *
   * @param {object} context Base render context.
   * @returns {object}
   */
  _prepareEquipmentControlsPartContext(context) {
    const combatData = this._prepareCombatData();
    const weaponState = measureHotbarContextPart("weapons", () =>
      PresentationCache.get(this.actor, "weapons", () => prepareReadiedWeaponState(this.actor))
    );
    return {
      ...context,
      weaponState: {
        ...weaponState,
        currentLabel: weaponState.names?.length
          ? weaponState.names.join(", ")
          : game.i18n.localize("AOV_SKJALDBORG.Weapons.None"),
        canManage: combatData.canManageWeapons,
        canRoll: combatData.canManageWeapons && weaponState.carriedWeapons.length > 0,
        selectedIsReadied: weaponState.carriedWeapons.some(weapon => weapon.selected && weapon.readied),
        toggleDisabled: !combatData.canManageWeapons || !weaponState.canDraw,
        dropDisabled: !combatData.canManageWeapons || !weaponState.canSheathe
      }
    };
  }

  /**
   * Prepare the tab panels and tab availability.
   *
   * @param {object} context Base render context.
   * @returns {Promise<object>}
   */
  async _prepareTabBodyPartContext(context) {
    const prepared = measureHotbarContextPart("actions", () =>
      PresentationCache.get(this.actor, "actions", () => prepareActorActions(this.actor))
    );
    const showMacroTab = game.settings.get(MODULE_ID, "replaceCoreHotbar");
    const equipmentGroups = measureHotbarContextPart("equipment", () =>
      PresentationCache.get(this.actor, "equipment", () => prepareActorEquipment(this.actor))
    );
    const showEquipTab = equipmentGroups.length > 0;
    const historyFamily = await measureHotbarContextPartAsync("historyFamily", () =>
      PresentationCache.getAsync(this.actor, "historyFamily", () => prepareActorHistoryFamily(this.actor))
    );
    const showHistoryFamilyTab = this.actor.type === "character" || historyFamily.hasContent;
    const wellbeing = measureHotbarContextPart("wellbeing", () => AoVAdapter.prepareActorWellbeing(this.actor));
    const showWellbeingTab = wellbeing.supported;
    const magicGroups = measureHotbarContextPart("magic", () =>
      PresentationCache.get(this.actor, "magic", () => prepareNamedGroups(prepared.magic, "magic"))
    );
    const showMagicTab = magicGroups.length > 0;
    this._ensureVisibleTab(context, {
      showMacroTab,
      showEquipTab,
      showMagicTab,
      showWellbeingTab,
      showHistoryFamilyTab
    });
    const statGroups = measureHotbarContextPart("stats", () =>
      PresentationCache.get(this.actor, "stats", () => prepareActorStats(this.actor))
    );
    const skillGroups = measureHotbarContextPart("skills", () =>
      PresentationCache.get(this.actor, "skills", () => prepareNamedGroups(prepared.skills, "skills"))
    );
    const macroSlots = showMacroTab ? measureHotbarContextPart("macros", () => this._prepareMacroSlots()) : [];
    return {
      ...this._prepareCombatWorkflowPartContext(context),
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
      hasStatActions: statGroups.length > 0,
      hasSkillActions: skillGroups.length > 0,
      hasMagicActions: magicGroups.length > 0,
      hasEquipment: equipmentGroups.length > 0,
      hasHistoryFamily: historyFamily.hasDisplayContent
    };
  }

  /**
   * Resolve combat values shared by workflow and weapon-control context.
   *
   * @returns {object}
   */
  _prepareCombatData() {
    const combat = game.combat ?? null;
    const workflowActive = isSkjaldborgCombatActive(combat) && !!this.combatant;
    const canControlCombatant = this.combatant
      ? AoVAdapter.canUserControlCombatant(game.user, this.combatant)
      : false;
    const combatantState = this.combatant ? getCombatantState(this.combatant) : null;
    const combatState = workflowActive ? getCombatState(combat) : null;
    return {
      combat,
      workflowActive,
      canControlCombatant,
      canDeclareIntent: this.actor.isOwner && (!this.combatant || canControlCombatant),
      canManageWeapons: this.actor.isOwner && (!this.combatant || canControlCombatant),
      combatantState,
      combatState
    };
  }

  /**
   * Prepare intent controls from current prepared or committed intent state.
   *
   * @param {object} combatData Shared combat values.
   * @returns {object[]}
   */
  _prepareIntentActions(combatData) {
    if (!combatData.canDeclareIntent) return [];
    const preparedIntent = getActorPreparedIntent(this.actor);
    const committedIntent = combatData.workflowActive
      && [INTENT_STATUS.COMMITTED, INTENT_STATUS.HELD].includes(combatData.combatantState?.intent?.status);
    const displayedIntent = committedIntent ? combatData.combatantState.intent : preparedIntent;
    return prepareIntentActions({
      selectedCategory: displayedIntent?.actionCategory ?? null,
      otherText: displayedIntent?.publicText ?? ""
    });
  }

  /**
   * Keep AppV2 tab state on a rendered tab when optional tabs disappear.
   *
   * @param {object} context Render context.
   * @param {object} visibility Tab visibility flags.
   * @returns {void}
   */
  _ensureVisibleTab(context, visibility) {
    const activeTab = this.tabGroups?.sheet;
    const hiddenActiveTab = (!visibility.showMacroTab && activeTab === "macros")
      || (!visibility.showEquipTab && activeTab === "equip")
      || (!visibility.showMagicTab && activeTab === "magic")
      || (!visibility.showWellbeingTab && activeTab === "wellbeing")
      || (!visibility.showHistoryFamilyTab && activeTab === "historyFamily");
    if (!hiddenActiveTab) return;
    this.tabGroups.sheet = "combat";
    if (context.tabs?.[activeTab]) {
      context.tabs[activeTab].cssClass = context.tabs[activeTab].cssClass.replace("active", "").trim();
    }
    if (context.tabs?.combat) {
      context.tabs.combat.cssClass = [context.tabs.combat.cssClass, "active"].filter(Boolean).join(" ");
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
    return hotbarVisibleEffects(this.actor)
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
    const categoryLabel = active ? intentDisplayLabel(category, combatantState?.intent?.publicText ?? "") : "";
    const statusLabel = active ? game.i18n.localize(`AOV_SKJALDBORG.IntentStatus.${status}`) : "";
    const reactions = Number(combatantState?.reactionCount ?? 0);
    const reactionPenalty = reactionPenaltyForCount(reactions);
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
      category: categoryLabel,
      status,
      statusLabel: categoryLabel,
      statusTooltip: active ? `${statusLabel}: ${categoryLabel}` : "",
      dex: Number(finalDex ?? 0),
      reactions,
      reactionPenalty,
      reactionTooltip: active
        ? game.i18n.format("AOV_SKJALDBORG.ActorHotbar.ReactionPenaltyHint", {
            count: reactions,
            penalty: reactionPenalty
          })
        : ""
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
    ActorHotbar.pruneStaleRoots(this.element);
    this._syncCoreHotbarVisibility();
    this._applyClientDimensions();
    this._applyThemeClass();
    this._applyOverlayPositioning();
    this._restoreOrInitializePosition();
    this._activateDockDragging();
    this._activatePositionDragging();
    this._activateDelegatedControls();
    this._syncRenderedWeaponControls();
    this._restoreScrollPositions();
    this._assertHotbarInvariants();
  }

  /** @inheritdoc */
  _replaceHTML(result, content, options) {
    return super._replaceHTML(result, content, options);
  }

  /** @inheritdoc */
  _onClose(options) {
    this._cancelDockDrag();
    this._cancelPositionDrag();
    this._delegatedControlsAbort?.abort();
    this._delegatedControlsAbort = null;
    this._delegatedControlsRoot = null;
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
    if (handle.dataset.skjDockDraggingBound === "true") return;
    handle.dataset.skjDockDraggingBound = "true";
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
    if (handle.dataset.skjPositionDraggingBound === "true") return;
    handle.dataset.skjPositionDraggingBound = "true";
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
   * Bind ordinary controls with one listener per event type on the rendered root.
   *
   * AppV2 replaces the hotbar HTML during render, so root-scoped delegation
   * avoids repeated query-and-bind loops while keeping native form semantics.
   *
   * @returns {void}
   */
  _activateDelegatedControls() {
    if (this._delegatedControlsRoot === this.element) return;
    this._delegatedControlsAbort?.abort();
    const abort = new AbortController();
    this._delegatedControlsAbort = abort;
    this._delegatedControlsRoot = this.element;
    const options = { signal: abort.signal };
    const captureOptions = { ...options, capture: true };
    this.element.addEventListener("pointerdown", event => this._onDelegatedCapturePointerDown(event), captureOptions);
    this.element.addEventListener("auxclick", event => this._onDelegatedAuxClick(event), captureOptions);
    this.element.addEventListener("contextmenu", event => this._onDelegatedContextMenu(event), captureOptions);
    this.element.addEventListener("keydown", event => this._onDelegatedKeydown(event), options);
    this.element.addEventListener("change", event => this._onDelegatedChange(event), options);
    this.element.addEventListener("pointerdown", event => this._onDelegatedPointerDown(event), options);
    this.element.addEventListener("dragstart", event => this._onDelegatedDragStart(event), options);
    this.element.addEventListener("dragend", event => this._onDelegatedDragEnd(event), options);
    this.element.addEventListener("dragover", event => this._onDelegatedDragOver(event), options);
    this.element.addEventListener("dragleave", event => this._onDelegatedDragLeave(event), options);
    this.element.addEventListener("drop", event => this._onDelegatedDrop(event), options);
    this.element.addEventListener("scroll", event => this._onDelegatedScroll(event), {
      ...options,
      capture: true,
      passive: true
    });
  }

  /**
   * Resolve an input matching a selector from a delegated event.
   *
   * @param {Event} event Delegated DOM event.
   * @param {string} selector Selector for the editable input.
   * @returns {HTMLInputElement|null}
   */
  _inputFromDelegatedEvent(event, selector) {
    const target = event.target instanceof Element ? event.target.closest(selector) : null;
    return target instanceof HTMLInputElement ? target : null;
  }

  /**
   * Handle Enter/Escape commit ergonomics for hotbar inline inputs.
   *
   * @param {KeyboardEvent} event Delegated key event.
   * @returns {void}
   */
  _onDelegatedKeydown(event) {
    if (!(event.target instanceof Element)) return;
    if (!event.target.closest("[data-resource-input], [data-wellbeing-damage], [data-equipment-quantity], [data-weapon-hp]")) return;
    handleCommitInputKeydown(event);
  }

  /**
   * Track scroll positions through one root listener.
   *
   * @param {Event} event Delegated scroll event.
   * @returns {void}
   */
  _onDelegatedScroll(event) {
    const target = event.target instanceof Element ? event.target.closest("[data-scroll-state]") : null;
    if (!(target instanceof HTMLElement)) return;
    const actorKey = this._actorScrollKey();
    const id = target.dataset.scrollState;
    if (!actorKey || !id) return;
    this._scrollPositions.set(`${actorKey}:${id}`, {
      top: target.scrollTop,
      left: target.scrollLeft
    });
  }

  /**
   * Route delegated input changes to their deterministic document writes.
   *
   * @param {Event} event Delegated change event.
   * @returns {void}
   */
  _onDelegatedChange(event) {
    if (this._inputFromDelegatedEvent(event, "[data-resource-input]")) {
      void this._commitResourceInput(event);
      return;
    }
    if (this._inputFromDelegatedEvent(event, "[data-wellbeing-damage]")) {
      void this._commitWellbeingDamage(event);
      return;
    }
    if (this._inputFromDelegatedEvent(event, "[data-equipment-quantity]")) {
      void this._commitEquipmentQuantity(event);
      return;
    }
    if (this._inputFromDelegatedEvent(event, "[data-weapon-hp]")) {
      void this._commitWeaponHitPoints(event);
      return;
    }

    const select = event.target instanceof Element
      ? event.target.closest("[data-readied-weapon-select]")
      : null;
    if (select instanceof HTMLSelectElement) this._syncRenderedWeaponControls();
  }

  /**
   * Determine whether a delegated event targets an action-like control.
   *
   * @param {Event} event Delegated DOM event.
   * @returns {HTMLElement|null}
   */
  _actionControlFromDelegatedEvent(event) {
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest?.(".skj-avatar-button, [data-hotbar-dock-handle]")) return null;
    const control = target?.closest?.([
      "[data-intent-action-control]",
      "[data-quick-slot-index]",
      "[data-reaction-control]",
      "[data-post-item-description]",
      '[data-action-kind="item"]',
      "[data-readied-weapon-toggle]",
      "[data-action=\"dropReadiedWeapon\"]",
      "[data-action=\"rollSelectedWeapon\"]"
    ].join(", "));
    return control instanceof HTMLElement ? control : null;
  }

  /**
   * Temporarily disable a draggable parent while a secondary click resolves.
   *
   * @param {Element|null|undefined} control Interaction control.
   * @returns {void}
   */
  _temporarilyDisableDragSource(control) {
    const source = control?.closest?.('[draggable="true"]');
    if (!(source instanceof HTMLElement)) return;
    source.draggable = false;
    const abort = new AbortController();
    const restore = () => {
      if (source.isConnected) source.draggable = true;
      abort.abort();
    };
    window.addEventListener("pointerup", restore, { once: true, signal: abort.signal });
    window.addEventListener("pointercancel", restore, { once: true, signal: abort.signal });
    window.addEventListener("contextmenu", restore, { once: true, signal: abort.signal });
    window.addEventListener("auxclick", restore, { once: true, signal: abort.signal });
  }

  /**
   * Stop secondary-button presses before AppV2 activation or drag handlers see them.
   *
   * @param {PointerEvent} event Delegated pointer event.
   * @returns {void}
   */
  _onDelegatedCapturePointerDown(event) {
    if (event.button !== 2) return;
    const control = this._actionControlFromDelegatedEvent(event);
    if (!control) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    this._temporarilyDisableDragSource(control);
  }

  /**
   * Suppress browser auxclick delivery after right-click context actions.
   *
   * @param {MouseEvent} event Delegated auxclick event.
   * @returns {void}
   */
  _onDelegatedAuxClick(event) {
    if (event.button !== 2) return;
    const control = this._actionControlFromDelegatedEvent(event);
    if (!control) return;
    event.preventDefault();
    event.stopImmediatePropagation();
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
    const input = this._inputFromDelegatedEvent(event, "[data-resource-input]");
    if (!input) return;
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
   * Persist one wellbeing damage edit through the AoV adapter.
   *
   * @param {Event} event Input change event.
   * @returns {Promise<void>}
   */
  async _commitWellbeingDamage(event) {
    const input = this._inputFromDelegatedEvent(event, "[data-wellbeing-damage]");
    if (!input) return;
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
   * Keep the readied-weapon toggle label aligned with the selected weapon.
   *
   * @returns {void}
   */
  _syncRenderedWeaponControls() {
    const select = this.element.querySelector("[data-readied-weapon-select]");
    const toggle = this.element.querySelector("[data-readied-weapon-toggle]");
    if (!select || !toggle) return;
    this._syncWeaponToggle(toggle, select);
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
    const current = getReadiedWeaponIds(this.actor);
    const isReadiedSelection = !!selectedWeaponId
      && (selectedWeaponId === String(current.right ?? "") || selectedWeaponId === String(current.left ?? ""));
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
    const input = this._inputFromDelegatedEvent(event, "[data-equipment-quantity]");
    if (!input) return;
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
    const input = this._inputFromDelegatedEvent(event, "[data-weapon-hp]");
    if (!input) return;
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
   * Route right-click behavior for actor-owned items and combat controls.
   *
   * Native form-field context menus are preserved for editable inputs.
   *
   * @param {PointerEvent} event Delegated context-menu event.
   * @returns {void}
   */
  _onDelegatedContextMenu(event) {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;

    const quickSlot = target.closest("[data-quick-slot-index]");
    if (quickSlot instanceof HTMLElement) {
      event.preventDefault();
      event.stopImmediatePropagation();
      void this._removeQuickAccessAction(Number(quickSlot.dataset.quickSlotIndex));
      return;
    }

    if (target.closest("input, textarea, select")) return;

    const intentControl = target.closest("[data-intent-action-control]");
    if (intentControl instanceof HTMLElement) {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (intentControl.dataset.actionKind === "utility" || intentControl.dataset.actionId === UTILITY_ACTION_ID) {
        void openUtilityDialog({ actor: this.actor, combatant: this.combatant, combat: game.combat ?? null, originEvent: event });
        return;
      }
      void this._commitIntentAction(intentControl.dataset.actionId);
      return;
    }

    const reactionControl = target.closest("[data-reaction-control]");
    if (reactionControl instanceof HTMLElement) {
      event.preventDefault();
      event.stopImmediatePropagation();
      void this._queueReactionChange("decrementReaction");
      return;
    }

    const postControl = target.closest("[data-post-item-description]");
    if (postControl instanceof HTMLElement) {
      event.preventDefault();
      event.stopImmediatePropagation();
      void this._postItemDescriptionToChat(postControl.dataset.postItemDescription);
      return;
    }

    const itemControl = target.closest('[data-action-kind="item"]:not([data-quick-slot-index])');
    if (itemControl instanceof HTMLElement && !itemControl.closest("[data-post-item-description]")) {
      event.preventDefault();
      event.stopImmediatePropagation();
      void openActorItem(this.actor, itemControl.dataset.actionId);
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
   * Temporarily disable parent drags for nested XP and magic toggles.
   *
   * @param {PointerEvent} event Delegated pointer event.
   * @returns {void}
   */
  _onDelegatedPointerDown(event) {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    if (event.button === 2) {
      const actionControl = target.closest("[data-action], [data-intent-action-control]");
      const source = actionControl?.closest?.('[draggable="true"]');
      if (!(source instanceof HTMLElement)) return;
      source.draggable = false;
      const abort = new AbortController();
      const restore = () => {
        if (source.isConnected) source.draggable = true;
        abort.abort();
      };
      window.addEventListener("pointerup", restore, { once: true, signal: abort.signal });
      window.addEventListener("pointercancel", restore, { once: true, signal: abort.signal });
      window.addEventListener("contextmenu", restore, { once: true, signal: abort.signal });
      return;
    }

    const toggle = target
      ? target.closest("[data-xp-toggle], [data-magic-prepared-toggle]")
      : null;
    if (!(toggle instanceof HTMLElement)) return;
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
  }

  /**
   * Resolve a delegated hotbar drag source.
   *
   * @param {DragEvent} event Delegated drag event.
   * @returns {HTMLElement|null}
   */
  _dragSourceFromDelegatedEvent(event) {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return null;
    const source = target.closest("[data-quick-source][draggable=true], [data-drag-group][draggable=true], .skj-quick-slot[draggable=true]");
    return source instanceof HTMLElement ? source : null;
  }

  /**
   * Start quick-access or reorder drag data from one delegated listener.
   *
   * @param {DragEvent} event Delegated drag event.
   * @returns {void}
   */
  _onDelegatedDragStart(event) {
    const dragTarget = event.target instanceof Element ? event.target : null;
    if (dragTarget?.closest("[data-xp-toggle], [data-magic-prepared-toggle]")) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (dragTarget?.closest("[data-intent-action-control]") && Number(event.buttons) === 2) {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    const source = this._dragSourceFromDelegatedEvent(event);
    if (!source) return;
    if (!event.dataTransfer) return;

    const kind = source.dataset.quickKind ?? source.dataset.actionKind ?? "";
    const id = source.dataset.quickId ?? source.dataset.actionId ?? "";
    const sourceSlot = source.dataset.quickSlotIndex;
    this._dragData = source.dataset.dragGroup ? {
      id,
      group: source.dataset.dragGroup,
      section: source.dataset.actionSection ?? ""
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
    source.classList.add("dragging");
  }

  /**
   * Clear delegated drag state.
   *
   * @returns {void}
   */
  _onDelegatedDragEnd() {
    this._dragData = null;
    this._quickDragData = null;
    this.element.classList.remove("skj-quick-drag-active");
    this.element.querySelectorAll(".dragging, .drop-target, .quick-drop-target, .quick-auto-preview").forEach(element => {
      element.classList.remove("dragging", "drop-target", "quick-drop-target", "quick-auto-preview");
    });
  }

  /**
   * Route quick-access slot and portrait drag-over events.
   *
   * @param {DragEvent} event Delegated drag event.
   * @returns {void}
   */
  _onDelegatedDragOver(event) {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;

    const reorderTarget = target.closest("[data-drag-group][draggable=true]");
    if (reorderTarget instanceof HTMLElement) {
      const sameGroup = this._dragData?.group === reorderTarget.dataset.dragGroup;
      const sameSection = (this._dragData?.section ?? "") === (reorderTarget.dataset.actionSection ?? "");
      if (sameGroup && sameSection) {
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        reorderTarget.classList.add("drop-target");
        return;
      }
    }

    const payload = this._readQuickAccessDragData(event);
    if (!payload) return;

    const slot = target.closest("[data-quick-slot-index]");
    if (slot instanceof HTMLElement) {
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = Number.isInteger(payload.sourceSlot) ? "move" : "copy";
      slot.classList.add("quick-drop-target");
      return;
    }

    const portraitTarget = target.closest("[data-quick-auto-target]");
    if (!(portraitTarget instanceof HTMLElement)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = Number.isInteger(payload.sourceSlot) ? "move" : "copy";
    portraitTarget.classList.add("quick-drop-target");
    portraitTarget.parentElement?.classList.add("quick-drop-target");
    this.element.querySelectorAll(".skj-quick-slot.empty").forEach(slotElement => slotElement.classList.add("quick-auto-preview"));
  }

  /**
   * Clear quick-access drag affordances when leaving delegated drop targets.
   *
   * @param {DragEvent} event Delegated drag-leave event.
   * @returns {void}
   */
  _onDelegatedDragLeave(event) {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    const reorderTarget = target.closest("[data-drag-group][draggable=true]");
    if (reorderTarget instanceof HTMLElement) {
      reorderTarget.classList.remove("drop-target");
      return;
    }

    const slot = target.closest("[data-quick-slot-index]");
    if (slot instanceof HTMLElement) {
      slot.classList.remove("quick-drop-target");
      return;
    }

    const portraitTarget = target.closest("[data-quick-auto-target]");
    if (!(portraitTarget instanceof HTMLElement)) return;
    if (event.relatedTarget instanceof Node && portraitTarget.contains(event.relatedTarget)) return;
    portraitTarget.classList.remove("quick-drop-target");
    portraitTarget.parentElement?.classList.remove("quick-drop-target");
    this.element.querySelectorAll(".skj-quick-slot.quick-auto-preview").forEach(slotElement => {
      slotElement.classList.remove("quick-auto-preview");
    });
  }

  /**
   * Route quick-access slot and portrait drops.
   *
   * @param {DragEvent} event Delegated drop event.
   * @returns {void}
   */
  _onDelegatedDrop(event) {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    const reorderTarget = target.closest("[data-drag-group][draggable=true]");
    if (reorderTarget instanceof HTMLElement) {
      const sameGroup = this._dragData?.group === reorderTarget.dataset.dragGroup;
      const sameSection = (this._dragData?.section ?? "") === (reorderTarget.dataset.actionSection ?? "");
      if (sameGroup && sameSection) {
        event.preventDefault();
        reorderTarget.classList.remove("drop-target");
        void this._dropAction(reorderTarget);
        return;
      }
    }

    const slot = target.closest("[data-quick-slot-index]");
    if (slot instanceof HTMLElement) {
      void this._dropQuickAccessAction(event, slot);
      return;
    }

    const portraitTarget = target.closest("[data-quick-auto-target]");
    if (portraitTarget instanceof HTMLElement) {
      void this._dropQuickAccessActionOnPortrait(event, portraitTarget);
    }
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
   * @param {"right"|"left"} [hand="right"] Target hand.
   * @returns {Promise<unknown|null>} Completed document operation.
   */
  async _performWeaponAction(action, weaponId = null, hand = "right") {
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
          weaponId,
          hand
        });
      } else if (action === "draw") {
        result = await setReadiedWeaponInHand(this.actor, hand, weaponId);
      } else {
        result = await clearReadiedWeaponInHand(this.actor, hand);
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
    if (event instanceof MouseEvent && event.button !== 0) {
      event.stopImmediatePropagation();
      return null;
    }
    const kind = target.dataset.actionKind;
    const actionId = target.dataset.actionId;

    if (kind === "item") return executeActorItem(this.actor, actionId, event);
    if (kind === "stat") return executeActorStat(this.actor, actionId, event);
    if (kind === "macro") return executeMacro(actionId);
    if (kind === "utility" || actionId === UTILITY_ACTION_ID) {
      return openUtilityDialog({ actor: this.actor, combatant: this.combatant, combat: game.combat ?? null, originEvent: event });
    }
    if (kind === "effect") {
      const effect = this.actor?.effects?.get?.(actionId)
        ?? Array.from(this.actor?.effects ?? []).find(candidate => candidate?.id === actionId)
        ?? null;
      return openEffectSheet(effect);
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
        if (actionId === ACTION_CATEGORIES.OTHER) {
          return this._commitIntentAction(actionId);
        }
        if (actionId === ACTION_CATEGORIES.ATTACK) {
          return openAttackRollDialog({ actor: this.actor, originEvent: event });
        }
        if (actionId === ACTION_CATEGORIES.MISSILE) {
          return openMissileRollDialog({ actor: this.actor, originEvent: event });
        }
        if (actionId === ACTION_CATEGORIES.KNOCKBACK) {
          return openKnockbackRollDialog({ actor: this.actor, originEvent: event });
        }
        if (actionId === ACTION_CATEGORIES.GRAPPLE) {
          return openGrappleRollDialog({ actor: this.actor, originEvent: event });
        }
        if (actionId === ACTION_CATEGORIES.DELAY) {
          return openDelayDialog({ actor: this.actor, combatant: this.combatant, combat: game.combat ?? null, originEvent: event });
        }
        if (actionId === ACTION_CATEGORIES.MAGIC) {
          return openRunicMagicDialog({ actor: this.actor, combatant: this.combatant, combat: game.combat ?? null, originEvent: event });
        }
        if (actionId === ACTION_CATEGORIES.RETREAT) {
          return openDisengageDialog({ actor: this.actor, combatant: this.combatant, combat: game.combat ?? null, originEvent: event });
        }
        if (actionId === ACTION_CATEGORIES.DEFEND) {
          return executeEvadeIntent(this.actor, this.combatant, game.combat ?? null);
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
    if (this._intentUpdatePending) return null;
    this._intentUpdatePending = true;
    try {
      const combat = game.combat ?? null;
      const liveCombatant = resolveActorCombatant(this.actor, combat) ?? this.combatant;
      const result = await toggleIntentCategory(
        this.actor,
        liveCombatant,
        combat,
        actionId,
        { promptOther: true }
      );
      return result;
    } finally {
      this._intentUpdatePending = false;
    }
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
    const current = getReadiedWeaponIds(this.actor);
    if (weaponId === String(current.right ?? "")) return this._performWeaponAction("sheathe", weaponId, "right");
    if (weaponId === String(current.left ?? "")) return this._performWeaponAction("sheathe", weaponId, "left");
    const hand = current.right ? (current.left ? "right" : "left") : "right";
    return this._performWeaponAction("draw", weaponId, hand);
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
    return this.actor?.sheet?.render?.({ force: true }) ?? null;
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
      return document?.sheet?.render?.({ force: true }) ?? null;
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
}

/**
 * Register actor-hotbar render hooks once.
 *
 * @returns {void}
 */
export function registerActorHotbarHooks(hooks = globalThis.Hooks) {
  return registerActorHotbarHookRegistry(ActorHotbar, hooks);
}

export const __test = {
  actorHotbarPartsForActiveEffect
};
