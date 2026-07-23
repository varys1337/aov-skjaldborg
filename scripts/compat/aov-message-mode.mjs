import { MODULE_ID } from "../constants.mjs";
import { debug } from "../logger.mjs";

const PATCH_MARKER = Symbol.for(`${MODULE_ID}.aovMessageModeCompatibility`);

/**
 * Detect the AoV v14 initiative override which still reads the deprecated
 * `core.rollMode` client setting. The setting value is not used by AoV's
 * implementation because that override intentionally creates no initiative
 * ChatMessages, so the safe v14 migration is to preserve the initiative/update
 * behavior while removing only the obsolete setting access.
 *
 * @param {Function} method Candidate Combat#rollInitiative implementation.
 * @returns {boolean}
 */
function methodUsesDeprecatedRollMode(method) {
  if (typeof method !== "function") return false;
  const source = Function.prototype.toString.call(method);
  return source.includes("rollMode") && source.includes("game.settings.get");
}

/**
 * Describe the current AoV Combat#rollInitiative compatibility state without
 * mutating the Combat class.
 *
 * @returns {{hasCombatClass: boolean, hasRollInitiative: boolean, patched: boolean, usesDeprecatedRollMode: boolean, compatible: boolean, status: string}}
 */
export function getAoVMessageModeCompatibilityStatus() {
  const prototype = CONFIG?.Combat?.documentClass?.prototype;
  const method = prototype?.rollInitiative;
  const hasCombatClass = !!prototype;
  const hasRollInitiative = typeof method === "function";
  const patched = !!prototype?.[PATCH_MARKER];
  const usesDeprecatedRollMode = hasRollInitiative && methodUsesDeprecatedRollMode(method);
  const compatible = hasRollInitiative && (patched || !usesDeprecatedRollMode);
  let status = "already-compatible";
  if (!hasCombatClass) status = "combat-class-unavailable";
  else if (!hasRollInitiative) status = "roll-initiative-unavailable";
  else if (patched) status = "patched";
  else if (usesDeprecatedRollMode) status = "unsafe-unpatched";
  return {
    hasCombatClass,
    hasRollInitiative,
    patched,
    usesDeprecatedRollMode,
    compatible,
    status
  };
}

/**
 * Install a narrowly scoped compatibility override for the current AoV Combat
 * document class. The replacement mirrors AoV 14.5's rollInitiative semantics:
 * owner-filtered combatants, evaluated initiative rolls, one embedded update,
 * no initiative chat cards, and preservation of the current turn when
 * updateTurn is false.
 *
 * The method accepts Foundry v14's documented `messageMode` and
 * `messageOptions` keys even though AoV's no-chat implementation does not use
 * them. This keeps callers source-compatible with the public v14 signature.
 *
 * @returns {boolean} Whether the runtime is either already compatible or was
 *   successfully patched.
 */
export function installAoVMessageModeCompatibility() {
  if (game.system?.id !== "aov") return false;

  const CombatClass = CONFIG?.Combat?.documentClass;
  const prototype = CombatClass?.prototype;
  const current = prototype?.rollInitiative;
  if (!prototype || typeof current !== "function") return false;

  if (prototype[PATCH_MARKER]) return true;
  if (!methodUsesDeprecatedRollMode(current)) return true;

  Object.defineProperty(prototype, PATCH_MARKER, {
    configurable: false,
    enumerable: false,
    value: Object.freeze({ original: current }),
    writable: false
  });

  prototype.rollInitiative = async function rollInitiativeV14(
    ids,
    {
      formula = null,
      updateTurn = false,
      messageMode = undefined,
      messageOptions = {}
    } = {}
  ) {
    // AoV 14.5 intentionally suppresses initiative ChatMessages. Retain the
    // public v14 options for API compatibility without changing that behavior.
    void messageMode;
    void messageOptions;

    const requestedIds = typeof ids === "string" ? [ids] : Array.from(ids ?? []);
    const updates = [];

    for (const id of requestedIds) {
      const combatant = this.combatants.get(id);
      if (!combatant?.isOwner) continue;

      let roll = combatant.getInitiativeRoll(formula);
      if (roll && typeof roll.then === "function") roll = await roll;
      if (!roll || typeof roll.evaluate !== "function") continue;

      await roll.evaluate();
      updates.push({ _id: id, initiative: roll.total });
    }

    if (!updates.length) return this;

    const updateOptions = { turnEvents: false };
    if (!updateTurn) updateOptions.combatTurn = this.turn;
    await this.updateEmbeddedDocuments("Combatant", updates, updateOptions);
    return this;
  };

  debug("Installed AoV v14 message-mode compatibility for Combat#rollInitiative.");
  return true;
}

/**
 * Report whether the AoV Combat class is free of the deprecated setting access
 * after compatibility installation.
 *
 * @returns {boolean}
 */
export function isAoVMessageModeCompatible() {
  return getAoVMessageModeCompatibilityStatus().compatible;
}
