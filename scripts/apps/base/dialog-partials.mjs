export const DIALOG_PARTIAL_TEMPLATE_PATHS = Object.freeze([
  "modules/aov-skjaldborg/templates/partials/dialog/dialog-shell.hbs",
  "modules/aov-skjaldborg/templates/partials/dialog/dialog-section.hbs",
  "modules/aov-skjaldborg/templates/partials/dialog/segmented-controls.hbs",
  "modules/aov-skjaldborg/templates/partials/dialog/custom-modifier-row.hbs",
  "modules/aov-skjaldborg/templates/partials/dialog/target-pills.hbs",
  "modules/aov-skjaldborg/templates/partials/dialog/summary-card.hbs",
  "modules/aov-skjaldborg/templates/partials/dialog/dialog-footer.hbs"
]);

let dialogPartialsLoaded = null;

export function ensureDialogPartialsLoaded() {
  if (!dialogPartialsLoaded) {
    const loadTemplates = foundry.applications?.handlebars?.loadTemplates;
    dialogPartialsLoaded = typeof loadTemplates === "function"
      ? loadTemplates(DIALOG_PARTIAL_TEMPLATE_PATHS)
      : Promise.resolve();
  }
  return dialogPartialsLoaded;
}
