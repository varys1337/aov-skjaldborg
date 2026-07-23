import {
  MODULE_ID,
  REPORT_DELIVERY,
  REPORT_PHASE_SETTING_KEYS,
  REPORT_RECIPIENTS,
  REPORT_SCOPE
} from "../constants.mjs";
import { AoVAdapter } from "../adapter/aov-adapter.mjs";
import { createModuleChatMessage } from "../compat/chat-message.mjs";
import { computeDexLedger } from "./dex-ledger.mjs";
import { getCombatantState, phaseLabelKey } from "./state.mjs";

/**
 * Determine whether the configured phase should create a report.
 *
 * @param {string} phase Phase id being entered.
 * @returns {boolean}
 */
export function shouldPostPhaseReport(phase) {
  const settingKey = REPORT_PHASE_SETTING_KEYS[phase];
  return !!settingKey && game.settings.get(MODULE_ID, settingKey);
}

/**
 * Determine whether a combatant has at least one non-GM owner.
 *
 * @param {Combatant} combatant Combatant document.
 * @returns {boolean}
 */
export function isPlayerOwnedCombatant(combatant) {
  if (!combatant?.actor) return false;
  return Array.from(game.users ?? []).some(user => {
    return !user.isGM && combatant.actor.testUserPermission(user, "OWNER");
  });
}

/**
 * Format a signed numeric DEX modifier for display.
 *
 * @param {number} value Modifier value.
 * @returns {string}
 */
function signed(value) {
  const number = Number(value) || 0;
  return number > 0 ? `+${number}` : String(number);
}

/**
 * Join tooltip lines in a compact Foundry tooltip-safe string.
 *
 * @param {string[]} lines Tooltip lines.
 * @returns {string}
 */
function tooltip(lines) {
  return lines.filter(Boolean).join(" | ");
}

/**
 * Build report rows from current combatant state without mutating documents.
 *
 * @param {Combat} combat Foundry Combat document.
 * @param {string} scope Combatant detail scope for this specific message.
 * Rows are ordered exactly as the phase begins: highest Final DEX first,
 * then highest INT as the AoV tie-breaker, followed by deterministic name/id
 * fallbacks so every recipient sees the same ranking.
 *
 * @returns {{combatantId: string, actorName: string, baseDex: number, int: number, finalDex: number, modifierTotal: string, baseDexTooltip: string, modifierTooltip: string, finalDexTooltip: string, preventedThisRound: boolean, modifiers: {label: string, value: string}[], rules: string[]}[]}
 */
export function buildDexReportRows(combat, scope = REPORT_SCOPE.ALL) {
  const rows = [];
  for (const combatant of combat.combatants) {
    if (!AoVAdapter.isCombatantCapable(combatant)) continue;
    if (scope === REPORT_SCOPE.PLAYER_OWNED && !isPlayerOwnedCombatant(combatant)) continue;
    const combatantState = getCombatantState(combatant);
    const ledger = combatantState.dexLedger ?? computeDexLedger(combatant, combatantState);
    const rules = [];
    if (combatantState.intent?.modifiers?.fullMove) {
      rules.push(game.i18n.localize("AOV_SKJALDBORG.Chat.FullMovementRule"));
    }
    if (Number.isFinite(ledger.fixedRank)) {
      rules.push(game.i18n.format("AOV_SKJALDBORG.Chat.FixedRankRule", { value: ledger.fixedRank }));
    }
    if (combatantState.intent?.delay?.enabled && Number.isFinite(Number(combatantState.intent.delay.targetDex))) {
      rules.push(game.i18n.format("AOV_SKJALDBORG.Chat.DelayRule", { value: combatantState.intent.delay.targetDex }));
    }
    if (ledger.preventedThisRound) {
      rules.push(game.i18n.localize("AOV_SKJALDBORG.Chat.PreventedRule"));
    }
    const modifiers = (ledger.modifiers ?? []).map(modifier => ({
      label: game.i18n.localize(modifier.label),
      value: signed(modifier.value)
    }));
    const modifierTotal = signed(ledger.modifierTotal);
    const baseDexLabel = game.i18n.localize("AOV_SKJALDBORG.Chat.BaseDex");
    const dexChangesLabel = game.i18n.localize("AOV_SKJALDBORG.Chat.DexChanges");
    const finalDexLabel = game.i18n.localize("AOV_SKJALDBORG.Chat.FinalDex");
    const intLabel = game.i18n.localize("AOV_SKJALDBORG.Labels.Int");
    rows.push({
      combatantId: combatant.id,
      actorName: combatant.name,
      baseDex: ledger.baseDex,
      int: ledger.int,
      finalDex: ledger.finalDex,
      modifierTotal,
      baseDexTooltip: tooltip([
        combatant.name,
        `${baseDexLabel}: ${ledger.baseDex}`,
        `${intLabel}: ${ledger.int}`
      ]),
      modifierTooltip: tooltip([
        `${dexChangesLabel}: ${modifierTotal}`,
        ...modifiers.map(modifier => `${modifier.label}: ${modifier.value}`),
        ...rules
      ]),
      finalDexTooltip: tooltip([
        combatant.name,
        `${baseDexLabel}: ${ledger.baseDex}`,
        `${dexChangesLabel}: ${modifierTotal}`,
        `${finalDexLabel}: ${ledger.finalDex}`,
        `${intLabel}: ${ledger.int}`,
        ...rules
      ]),
      preventedThisRound: ledger.preventedThisRound,
      modifiers,
      rules
    });
  }
  return rows.sort((a, b) => (
    (b.finalDex - a.finalDex)
    || (b.int - a.int)
    || a.actorName.localeCompare(b.actorName, game.i18n.lang)
    || a.combatantId.localeCompare(b.combatantId)
  ));
}

