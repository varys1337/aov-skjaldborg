/**
 * Versioned Age of Vikings integration contract for AoV 14.4-14.5.
 *
 * Runtime modules outside the adapter boundary consume these identifiers
 * instead of embedding system routes. The validator checks every path against
 * the installed AoV system before packaging.
 */
export const AOV_IMPORTS = Object.freeze({
  CHECKS: "systems/aov/system/apps/checks.mjs",
  COMBAT_CHAT: "systems/aov/system/chat/combat-chat.mjs",
  DIALOG: "systems/aov/system/setup/aov-dialog.mjs",
  ROLL_TYPES: "systems/aov/system/apps/roll-types.mjs",
  SELECT_LISTS: "systems/aov/system/apps/select-lists.mjs"
});

export const AOV_TEMPLATES = Object.freeze({
  ROLL_COMBAT: "systems/aov/templates/chat/roll-combat.hbs",
  ROLL_RESISTANCE: "systems/aov/templates/chat/roll-resistance.hbs",
  ROLL_OPTIONS: "systems/aov/templates/dialog/rollOptions.hbs"
});

export function routeForAoVImport(path) {
  const contractPath = String(path ?? "");
  return foundry.utils.getRoute?.(contractPath) ?? `/${contractPath}`;
}

export async function importAoVModule(path) {
  return import(routeForAoVImport(path));
}
