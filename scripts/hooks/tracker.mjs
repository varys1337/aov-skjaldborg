import { AoVAdapter } from "../adapter/aov-adapter.mjs";
import {
  ACTION_CATEGORIES,
  INTENT_STATUS,
  MOVEMENT_PLAN_STATUS,
  PHASES,
  RESOLUTION_STATUS
} from "../constants.mjs";
import { getCombatState, getCombatantState, phaseLabelKey } from "../combat/state.mjs";
import { reactionPenaltyForCount } from "../combat/reaction-penalty-effects.mjs";
import { getEnabledPhases } from "../combat/phase-structure.mjs";
import { getCombatOptions, getReadiedWeaponList } from "../combat/weapon-state.mjs";
import { movementEngagementEligibility } from "../combat/movement-eligibility.mjs";
import { requestGm } from "../socket.mjs";
import { canUserViewMovementDetails } from "../permissions.mjs";
import {
  combatantFromTrackerRow,
  combatFromTrackerApp,
  elementFromTrackerHook,
  trackerCombatantRows,
  trackerHeaderElement
} from "../compat/tracker-adapter.mjs";
import { htmlEscape } from "../ui/dom-utils.mjs";
import { performanceDiagnostics } from "../performance/performance-monitor.mjs";

const INTENT_STATUS_ICONS = Object.freeze({
  [INTENT_STATUS.UNCOMMITTED]: "fa-circle-question",
  [INTENT_STATUS.COMMITTED]: "fa-circle-check",
  [INTENT_STATUS.HELD]: "fa-hand"
});

/**
 * Localize a key.
 *
 * @param {string} key Localization key.
 * @returns {string}
 */
function localize(key) {
  return game.i18n.localize(key);
}

function formatCompactNumber(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "0";
  return Number(numeric.toFixed(1)).toString();
}

/**
 * Render a small tracker control button.
 *
 * @param {{action: string, icon: string, label: string, phase?: string, disabled?: boolean, active?: boolean}} config Button configuration.
 * @returns {string}
 */
function button({ action, icon, label, phase, disabled = false, active = false }) {
  const safeLabel = htmlEscape(label);
  const pressed = active ? 'aria-current="step"' : "";
  return `
    <button type="button" class="skj-button ${active ? "active" : ""}" data-skj-action="${action}" ${phase ? `data-phase="${phase}"` : ""} ${disabled ? "disabled" : ""} data-tooltip="${safeLabel}" aria-label="${safeLabel}" ${pressed}>
      <i class="fa-solid ${icon}" inert></i>
    </button>
  `;
}

/**
 * Render the tracker header phase bar.
 *
 * @param {Combat} combat Foundry Combat document.
 * @param {import("../types.mjs").SkjaldborgCombatState} state Current combat state.
 * @returns {string}
 */
function renderPhaseBar(combat, state) {
  const phaseButtons = getEnabledPhases().map(phase => button({
    action: "advance-phase",
    phase,
    icon: {
      [PHASES.INTENT]: "fa-comment-dots",
      [PHASES.MOVEMENT]: "fa-person-running",
      [PHASES.RESOLUTION]: "fa-swords",
      [PHASES.BOOKKEEPING]: "fa-scroll"
    }[phase],
    label: localize(phaseLabelKey(phase)),
    active: state.phase === phase,
    disabled: !game.user.isGM
  })).join("");

  const navigationLabel = htmlEscape(localize("AOV_SKJALDBORG.Controls.PhaseNavigation"));
  const movementStatus = htmlEscape(localize(`AOV_SKJALDBORG.MovementStatus.${state.movementRun?.status ?? "none"}`));

  return `
    <section class="skj-phasebar" data-combat-id="${combat?.id ?? ""}">
      <nav class="skj-phasebar-main" aria-label="${navigationLabel}">
        <div class="skj-phase-buttons">${phaseButtons}</div>
        <div class="skj-movement-run">${localize("AOV_SKJALDBORG.Labels.Movement")}: ${movementStatus}</div>
      </nav>
    </section>
  `;
}

/**
 * Render the current combatant workflow status as a compact pill.
 *
 * @param {import("../types.mjs").SkjaldborgCombatantState} state Combatant state.
 * @returns {string}
 */
