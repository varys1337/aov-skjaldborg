import {
  ACTION_CATEGORIES,
  DISENGAGEMENT_METHODS,
  DISENGAGEMENT_STATUS,
  DISENGAGING_STATUS_ID,
  MOUNTED_STATUS_ID,
  MODULE_ID,
  MOVEMENT_DEBUG_CATEGORIES,
  MOVEMENT_PLAN_STATUS
} from "../constants.mjs";
import { createModuleChatMessage } from "../compat/chat-message.mjs";
import {
  effectHasStatus,
  effectIsActive,
  moduleFlag,
  registerStatusEffect,
  safeDeleteActiveEffect,
  statusEffectConfig,
  upsertActorStatusEffect
} from "../compat/active-effects.mjs";
import { warn } from "../logger.mjs";
import { RenderCoordinator } from "../ui/render-coordinator.mjs";
import { movementDebug } from "./movement-debugger.mjs";
import { syncEngagementVisuals } from "./engagement-status.mjs";
import { removeEngagementPartners, uniquePartnerIds } from "./engagement-links.mjs";
import { measureOccupiedGridSeparation, reachUnitsForCombatant, tokenSourceGridRect } from "./movement-controller.mjs";
import { getCombatState, getCombatantState, updateCombatantState } from "./state.mjs";
import { combatantById, combatantValues } from "./combatant-token-resolution.mjs";

const MOUNTED_EFFECT_NAME = "AOV_SKJALDBORG.StatusEffects.Mounted";
const DISENGAGING_EFFECT_NAME = "AOV_SKJALDBORG.StatusEffects.Disengaging";
const MOUNTED_EFFECT_ICON = "icons/svg/wingfoot.svg";
const DISENGAGING_EFFECT_ICON = "icons/svg/aura.svg";
const MANAGED_DISENGAGING_FLAG = "managedDisengaging";
const OPPORTUNITY_MODES = Object.freeze({
  ONE: "one",
  ALL: "all"
});

function localize(key) {
  return game.i18n.localize(key);
}

/**
 * Register mounted and disengaging status-effect catalog entries.
 *
 * AoV may mutate CONFIG.statusEffects during startup, so main.mjs calls this
 * repeatedly at init/setup/ready and this function must remain idempotent.
 *
 * @returns {void}
 */
export function registerDisengagementStatusEffects() {
  registerStatusEffect(statusEffectConfig(MOUNTED_STATUS_ID, MOUNTED_EFFECT_NAME, MOUNTED_EFFECT_ICON), {
    warning: "Unable to register Skjaldborg mounted status effect"
  });
  registerStatusEffect(statusEffectConfig(DISENGAGING_STATUS_ID, DISENGAGING_EFFECT_NAME, DISENGAGING_EFFECT_ICON), {
    warning: "Unable to register Skjaldborg disengaging status effect"
  });
}

function actorForCombatant(combatant) {
  return combatant?.actor ?? combatant?.token?.actor ?? combatant?.token?.object?.actor ?? null;
}

function isDisengagingEffect(effect) {
  return effectHasStatus(effect, DISENGAGING_STATUS_ID)
    || moduleFlag(effect, MANAGED_DISENGAGING_FLAG) === true;
}

function actorHasStatus(actor, statusId) {
  return Array.from(actor?.effects ?? []).some(effect => effectIsActive(effect) && effectHasStatus(effect, statusId));
}

/**
 * Determine whether a combatant's Actor currently has the Mounted status.
 *
 * @param {Combatant|object|null} combatant Combatant to inspect.
 * @returns {boolean}
 */
export function isCombatantMounted(combatant) {
  return actorHasStatus(actorForCombatant(combatant), MOUNTED_STATUS_ID);
}

async function syncDisengagingStatusEffect(combatant, active) {
  const actor = actorForCombatant(combatant);
  if (!actor || typeof CONFIG?.ActiveEffect?.documentClass !== "function") return null;
  const effect = Array.from(actor.effects ?? []).find(isDisengagingEffect) ?? null;
  if (!active) {
    await safeDeleteActiveEffect(effect, { reason: "disengaging-inactive" });
    return null;
  }
  return upsertActorStatusEffect(actor, {
    statusId: DISENGAGING_STATUS_ID,
    name: localize(DISENGAGING_EFFECT_NAME),
    img: DISENGAGING_EFFECT_ICON,
    moduleFlags: { [MANAGED_DISENGAGING_FLAG]: true },
    predicate: isDisengagingEffect
  });
}

