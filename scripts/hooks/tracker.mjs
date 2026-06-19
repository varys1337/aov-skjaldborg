import { AoVAdapter } from "../adapter/aov-adapter.mjs";
import {
  ACTION_CATEGORIES,
  DEFENSE_REACTION_STEP,
  INTENT_STATUS,
  MODULE_ID,
  MOVEMENT_PLAN_STATUS,
  PHASES,
  RESOLUTION_STATUS
} from "../constants.mjs";
import { getCombatState, getCombatantState, phaseLabelKey } from "../combat/state.mjs";
import { getEnabledPhases } from "../combat/phase-structure.mjs";
import { getReadiedWeapon } from "../combat/weapon-state.mjs";
import { requestGm } from "../socket.mjs";

const INTENT_STATUS_ICONS = Object.freeze({
  [INTENT_STATUS.UNCOMMITTED]: "fa-circle-question",
  [INTENT_STATUS.COMMITTED]: "fa-circle-check",
  [INTENT_STATUS.HELD]: "fa-hand"
});

/**
 * Normalize render-hook HTML arguments across jQuery-style and HTMLElement-style hooks.
 *
 * @param {Application|object} app Rendering application.
 * @param {HTMLElement|JQuery|undefined} html Hook HTML argument.
 * @returns {HTMLElement|null}
 */
function elementFromHook(app, html) {
  if (html instanceof HTMLElement) return html;
  if (html?.[0] instanceof HTMLElement) return html[0];
  return app?.element instanceof HTMLElement ? app.element : null;
}

/**
 * Resolve the Combat document represented by a tracker application.
 *
 * @param {Application|object} app Combat tracker application.
 * @returns {Combat|null}
 */
function combatFromApp(app) {
  return app?.viewed ?? app?.combat ?? game.combat ?? null;
}

/**
 * Localize a key.
 *
 * @param {string} key Localization key.
 * @returns {string}
 */
function localize(key) {
  return game.i18n.localize(key);
}

/**
 * Escape text before inserting module-generated HTML into the tracker.
 *
 * @param {unknown} value Candidate text.
 * @returns {string}
 */
function escapeHtml(value) {
  const div = document.createElement("div");
  div.textContent = String(value ?? "");
  return div.innerHTML;
}

/**
 * Render a small tracker control button.
 *
 * @param {{action: string, icon: string, label: string, phase?: string, disabled?: boolean, active?: boolean}} config Button configuration.
 * @returns {string}
 */
