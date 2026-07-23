import { versionAtLeast } from "../utils/version.mjs";

export const CHAT_MESSAGE_DELIVERY = Object.freeze({
  INTERACTIVE: "interactive",
  BACKGROUND: "background"
});

/**
 * Build Foundry document-create options for a module chat message.
 *
 * Foundry 14.365 forwards `notify` and `scroll` to the chat log. Automated
 * background reports opt out of both so they do not steal the user's current
 * chat position or create an unread notification. Older supported v14 builds
 * receive the caller's original operation object without undocumented keys.
 *
 * @param {string} delivery Delivery policy.
 * @param {object} [operation={}] Caller-supplied document operation.
 * @param {string} [foundryVersion] Explicit version for contracts.
 * @returns {object}
 */
export function chatMessageOperation(
  delivery,
  operation = {},
  foundryVersion = String(globalThis.game?.release?.version ?? globalThis.game?.version ?? "")
) {
  const base = delivery === CHAT_MESSAGE_DELIVERY.BACKGROUND && versionAtLeast(foundryVersion, "14.365")
    ? { notify: false, scroll: false }
    : {};
  return { ...base, ...(operation ?? {}) };
}

/**
 * Create a ChatMessage through Foundry v14's message-visibility API.
 *
 * Foundry v14 renamed the client visibility setting from `core.rollMode` to
 * `core.messageMode` and exposes `ChatMessage.applyMode` as the public way to
 * translate the user's selected message mode into `whisper` and `blind` data.
 * Calling `applyMode` without an explicit mode delegates to the current client
 * setting without coupling the module to either setting key.
 *
 * Messages with an explicit audience, such as phase reports, can opt out so
 * their caller-supplied `whisper` and `blind` fields remain authoritative.
 *
 * @param {object} data Candidate ChatMessage source data.
 * @param {object} [options={}] Creation options.
 * @param {boolean} [options.applyDefaultMode=true] Apply the current client's default message mode.
 * @param {string|undefined} [options.mode] Optional explicit Foundry message mode.
 * @param {"interactive"|"background"} [options.delivery="interactive"] Chat presentation policy.
 * @param {object} [options.operation={}] ChatMessage document-create operation.
 * @returns {Promise<ChatMessage|null>}
 */
export async function createModuleChatMessage(
  data,
  {
    applyDefaultMode = true,
    mode = undefined,
    delivery = CHAT_MESSAGE_DELIVERY.INTERACTIVE,
    operation = {}
  } = {}
) {
  const messageData = { ...data };
  if (applyDefaultMode) ChatMessage.applyMode(messageData, mode);
  return (await ChatMessage.create(messageData, chatMessageOperation(delivery, operation))) ?? null;
}
