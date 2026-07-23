import { AoVAdapter } from "../adapter/aov-adapter.mjs";
import { maybeAutoIncrementReactionForDefense } from "../combat/reaction-automation.mjs";

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