function button({ action, icon, label, phase, disabled = false, active = false }) {
  const safeLabel = escapeHtml(label);
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

  const navigationLabel = escapeHtml(localize("AOV_SKJADLBORG.Controls.PhaseNavigation"));
  const movementStatus = escapeHtml(localize(`AOV_SKJADLBORG.MovementStatus.${state.movementRun?.status ?? "none"}`));

  return `
    <section class="skj-phasebar" data-combat-id="${combat?.id ?? ""}">
      <nav class="skj-phasebar-main" aria-label="${navigationLabel}">
        <div class="skj-phase-buttons">${phaseButtons}</div>
        <div class="skj-movement-run">${localize("AOV_SKJADLBORG.Labels.Movement")}: ${movementStatus}</div>
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
  const statusLabel = localize(`AOV_SKJADLBORG.IntentStatus.${status}`);
  const category = Object.values(ACTION_CATEGORIES).includes(state.intent?.actionCategory)
    ? state.intent.actionCategory
    : null;
  const categoryLabel = category ? localize(`AOV_SKJADLBORG.ActionCategories.${category}`) : "";
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
  const safeLabel = escapeHtml(label);
  const safeText = escapeHtml(text);
  return `<span class="skj-tracker-indicator ${className}" data-tooltip="${safeLabel}" aria-label="${safeLabel}"><i class="fa-solid ${icon}" inert></i>${safeText ? `<span>${safeText}</span>` : ""}</span>`;
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
  const reactionPenalty = Number(state.reactionCount ?? 0) * DEFENSE_REACTION_STEP;
  const indicators = [
    renderIndicator({
      className: "reactions",
      icon: "fa-shield-halved",
      label: `${localize("AOV_SKJADLBORG.Labels.Reactions")}: ${reactionPenalty}%`,
      text: `${reactionPenalty}%`
    })
  ];

  const movement = state.movement ?? {};
  const movementStatus = movement.planStatus ?? "none";
  const distance = Number(movement.distance ?? 0);
  if ([MOVEMENT_PLAN_STATUS.COMPLETED, MOVEMENT_PLAN_STATUS.STOPPED].includes(movementStatus) && distance > 0) {
    const waypointCount = Math.max(
      Array.isArray(movement.route) ? movement.route.length : 0,
      Array.isArray(movement.waypoints) ? movement.waypoints.length : 0
    );
    const units = String(movement.units ?? "").trim();
    const statusLabel = localize(`AOV_SKJADLBORG.MovementStatus.${movementStatus}`);
    const shortText = `${distance}${units ? ` ${units}` : ""}`;
    indicators.push(renderIndicator({
      className: `movement ${movementStatus}`,
      icon: "fa-route",
      label: game.i18n.format("AOV_SKJADLBORG.Tracker.MovementPlan", {
        status: statusLabel,
        distance,
        units,
        waypoints: waypointCount
      }),
      text: shortText
    }));
  }

  const readiedWeapon = getReadiedWeapon(combatant?.actor ?? combatant?.token?.actor ?? null);
  if (readiedWeapon) {
    indicators.push(renderIndicator({
      className: "readied-weapon",
      icon: "fa-sword",
      label: game.i18n.format("AOV_SKJADLBORG.Tracker.ReadiedWeapon", { weapon: readiedWeapon.name }),
      text: readiedWeapon.name
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
    ? `<span class="skj-public-intent">${escapeHtml(state.intent.publicText)}</span>`
    : "";
  const privateText = game.user.isGM && state.intent?.privateText
    ? `<span class="skj-private">${escapeHtml(state.intent.privateText)}</span>`
    : "";
  const notes = [
    activeAction ? `<span class="skj-active-action">${escapeHtml(activeAction.label)}</span>` : "",
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
  element.querySelectorAll("[data-skj-action]").forEach(control => {
    control.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      const action = control.dataset.skjAction;
      const phase = control.dataset.phase;
      if (action === "advance-phase") return requestGm("advancePhase", { combatId: combat.id, phase });
      return null;
    }, { once: true });
  });
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
    if (!AoVAdapter.isAoVWorld()) return;
    const element = elementFromHook(app, html);
    if (!element) return;

    element.querySelectorAll(".skj-phasebar, .skj-combatant-row, .skj-combatant-indicators, .skj-combatant-notes, .skj-combatant-status, .skj-combatant-status-fallback, .skj-status-fallback").forEach(n => n.remove());
    if (!AoVAdapter.enabledSetting) return;

    const combat = combatFromApp(app);
    if (!combat) return;
    const state = getCombatState(combat);
    const header = element.querySelector(".combat-tracker-header") ?? element.querySelector("header") ?? element;
    header.insertAdjacentHTML("beforeend", renderPhaseBar(combat, state));

    // AoV owns the Adjust Initiative control and its click automation. Do not
    // phase-gate that native control here: all four Skjaldborg phases belong to
    // the same logical combat round, so the control remains available wherever
    // AoV rendered it.

    for (const row of element.querySelectorAll("[data-combatant-id]")) {
      const combatant = combat.combatants.get(row.dataset.combatantId);
      if (!combatant) continue;
      decorateCombatantRow(row, combatant, getCombatantState(combatant), state);
    }
    attachTrackerEvents(element, combat);
  };

  Hooks.on("renderCombatTracker", hook);
  Hooks.on("renderAoVCombatTracker", hook);
}
