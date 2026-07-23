import { MODULE_ID } from "../constants.mjs";
import { warn } from "../logger.mjs";
import { collectionArray, numberOr, safeFromUuid } from "../utils/document-data.mjs";
import { guardedUpdate } from "../utils/guarded-document-writes.mjs";
import { AOV_TEMPLATES } from "../adapter/aov-contract.mjs";
import { combatantForTokenDocument, combatantValues } from "./combatant-token-resolution.mjs";

export { collectionArray, numberOr, safeFromUuid } from "../utils/document-data.mjs";

/**
 * Localize a string key through Foundry's active i18n service.
 *
 * @param {string} key Localization key.
 * @returns {string}
 */
export function localize(key) {
  return game.i18n.localize(key);
}

/**
 * Read an AoV actor ability total from either total or value storage.
 *
 * @param {Actor|object|null|undefined} actor Actor document.
 * @param {string} key Ability key.
 * @returns {number}
 */
export function abilityTotal(actor, key) {
  const data = actor?.system?.abilities?.[key];
  return numberOr(data?.total ?? data?.value, 0);
}

/**
 * Resolve the image to show in compact module chat cards.
 *
 * @param {Actor|object|null|undefined} actor Actor document.
 * @returns {string}
 */
export function actorImage(actor) {
  return actor?.img || "icons/svg/mystery-man.svg";
}

/**
 * Resolve the display name to show in compact module chat cards.
 *
 * @param {Actor|object|null|undefined} actor Actor document.
 * @returns {string}
 */
export function actorName(actor) {
  return actor?.name || localize("AOV_SKJALDBORG.Warnings.ActorUnavailable");
}


/**
 * Resolve the pending chat-message HTMLElement defensively.
 *
 * @param {HTMLElement|ArrayLike<HTMLElement>|null|undefined} html Pending message HTML.
 * @returns {HTMLElement|null}
 */
export function resolveChatMessageElement(html) {
  if (!html) return null;
  if (typeof html.querySelector === "function") return html;
  const candidate = html[0];
  return candidate && typeof candidate.querySelector === "function" ? candidate : null;
}

/**
 * Resolve an AoV participant id/type pair into its Actor document.
 *
 * @param {unknown} participantId AoV participant id.
 * @param {unknown} participantType AoV participant type.
 * @returns {Actor|null}
 */
export function actorFromAoVParticipant(participantId, participantType) {
  const id = String(participantId ?? "");
  const type = String(participantType ?? "");
  if (!id) return null;
  if (type === "token") return game.actors?.tokens?.[id] ?? null;
  if (type === "actor") return game.actors?.get?.(id) ?? null;
  return null;
}

/**
 * Whether core AoV automatic damage application is currently enabled.
 *
 * @returns {boolean}
 */
export function autoDamageEnabled() {
  try {
    return !!game.settings.get("aov", "autoDmg");
  } catch (_exception) {
    return false;
  }
}

/**
 * Read the current armor points from a target hit location.
 *
 * @param {Actor|object} actor Target Actor.
 * @param {Item|object} hitLocation Target hit-location Item.
 * @returns {number}
 */
