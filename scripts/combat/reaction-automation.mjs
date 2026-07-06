import { AoVAdapter } from "../adapter/aov-adapter.mjs";
import { MODULE_ID } from "../constants.mjs";
import { runtimeSettings } from "../runtime-settings.mjs";
import { warn } from "../logger.mjs";
import { combatantForTokenDocument } from "./combatant-token-resolution.mjs";
import { getCombatantState } from "./state.mjs";

const REACTION_COMBAT_ACTIONS = new Set(["parry", "dodge"]);

function activeCombat(combat) {
  if (!combat) return false;
  if (combat.started === true) return true;
  return Number(combat.round ?? 0) > 0;
}

/**
 * Check whether a core AoV defender result spent a reaction.
 *
 * @param {object|null|undefined} result Defense workflow result.
 * @returns {boolean}
 */
export function defenseResultUsesReaction(result) {
  if (!result || result.cancelled === true) return false;
  if (result.accepted === false || result.alreadyResolved === true || result.duplicate === true) return false;
  const combatAction = String(result.combatAction ?? result.defenseCombatAction ?? "").toLowerCase();
  if (REACTION_COMBAT_ACTIONS.has(combatAction)) return true;
  const defenseMode = String(result.defenseMode ?? "").toLowerCase();
  return defenseMode === "dodge";
}

/**
 * Read the world toggle for Parry/Dodge reaction automation.
 *
 * @returns {boolean}
 */
export function reactionAutomationEnabled() {
  try {
    return runtimeSettings.autoIncrementReactions === true;
  } catch (_exception) {
    return false;
  }
}

/**
 * Resolve the combatant that defended in a core AoV defense workflow.
 *
 * @param {Combat|null|undefined} combat Active Combat document.
 * @param {object} [payload={}] Defense workflow payload.
 * @returns {Promise<Combatant|null>}
 */
export async function resolveDefenseReactionCombatant(combat, payload = {}) {
  if (!combat) return null;
  const { token } = await AoVAdapter.resolveDefenseParticipant(payload);
  return token ? combatantForTokenDocument(combat, token) : null;
}

/**
 * Automatically increment the defender's reaction tracker when a committed
 * Parry or Dodge defense roll completes.
 *
 * @param {object} request Automation request.
 * @param {object|null|undefined} request.result Defense workflow result.
 * @param {object} [request.payload={}] Defense workflow payload.
 * @param {Combat|null} [request.combat=game.combat] Combat document.
 * @param {(action: string, payload: object) => Promise<unknown>} request.requestReactionIncrement GM socket request function.
 * @returns {Promise<boolean>} Whether an increment request was submitted.
 */
export async function maybeAutoIncrementReactionForDefense({
  result,
  payload = {},
  combat = game.combat,
  requestReactionIncrement
} = {}) {
  if (!reactionAutomationEnabled()) return false;
  if (!activeCombat(combat)) return false;
  if (!defenseResultUsesReaction(result)) return false;
  if (typeof requestReactionIncrement !== "function") return false;

  try {
    const combatant = await resolveDefenseReactionCombatant(combat, payload);
    if (!combatant) {
      warn("Skipped automatic reaction increment; defender combatant could not be resolved.", {
        combatId: combat?.id ?? null,
        tokenUuid: payload?.tokenUuid ?? payload?.targetTokenUuid ?? null,
        actorUuid: payload?.actorUuid ?? payload?.targetActorUuid ?? null
      });
      return false;
    }
    const state = getCombatantState(combatant);
    await requestReactionIncrement("incrementReaction", {
      combatId: combat.id,
      combatantId: combatant.id,
      expectedCombatantUpdatedAt: state.updatedAt ?? null
    });
    return true;
  } catch (exception) {
    warn("Automatic reaction increment failed after a committed defense roll.", exception);
    return false;
  }
}