/**
 * Resolve all GM user ids.
 *
 * @returns {string[]}
 */
export function getGmRecipientIds() {
  return Array.from(game.users ?? [])
    .filter(user => user.isGM)
    .map(user => user.id)
    .filter(Boolean);
}

/**
 * Resolve all non-GM user ids.
 *
 * @returns {string[]}
 */
export function getPlayerRecipientIds() {
  return Array.from(game.users ?? [])
    .filter(user => !user.isGM)
    .map(user => user.id)
    .filter(Boolean);
}

/**
 * Resolve the configured combined whisper recipient list.
 *
 * This export remains available for compatibility with prior module versions.
 * Message creation now separates GM and player whispers so each audience may
 * receive a different combatant detail scope.
 *
 * @returns {string[]} User ids.
 */
export function getReportRecipientIds() {
  const configured = game.settings.get(MODULE_ID, "reportWhisperRecipients");
  return configured === REPORT_RECIPIENTS.GM_AND_PLAYERS
    ? [...getGmRecipientIds(), ...getPlayerRecipientIds()]
    : getGmRecipientIds();
}

/**
 * Render one phase report for a specific combatant scope.
 *
 * @param {Combat} combat Foundry Combat document.
 * @param {import("../types.mjs").SkjaldborgCombatState} state Current combat state.
 * @param {string} scope Combatant detail scope for this message.
 * @returns {Promise<string>}
 */
async function renderReportContent(combat, state, scope) {
  const phase = game.i18n.localize(phaseLabelKey(state.phase));
  const reportTitle = game.i18n.format("AOV_SKJALDBORG.Chat.ReportTitle", {
    round: state.logicalRound,
    phase
  });

  return foundry.applications.handlebars.renderTemplate(
    "modules/aov-skjaldborg/templates/phase-report.hbs",
    {
      reportTitle,
      combatants: buildDexReportRows(combat, scope)
    }
  );
}

/**
 * Create one report message with explicit recipients and scope metadata.
 *
 * @param {Combat} combat Foundry Combat document.
 * @param {import("../types.mjs").SkjaldborgCombatState} state Current combat state.
 * @param {string} scope Combatant detail scope for this message.
 * @param {string[]} whisper User ids. Empty means public.
 * @param {string} audience Diagnostic audience label.
 * @returns {Promise<ChatMessage|null>}
 */
async function createReportMessage(combat, state, scope, whisper, audience) {
  if (audience !== "public" && !whisper.length) return null;
  const content = await renderReportContent(combat, state, scope);
  return createModuleChatMessage({
    speaker: ChatMessage.getSpeaker({ scene: canvas.scene }),
    content,
    blind: false,
    whisper,
    flags: {
      [MODULE_ID]: {
        combatId: combat.id,
        phase: state.phase,
        logicalRound: state.logicalRound,
        delivery: whisper.length ? REPORT_DELIVERY.WHISPER : REPORT_DELIVERY.PUBLIC,
        audience,
        scope
      }
    }
  }, { applyDefaultMode: false });
}


/**
 * Track whether chat-report hooks were registered for this client.
 *
 * @type {boolean}
 */
let chatReportHooksRegistered = false;

