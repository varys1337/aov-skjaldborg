/**
 * Missile follow-up automation.
 *
 * Source AoV combat cards store module-owned missile flags. The GM client
 * observes later combat-card closure and damage-card updates, posts the
 * Shooting into Melee random-target prompt when needed, and persists resolved
 * hit-location metadata for future shield coverage. All document writes are
 * idempotent and guarded by module flags.
 */
import { MODULE_ID } from "../constants.mjs";
import { createModuleChatMessage } from "../compat/chat-message.mjs";
import { warn } from "../logger.mjs";
import { incrementCounter } from "../performance/performance-monitor.mjs";
import { getCombatOptions } from "./weapon-state.mjs";
import {
  aovCards,
  actorImage,
  actorName,
  idTypeMatch,
  localize,
  recentFlaggedMessages,
  registerChatMessageAutomationHooks,
  renderActorStackCard,
  rerenderAoVMessage,
  safeFromUuid
} from "./automation-helpers.mjs";

const MISSILE_INTO_MELEE_FLAG = "missileIntoMelee";
const MISSILE_HIT_LOCATION_FLAG = "missileHitLocation";
const MISSILE_SHIELD_COVER_FLAG = "missileShieldCover";
const MISSILE_MATCH_WINDOW_MS = 10 * 60 * 1000;
const processingMessages = new Set();
let hooksRegistered = false;

function weaponType(weapon) {
  return String(weapon?.system?.weaponType ?? "").trim().toLowerCase();
}

async function resolveShotWeapon(shot) {
  return shot?.weaponUuid ? safeFromUuid(shot.weaponUuid) : null;
}

async function isProjectileShot(shot) {
  const weapon = await resolveShotWeapon(shot);
  const type = weaponType(weapon);
  if (type === "thrown") return false;
  if (type === "missile") return true;
  return shot?.range?.enabled === true || !!shot?.ammunitionId || !!shot?.ammunitionUuid;
}