function partnerCombatants(combat, combatant, ids = null) {
  const source = ids ?? getCombatantState(combatant).engagement?.partnerIds ?? [];
  return Array.from(new Set(source.filter(Boolean))).map(id => combatantById(combat, id)).filter(Boolean);
}

function defaultDisengagementState() {
  return {
    method: DISENGAGEMENT_METHODS.NONE,
    status: DISENGAGEMENT_STATUS.NONE,
    declaredRound: null,
    resolvesAtRound: null,
    partnerIds: [],
    mountedAtDeclaration: false,
    opponentMountedAtDeclaration: false,
    defensiveOnly: false,
    freeAttackResolved: false,
    opportunityAttackerId: null,
    opportunityAttackerIds: [],
    opportunityMode: OPPORTUNITY_MODES.ONE,
    reason: ""
  };
}

function activeEgressState(partnerIds, method, sourceRound, reason) {
  return {
    status: "active",
    ignoredPartnerIds: Array.from(new Set((partnerIds ?? []).filter(Boolean))),
    method,
    sourceRound: Number(sourceRound) || null,
    activatedAt: Date.now(),
    reason
  };
}

async function grantDisengagementEgress(combatant, partnerIds, method, reason) {
  const ids = Array.from(new Set((partnerIds ?? []).filter(Boolean)));
  if (!ids.length) return null;
  const state = getCombatantState(combatant);
  const currentEgress = state.engagement?.egress ?? {};
  const ignoredPartnerIds = Array.from(new Set([
    ...(currentEgress.status === "active" ? currentEgress.ignoredPartnerIds ?? [] : []),
    ...ids
  ]));
  const nextEgress = activeEgressState(ignoredPartnerIds, method, Number(getCombatState(combatant?.combat ?? game.combat).logicalRound) || null, reason);
  await updateCombatantState(combatant, {
    engagement: {
      ...state.engagement,
      egress: nextEgress
    }
  });
  movementDebug(MOVEMENT_DEBUG_CATEGORIES.ENGAGEMENT, "disengagement-egress-granted", () => ({
    combatantId: combatant?.id ?? null,
    ignoredPartnerIds,
    method,
    reason
  }), { combatId: combatant?.combat?.id ?? game.combat?.id ?? null, combatantId: combatant?.id ?? null });
  return nextEgress;
}

async function writeEngagement(combat, combatant, engagement) {
  await updateCombatantState(combatant, { engagement });
  await syncEngagementVisuals(combatant, engagement, combat);
}

/**
 * Clear engagement links between one combatant and selected partners.
 *
 * @param {Combat|null} combat Active Combat.
 * @param {Combatant|object} combatant Source combatant.
 * @param {string[]|null} [partnerIds=null] Partner ids to remove; all partners when null.
 * @param {string} [reason="disengaged"] Persisted reason.
 * @returns {Promise<number>} Number of partner links cleared.
 */
export async function clearEngagementLinks(combat, combatant, partnerIds = null, reason = "disengaged") {
  const partners = partnerCombatants(combat, combatant, partnerIds);
  const partnerIdsToRemove = partners.map(partner => partner.id);
  const sourceState = getCombatantState(combatant);
  await writeEngagement(
    combat,
    combatant,
    removeEngagementPartners(sourceState.engagement, partnerIdsToRemove, reason)
  );

  for (const partner of partners) {
    const state = getCombatantState(partner);
    await writeEngagement(
      combat,
      partner,
      removeEngagementPartners(state.engagement, [combatant.id], reason)
    );
  }
  RenderCoordinator.invalidateCombatTracker("disengagement-links-cleared", {
    combatantIds: [combatant?.id, ...partnerIdsToRemove].filter(Boolean),
    parts: ["rows"]
  });
  return partners.length;
}

function normalizeDisengagementMethod(method) {
  const value = String(method ?? "").trim();
  if (value === DISENGAGEMENT_METHODS.FLEE) return DISENGAGEMENT_METHODS.FLEE;
  if (value === DISENGAGEMENT_METHODS.KNOCKBACK) return DISENGAGEMENT_METHODS.KNOCKBACK;
  return DISENGAGEMENT_METHODS.RETREAT;
}

function normalizeOpportunityMode(value) {
  return String(value ?? "") === OPPORTUNITY_MODES.ALL ? OPPORTUNITY_MODES.ALL : OPPORTUNITY_MODES.ONE;
}

