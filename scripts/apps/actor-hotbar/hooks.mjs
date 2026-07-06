import {
  DISENGAGING_STATUS_ID,
  ENGAGED_STATUS_ID,
  EVADING_STATUS_ID,
  GRAPPLED_STATUS_ID,
  IMMOBILIZED_STATUS_ID,
  IMPALED_STATUS_ID,
  INJURY_STATUS_ID,
  MODULE_ID
} from "../../constants.mjs";
import { effectHasStatus, effectParentActor, moduleFlag } from "../../compat/active-effects.mjs";
import { PresentationCache } from "../../ui/presentation-cache.mjs";
import { RenderCoordinator } from "../../ui/render-coordinator.mjs";
import {
  actorHotbarPartsForActorChange,
  actorHotbarPartsForCombatantChange,
  actorHotbarPartsForCombatChange,
  actorHotbarPartsForItemChange
} from "../../utils/changed-paths.mjs";
import {
  invalidateActorItemSnapshot,
  resolveHotbarActor
} from "../../ui/action-catalog.mjs";

let hooksRegistered = false;
let ActorHotbarClass = null;

/**
 * Test whether a TokenDocument represents the actor shown by the hotbar.
 *
 * @param {TokenDocument|null|undefined} token Token document.
 * @returns {boolean}
 */
function tokenBelongsToCurrentHotbarActor(token) {
  const currentActor = ActorHotbarClass?.current?.actor;
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
  return ActorHotbarClass?.current?.actor?.id ?? resolveHotbarActor()?.id ?? null;
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
  if (document.documentName === "ActiveEffect") return effectParentActor(document)?.id ?? null;
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
  const current = ActorHotbarClass?.current;
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
  const current = ActorHotbarClass?.current;
  const currentActorId = currentHotbarActorId();
  if (!currentActorId || !combatant) return false;
  return combatant.id === current?.combatant?.id
    || combatant.actor?.id === currentActorId
    || combatant.token?.actor?.id === currentActorId;
}

/**
 * Classify ActiveEffect changes into the narrowest safe hotbar regions.
 *
 * @param {ActiveEffect|object|null} effect Candidate ActiveEffect.
 * @returns {Set<string>} Hotbar invalidation regions.
 */
