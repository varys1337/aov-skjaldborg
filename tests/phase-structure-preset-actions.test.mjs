import assert from "node:assert/strict";

class ApplicationV2 {
  async render() {
    this.renderedByPreset = true;
  }
}

globalThis.foundry = {
  applications: {
    api: {
      ApplicationV2,
      HandlebarsApplicationMixin: Base => class extends Base {}
    }
  },
  utils: {
    expandObject: value => value
  }
};

const stored = new Map();
globalThis.game = {
  settings: {
    get: (_module, key) => stored.has(key) ? stored.get(key) : true,
    set: async (_module, key, value) => {
      stored.set(key, value);
      return value;
    }
  },
  i18n: { localize: key => key },
  aovSkjadlborg: null,
  combat: null
};
globalThis.ui = {
  combat: { render: () => {} },
  notifications: { warn: () => {} }
};

const { PhaseStructureSettings } = await import("../scripts/apps/phase-structure-settings.mjs");
const { PHASE_STRUCTURE_SETTING_KEYS, PHASES } = await import("../scripts/constants.mjs");

const app = new PhaseStructureSettings();
await PhaseStructureSettings.onStreamlinedPreset.call(app, { preventDefault() {} });

assert.equal(stored.get(PHASE_STRUCTURE_SETTING_KEYS[PHASES.INTENT]), false);
assert.equal(stored.get(PHASE_STRUCTURE_SETTING_KEYS[PHASES.MOVEMENT]), false);
assert.equal(stored.get(PHASE_STRUCTURE_SETTING_KEYS[PHASES.RESOLUTION]), true);
assert.equal(stored.get(PHASE_STRUCTURE_SETTING_KEYS[PHASES.BOOKKEEPING]), false);
assert.equal(app.renderedByPreset, true, "the clicked AppV2 instance should rerender after persistence");

console.log("phase-structure-preset-actions ok");