function selectedOpportunityAttackerIds(partnerIds, { opportunityAttackerId = null, opportunityAttackerIds = [], opportunityMode = OPPORTUNITY_MODES.ONE } = {}) {
  const partnerSet = new Set(partnerIds);
  const mode = normalizeOpportunityMode(opportunityMode);
  if (mode === OPPORTUNITY_MODES.ALL) return partnerIds;
  const submitted = uniquePartnerIds([
    ...((Array.isArray(opportunityAttackerIds) ? opportunityAttackerIds : [])),
    opportunityAttackerId
  ]).filter(id => partnerSet.has(id));
  return submitted.length ? [submitted[0]] : (partnerIds[0] ? [partnerIds[0]] : []);
}

/**
 * Validate a declared intent against an active retreat disengagement.
 *
 * @param {Combatant|object} combatant Combatant declaring intent.
 * @param {object|null|undefined} intent Proposed intent payload.
 * @returns {void}
 * @throws {Error} When retreat rules restrict the selected action.
 */
export function validateIntentAgainstDisengagement(combatant, intent) {
  const state = getCombatantState(combatant);
  const disengagement = state.disengagement ?? {};
  if (disengagement.status !== DISENGAGEMENT_STATUS.DECLARED || disengagement.method !== DISENGAGEMENT_METHODS.RETREAT) return;
  const category = intent?.actionCategory;
  if (![ACTION_CATEGORIES.RETREAT, ACTION_CATEGORIES.DEFEND, ACTION_CATEGORIES.WAIT, ACTION_CATEGORIES.DELAY].includes(category)) {
    throw new Error(localize("AOV_SKJALDBORG.Warnings.RetreatDefensiveOnly"));
  }
}

/**
 * Declare a disengagement method for a combatant and persist combat state.
 *
 * @param {Combat|null} combat Active Combat.
 * @param {Combatant|object} combatant Declaring combatant.
 * @param {object} [options={}] Declaration options.
 * @param {string} [options.method=DISENGAGEMENT_METHODS.RETREAT] Disengagement method.
 * @param {string[]} [options.partnerIds=[]] Selected engagement partner ids.
 * @param {string|null} [options.opportunityAttackerId=null] Primary flee-opportunity attacker id.
 * @param {string[]} [options.opportunityAttackerIds=[]] Flee-opportunity attacker ids.
 * @param {string} [options.opportunityMode=OPPORTUNITY_MODES.ONE] Opportunity selection mode.
 * @returns {Promise<object>} Persisted disengagement state.
 */