function renderCombatantStatus(state) {
  const candidate = state.intent?.status;
  const status = Object.values(INTENT_STATUS).includes(candidate) ? candidate : INTENT_STATUS.UNCOMMITTED;
  const icon = INTENT_STATUS_ICONS[status] ?? "fa-circle-question";
  const statusLabel = localize(`AOV_SKJALDBORG.IntentStatus.${status}`);
  const category = Object.values(ACTION_CATEGORIES).includes(state.intent?.actionCategory)
    ? state.intent.actionCategory
    : null;
  const categoryLabel = category ? localize(`AOV_SKJALDBORG.ActionCategories.${category}`) : "";
  const text = status !== INTENT_STATUS.UNCOMMITTED && categoryLabel
    ? categoryLabel
    : statusLabel;
  const label = status !== INTENT_STATUS.UNCOMMITTED && categoryLabel
    ? `${statusLabel}: ${categoryLabel}`
    : statusLabel;
  const categoryClass = category ? `intent-${category}` : "intent-uncommitted";
  return renderIndicator({
    className: `status-action skj-pill skj-combatant-status ${status} ${categoryClass}`,
    icon,
    label,
    text
  });
}

/**
 * Render one compact workflow indicator.
 *
 * @param {{className?: string, icon: string, label: string, text?: string}} config Indicator configuration.
 * @returns {string}
 */
function renderIndicator({ className = "", icon, label, text = "" }) {
  const safeLabel = htmlEscape(label);
  const safeText = htmlEscape(text);
  return `<span class="skj-tracker-indicator ${className}" data-tooltip="${safeLabel}" aria-label="${safeLabel}"><i class="fa-solid ${icon}" inert></i>${safeText ? `<span>${safeText}</span>` : ""}</span>`;
}

const NATIVE_TRACKER_TOOLTIP_FALLBACKS = Object.freeze({
  "COMBAT.ToggleVis": "Toggle visibility",
  "COMBAT.ToggleDead": "Toggle defeated",
  "COMBAT.ToggleDefeated": "Toggle defeated",
  "COMBAT.PingCombatant": "Ping combatant"
});
const TRACKER_EVENT_BINDING = Symbol("aovSkjaldborgTrackerEventBinding");

/**
 * Replace unresolved native AoV/Foundry tracker tooltip keys with readable text.
 *
 * The core v14 tooltip manager localizes `data-tooltip`, but if the owning
 * system emits a key which is not present in the active dictionary the raw key
 * becomes visible to users. This pass keeps module-owned decorations separate
 * while repairing those native controls after the tracker has rendered.
 *
 * @param {HTMLElement} element Tracker root element.
 * @returns {void}
 */
function localizeNativeTrackerTooltips(element) {
  const candidates = Array.from(element.querySelectorAll("[data-tooltip], [aria-label], [title]"));
  for (const control of candidates) {
    for (const [key, fallback] of Object.entries(NATIVE_TRACKER_TOOLTIP_FALLBACKS)) {
      const localized = game.i18n.localize(key);
      const label = localized && localized !== key ? localized : fallback;
      if (control.getAttribute("data-tooltip") === key) control.setAttribute("data-tooltip", label);
      if (control.getAttribute("aria-label") === key) control.setAttribute("aria-label", label);
      if (control.getAttribute("title") === key) control.setAttribute("title", label);
    }
  }
}

/**
 * Build compact intent, movement, equipment, and resolution indicators.
 *
 * The indicators are deliberately derived from persisted Combatant and Combat
 * state only. They do not write movement data or influence phase execution.
 *
 * @param {Combatant} combatant Foundry Combatant document.
 * @param {import("../types.mjs").SkjaldborgCombatantState} state Combatant state.
 * @param {import("../types.mjs").SkjaldborgCombatState} combatState Combat state.
 * @returns {string}
 */