export function locationArmor(actor, hitLocation) {
  const value = actor?.type === "npc" ? hitLocation?.system?.npcAP : hitLocation?.system?.map;
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

/**
 * Read gross damage before armor absorption from an AoV damage card.
 *
 * @param {object|null|undefined} card AoV damage card.
 * @returns {number}
 */
export function grossDamage(card) {
  const damageBeforeAbsorb = Number(card?.damageBeforeAbsorb);
  if (Number.isFinite(damageBeforeAbsorb)) return Math.max(0, damageBeforeAbsorb);
  return Math.max(0, (Number(card?.rollVal ?? 0) || 0) + (Number(card?.armourAbsorb ?? 0) || 0));
}

/**
 * Read AoV combat cards from a ChatMessage.
 *
 * @param {ChatMessage|null|undefined} message Candidate message.
 * @returns {object[]}
 */
export function aovCards(message) {
  const cards = message?.getFlag?.("aov", "chatCard") ?? message?.flags?.aov?.chatCard ?? [];
  return Array.isArray(cards) ? cards : [];
}

/**
 * Return the initiating card from an AoV combat ChatMessage.
 *
 * @param {ChatMessage|object|null|undefined} message Candidate message.
 * @returns {object|null}
 */
export function attackCard(message) {
  return aovCards(message)[0] ?? null;
}

/**
 * Whether an AoV combat card has reached its closed state.
 *
 * @param {ChatMessage|object|null|undefined} message Candidate message.
 * @returns {boolean}
 */
export function attackCardResolved(message) {
  return message?.getFlag?.("aov", "cardType") === "CO"
    && message?.getFlag?.("aov", "state") === "closed";
}

/**
 * Whether the initiating AoV combat card succeeded.
 *
 * @param {ChatMessage|object|null|undefined} message Candidate message.
 * @returns {boolean}
 */
export function attackCardSucceeded(message) {
  const card = attackCard(message);
  return card?.rollDamage === true || Number(card?.resultLevel ?? 1) >= 2;
}

/**
 * Read a stable-ish creation timestamp for recent-message matching.
 *
 * @param {ChatMessage|null|undefined} message Candidate message.
 * @returns {number}
 */
export function messageTimestamp(message) {
  return Number(message?.timestamp ?? message?._stats?.createdTime ?? 0) || 0;
}

/**
 * Compare AoV participant ids while tolerating missing type fields.
 *
 * @param {unknown} id Candidate id.
 * @param {unknown} type Candidate type.
 * @param {unknown} cardId Card id.
 * @param {unknown} cardType Card type.
 * @returns {boolean}
 */
export function idTypeMatch(id, type, cardId, cardType) {
  const leftId = String(id ?? "");
  const rightId = String(cardId ?? "");
  if (!leftId || !rightId || leftId !== rightId) return false;
  const leftType = String(type ?? "");
  const rightType = String(cardType ?? "");
  return !leftType || !rightType || leftType === rightType;
}

/**
 * Find recent chat messages carrying a module flag.
 *
 * @param {object} options Lookup options.
 * @param {ChatMessage|null} [options.excludeMessage=null] Message to omit.
 * @param {string} options.flag Module flag key.
 * @param {number} [options.windowMs=600000] Recent-message window in milliseconds.
 * @param {(entry: {message: ChatMessage, flag: object}) => boolean} [options.predicate] Extra filter.
 * @param {(flag: object, message: ChatMessage) => number} [options.createdAt] Flag timestamp reader.
 * @returns {{message: ChatMessage, flag: object}[]}
 */
export function recentFlaggedMessages({
  excludeMessage = null,
  flag,
  windowMs = 10 * 60 * 1000,
  predicate = null,
  createdAt = (flagData, message) => Number(flagData?.createdAt ?? messageTimestamp(message))
} = {}) {
  const now = Date.now();
  return collectionArray(ui?.chat?.collection ?? game?.messages)
    .filter(message => message?.id !== excludeMessage?.id)
    .map(message => ({ message, flag: message.getFlag?.(MODULE_ID, flag) ?? null }))
    .filter(entry => entry.flag && entry.flag.resolved !== true)
    .filter(entry => {
      const timestamp = Number(createdAt(entry.flag, entry.message));
      return !timestamp || Math.abs(now - timestamp) <= windowMs;
    })
    .filter(entry => typeof predicate === "function" ? predicate(entry) : true)
    .sort((a, b) => Number(createdAt(b.flag, b.message)) - Number(createdAt(a.flag, a.message)));
}

export function combatantForToken(combat, tokenDocument, actor) {
  if (!combat) return null;
  const tokenMatched = combatantForTokenDocument(combat, tokenDocument);
  if (tokenMatched) return tokenMatched;

  // Last-resort compatibility fallback for legacy AoV calls which provide an
  // Actor but no resolvable TokenDocument. Ambiguous linked-token copies are
  // deliberately not collapsed.
  const actorId = String(actor?.id ?? "").trim();
  if (!actorId) return null;
  const actorMatches = combatantValues(combat).filter(combatant => String(combatant?.actor?.id ?? combatant?.actorId ?? "") === actorId);
  return actorMatches.length === 1 ? actorMatches[0] : null;
}

/**
 * Resolve AoV's result-level label with a numeric fallback.
 *
 * @param {unknown} resultLevel AoV result level.
 * @returns {string}
 */
export function resultLevelLabel(resultLevel) {
  const key = `AOV.resultLevel.${resultLevel}`;
  const localized = game.i18n.localize(key);
  return localized === key ? String(resultLevel) : localized;
}

/**
 * Build the compact success/failure icon HTML used in module cards.
 *
 * @param {unknown} resultLevel AoV result level.
 * @returns {string}
 */
export function resultIconHtml(resultLevel) {
  const level = Number(resultLevel);
  if (level >= 4) return '<i class="result-success fas fa-axe-battle"></i><i class="result-success fas fa-axe-battle"></i><i class="result-success fas fa-axe-battle"></i>';
  if (level === 3) return '<i class="result-success fas fa-axe-battle"></i><i class="result-success fas fa-axe-battle"></i>';
  if (level === 2) return '<i class="result-success fas fa-axe-battle"></i>';
  if (level === 1) return '<i class="result-fail fas fa-skull"></i>';
  return '<i class="result-fail fas fa-skull"></i><i class="result-fail fas fa-skull"></i>';
}

/**
 * Show a roll through Dice So Nice when the module is available.
 *
 * @param {Roll|null|undefined} roll Evaluated Roll.
 * @param {string} [warningMessage] Warning logged when Dice So Nice fails.
 * @returns {Promise<boolean>}
 */
export async function showDice3dForRoll(roll, warningMessage = "Dice So Nice roll display failed for Skjaldborg automation.") {
  const dice3d = game.dice3d;
  if (!roll || typeof dice3d?.showForRoll !== "function") return false;
  try {
    await dice3d.showForRoll(roll, game.user, true, null, false);
    return true;
  } catch (exception) {
    warn(warningMessage, exception);
    return false;
  }
}

/**
 * Evaluate a formula and attempt to display it through Dice So Nice.
 *
 * @param {string} formula Roll formula.
 * @param {string} warningMessage Warning logged when Dice So Nice fails.
 * @returns {Promise<Roll>}
 */
export async function evaluateVisibleRoll(formula, warningMessage) {
  const roll = await new Roll(formula).evaluate();
  await showDice3dForRoll(roll, warningMessage);
  return roll;
}

/**
 * Clamp an AoV critical or fumble chance percentage to the supported 0-10 range.
 *
 * @param {unknown} value Candidate percentage.
 * @returns {number}
 */
export function clampCritFumbleChance(value) {
  const number = Number(value);
  const finite = Number.isFinite(number) ? number : 5;
  return Math.min(Math.max(finite, 0), 10);
}

/**
 * Resolve AoV 14.4 critical and fumble chance percentages from a skill/passion.
 *
 * @param {Item|object|null|undefined} item AoV skill or passion item.
 * @returns {{critChance: number, fumbleChance: number}}
 */
export function getItemCritFumbleChances(item) {
  return {
    critChance: clampCritFumbleChance(5 * numberOr(item?.system?.critMult, 1)),
    fumbleChance: clampCritFumbleChance(5 * numberOr(item?.system?.fumbleMult, 1))
  };
}

function itemCid(item) {
  return String(item?.flags?.aov?.cidFlag?.id ?? "").trim();
}

/**
 * Resolve AoV 14.4 weapon critical and fumble chances from the linked skill.
 *
 * @param {Actor|object|null|undefined} actor Actor owning the weapon.
 * @param {Item|object|null|undefined} weapon Weapon item.
 * @returns {{critChance: number, fumbleChance: number}}
 */
export function getWeaponCritFumbleChances(actor, weapon) {
  const skillCid = String(weapon?.system?.skillCID ?? "").trim();
  if (!skillCid) return getItemCritFumbleChances(null);
  const linkedSkill = collectionArray(actor?.items)
    .find(item => item?.type === "skill" && itemCid(item) === skillCid);
  return getItemCritFumbleChances(linkedSkill);
}

/**
 * Evaluate an AoV 14.4 D100 roll result against a target score.
 *
 * This mirrors AoV 14.4 AOVCheck.successLevel for critical, special, fumble,
 * clamped success, and final result ordering.
 *
 * @param {object} options Evaluation options.
 * @param {unknown} options.targetScore Target percentage.
 * @param {unknown} options.rollResult D100 result.
 * @param {unknown} [options.critChance=5] Critical chance percentage.
 * @param {unknown} [options.fumbleChance=5] Fumble chance percentage.
 * @returns {0|1|2|3|4} AoV result level.
 */
export function evaluateAovD100({
  targetScore,
  rollResult,
  critChance = 5,
  fumbleChance = 5
} = {}) {
  const target = numberOr(targetScore, 0);
  const roll = numberOr(rollResult, 0);
  const critical = Math.max(Math.round(target * clampCritFumbleChance(critChance) / 100), 1);
  const special = Math.max(Math.round(target / 5), 1);
  const fumble = Math.max(
    90,
    Math.min(101 - Math.round((100 - target) * clampCritFumbleChance(fumbleChance) / 100), 100)
  );
  const success = Math.min(Math.max(target, 5), 95);

  if (roll <= critical) return 4;
  if (roll <= special) return 3;
  if (roll >= fumble) return 0;
  if (roll <= success) return 2;
  return 1;
}

/**
 * Evaluate an AoV 14.4 D100 roll result with default critical and fumble chances.
 *
 * @param {unknown} targetScore Target percentage.
 * @param {unknown} rollResult D100 result.
 * @returns {0|1|2|3|4} AoV result level.
 */
export function evaluateD100(targetScore, rollResult) {
  return evaluateAovD100({ targetScore, rollResult });
}

/**
 * Convert a D6 total to a D3 total using AoV's ceiling rule.
 *
 * @param {unknown} total D6 total.
 * @returns {number}
 */
export function d6TotalToD3(total) {
  return Math.max(1, Math.ceil((Number(total) || 1) / 2));
}

/**
 * Render a compact AoV-styled module chat card with one actor stack.
 *
 * @param {object} options Render options.
 * @returns {string}
 */
export function renderActorStackCard({
  actor,
  title,
  label,
  resultHtml = "",
  resultClass = "",
  extraRows = [],
  showResultTitle = true,
  formClass = "",
  resultBaseClass = "",
  rowClass = ""
}) {
  const escapedRows = extraRows
    .filter(row => row !== null && row !== undefined && String(row).trim() !== "")
    .map(row => `<div class="header roll-truncate${rowClass ? ` ${foundry.utils.escapeHTML(rowClass)}` : ""}"><div class="name"><span class="tag">${foundry.utils.escapeHTML(String(row))}</span></div></div>`)
    .join("");
  const formClasses = ["aov", "aov-skjaldborg-knockback-chat", formClass].filter(Boolean).join(" ");
  const resultClasses = ["combat-result", "skj-knockback-chat-result", resultBaseClass, resultClass].filter(Boolean).join(" ");
  return `
    <form class="${foundry.utils.escapeHTML(formClasses)}">
      <div class="">
        <ol class="op-list">
          <div class="dice-roll expanded" data-action="expandRoll">
            <li class="actor-roll">
              <img class="open-actor" src="${foundry.utils.escapeHTML(actorImage(actor))}" height="53" width="53" data-tooltip="${foundry.utils.escapeHTML(actorName(actor))}" />
              <div class="roll-details">
                <div class="header">
                  <div class="name"><span class="tag bold">${foundry.utils.escapeHTML(actorName(actor))}</span></div>
                </div>
                <div class="header roll-truncate">
                  <div class="name truncate"><span class="tag">${foundry.utils.escapeHTML(label)}</span></div>
                </div>
                ${escapedRows}
              </div>
            </li>
          </div>
        </ol>
      </div>
      <div class="${foundry.utils.escapeHTML(resultClasses)}">
        ${showResultTitle ? `<strong>${foundry.utils.escapeHTML(title)}</strong>` : ""}
        ${resultHtml ? `<span>${resultHtml}</span>` : ""}
      </div>
    </form>`;
}

/**
 * Build a small icon-plus-text result line for compact module cards.
 *
 * @param {{iconHtml?: string, text?: string}} [options={}] Result line options.
 * @returns {string}
 */
export function inlineResultHtml({ iconHtml = "", text = "" } = {}) {
  return `<span class="skj-knockback-chat-line skj-knockback-chat-line--inline">${iconHtml}${foundry.utils.escapeHTML(text)}</span>`;
}

/**
 * Render an AoV chat template through Foundry's Handlebars renderer.
 *
 * @param {string} template Template path.
 * @param {object} data Template data.
 * @returns {Promise<string>}
 */
export async function renderAoVChat(template, data) {
  return foundry.applications.handlebars.renderTemplate(template, data);
}

/**
 * Re-render a message's AoV chat content from its current flag state.
 *
 * @param {ChatMessage} message Message to re-render.
 * @returns {Promise<void>}
 */
export async function rerenderAoVMessage(message, {
  fallbackTemplate = AOV_TEMPLATES.ROLL_COMBAT,
  guarded = false
} = {}) {
  const refreshed = game.messages?.get?.(message.id) ?? message;
  const template = refreshed.flags?.aov?.chatTemplate ?? fallbackTemplate;
  if (!template) return;
  const content = await renderAoVChat(template, refreshed.flags.aov);
  if (guarded) {
    await guardedUpdate(refreshed, { content }, { category: "chat.aovRerender" });
    return;
  }
  await refreshed.update({ content });
}

/**
 * Locate the first unresolved positive AoV damage card awaiting hit location.
 *
 * @param {ChatMessage|object|null|undefined} message Candidate message.
 * @returns {{card: object, index: number}|null}
 */
export function findDamageLocationCard(message) {
  const cards = aovCards(message);
  const index = cards.findIndex(card => (
    card?.rollType === "DM"
    && card.damageCF === true
    && grossDamage(card) > 0
    && !String(card.targetLocID ?? "").trim()
  ));
  return index >= 0 ? { card: cards[index], index } : null;
}

/**
 * Register the common create/update ChatMessage observer pair.
 *
 * @param {(message: ChatMessage) => Promise<unknown>|unknown} handler Handler.
 * @param {{hooks?: typeof Hooks, onError?: (error: unknown) => void}} [options={}] Registration options.
 * @returns {number} Number of registered hooks.
 */
export function registerChatMessageAutomationHooks(handler, {
  hooks = globalThis.Hooks,
  onError = exception => warn(exception)
} = {}) {
  if (typeof handler !== "function" || typeof hooks?.on !== "function") return 0;
  const callback = message => {
    void Promise.resolve(handler(message)).catch(onError);
  };
  hooks.on("createChatMessage", callback);
  hooks.on("updateChatMessage", callback);
  return 2;
}

function participantForActor(actor, tokenDocument = null) {
  if (tokenDocument?.uuid) {
    const tokenId = String(tokenDocument.uuid).split(".Token.").at(-1) ?? tokenDocument.id;
    if (tokenId && game.actors?.tokens?.[tokenId]) {
      return {
        particId: tokenId,
        particType: "token",
        particName: tokenDocument.name ?? actorName(actor),
        particImg: actorImage(actor),
        actorType: actor?.type ?? ""
      };
    }
  }
  return {
    particId: actor?.id ?? "",
    particType: "actor",
    particName: actorName(actor),
    particImg: actorImage(actor),
    actorType: actor?.type ?? ""
  };
}

/**
 * Build a minimal AoV combat attack card for module-authored workflows.
 *
 * @param {object} options Attack-card options.
 * @returns {object}
 */
export function buildCombatAttackCard({ actor, tokenDocument, weapon, targetToken, targetNumber, flatMod, fallbackLabel, labelSuffix = "" }) {
  const participant = participantForActor(actor, tokenDocument);
  const baseLabel = weapon?.name ?? fallbackLabel ?? localize("AOV_SKJALDBORG.KnockbackDialog.Weapon");
  const label = `${baseLabel}${labelSuffix ? ` - ${labelSuffix}` : ""}`;
  const { critChance, fumbleChance } = getWeaponCritFumbleChances(actor, weapon);
  return {
    rollType: "WP",
    particId: participant.particId,
    particType: participant.particType,
    particName: participant.particName,
    particImg: participant.particImg,
    actorType: participant.actorType,
    targetId: targetToken?.document?.id ?? targetToken?.id ?? "",
    targetType: "token",
    targetLoc: "",
    characteristic: false,
    label,
    critChance,
    fumbleChance,
    targetScore: targetNumber,
    rawScore: numberOr(weapon?.system?.total, 0),
    difficulty: "simple",
    diffLabel: game.i18n.localize("AOV.rolls.simple"),
    rollFormula: "1D100",
    flatMod,
    encPenalty: numberOr(actor?.system?.encPenalty, 0),
    mqPenalty: 0,
    targetAdj: 0,
    rollResult: undefined,
    rollVal: undefined,
    oppRes: 0,
    damTypeLabel: "",
    damBonus: 0,
    successLevel: "99",
    successLevelLabel: "",
    augAdj: 0,
    diceRolled: "",
    skillId: weapon?.id ?? false,
    // AoV's stock roll-combat.hbs prints an extra parenthetical action label
    // for every combatAction except "none" and "dodge". Module special-action
    // cards still need to roll, so "none" cannot be used. The "dodge" sentinel
    // keeps the label clean without changing the CO resolver's D100 handling.
    combatAction: "dodge",
    combatActionLabel: "",
    resultLevel: 0,
    resultLabel: "",
    userID: game.user?.id ?? "",
    origID: game.user?.id ?? ""
  };
}

/**
 * Build one side of an AoV resistance card.
 *
 * @param {object} options Resistance-card options.
 * @returns {object}
 */
export function buildResistanceChatCard({
  actor,
  tokenDocument,
  label,
  rawScore,
  active,
  targetScore = null,
  flatMod = 0,
  characteristic = false
}) {
  const participant = participantForActor(actor, tokenDocument);
  const normalizedRawScore = numberOr(rawScore, 0);
  const normalizedFlatMod = numberOr(flatMod, 0);
  return {
    rollType: "CH",
    particId: participant.particId,
    particType: participant.particType,
    particName: participant.particName,
    particImg: participant.particImg,
    actorType: participant.actorType,
    targetId: "",
    targetType: "",
    targetLoc: "",
    characteristic,
    label,
    targetScore: targetScore === null || targetScore === undefined ? normalizedRawScore * 5 : numberOr(targetScore, 0),
    rawScore: normalizedRawScore,
    difficulty: "simple",
    diffLabel: game.i18n.localize("AOV.rolls.simple"),
    rollFormula: "1D100",
    flatMod: normalizedFlatMod,
    encPenalty: 0,
    mqPenalty: 0,
    targetAdj: 0,
    rollResult: undefined,
    rollVal: undefined,
    oppRes: 0,
    damTypeLabel: "",
    damBonus: 0,
    successLevel: "99",
    successLevelLabel: "",
    augAdj: 0,
    diceRolled: "",
    skillId: false,
    resultLevel: 0,
    resultLabel: "",
    userID: game.user?.id ?? "",
    origID: game.user?.id ?? "",
    active
  };
}