export async function declareDisengagement(combat, combatant, { method = DISENGAGEMENT_METHODS.RETREAT, partnerIds = [], opportunityAttackerId = null, opportunityAttackerIds = [], opportunityMode = OPPORTUNITY_MODES.ONE } = {}) {
  const combatState = getCombatState(combat);
  const currentState = getCombatantState(combatant);
  const normalizedMethod = normalizeDisengagementMethod(method);
  const allPartners = partnerCombatants(combat, combatant);
  const allPartnerIds = allPartners.map(partner => partner.id);
  const allPartnerSet = new Set(allPartnerIds);
  const requestedPartnerIds = uniquePartnerIds(Array.isArray(partnerIds) ? partnerIds : []).filter(id => allPartnerSet.has(id));
  const selectedPartnerIds = requestedPartnerIds.length ? requestedPartnerIds : allPartnerIds;
  const partners = partnerCombatants(combat, combatant, selectedPartnerIds);
  const partnerIdsForState = partners.map(partner => partner.id);
  const mountedAtDeclaration = isCombatantMounted(combatant);
  const opponentMountedAtDeclaration = partners.some(isCombatantMounted);

  if (normalizedMethod === DISENGAGEMENT_METHODS.RETREAT && !mountedAtDeclaration && opponentMountedAtDeclaration) {
    throw new Error(localize("AOV_SKJALDBORG.Warnings.CannotRetreatFromMounted"));
  }

  const declaredRound = Number(combatState.logicalRound) || 1;
  const normalizedOpportunityMode = normalizeOpportunityMode(opportunityMode);
  const selectedOpportunityIds = selectedOpportunityAttackerIds(partnerIdsForState, {
    opportunityAttackerId,
    opportunityAttackerIds,
    opportunityMode: normalizedOpportunityMode
  });
  const selectedOpportunity = selectedOpportunityIds[0] ?? null;
  const disengagement = {
    method: normalizedMethod,
    status: DISENGAGEMENT_STATUS.DECLARED,
    declaredRound,
    resolvesAtRound: normalizedMethod === DISENGAGEMENT_METHODS.RETREAT ? declaredRound + 1 : declaredRound,
    partnerIds: partnerIdsForState,
    mountedAtDeclaration,
    opponentMountedAtDeclaration,
    defensiveOnly: normalizedMethod === DISENGAGEMENT_METHODS.RETREAT,
    freeAttackResolved: false,
    opportunityAttackerId: normalizedMethod === DISENGAGEMENT_METHODS.FLEE ? selectedOpportunity : null,
    opportunityAttackerIds: normalizedMethod === DISENGAGEMENT_METHODS.FLEE ? selectedOpportunityIds : [],
    opportunityMode: normalizedMethod === DISENGAGEMENT_METHODS.FLEE ? normalizedOpportunityMode : OPPORTUNITY_MODES.ONE,
    reason: normalizedMethod
  };

  await updateCombatantState(combatant, {
    intent: {
      ...currentState.intent,
      status: "committed",
      actionCategory: ACTION_CATEGORIES.RETREAT,
      publicText: localize(`AOV_SKJALDBORG.DisengageDialog.Methods.${normalizedMethod}.Label`),
      privateText: ""
    },
    movement: {
      ...currentState.movement,
      mode: normalizedMethod,
      planStatus: currentState.movement?.planStatus ?? MOVEMENT_PLAN_STATUS.NONE
    },
    disengagement
  });
  await syncDisengagingStatusEffect(combatant, normalizedMethod === DISENGAGEMENT_METHODS.RETREAT);
  RenderCoordinator.invalidateCombatTracker("disengagement-declared", {
    combatantIds: [combatant?.id].filter(Boolean),
    parts: ["rows"]
  });
  return disengagement;
}

async function postFleeOpportunityMessage(combat, fleeing, attacker) {
  const content = `
    <div class="aov-skjaldborg-card">
      <h3>${localize("AOV_SKJALDBORG.DisengageDialog.FleeOpportunityTitle")}</h3>
      <p>${game.i18n.format("AOV_SKJALDBORG.DisengageDialog.FleeOpportunityBody", {
        attacker: attacker?.name ?? localize("AOV_SKJALDBORG.Labels.Unknown"),
        target: fleeing?.name ?? localize("AOV_SKJALDBORG.Labels.Unknown")
      })}</p>
    </div>`;
  return createModuleChatMessage({
    speaker: ChatMessage.getSpeaker({ actor: attacker?.actor ?? fleeing?.actor ?? null, scene: canvas.scene }),
    content,
    flags: {
      [MODULE_ID]: {
        fleeOpportunityAttack: {
          combatId: combat?.id ?? null,
          attackerCombatantId: attacker?.id ?? null,
          fleeingCombatantId: fleeing?.id ?? null,
          unparryable: true,
          undodgeable: true,
          consumesNormalAction: false
        }
      }
    }
  });
}

/**
 * Resolve pending flee declarations for the current combat round.
 *
 * @param {Combat|null} combat Active Combat.
 * @returns {Promise<number>} Number of flee declarations resolved.
 */
export async function resolvePendingFlees(combat) {
  if (!game.user?.isGM || !combat) return 0;
  let resolved = 0;
  for (const combatant of combatantValues(combat)) {
    const state = getCombatantState(combatant);
    const disengagement = state.disengagement ?? {};
    if (disengagement.method !== DISENGAGEMENT_METHODS.FLEE || disengagement.status !== DISENGAGEMENT_STATUS.DECLARED) continue;
    const fallbackPartners = partnerCombatants(combat, combatant, disengagement.partnerIds);
    const fallbackPartnerIds = new Set(fallbackPartners.map(partner => partner.id));
    const attackerIds = uniquePartnerIds(
      (Array.isArray(disengagement.opportunityAttackerIds) && disengagement.opportunityAttackerIds.length)
        ? disengagement.opportunityAttackerIds
        : [disengagement.opportunityAttackerId]
    ).filter(id => fallbackPartnerIds.has(id));
    const attackers = attackerIds.map(id => combatantById(combat, id)).filter(Boolean);
    if (!attackers.length && fallbackPartners[0]) attackers.push(fallbackPartners[0]);
    for (const attacker of attackers) {
      if (attacker) await postFleeOpportunityMessage(combat, combatant, attacker);
      Hooks.callAll?.("aovSkjaldborgFleeOpportunityAttack", {
        combat,
        fleeingCombatant: combatant,
        attackerCombatant: attacker,
        unparryable: true,
        undodgeable: true,
        consumesNormalAction: false
      });
    }
    await clearEngagementLinks(combat, combatant, disengagement.partnerIds, "flee");
    await grantDisengagementEgress(combatant, disengagement.partnerIds, DISENGAGEMENT_METHODS.FLEE, "flee-egress");
    await updateCombatantState(combatant, {
      disengagement: {
        ...disengagement,
        status: DISENGAGEMENT_STATUS.COMPLETE,
        freeAttackResolved: true,
        reason: "flee-opportunity-resolved"
      }
    });
    resolved += 1;
  }
  if (resolved) movementDebug(MOVEMENT_DEBUG_CATEGORIES.ENGAGEMENT, "pending-flees-resolved", () => ({ resolved }), { combatId: combat.id });
  return resolved;
}

