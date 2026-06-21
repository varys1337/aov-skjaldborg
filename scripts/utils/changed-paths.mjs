/**
 * Flatten a Foundry differential update object into dot-separated property paths.
 *
 * @param {object|null|undefined} changed Differential update payload.
 * @returns {string[]}
 */
export function flattenChangedPaths(changed) {
  const paths = [];
  const visit = (value, prefix) => {
    if (!prefix) return;
    paths.push(prefix);
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    for (const [key, nested] of Object.entries(value)) {
      visit(nested, `${prefix}.${key}`);
    }
  };
  if (!changed || typeof changed !== "object") return paths;
  for (const [key, value] of Object.entries(changed)) visit(value, key);
  return Array.from(new Set(paths));
}

/**
 * Test whether any flattened update path is equal to or inside a watched path.
 *
 * @param {string[]|object|null|undefined} changedOrPaths Differential object or flattened paths.
 * @param {string[]} watchedPaths Path prefixes to test.
 * @returns {boolean}
 */
export function hasAnyChangedPath(changedOrPaths, watchedPaths) {
  const paths = Array.isArray(changedOrPaths) ? changedOrPaths : flattenChangedPaths(changedOrPaths);
  return paths.some(path => watchedPaths.some(watched => path === watched || path.startsWith(`${watched}.`)));
}

/**
 * Classify Actor changes into hotbar invalidation regions.
 *
 * @param {object|null|undefined} changed Actor differential.
 * @returns {Set<string>}
 */
export function actorHotbarPartsForActorChange(changed) {
  const paths = flattenChangedPaths(changed);
  const parts = new Set();
  if (!paths.length) return parts;
  if (hasAnyChangedPath(paths, ["img", "name", "prototypeToken", "prototypeToken.texture", "prototypeToken.disposition"])) {
    parts.add("portrait");
    parts.add("shell");
  }
  if (hasAnyChangedPath(paths, ["system.hp", "system.mp", "system.wounds", "system.hitLocations"])) parts.add("resources");
  if (hasAnyChangedPath(paths, ["system.abilities", "system.stats", "system.skills", "system.passions"])) parts.add("tabBody");
  if (hasAnyChangedPath(paths, ["flags.aov-skjaldborg.quickAccess", "flags.aov-skjaldborg.actionOrder"])) parts.add("quickAccess");
  if (hasAnyChangedPath(paths, ["flags.aov-skjaldborg.preparedIntent", "flags.aov-skjaldborg.readiedWeapon"])) {
    parts.add("workflow");
    parts.add("weaponControls");
  }
  return parts;
}

/**
 * Classify owned Item changes into hotbar invalidation regions.
 *
 * @param {object|null|undefined} changed Item differential.
 * @returns {Set<string>}
 */
export function actorHotbarPartsForItemChange(changed) {
  const paths = flattenChangedPaths(changed);
  const parts = new Set();
  if (!paths.length) return parts;
  if (hasAnyChangedPath(paths, ["name", "img", "type", "system.equipStatus", "system.quantity", "system.encumbrance"])) {
    parts.add("tabBody");
    parts.add("quickAccess");
  }
  if (hasAnyChangedPath(paths, ["system.damage", "system.damType", "system.weaponCat", "system.weaponType", "system.combat", "system.hitPoints", "system.hp"])) {
    parts.add("weaponControls");
    parts.add("tabBody");
  }
  if (hasAnyChangedPath(paths, ["system.xpCheck"])) parts.add("tabBody");
  if (hasAnyChangedPath(paths, ["system.prepared", "system.rune", "system.seidur", "system.magic"])) {
    parts.add("resources");
    parts.add("tabBody");
  }
  if (hasAnyChangedPath(paths, ["system.damageTaken", "system.treated", "system.location", "system.ap"])) {
    parts.add("resources");
    parts.add("tabBody");
  }
  return parts;
}

/**
 * Classify Combatant changes into hotbar invalidation regions.
 *
 * @param {object|null|undefined} changed Combatant differential.
 * @returns {Set<string>}
 */
export function actorHotbarPartsForCombatantChange(changed) {
  const paths = flattenChangedPaths(changed);
  const parts = new Set();
  if (!paths.length) return parts;
  if (hasAnyChangedPath(paths, ["initiative", "flags.aov-skjaldborg.combatantState.intent", "flags.aov-skjaldborg.combatantState.reactionCount", "flags.aov-skjaldborg.combatantState.dexLedger", "flags.aov-skjaldborg.combatantState.movement", "flags.aov-skjaldborg.combatantState.engagement"])) {
    parts.add("workflow");
    parts.add("weaponControls");
  }
  if (hasAnyChangedPath(paths, ["tokenId", "actorId", "hidden", "defeated"])) parts.add("shell");
  return parts;
}

/**
 * Classify Combat changes into hotbar invalidation regions.
 *
 * @param {object|null|undefined} changed Combat differential.
 * @returns {Set<string>}
 */
export function actorHotbarPartsForCombatChange(changed) {
  const paths = flattenChangedPaths(changed);
  const parts = new Set();
  if (!paths.length) return parts;
  if (hasAnyChangedPath(paths, ["turn", "round", "combatants", "flags.aov-skjaldborg.combatState"])) {
    parts.add("workflow");
    parts.add("weaponControls");
    parts.add("tabBody");
  }
  return parts;
}