export function actorHotbarPartsForActiveEffect(effect) {
  const parts = new Set(["effects"]);

  if (moduleFlag(effect, "managedEvading") !== undefined || effectHasStatus(effect, EVADING_STATUS_ID)) {
    parts.add("workflow");
    return parts;
  }
  if (moduleFlag(effect, "managedReactionPenalty") !== undefined) {
    parts.add("workflow");
    return parts;
  }
  if (moduleFlag(effect, "managedEngagement") !== undefined || effectHasStatus(effect, ENGAGED_STATUS_ID)) {
    parts.add("workflow");
    return parts;
  }
  if (moduleFlag(effect, "managedDisengaging") !== undefined || effectHasStatus(effect, DISENGAGING_STATUS_ID)) {
    parts.add("workflow");
    return parts;
  }
  if (moduleFlag(effect, "managedKnockbackStatus") !== undefined || effectHasStatus(effect, "prone")) {
    parts.add("workflow");
    return parts;
  }
  if (moduleFlag(effect, "grapple") !== undefined || effectHasStatus(effect, GRAPPLED_STATUS_ID) || effectHasStatus(effect, IMMOBILIZED_STATUS_ID)) {
    parts.add("workflow");
    parts.add("tabBody");
    parts.add("wellbeing");
    return parts;
  }
  if (moduleFlag(effect, "stunStatus") !== undefined) {
    parts.add("workflow");
    parts.add("tabBody");
    parts.add("wellbeing");
    return parts;
  }
  if (
    moduleFlag(effect, "impalement") !== undefined
    || moduleFlag(effect, "injuryThreshold") !== undefined
    || effectHasStatus(effect, IMPALED_STATUS_ID)
    || effectHasStatus(effect, INJURY_STATUS_ID)
  ) {
    parts.add("resources");
    parts.add("tabBody");
    parts.add("wellbeing");
    return parts;
  }
  if (Object.keys(effect?.flags?.[MODULE_ID] ?? {}).length) {
    parts.add("tabBody");
    return parts;
  }

  parts.add("resources");
  parts.add("tabBody");
  return parts;
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
  let itemSnapshotAffected = false;
  if (affected.has("resources")) categories.add("resources");
  if (affected.has("effects") || affected.has("headerEffects")) categories.add("effects");
  if (affected.has("weaponControls") || affected.has("equipmentControls")) {
    categories.add("weapons");
    categories.add("equipment");
    itemSnapshotAffected = true;
  }
  if (affected.has("quickAccess")) {
    categories.add("actions");
    categories.add("stats");
    itemSnapshotAffected = true;
  }
  if (affected.has("equipment")) {
    categories.add("equipment");
    categories.add("weapons");
    itemSnapshotAffected = true;
  }
  if (affected.has("magic")) {
    categories.add("magic");
    categories.add("actions");
    itemSnapshotAffected = true;
  }
  if (affected.has("skills")) {
    categories.add("skills");
    categories.add("actions");
    itemSnapshotAffected = true;
  }
  if (affected.has("stats")) categories.add("stats");
  if (affected.has("historyFamily")) {
    categories.add("historyFamily");
    categories.add("actions");
    itemSnapshotAffected = true;
  }
  if (affected.has("wellbeing")) categories.add("wellbeing");
  if (affected.has("tabBody")) {
    categories.add("actions");
    categories.add("equipment");
    categories.add("stats");
    categories.add("skills");
    categories.add("magic");
    categories.add("historyFamily");
    itemSnapshotAffected = true;
  }
  if (affected.has("shell")) {
    PresentationCache.invalidate(actor);
    invalidateActorItemSnapshot(actor);
  } else {
    if (categories.size) PresentationCache.invalidate(actor, categories);
    if (itemSnapshotAffected) invalidateActorItemSnapshot(actor);
  }
}

/**
 * Schedule a part-aware hotbar refresh.
 *
 * @param {Set<string>|string[]} parts Affected hotbar regions.
 * @param {string} reason Diagnostic reason.
 * @param {Actor|null|undefined} [actor=ActorHotbarClass?.current?.actor] Actor whose cache should be invalidated.
 * @returns {void}
 */
function invalidateActorHotbar(parts, reason, actor = ActorHotbarClass?.current?.actor) {
  const affected = new Set(parts ?? []);
  if (!affected.size) return;
  invalidatePresentationForHotbarParts(actor, affected);
  ActorHotbarClass?.scheduleRender({
    parts: affected,
    reason,
    full: affected.has("shell")
  });
}

/**
 * Register actor-hotbar render hooks once.
 *
 * @param {typeof import("../actor-hotbar.mjs").ActorHotbar} ActorHotbar Hotbar facade class.
 * @returns {void}
 */
export function registerActorHotbarHooks(ActorHotbar) {
  if (hooksRegistered) return;
  ActorHotbarClass = ActorHotbar;
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
    if (documentBelongsToCurrentHotbarActor(effect)) {
      invalidateActorHotbar(actorHotbarPartsForActiveEffect(effect), "effect-create", effectParentActor(effect));
    }
  });
  Hooks.on("updateActiveEffect", (effect, changed) => {
    if (!documentBelongsToCurrentHotbarActor(effect)) return;
    if (!Object.keys(changed ?? {}).length) return;
    invalidateActorHotbar(actorHotbarPartsForActiveEffect(effect), "effect-update", effectParentActor(effect));
  });
  Hooks.on("deleteActiveEffect", effect => {
    if (documentBelongsToCurrentHotbarActor(effect)) {
      invalidateActorHotbar(actorHotbarPartsForActiveEffect(effect), "effect-delete", effectParentActor(effect));
    }
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