/**
 * Resolve retreat disengagement declarations whose delay has elapsed.
 *
 * @param {Combat|null} combat Active Combat.
 * @returns {Promise<number>} Number of retreat declarations resolved.
 */
export async function resolvePendingRetreatDisengagements(combat) {
  if (!game.user?.isGM || !combat) return 0;
  const combatState = getCombatState(combat);
  const roundCompleting = Number(combatState.logicalRound) || 1;
  let resolved = 0;
  for (const combatant of combatantValues(combat)) {
    const state = getCombatantState(combatant);
    const disengagement = state.disengagement ?? {};
    if (disengagement.method !== DISENGAGEMENT_METHODS.RETREAT || disengagement.status !== DISENGAGEMENT_STATUS.DECLARED) continue;
    const declaredRound = Number(disengagement.declaredRound) || roundCompleting;
    if (declaredRound > roundCompleting) continue;
    await clearEngagementLinks(combat, combatant, disengagement.partnerIds, "retreat-complete");
    await grantDisengagementEgress(combatant, disengagement.partnerIds, DISENGAGEMENT_METHODS.RETREAT, "retreat-egress");
    await updateCombatantState(combatant, {
      disengagement: {
        ...disengagement,
        status: DISENGAGEMENT_STATUS.COMPLETE,
        resolvesAtRound: roundCompleting + 1,
        reason: "retreat-complete"
      }
    });
    await syncDisengagingStatusEffect(combatant, false);
    resolved += 1;
  }
  if (resolved) movementDebug(MOVEMENT_DEBUG_CATEGORIES.ENGAGEMENT, "pending-retreats-resolved", () => ({ resolved }), { combatId: combat.id });
  return resolved;
}

function combatantTokenIdentityCandidates(combatant) {
  const token = combatant?.token;
  const document = token?.object?.document ?? token?.document ?? token ?? null;
  const candidates = [
    combatant?.tokenId,
    token?.id,
    token?._id,
    token?.object?.id,
    token?.object?.document?.id,
    token?.document?.id,
    document?.id,
    document?._id
  ];
  const uuid = String(document?.uuid ?? token?.uuid ?? "");
  if (uuid.includes(".Token.")) candidates.push(uuid.split(".Token.").at(-1));
  return Array.from(new Set(candidates.map(candidate => String(candidate ?? "").trim()).filter(Boolean)));
}

function liveTokenDocumentById(tokenId, combatant = null) {
  const id = String(tokenId ?? "").trim();
  if (!id) return null;
  return canvas?.scene?.tokens?.get?.(id)
    ?? combatant?.combat?.scene?.tokens?.get?.(id)
    ?? game.scenes?.get?.(combatant?.sceneId)?.tokens?.get?.(id)
    ?? null;
}

function tokenDocumentForDisengagementCombatant(combatant) {
  const tokenIds = combatantTokenIdentityCandidates(combatant);
  for (const id of tokenIds) {
    const live = liveTokenDocumentById(id, combatant);
    if (live) return live;
  }
  return combatant?.token?.object?.document
    ?? combatant?.token?.document
    ?? combatant?.token
    ?? null;
}

