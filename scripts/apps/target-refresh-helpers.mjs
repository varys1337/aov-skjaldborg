import { actorPortraitSource, isVideoSource } from "../ui/dom-utils.mjs";
import { error } from "../logger.mjs";

/**
 * Build one live target snapshot from a canvas Token.
 *
 * @param {Token|object|null|undefined} token Canvas Token placeable.
 * @returns {object|null}
 */
export function targetSnapshot(token) {
  const document = token?.document ?? token ?? null;
  const actor = token?.actor ?? document?.actor ?? null;
  if (!document || !actor) return null;
  const tokenUuid = String(document.uuid ?? token?.uuid ?? document.id ?? "").trim();
  if (!tokenUuid) return null;
  const img = actorPortraitSource(actor, token);
  return {
    key: tokenUuid,
    token,
    tokenDocument: document,
    tokenUuid,
    tokenId: String(document.id ?? token?.id ?? ""),
    actor,
    actorUuid: actor.uuid ?? null,
    actorId: actor.id ?? null,
    name: actor.name ?? document.name ?? token?.name ?? "",
    img,
    imgIsVideo: isVideoSource(img)
  };
}

/**
 * Return all current user targets which represent an Actor.
 *
 * @returns {object[]}
 */
export function currentTargetSnapshots() {
  return Array.from(game.user?.targets ?? [])
    .map(targetSnapshot)
    .filter(Boolean);
}

/**
 * Convert a live target snapshot into data safe to store in ChatMessage flags.
 *
 * @param {object|null|undefined} snapshot Live target snapshot.
 * @returns {object|null}
 */
export function serializeTargetSnapshot(snapshot) {
  if (!snapshot?.tokenUuid) return null;
  return {
    key: snapshot.key,
    tokenUuid: snapshot.tokenUuid,
    tokenId: snapshot.tokenId,
    actorUuid: snapshot.actorUuid,
    actorId: snapshot.actorId,
    name: snapshot.name,
    img: snapshot.img,
    imgIsVideo: snapshot.imgIsVideo
  };
}

/**
 * Register an ApplicationV2 targetToken listener scoped to the current user.
 *
 * @param {object} app Dialog/application instance.
 * @param {Function} refreshCallback Callback invoked after current-user target changes.
 * @returns {void}
 */
export function registerTargetRefresh(app, refreshCallback) {
  unregisterTargetRefresh(app);
  const handler = user => {
    if (user?.id !== game.user?.id) return;
    void Promise.resolve(refreshCallback()).catch(exception => {
      error("Failed to refresh a Skjaldborg dialog after target changes.", exception);
    });
  };
  app._skjTargetRefreshHandler = handler;
  Hooks.on("targetToken", handler);
}

/**
 * Unregister a listener installed with registerTargetRefresh.
 *
 * @param {object} app Dialog/application instance.
 * @returns {void}
 */
export function unregisterTargetRefresh(app) {
  if (!app?._skjTargetRefreshHandler) return;
  Hooks.off("targetToken", app._skjTargetRefreshHandler);
  app._skjTargetRefreshHandler = null;
}

/**
 * Capture restorable form values. Multiple checkbox values per name are kept.
 *
 * @param {HTMLFormElement|null|undefined} form Form element.
 * @returns {Record<string, string[]>}
 */
export function captureFormValues(form) {
  if (!(form instanceof HTMLFormElement)) return {};
  const values = {};
  const data = new FormData(form);
  for (const [key, value] of data.entries()) {
    const name = String(key);
    values[name] ??= [];
    values[name].push(String(value));
  }
  return values;
}

/**
 * Restore values captured by captureFormValues into a freshly-rendered form.
 *
 * @param {HTMLFormElement|null|undefined} form Form element.
 * @param {Record<string, string[]>} values Captured values.
 * @returns {void}
 */
export function restoreFormValues(form, values = {}) {
  if (!(form instanceof HTMLFormElement)) return;
  const byName = values && typeof values === "object" ? values : {};
  const elements = Array.from(form.elements ?? []);
  for (const element of elements) {
    if (!element?.name || element.disabled) continue;
    const restored = byName[element.name];
    if (!Array.isArray(restored)) continue;
    if (element instanceof HTMLInputElement) {
      if (element.type === "checkbox") {
        const value = element.value || "on";
        element.checked = restored.includes(value);
      } else if (element.type === "radio") {
        element.checked = restored.includes(element.value);
      } else {
        element.value = restored.at(-1) ?? "";
      }
    } else if (element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement) {
      element.value = restored.at(-1) ?? "";
    }
  }
}

/**
 * Extract only selected field names from captured form data.
 *
 * @param {Record<string, string[]>} values Captured values.
 * @param {string[]} names Field names to preserve.
 * @returns {Record<string, string[]>}
 */
export function pickFormValues(values, names) {
  const result = {};
  for (const name of names) {
    if (Array.isArray(values?.[name])) result[name] = [...values[name]];
  }
  return result;
}

/**
 * Test whether a target option is still valid for the active choice list.
 *
 * @param {string} value Candidate submitted value.
 * @param {object[]} choices Prepared choices.
 * @param {string} [field="value"] Choice field name.
 * @returns {string}
 */
export function validChoiceValue(value, choices, field = "value") {
  const requested = String(value ?? "");
  if (requested && choices.some(choice => String(choice?.[field] ?? "") === requested)) return requested;
  return String(choices[0]?.[field] ?? "");
}