/**
 * Resolve the pending chat-message HTMLElement defensively.
 *
 * Foundry v14 documents renderChatMessageHTML as providing an HTMLElement, but
 * accepting an array-like wrapper here keeps the compatibility guard harmless
 * if another integration proxies the hook argument.
 *
 * @param {HTMLElement|ArrayLike<HTMLElement>|null|undefined} html Pending message HTML.
 * @returns {HTMLElement|null}
 */
function resolveChatMessageElement(html) {
  if (!html) return null;
  if (typeof html.setAttribute === "function") return html;
  const candidate = html[0];
  return candidate && typeof candidate.setAttribute === "function" ? candidate : null;
}

/**
 * Suppress a player-audience report on GM clients.
 *
 * Foundry permits GMs to see private messages beyond the explicit whisper
 * recipient list. The player-scoped report therefore remains a real whispered
 * ChatMessage for its intended players, while its pending HTML is explicitly
 * removed from every GM chat log. Inline display:none!important is used in
 * addition to the hidden attribute because system/theme CSS may override the
 * browser's default [hidden] rule.
 *
 * @param {ChatMessage} message ChatMessage being rendered.
 * @param {HTMLElement|ArrayLike<HTMLElement>} html Pending message HTML.
 * @returns {void}
 */
function suppressPlayerReportForGm(message, html) {
  if (!game.user?.isGM) return;
  const audience = message?.getFlag?.(MODULE_ID, "audience")
    ?? message?.flags?.[MODULE_ID]?.audience;
  if (audience !== "players") return;

  const element = resolveChatMessageElement(html);
  if (!element) return;
  element.hidden = true;
  element.setAttribute("aria-hidden", "true");
  element.classList?.add?.("aov-skjaldborg-hidden-report");
  element.style?.setProperty?.("display", "none", "important");
}

/**
 * Hide player-audience report messages from GM chat logs.
 *
 * Two ChatMessage documents are required when GMs and players receive different
 * combatant scopes. This hook guarantees that each client renders only its own
 * audience-specific card. Registration is idempotent.
 *
 * @returns {void}
 */
export function registerChatReportHooks(hooks = globalThis.Hooks) {
  if (chatReportHooksRegistered) return;
  chatReportHooksRegistered = true;
  hooks.on("renderChatMessageHTML", suppressPlayerReportForGm);

  // Re-render an already-open GM chat log so player-audience messages created
  // before module ready are also suppressed by the newly registered hook.
  if (game.user?.isGM) queueMicrotask(() => globalThis.ui?.chat?.render?.());
}

/**
 * Create configured chat reports when a Skjaldborg phase is entered.
 *
 * GM reports always contain every capable combatant. When whispered reports
 * also target players, a second player-only message is created using the
 * configured player report scope. The render hook suppresses that player-scoped
 * message on GM clients, preventing a duplicate card in the GM chat log. Public
 * reports necessarily use one shared all-combatant card because public ChatMessages cannot vary
 * content by viewer.
 *
 * @param {Combat} combat Foundry Combat document.
 * @param {import("../types.mjs").SkjaldborgCombatState} state Current combat state.
 * @returns {Promise<ChatMessage|ChatMessage[]|null>}
 */
export async function createPhaseReport(combat, state) {
  if (!game.user?.isGM || !shouldPostPhaseReport(state.phase)) return null;

  const delivery = game.settings.get(MODULE_ID, "reportDelivery");
  if (delivery === REPORT_DELIVERY.PUBLIC) {
    return createReportMessage(combat, state, REPORT_SCOPE.ALL, [], "public");
  }

  const messages = [];
  const gmMessage = await createReportMessage(
    combat,
    state,
    REPORT_SCOPE.ALL,
    getGmRecipientIds(),
    "gm"
  );
  if (gmMessage) messages.push(gmMessage);

  const recipients = game.settings.get(MODULE_ID, "reportWhisperRecipients");
  if (recipients === REPORT_RECIPIENTS.GM_AND_PLAYERS) {
    const playerScope = game.settings.get(MODULE_ID, "reportCombatantScope");
    const playerMessage = await createReportMessage(
      combat,
      state,
      Object.values(REPORT_SCOPE).includes(playerScope) ? playerScope : REPORT_SCOPE.PLAYER_OWNED,
      getPlayerRecipientIds(),
      "players"
    );
    if (playerMessage) messages.push(playerMessage);
  }

  if (!messages.length) return null;
  return messages.length === 1 ? messages[0] : messages;
}