function knockbackPairStillInReach(attacker, target) {
  const attackerToken = tokenDocumentForDisengagementCombatant(attacker);
  const targetToken = tokenDocumentForDisengagementCombatant(target);
  const attackerRect = tokenSourceGridRect(attackerToken);
  const targetRect = tokenSourceGridRect(targetToken);
  const separation = measureOccupiedGridSeparation(attackerRect, targetRect);
  const threshold = Math.max(reachUnitsForCombatant(attacker), reachUnitsForCombatant(target));
  const inReach = Number.isFinite(separation) && Number.isFinite(threshold) && separation <= threshold;
  movementDebug(MOVEMENT_DEBUG_CATEGORIES.ENGAGEMENT, "knockback-reach-check", () => ({
    attackerCombatantId: attacker?.id ?? null,
    targetCombatantId: target?.id ?? null,
    attackerTokenId: attackerToken?.id ?? attackerToken?._id ?? null,
    targetTokenId: targetToken?.id ?? targetToken?._id ?? null,
    attackerRect,
    targetRect,
    separation,
    threshold,
    inReach
  }), { combatId: attacker?.combat?.id ?? game.combat?.id ?? null });
  return inReach;
}

/**
 * Clear engagement state after a successful knockback moves a pair apart.
 *
 * @param {Combat|null} combat Active Combat.
 * @param {string} attackerCombatantId Attacker combatant id.
 * @param {string} targetCombatantId Target combatant id.
 * @param {object} [options={}] Resolution options.
 * @param {boolean} [options.clearAll=false] Clear every attacker partner.
 * @param {boolean} [options.onlyIfOutOfReach=false] Skip when attacker and target remain in reach.
 * @returns {Promise<number>} Number of engagement links cleared.
 */
export async function resolveKnockbackDisengagement(combat, attackerCombatantId, targetCombatantId, { clearAll = false, onlyIfOutOfReach = false } = {}) {
  if (!game.user?.isGM || !combat) return 0;
  const attacker = combatantById(combat, attackerCombatantId);
  const target = combatantById(combat, targetCombatantId);
  if (!attacker || !target) return 0;
  if (onlyIfOutOfReach && !clearAll && knockbackPairStillInReach(attacker, target)) return 0;
  const ids = clearAll ? (getCombatantState(attacker).engagement?.partnerIds ?? []) : [target.id];
  const cleared = await clearEngagementLinks(combat, attacker, ids, "knockback");
  if (!cleared) return 0;
  await grantDisengagementEgress(attacker, ids, DISENGAGEMENT_METHODS.KNOCKBACK, "knockback-egress");
  const state = getCombatantState(attacker);
  await updateCombatantState(attacker, {
    disengagement: {
      ...defaultDisengagementState(),
      method: DISENGAGEMENT_METHODS.KNOCKBACK,
      status: DISENGAGEMENT_STATUS.COMPLETE,
      declaredRound: Number(getCombatState(combat).logicalRound) || 1,
      resolvesAtRound: Number(getCombatState(combat).logicalRound) || 1,
      partnerIds: ids,
      mountedAtDeclaration: isCombatantMounted(attacker),
      opponentMountedAtDeclaration: isCombatantMounted(target),
      reason: "knockback"
    },
    engagement: getCombatantState(attacker).engagement ?? state.engagement
  });
  return cleared;
}

/**
 * Clear one displaced attacker/target engagement only when reach is lost.
 *
 * @param {object} context Automation context containing combatant ids.
 * @returns {Promise<number>}
 */
export async function resolveOutOfReachEngagementPair(context = {}) {
  const combat = context.combatId
    ? game.combats?.get?.(context.combatId) ?? game.combat
    : game.combat;
  if (!combat || !context.attackerCombatantId || !context.targetCombatantId) return 0;
  return resolveKnockbackDisengagement(
    combat,
    context.attackerCombatantId,
    context.targetCombatantId,
    { clearAll: false, onlyIfOutOfReach: true }
  );
}

/**
 * Register disengagement integration hooks once.
 *
 * @returns {void}
 */
export function registerDisengagementHooks(hooks = globalThis.Hooks) {
  hooks.on("aovSkjaldborgKnockbackResolved", payload => {
    if (!game.user?.isGM) return;
    const combat = payload?.combat ?? game.combat;
    void resolveKnockbackDisengagement(
      combat,
      payload?.attackerCombatantId ?? payload?.attackerCombatant?.id,
      payload?.targetCombatantId ?? payload?.targetCombatant?.id,
      {
        clearAll: payload?.clearAll === true,
        onlyIfOutOfReach: payload?.onlyIfOutOfReach === true
      }
    ).catch(warn);
  });
}