function locationArmor(actor, hitLocation) {
  const value = actor?.type === "npc" ? hitLocation?.system?.npcAP : hitLocation?.system?.map;
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function shieldCoverForHit(targetActor, locationId) {
  const cover = getCombatOptions(targetActor).shieldCover;
  const shieldId = String(cover?.shieldId ?? "");
  const protectedIds = new Set((cover?.locationIds ?? []).map(String).filter(Boolean));
  if (!shieldId || !protectedIds.has(String(locationId ?? ""))) return null;
  const shield = targetActor?.items?.get?.(shieldId) ?? null;
  if (shield?.type !== "weapon") return null;
  return { shield, protectedIds };
}

function shieldCoverDamage(card, targetActor, hitLocation, shield) {
  const damageBeforeAbsorb = Math.max(0, Number(card.damageBeforeAbsorb ?? (Number(card.rollVal ?? 0) + Number(card.armourAbsorb ?? 0))) || 0);
  const shieldHp = Math.max(0, Number(shield?.system?.currHP) || 0);
  const shieldAbsorb = Math.min(damageBeforeAbsorb, shieldHp);
  const afterShield = Math.max(0, damageBeforeAbsorb - shieldAbsorb);
  const armor = locationArmor(targetActor, hitLocation);
  const armourAbsorb = card.armourBlock ? Math.min(afterShield, armor) : 0;
  const finalDamage = Math.max(0, afterShield - armourAbsorb);
  const shieldHpLoss = damageBeforeAbsorb > shieldHp && shieldHp > 0 ? 1 : 0;
  return {
    damageBeforeAbsorb,
    shieldHp,
    shieldAbsorb,
    afterShield,
    armourAbsorb,
    finalDamage,
    shieldHpLoss
  };
}

function applyShieldCoverToCard(card, shield, damage) {
  return {
    ...card,
    damageBeforeAbsorb: damage.damageBeforeAbsorb,
    weaponAbsorb: damage.shieldAbsorb,
    targetWpnId: shield.id,
    targetWpnName: shield.name,
    armourAbsorb: damage.armourAbsorb,
    rollVal: damage.finalDamage
  };
}

function escapeHtml(value) {
  return foundry.utils.escapeHTML(String(value ?? ""));
}

function shieldDamageNarration(shield, damage) {
  return damage.shieldHpLoss > 0
    ? game.i18n.format("AOV_SKJALDBORG.MissileDialog.ShieldCoverTakesDamage", {
        shield: shield?.name ?? "",
        damage: damage.shieldHpLoss
      })
    : game.i18n.format("AOV_SKJALDBORG.MissileDialog.ShieldCoverNoDamage", {
        shield: shield?.name ?? ""
      });
}

function renderShieldCoverChatCard({ targetActor, hitLocation, shield, damage }) {
  const title = localize("AOV_SKJALDBORG.MissileDialog.ShieldCoverTitle");
  const narration = shieldDamageNarration(shield, damage);
  const damageHeader = game.i18n.format("AOV_SKJALDBORG.MissileDialog.ShieldCoverDamageHeader", {
    final: damage.finalDamage,
    original: damage.damageBeforeAbsorb,
    shield: damage.shieldAbsorb,
    armor: damage.armourAbsorb
  });
  const detailRows = [
    game.i18n.format("AOV_SKJALDBORG.MissileDialog.ShieldCoverDetailLocation", {
      location: hitLocation?.name ?? ""
    }),
    game.i18n.format("AOV_SKJALDBORG.MissileDialog.ShieldCoverDetailOriginal", {
      damage: damage.damageBeforeAbsorb
    }),
    game.i18n.format("AOV_SKJALDBORG.MissileDialog.ShieldCoverDetailShield", {
      shield: damage.shieldAbsorb
    }),
    game.i18n.format("AOV_SKJALDBORG.MissileDialog.ShieldCoverDetailArmor", {
      armor: damage.armourAbsorb
    }),
    game.i18n.format("AOV_SKJALDBORG.MissileDialog.ShieldCoverDetailFinal", {
      final: damage.finalDamage
    })
  ];

  return `
    <form class="aov aov-skjaldborg-shield-cover-chat">
      <div>
        <ol class="op-list">
          <div class="dice-roll" data-action="expandRoll">
            <li class="actor-roll">
              <img class="open-actor" src="${escapeHtml(actorImage(targetActor))}" height="53" width="53" data-tooltip="${escapeHtml(actorName(targetActor))}" />
              <div class="roll-details">
                <div class="header">
                  <div class="name"><span class="tag bold">${escapeHtml(actorName(targetActor))}</span></div>
                </div>
                <div class="header roll-truncate">
                  <div class="name truncate"><span class="tag">${escapeHtml(title)}</span></div>
                </div>
              </div>
            </li>
            <div>
              <div class="damres pending skj-shield-cover-damage-header">
                <span class="pending">${escapeHtml(damageHeader)}</span>
              </div>
            </div>
            <div class="actor-roll dice-tooltip skj-shield-cover-details">
              ${detailRows.map(row => `<div class="rollHidden skj-shield-cover-detail">${escapeHtml(row)}</div>`).join("")}
            </div>
          </div>
        </ol>
      </div>
      <div class="combat-result">${escapeHtml(narration)}</div>
    </form>`;
}

async function createShieldCoverCard({ targetActor, hitLocation, shield, damage }) {
  const title = localize("AOV_SKJALDBORG.MissileDialog.ShieldCoverTitle");
  const content = renderShieldCoverChatCard({ targetActor, hitLocation, shield, damage });
  return createModuleChatMessage({
    user: game.user.id,
    speaker: { actor: targetActor?.id ?? null, alias: title },
    content
  }, { applyDefaultMode: true });
}

function matchesDamageCard(shot, damageCard) {
  if (!shot?.sourceMessageId || !damageCard) return false;
  const targetMatches = idTypeMatch(shot.targetParticipantId, shot.targetParticipantType, damageCard.targetId, damageCard.targetType)
    || idTypeMatch(shot.targetActorId, "actor", damageCard.targetId, damageCard.targetType)
    || idTypeMatch(shot.targetTokenId, "token", damageCard.targetId, damageCard.targetType);
  if (!targetMatches) return false;

  const attackerMatches = idTypeMatch(shot.attackerParticipantId, shot.attackerParticipantType, damageCard.particId, damageCard.particType)
    || idTypeMatch(shot.attackerActorId, "actor", damageCard.particId, damageCard.particType)
    || idTypeMatch(shot.attackerTokenId, "token", damageCard.particId, damageCard.particType);
  if (!attackerMatches) return false;

  const weaponId = String(shot.weaponId ?? "");
  const damageSkillId = String(damageCard.skillId ?? "");
  return !weaponId || !damageSkillId || weaponId === damageSkillId;
}

function findResolvedDamageLocationCard(message) {
  const cards = aovCards(message);
  const index = cards.findIndex(card => (
    card?.rollType === "DM"
    && Number(card.rollVal) > 0
    && String(card.targetLocID ?? "").trim()
  ));
  return index >= 0 ? { card: cards[index], index } : null;
}

function findMatchingMissileShot(damageMessage, damageCard) {
  const direct = damageMessage.getFlag?.(MODULE_ID, "missileShot") ?? null;
  if (matchesDamageCard(direct, damageCard)) return { message: damageMessage, shot: direct };

  const [match = null] = recentFlaggedMessages({
    excludeMessage: damageMessage,
    flag: "missileShot",
    windowMs: MISSILE_MATCH_WINDOW_MS,
    predicate: entry => entry.flag?.sourceMessageId
      && entry.message?.getFlag?.(MODULE_ID, MISSILE_HIT_LOCATION_FLAG)?.resolved !== true
      && matchesDamageCard(entry.flag, damageCard)
  });
  return match ? { message: match.message, shot: match.flag } : null;
}

async function createIntoMeleePrompt(message, intoMelee, roll) {
  const actor = await safeFromUuid(intoMelee.attackerActorUuid);
  const content = renderActorStackCard({
    actor,
    title: localize("AOV_SKJALDBORG.MissileDialog.IntoMeleeResultTitle"),
    label: localize("AOV_SKJALDBORG.MissileDialog.IntoMelee"),
    resultHtml: localize("AOV_SKJALDBORG.MissileDialog.IntoMeleeRandomTarget"),
    resultClass: "skj-missile-chat-result--into-melee",
    showResultTitle: false,
    formClass: "aov-skjaldborg-missile-chat",
    extraRows: [
      game.i18n.format("AOV_SKJALDBORG.MissileDialog.IntoMeleeRollRow", {
        roll,
        adjusted: intoMelee.adjustedChance,
        normal: intoMelee.normalChance
      })
    ]
  });
  return createModuleChatMessage({
    user: game.user.id,
    speaker: { actor: actor?.id ?? null, alias: localize("AOV_SKJALDBORG.MissileDialog.IntoMeleeResultTitle") },
    content
  }, { applyDefaultMode: true });
}

async function resolveIntoMeleeMessage(message) {
  if (!game.user?.isGM || message?.getFlag?.("aov", "cardType") !== "CO" || message?.getFlag?.("aov", "state") !== "closed") return;
  const intoMelee = message.getFlag?.(MODULE_ID, MISSILE_INTO_MELEE_FLAG) ?? null;
  if (!intoMelee || intoMelee.resolved === true) return;
  const attacker = aovCards(message)[0] ?? null;
  const roll = Number(attacker?.rollVal ?? attacker?.rollResult);
  const adjusted = Number(intoMelee.adjustedChance);
  const normal = Number(intoMelee.normalChance);
  let resultMessageId = null;
  if (Number.isFinite(roll) && Number.isFinite(adjusted) && Number.isFinite(normal) && roll > adjusted && roll <= normal) {
    const result = await createIntoMeleePrompt(message, intoMelee, roll);
    resultMessageId = result?.id ?? null;
  }
  await message.update({
    [`flags.${MODULE_ID}.${MISSILE_INTO_MELEE_FLAG}.resolved`]: true,
    [`flags.${MODULE_ID}.${MISSILE_INTO_MELEE_FLAG}.resolvedAt`]: Date.now(),
    [`flags.${MODULE_ID}.${MISSILE_INTO_MELEE_FLAG}.roll`]: Number.isFinite(roll) ? roll : null,
    [`flags.${MODULE_ID}.${MISSILE_INTO_MELEE_FLAG}.resultMessageId`]: resultMessageId
  });
}

async function persistMissileHitLocation(message) {
  if (!game.user?.isGM || message?.getFlag?.(MODULE_ID, MISSILE_HIT_LOCATION_FLAG)?.resolved === true) return;
  const located = findResolvedDamageLocationCard(message);
  if (!located) return;
  const source = findMatchingMissileShot(message, located.card);
  if (!source) return;

  const targetActor = await safeFromUuid(source.shot.targetActorUuid);
  const locationId = String(located.card.targetLocID ?? "");
  const location = targetActor?.items?.get?.(locationId) ?? null;
  const range = source.shot.aimedLocationId === locationId
    ? String(source.shot.aimedLocationRange ?? "")
    : (location
        ? (Number(location.system?.lowRoll) === Number(location.system?.highRoll)
            ? String(location.system?.lowRoll ?? "")
            : `${location.system?.lowRoll ?? ""}-${location.system?.highRoll ?? ""}`)
        : "");

  await message.update({
    [`flags.${MODULE_ID}.${MISSILE_HIT_LOCATION_FLAG}`]: {
      resolved: true,
      sourceMessageId: source.message.id,
      damageMessageId: message.id,
      resolvedAt: Date.now(),
      selectedBy: source.shot.aimedLocationId === locationId ? "aimed" : "core",
      targetActorUuid: source.shot.targetActorUuid ?? null,
      targetTokenUuid: source.shot.targetTokenUuid ?? null,
      hitLocationId: locationId,
      hitLocationName: location?.name ?? String(located.card.targetLoc ?? ""),
      hitLocationRange: range,
      armourAbsorb: Number(located.card.armourAbsorb ?? 0) || 0,
      rollVal: Number(located.card.rollVal ?? 0) || 0
    }
  });
  if (source.message.id !== message.id) {
    await source.message.update({
      [`flags.${MODULE_ID}.missileShot.resolved`]: true,
      [`flags.${MODULE_ID}.missileShot.damageMessageId`]: message.id,
      [`flags.${MODULE_ID}.missileShot.hitLocationId`]: locationId,
      [`flags.${MODULE_ID}.missileShot.resolvedAt`]: Date.now()
    });
  }
}

async function resolveShieldCoverForMissileHit(message) {
  if (!game.user?.isGM || message?.getFlag?.(MODULE_ID, MISSILE_SHIELD_COVER_FLAG)?.resolved === true) return false;
  const located = findResolvedDamageLocationCard(message);
  if (!located) return false;
  const source = findMatchingMissileShot(message, located.card);
  if (!source || source.shot?.resolved === true) return false;
  if (!(await isProjectileShot(source.shot))) return false;

  const targetActor = await safeFromUuid(source.shot.targetActorUuid);
  const locationId = String(located.card.targetLocID ?? "");
  const hitLocation = targetActor?.items?.get?.(locationId) ?? null;
  const cover = shieldCoverForHit(targetActor, locationId);
  if (!targetActor || hitLocation?.type !== "hitloc" || !cover?.shield) return false;

  const cards = foundry.utils.deepClone(aovCards(message));
  const card = cards[located.index] ?? null;
  if (!card || card.rollType !== "DM") return false;
  const damage = shieldCoverDamage(card, targetActor, hitLocation, cover.shield);
  cards[located.index] = applyShieldCoverToCard(card, cover.shield, damage);

  await createShieldCoverCard({ targetActor, hitLocation, shield: cover.shield, damage });
  if (damage.shieldHpLoss > 0 && cover.shield?.update) {
    await cover.shield.update({
      "system.currHP": Math.max(0, (Number(cover.shield.system?.currHP) || 0) - damage.shieldHpLoss)
    }, { [MODULE_ID]: { reason: "missile-shield-cover" } });
  }

  await message.update({
    "flags.aov.chatCard": cards,
    [`flags.${MODULE_ID}.${MISSILE_SHIELD_COVER_FLAG}`]: {
      resolved: true,
      sourceMessageId: source.message.id,
      damageMessageId: message.id,
      resolvedAt: Date.now(),
      targetActorUuid: source.shot.targetActorUuid ?? null,
      targetTokenUuid: source.shot.targetTokenUuid ?? null,
      hitLocationId: hitLocation.id,
      hitLocationName: hitLocation.name,
      shieldId: cover.shield.id,
      shieldName: cover.shield.name,
      damage
    }
  });
  await rerenderAoVMessage(message);
  return true;
}

async function handleMessageUpdate(message) {
  const key = String(message?.id ?? "");
  if (!key || processingMessages.has(key)) return;
  incrementCounter("automation.missile.message", 1, {
    cardType: message.getFlag?.("aov", "cardType") ?? null,
    state: message.getFlag?.("aov", "state") ?? null
  });
  processingMessages.add(key);
  try {
    await resolveIntoMeleeMessage(message);
    await resolveShieldCoverForMissileHit(message);
    await persistMissileHitLocation(message);
  } finally {
    processingMessages.delete(key);
  }
}

/**
 * Register missile automation hooks once on the local client.
 *
 * @returns {void}
 */
export function registerMissileAutomationHooks(hooks = globalThis.Hooks) {
  if (hooksRegistered) return;
  hooksRegistered = true;
  registerChatMessageAutomationHooks(handleMessageUpdate, { hooks });
}

export const __test = {
  isHooksRegistered: () => hooksRegistered
};