function renderIntentIndicators(combatant, state, combatState) {
  const reactionPenalty = reactionPenaltyForCount(state.reactionCount);
  const indicators = [
    renderIndicator({
      className: "reactions",
      icon: "fa-shield-halved",
      label: game.i18n.format("AOV_SKJALDBORG.Labels.NextReactionPenalty", { penalty: reactionPenalty }),
      text: `${reactionPenalty}%`
    })
  ];

  const movement = state.movement ?? {};
  const movementStatus = movement.planStatus ?? "none";
  const distance = Number(movement.distance ?? 0);
  if ([
    MOVEMENT_PLAN_STATUS.PLANNED,
    MOVEMENT_PLAN_STATUS.EXECUTING,
    MOVEMENT_PLAN_STATUS.COMPLETED,
    MOVEMENT_PLAN_STATUS.STOPPED
  ].includes(movementStatus) && distance > 0) {
    const waypointCount = Math.max(
      Array.isArray(movement.route) ? movement.route.length : 0,
      Array.isArray(movement.waypoints) ? movement.waypoints.length : 0
    );
    const units = String(movement.units ?? "").trim();
    const statusLabel = localize(`AOV_SKJALDBORG.MovementStatus.${movementStatus}`);
    const canSeeMovement = canUserViewMovementDetails(game.user, combatant);
    const shortText = canSeeMovement
      ? `${distance}${units ? ` ${units}` : ""}`
      : localize("AOV_SKJALDBORG.Tracker.HiddenMovement");
    const eligibility = movementEngagementEligibility(combatant, distance);
    const cannotEngage = !eligibility.canEngage;
    const movementLabel = canSeeMovement
      ? game.i18n.format("AOV_SKJALDBORG.Tracker.MovementPlan", {
        status: statusLabel,
        distance,
        units,
        waypoints: waypointCount
      })
      : game.i18n.format("AOV_SKJALDBORG.Tracker.HiddenMovementPlan", { status: statusLabel });
    const label = canSeeMovement && cannotEngage
      ? `${movementLabel}; ${game.i18n.format("AOV_SKJALDBORG.Tracker.CantEngage", {
        gridUnits: formatCompactNumber(eligibility.gridUnits),
        limit: eligibility.limit
      })}`
      : movementLabel;
    indicators.push(renderIndicator({
      className: `movement ${movementStatus}${cannotEngage ? " cannot-engage" : ""}${canSeeMovement ? "" : " hidden-detail"}`,
      icon: "fa-route",
      label,
      text: shortText
    }));
  }

  const actor = combatant?.actor ?? combatant?.token?.actor ?? null;
  const readiedWeapons = getReadiedWeaponList(actor);
  if (readiedWeapons.length) {
    const weaponNames = readiedWeapons.map(weapon => weapon.name).join(", ");
    indicators.push(renderIndicator({
      className: "readied-weapon",
      icon: "fa-sword",
      label: game.i18n.format("AOV_SKJALDBORG.Tracker.ReadiedWeapon", { weapon: weaponNames }),
      text: weaponNames
    }));
  }
  if (getCombatOptions(actor).shieldwall.enabled) {
    indicators.push(renderIndicator({
      className: "shieldwall",
      icon: "fa-shield",
      label: game.i18n.localize("AOV_SKJALDBORG.Utility.ShieldwallEnabled"),
      text: game.i18n.localize("AOV_SKJALDBORG.Utility.ShieldwallShort")
    }));
  }

  return `<div class="skj-combatant-indicators" data-skj-intent-indicators>${indicators.join("")}</div>`;
}

/**
 * Resolve the compact native combatant control row for upper status insertion.
 *
 * @param {HTMLElement} row Combatant tracker row.
 * @returns {HTMLElement|null}
 */
function findCombatantControlRow(row) {
  return row.querySelector(".combatant-controls, .token-controls, [data-combatant-controls]")
    ?? row.querySelector(".token-name")?.querySelector(".combatant-control, .token-control, [data-control]")?.parentElement
    ?? null;
}

/**
 * Render compact per-combatant metrics below the native tracker controls.
 *
 * @param {Combatant} combatant Foundry Combatant document.
 * @param {import("../types.mjs").SkjaldborgCombatantState} state Combatant state.
 * @param {import("../types.mjs").SkjaldborgCombatState} combatState Combat state.
 * @returns {string}
 */
function renderCombatantDetails(combatant, state, combatState) {
  const activeAction = (combatState.resolutionQueue ?? []).find(a => a.combatantId === combatant.id && a.status === RESOLUTION_STATUS.ACTIVE);
  const publicText = state.intent?.publicText
    ? `<span class="skj-public-intent">${htmlEscape(state.intent.publicText)}</span>`
    : "";
  const privateText = game.user.isGM && state.intent?.privateText
    ? `<span class="skj-private">${htmlEscape(state.intent.privateText)}</span>`
    : "";
  const notes = [
    activeAction ? `<span class="skj-active-action">${htmlEscape(activeAction.label)}</span>` : "",
    publicText,
    privateText
  ].filter(Boolean).join("");

  return `
    ${renderIntentIndicators(combatant, state, combatState)}
    ${notes ? `<div class="skj-combatant-notes">${notes}</div>` : ""}
  `;
}

