import { MODULE_ID } from "../constants.mjs";
import { SOCKET_AUTHORITY } from "./schema.mjs";

export function resolveRequestingUser(userId) {
  const id = String(userId ?? "");
  if (id && id === game.user?.id) return game.user;
  const user = game.users?.get?.(id) ?? game.users?.find?.(candidate => candidate.id === id) ?? null;
  if (!user) throw new Error(`Rejected ${MODULE_ID} socket request from an unknown User.`);
  return user;
}

export function isActionForThisClient({ schema, message, user = game.user } = {}) {
  if (schema?.clientAction !== true) return false;
  const targetId = String(message?.to ?? "");
  return !!targetId && targetId === user?.id;
}

export function assertSocketAuthority({ action, schema, user, payload, message } = {}) {
  void payload;
  if (!schema) throw new Error(`Unknown ${MODULE_ID} socket action "${action ?? ""}"`);

  if (schema.authority === SOCKET_AUTHORITY.GM) {
    if (!user?.isGM) throw new Error(game.i18n.localize("AOV_SKJALDBORG.Warnings.GmOnly"));
    return;
  }

  if (schema.authority === SOCKET_AUTHORITY.LOCAL_CLIENT) {
    if (!isActionForThisClient({ schema, message, user: game.user })) {
      throw new Error(`Rejected ${MODULE_ID} client socket action "${action ?? ""}" because it is not addressed to this client.`);
    }
    return;
  }

  if (schema.authority === SOCKET_AUTHORITY.ACTOR_OWNER_OR_GM) return;

  throw new Error(`Unsupported ${MODULE_ID} socket authority for action "${action ?? ""}".`);
}
