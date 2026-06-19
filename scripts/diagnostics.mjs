import { MODULE_ID, SOCKET_NAME } from "./constants.mjs";
import { AoVAdapter } from "./adapter/aov-adapter.mjs";
import { getCombatState } from "./combat/state.mjs";

/**
 * Build a diagnostic row.
 *
 * @param {string} id Check id.
 * @param {boolean} ok Whether the check passed.
 * @param {string} [detail=""] Extra detail for console output.
 * @returns {{id: string, ok: boolean, detail: string}}
 */
function check(id, ok, detail = "") {
  return { id, ok: !!ok, detail };
}

/**
 * Confirm a Handlebars template can be rendered.
 *
 * @param {string} path Foundry template path.
 * @returns {Promise<boolean>}
 */
async function canRenderTemplate(path) {
  try {
    await foundry.applications.handlebars.renderTemplate(path, {});
    return true;
  }
  catch (_err) {
    return false;
  }
}

/**
 * Run in-world diagnostics for installation and runtime assumptions.
 *
 * Exposed as `game.aovSkjadlborg.diagnostics.run()` after ready.
 *
 * @returns {Promise<{id: string, ok: boolean, detail: string}[]>}
 */
export async function runDiagnostics() {
  const results = [];
  const combat = game.combat ?? null;
  results.push(check("system", AoVAdapter.isAoVWorld(), `game.system.id=${game.system?.id ?? "unknown"}`));
  results.push(check("setting-enabled", typeof game.settings.get(MODULE_ID, "enabled") === "boolean"));
  results.push(check("action-ring-setting", typeof game.settings.get(MODULE_ID, "enableActionRing") === "boolean"));
  results.push(check("actor-hotbar-setting", typeof game.settings.get(MODULE_ID, "enableActorHotbar") === "boolean"));
  results.push(check("appv2", !!foundry.applications?.api?.ApplicationV2));
  results.push(check("dialogv2", !!foundry.applications?.api?.DialogV2));
  results.push(check("socket-name", SOCKET_NAME === `module.${MODULE_ID}`, SOCKET_NAME));
  results.push(check("combat-class-preserved", CONFIG.Combat?.documentClass?.name !== "SkjaldborgCombat", CONFIG.Combat?.documentClass?.name));
  results.push(check("tracker-class-preserved", CONFIG.ui?.combat?.name !== "SkjaldborgCombatTracker", CONFIG.ui?.combat?.name));
  results.push(check("active-combat", !!combat, combat?.id ?? ""));
  if (combat) {
    const state = getCombatState(combat);
    results.push(check("combat-state-readable", !!state && typeof state.phase === "string", state.phase));
  }
  results.push(check("hud-template", await canRenderTemplate("modules/aov-skjadlborg/templates/combat-hud.hbs")));
  results.push(check("phase-report-template", await canRenderTemplate("modules/aov-skjadlborg/templates/phase-report.hbs")));
  results.push(check("action-ring-template", await canRenderTemplate("modules/aov-skjadlborg/templates/action-ring.hbs")));
  results.push(check("actor-hotbar-template", await canRenderTemplate("modules/aov-skjadlborg/templates/actor-hotbar.hbs")));

  const failed = results.filter(r => !r.ok);
  console.table(results);
  if (failed.length) {
    ui.notifications.warn(game.i18n.format("AOV_SKJADLBORG.Diagnostics.Failed", { count: failed.length }));
  }
  else {
    ui.notifications.info(game.i18n.localize("AOV_SKJADLBORG.Diagnostics.Passed"));
  }
  return results;
}