/**
 * Insert module-owned status and metric elements into one combatant row.
 *
 * @param {HTMLElement} row Combatant tracker row.
 * @param {Combatant} combatant Foundry Combatant document.
 * @param {import("../types.mjs").SkjaldborgCombatantState} state Combatant state.
 * @param {import("../types.mjs").SkjaldborgCombatState} combatState Combat state.
 * @returns {void}
 */
function decorateCombatantRow(row, combatant, state, combatState) {
  performanceDiagnostics.count("tracker.decorate.row", 1, {
    combatantId: combatant?.id ?? null,
    phase: combatState?.phase ?? null
  });
  const nameBlock = row.querySelector(".token-name") ?? row;
  const controls = findCombatantControlRow(row);
  if (controls) {
    const statusHtml = renderCombatantStatus(state);
    const effects = controls.querySelector(".token-effects");
    if (effects) effects.insertAdjacentHTML("beforebegin", statusHtml);
    else controls.insertAdjacentHTML("beforeend", statusHtml);
  } else {
    nameBlock.insertAdjacentHTML("beforeend", `<div class="skj-combatant-status-fallback">${renderCombatantStatus(state)}</div>`);
  }
  nameBlock.insertAdjacentHTML("beforeend", renderCombatantDetails(combatant, state, combatState));
}

/**
 * Attach click handlers to injected tracker controls.
 *
 * @param {HTMLElement} element Tracker root element.
 * @param {Combat} combat Foundry Combat document.
 * @returns {void}
 */
function attachTrackerEvents(element, combat) {
  element[TRACKER_EVENT_BINDING]?.abort?.();
  const controller = new AbortController();
  element[TRACKER_EVENT_BINDING] = controller;
  element.addEventListener("click", event => {
    const control = event.target?.closest?.("[data-skj-action]");
    if (!control || !element.contains(control) || control.disabled) return;
    event.preventDefault();
    event.stopPropagation();
    const action = control.dataset.skjAction;
    const phase = control.dataset.phase;
    if (action === "advance-phase") void requestGm("advancePhase", { combatId: combat.id, phase });
  }, { signal: controller.signal });
  performanceDiagnostics.count("tracker.controls.bound", 1, { combatId: combat?.id ?? null, delegated: true });
}

/**
 * Register tracker render hooks.
 *
 * The module decorates AoV's existing tracker instead of replacing
 * `CONFIG.ui.combat`, preserving system ownership and AppV2 lifecycle.
 *
 * @returns {void}
 */
export function registerTrackerHooks() {
  const hook = (app, html) => {
    const measureId = performanceDiagnostics.markStart("tracker.decorate");
    let rowCount = 0;
    let combatId = null;
    let skipped = false;
    try {
    if (!AoVAdapter.isAoVWorld()) return;
    const element = elementFromTrackerHook(app, html);
    if (!element) return;

    element.querySelectorAll(".skj-phasebar, .skj-combatant-row, .skj-combatant-indicators, .skj-combatant-notes, .skj-combatant-status, .skj-combatant-status-fallback, .skj-status-fallback").forEach(n => n.remove());
    if (!AoVAdapter.enabledSetting) return;

    const combat = combatFromTrackerApp(app);
    if (!combat) return;
    combatId = combat.id ?? null;
    const state = getCombatState(combat);
    const header = trackerHeaderElement(element);
    header.insertAdjacentHTML("beforeend", renderPhaseBar(combat, state));

    // AoV owns the Adjust Initiative control and its click automation. Do not
    // phase-gate that native control here: all four Skjaldborg phases belong to
    // the same logical combat round, so the control remains available wherever
    // AoV rendered it.

    for (const row of trackerCombatantRows(element)) {
      const combatant = combatantFromTrackerRow(combat, row);
      if (!combatant) continue;
      rowCount += 1;
      decorateCombatantRow(row, combatant, getCombatantState(combatant), state);
    }
    localizeNativeTrackerTooltips(element);
    attachTrackerEvents(element, combat);
    } catch (exception) {
      skipped = true;
      throw exception;
    } finally {
      performanceDiagnostics.markEnd(measureId, { combatId, rowCount, skipped });
    }
  };

  Hooks.on("renderCombatTracker", hook);
  Hooks.on("renderAoVCombatTracker", hook);
}
