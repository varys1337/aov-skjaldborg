/**
 * Normalize render-hook HTML arguments across ApplicationV2 and legacy wrapper
 * shapes without taking ownership of the system tracker.
 *
 * @param {Application|object} app Rendering application.
 * @param {HTMLElement|JQuery|undefined} html Hook HTML argument.
 * @returns {HTMLElement|null}
 */
export function elementFromTrackerHook(app, html) {
  if (html instanceof HTMLElement) return html;
  if (html?.[0] instanceof HTMLElement) return html[0];
  return app?.element instanceof HTMLElement ? app.element : null;
}

/**
 * Resolve the Combat document represented by an AoV tracker ApplicationV2.
 *
 * @param {Application|object} app Combat tracker application.
 * @returns {Combat|null}
 */
export function combatFromTrackerApp(app) {
  return app?.viewed ?? app?.combat ?? game.combat ?? null;
}

/**
 * Resolve a tracker row regardless of whether the callback receives the row
 * itself or a nested element.
 *
 * @param {HTMLElement|null|undefined} element Candidate element.
 * @returns {HTMLElement|null}
 */
export function combatantRowFromElement(element) {
  if (!element || typeof element !== "object") return null;
  if (element[0] instanceof HTMLElement) return combatantRowFromElement(element[0]);
  if (element.matches?.("[data-combatant-id]")) return element;
  return element.closest?.("[data-combatant-id]") ?? null;
}

/**
 * Resolve the tracker header insertion point.
 *
 * @param {HTMLElement} element Tracker root element.
 * @returns {HTMLElement}
 */
export function trackerHeaderElement(element) {
  return element.querySelector(".combat-tracker-header") ?? element.querySelector("header") ?? element;
}

/**
 * Return all combatant rows in the current AoV tracker markup.
 *
 * @param {HTMLElement} element Tracker root element.
 * @returns {HTMLElement[]}
 */
export function trackerCombatantRows(element) {
  return Array.from(element.querySelectorAll("[data-combatant-id]"));
}

/**
 * Resolve a Combatant document from a tracker row.
 *
 * @param {Combat|null} combat Combat document.
 * @param {HTMLElement} row Tracker row.
 * @returns {Combatant|null}
 */
export function combatantFromTrackerRow(combat, row) {
  const combatantId = row?.dataset?.combatantId;
  return combatantId ? combat?.combatants?.get?.(combatantId) ?? null : null;
}

/**
 * Resolve the Combatant targeted by a combat tracker context-menu action.
 *
 * @param {Application|object} app Combat tracker application.
 * @param {HTMLElement|null|undefined} element Context-menu target element.
 * @returns {{combat: Combat|null, row: HTMLElement|null, combatantId: string|null, combatant: Combatant|null, reason: string|null}}
 */
export function combatantFromTrackerContext(app, element) {
  const combat = combatFromTrackerApp(app);
  if (!combat) {
    return { combat: null, row: null, combatantId: null, combatant: null, reason: "missing-combat" };
  }
  if (!combat.started) {
    return { combat, row: null, combatantId: null, combatant: null, reason: "combat-not-started" };
  }

  const row = combatantRowFromElement(element);
  if (!row) {
    return { combat, row: null, combatantId: null, combatant: null, reason: "missing-row" };
  }

  const combatantId = row.dataset?.combatantId ?? null;
  if (!combatantId) {
    return { combat, row, combatantId: null, combatant: null, reason: "missing-combatant-id" };
  }

  const combatant = combat.combatants?.get?.(combatantId) ?? null;
  if (!combatant) {
    return { combat, row, combatantId, combatant: null, reason: "unknown-combatant" };
  }

  return { combat, row, combatantId, combatant, reason: null };
}
