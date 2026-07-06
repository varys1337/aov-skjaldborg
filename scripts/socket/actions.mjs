import { AoVAdapter } from "../adapter/aov-adapter.mjs";
import { maybeAutoIncrementReactionForDefense } from "../combat/reaction-automation.mjs";
import { SocketActionSchemaError } from "./errors.mjs";

export async function handlePromptDefenseRoll({ payload, requestGm }) {
  const result = await AoVAdapter.rollDialogDefenseWorkflow(payload ?? {}, {
    commitDefenseCard: commitPayload => requestGm("commitDefenseCard", commitPayload)
  });
  await maybeAutoIncrementReactionForDefense({
    result,
    payload: payload ?? {},
    combat: game.combat,
    requestReactionIncrement: requestGm
  });
  return result;
}

export async function handleLegacySocketAction({ message }) {
  throw new SocketActionSchemaError(`Socket action "${message?.action ?? ""}" has not migrated to schema execution yet.`, {
    action: message?.action ?? "",
    code: "legacy-action"
  });
}
