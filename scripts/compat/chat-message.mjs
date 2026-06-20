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
 * @param {object} [options.operation={}] ChatMessage document-create operation.
 * @returns {Promise<ChatMessage|null>}
 */
export async function createModuleChatMessage(
  data,
  { applyDefaultMode = true, mode = undefined, operation = {} } = {}
) {
  const messageData = { ...data };
  if (applyDefaultMode) ChatMessage.applyMode(messageData, mode);
  return (await ChatMessage.create(messageData, operation)) ?? null;
}
