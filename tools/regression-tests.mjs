import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";

const MODULE_ID = "aov-skjaldborg";
let idCounter = 0;

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function mergeObject(base = {}, patch = {}, { inplace = false } = {}) {
  const target = inplace ? base : clone(base);
  for (const [key, value] of Object.entries(patch ?? {})) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      target[key] = mergeObject(target[key] ?? {}, value, { inplace: false });
    } else {
      target[key] = clone(value);
    }
  }
  return target;
}

function setProperty(object, path, value) {
  const parts = String(path ?? "").split(".").filter(Boolean);
  if (!object || typeof object !== "object" || !parts.length) return object;

  let target = object;
  for (const part of parts.slice(0, -1)) {
    if (!target[part] || typeof target[part] !== "object" || Array.isArray(target[part])) {
      target[part] = {};
    }
    target = target[part];
  }

  target[parts.at(-1)] = clone(value);
  return object;
}
function installFoundryMocks() {
  const users = new Map();
  const gm = { id: "gm", isGM: true, active: true };
  users.set(gm.id, gm);
  users.find = predicate => Array.from(users.values()).find(predicate);

  globalThis.CONST = {
    TOKEN_DISPOSITIONS: {
      FRIENDLY: 1,
      HOSTILE: -1
    },
    GRID_TYPES: {
      GRIDLESS: 0,
      SQUARE: 1
    },
    ACTIVE_EFFECT_ICON_DISPLAY_MODES: {
      NONE: 0,
      TEMPORARY: 1,
      ALWAYS: 2
    }
  };
  globalThis.foundry = {
    utils: {
      deepClone: clone,
      mergeObject,
      setProperty,
      randomID: () => `test-${++idCounter}`,
      getProperty: (object, path) => String(path ?? "").split(".").reduce((value, part) => value?.[part], object),
      hasProperty: (object, path) => {
        const parts = String(path ?? "").split(".").filter(Boolean);
        let value = object;
        for (const part of parts) {
          if (value == null || !Object.prototype.hasOwnProperty.call(value, part)) return false;
          value = value[part];
        }
        return true;
      },
      escapeHTML: value => String(value ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
    }
  };
  globalThis.foundry.applications = {
    api: {
      ApplicationV2: class ApplicationV2 {},
      DialogV2: class DialogV2 {},
      HandlebarsApplicationMixin: Base => Base
    },
    handlebars: {
      renderTemplate: async () => ""
    }
  };
  globalThis.game = {
    user: gm,
    users,
    combats: new Map(),
    combat: null,
    i18n: {
      localize: key => key,
      format: (key, data = {}) => `${key}:${JSON.stringify(data)}`
    },
    settings: {
      get: (_module, key) => {
        if (key === "movementDebugEnabled") return false;
        if (key === "movementDebugLevel") return "summary";
        if (key === "movementDebugCategories") return {};
        if (key === "performanceDiagnostics") return false;
        if (key === "debug") return false;
        if (key === "dynamicPlanningInitiative") return false;
        if (key === "enabledPhases") return ["intent", "movement", "resolution", "bookkeeping"];
        return false;
      },
      set: async () => null
    },
    socket: {
      on: () => null,
      emit: () => null
    }
  };
  globalThis.canvas = {
    scene: {
      grid: { size: 100, distance: 5 },
      tokens: new Map()
    },
    grid: { size: 100 },
    interface: null
  };
  globalThis.ui = {
    controls: {
      render: () => null
    },
    notifications: {
      warn: () => null,
      error: () => null
    }
  };
  globalThis.CONFIG = {};
  globalThis.Hooks = {
    registered: [],
    callAll: () => null,
    on: (name, fn) => {
      globalThis.Hooks.registered.push({ name, fn });
      return fn;
    }
  };
}

function actor(id) {
  const flags = { [MODULE_ID]: {} };
  return {
    id: `actor-${id}`,
    type: "npc",
    isOwner: true,
    system: {
      hp: { max: 10, value: 10 },
      moveRate: 10,
      abilities: {
        dex: { total: 12, value: 12 },
        int: { total: 10, value: 10 }
      }
    },
    items: [],
    effects: [],
    testUserPermission: () => true,
    getFlag: (module, key) => flags[module]?.[key],
    setFlag: async (module, key, value) => {
      flags[module] ??= {};
      flags[module][key] = clone(value);
      return value;
    },
    unsetFlag: async (module, key) => {
      if (flags[module]) delete flags[module][key];
      return null;
    }
  };
}

function token(id, x, y, disposition) {
  return {
    id: `token-${id}`,
    _id: `token-${id}`,
    x,
    y,
    width: 1,
    height: 1,
    disposition,
    _source: { x, y, width: 1, height: 1 },
    object: null,
    testUserPermission: () => true
  };
}

function combatant(id, x, y, disposition, state = {}) {
  const flags = { [MODULE_ID]: { combatantState: clone(state) } };
  const tokenDocument = token(id, x, y, disposition);
  const owner = actor(id);
  tokenDocument.actor = owner;
  const combatantDocument = {
    id,
    tokenId: tokenDocument.id,
    token: tokenDocument,
    actor: owner,
    defeated: false,
    isDefeated: false,
    getFlag: (module, key) => flags[module]?.[key],
    setFlag: async (module, key, value) => {
      flags[module] ??= {};
      flags[module][key] = clone(value);
      return value;
    }
  };
  return combatantDocument;
}

function combat(id, combatants) {
  const collection = new Map(combatants.map(entry => [entry.id, entry]));
  const flags = {
    [MODULE_ID]: {
      combatState: {
        enabled: true,
        phase: "intent",
        logicalRound: 1,
        updatedAt: 1
      }
    }
  };
  const document = {
    id,
    started: true,
    combatants: collection,
    updateLog: [],
    updateEmbeddedDocuments: async (_type, updates) => {
      document.updateLog.push(...clone(updates ?? []));
      for (const update of updates ?? []) {
        const entry = collection.get(update._id);
        if (!entry) continue;
        for (const [key, value] of Object.entries(update)) {
          if (key === "_id") continue;
          if (key.includes(".")) foundry.utils.setProperty(entry, key, value);
          else entry[key] = clone(value);
        }
      }
      return updates ?? [];
    },
    getFlag: (module, key) => flags[module]?.[key],
    setFlag: async (module, key, value) => {
      flags[module] ??= {};
      flags[module][key] = clone(value);
      return value;
    }
  };
  for (const entry of combatants) entry.combat = document;
  game.combat = document;
  game.combats.set(id, document);
  return document;
}

function intent(category = "attack", publicText = "") {
  return {
    status: "committed",
    actionCategory: category,
    publicText,
    privateText: "",
    modifiers: { drawWeapon: false, sheatheWeapon: false, surprised: false, fullMove: false },
    delay: { enabled: false, targetDex: null },
    waitInterrupt: { enabled: false, text: "" },
    splitCount: 1,
    fixedRank: null,
    runeCarryover: false
  };
}

function weapon(id, name, extraSystem = {}) {
  return {
    id,
    uuid: `Actor.test.Item.${id}`,
    type: "weapon",
    name,
    system: {
      equipStatus: 1,
      total: 100,
      ...extraSystem
    }
  };
}

async function readyWeapon(combatantDocument, item) {
  combatantDocument.actor.items = [item];
  await combatantDocument.actor.setFlag(MODULE_ID, "readiedWeapons", {
    right: item.id,
    left: null,
    unlimited: false
  });
}

async function testReadiedWeaponsAndCombatOptions() {
  const {
    getCombatOptions,
    getReadiedWeaponIds,
    getReadiedWeaponList,
    isShieldLikeWeapon,
    setCombatOptions,
    setReadiedWeapons
  } = await import("../scripts/combat/weapon-state.mjs");
  const owner = actor("readied");
  owner.items = [
    weapon("sword", "Sword"),
    weapon("shield", "Round Shield", { weaponCatName: "Shield" }),
    weapon("packed", "Packed Axe", { equipStatus: 2 })
  ];

  await owner.setFlag(MODULE_ID, "readiedWeaponId", "sword");
  assert.deepEqual(getReadiedWeaponIds(owner), { right: "sword", left: null, unlimited: false });
  assert.deepEqual(getReadiedWeaponList(owner).map(item => item.id), ["sword"]);

  await setReadiedWeapons(owner, { right: "sword", left: "shield", unlimited: true });
  assert.equal(owner.getFlag(MODULE_ID, "readiedWeaponId"), undefined);
  assert.deepEqual(getReadiedWeaponIds(owner), { right: "sword", left: "shield", unlimited: true });
  assert.deepEqual(getReadiedWeaponList(owner).map(item => item.id), ["sword", "shield"]);
  assert.equal(isShieldLikeWeapon(owner.items[1]), true);

  await setCombatOptions(owner, {
    twoWeaponFighting: { enabled: true, primaryWeaponId: "sword", secondaryWeaponId: "shield", primaryChance: 100, secondaryChance: 80 },
    shieldCover: { shieldId: "shield", locationIds: ["arm", "head", "arm", ""] },
    shieldwall: { enabled: true }
  });
  assert.deepEqual(getCombatOptions(owner), {
    twoWeaponFighting: { enabled: true, primaryWeaponId: "sword", secondaryWeaponId: "shield", primaryChance: 100, secondaryChance: 80 },
    shieldCover: { shieldId: "shield", locationIds: ["arm", "head"] },
    shieldwall: { enabled: true }
  });
}

async function testWeaponLengthReach() {
  const {
    checkMovementEngagements,
    parseWeaponLengthMeters,
    reachUnitsForActor,
    reachUnitsForCombatant,
    reachUnitsFromLength
  } = await import("../scripts/combat/movement-controller.mjs");
  const { getCombatantState } = await import("../scripts/combat/state.mjs");

  assert.equal(reachUnitsFromLength(null), 1);
  assert.equal(reachUnitsFromLength(Number.NaN), 1);
  assert.equal(reachUnitsFromLength(1.39), 1);
  assert.equal(reachUnitsFromLength(1.4), 2);
  assert.equal(reachUnitsFromLength(2.39), 2);
  assert.equal(reachUnitsFromLength(2.4), 3);
  assert.equal(parseWeaponLengthMeters("140 cm"), 1.4);
  assert.equal(parseWeaponLengthMeters("1,4 m"), 1.4);

  const blankReach = combatant("blank-reach", 0, 0, 1);
  await readyWeapon(blankReach, weapon("blank-sword", "Longspear"));
  assert.equal(reachUnitsForCombatant(blankReach), 1);

  const mediumReach = combatant("medium-reach", 0, 0, 1);
  await readyWeapon(mediumReach, weapon("medium-spear", "Spear", { length: "1.4" }));
  assert.equal(reachUnitsForActor(mediumReach.actor), 2);
  assert.equal(reachUnitsForCombatant(mediumReach), 2);

  const longReach = combatant("long-reach", 0, 0, 1);
  await readyWeapon(longReach, weapon("long-spear", "Longspear", { length: "2.4" }));
  assert.equal(reachUnitsForCombatant(longReach), 3);

  const missileReach = combatant("missile-reach", 0, 0, 1);
  await readyWeapon(missileReach, weapon("bow", "Bow", { length: "3", weaponType: "missile" }));
  assert.equal(reachUnitsForCombatant(missileReach), 1);

  const mediumTarget = combatant("medium-target", 200, 0, -1);
  const mediumCombat = combat("medium-reach-combat", [mediumReach, mediumTarget]);
  assert.equal(await checkMovementEngagements(mediumCombat, { includeStationary: true, reason: "regression-medium-reach" }), 1);
  assert.deepEqual(getCombatantState(mediumReach).engagement.partnerIds, ["medium-target"]);

  const longTarget = combatant("long-target", 300, 0, -1);
  const longCombat = combat("long-reach-combat", [longReach, longTarget]);
  assert.equal(await checkMovementEngagements(longCombat, { includeStationary: true, reason: "regression-long-reach" }), 1);
  assert.deepEqual(getCombatantState(longReach).engagement.partnerIds, ["long-target"]);

  const fallbackTarget = combatant("fallback-target", 300, 0, -1);
  const fallbackCombat = combat("fallback-reach-combat", [blankReach, fallbackTarget]);
  assert.equal(await checkMovementEngagements(fallbackCombat, { includeStationary: true, reason: "regression-no-name-fallback" }), 0);
  assert.notEqual(getCombatantState(blankReach).engagement?.engaged, true);
}

async function testReachVisualizerConfigAndGeometry() {
  const {
    REACH_VISUALIZER_DEFAULTS,
    REACH_VISUALIZER_SHAPE,
    REACH_VISUALIZER_VISIBILITY
  } = await import("../scripts/constants.mjs");
  const {
    getReachVisualizerSettings,
    normalizeReachVisualizerSettings
  } = await import("../scripts/canvas/reach-visualizer-config.mjs");
  const {
    circleReachRadius,
    isSquareGridType,
    squareReachOutline,
    tokenGridRect,
    tokenPixelDimensions
  } = await import("../scripts/canvas/reach-visualizer-geometry.mjs");
  const render = await import("../scripts/canvas/reach-visualizer-render.mjs");

  const normalized = normalizeReachVisualizerSettings({
    enabled: true,
    visibility: "bogus",
    shape: "bogus",
    opacity: 2,
    passiveOpacity: 0,
    activeOpacity: 0.83,
    lineWidth: 99
  });
  assert.equal(normalized.enabled, true);
  assert.equal(normalized.visibility, REACH_VISUALIZER_DEFAULTS.visibility);
  assert.equal(normalized.shape, REACH_VISUALIZER_DEFAULTS.shape);
  assert.equal(normalized.opacity, 1);
  assert.equal(normalized.passiveOpacity, 0.05);
  assert.equal(normalized.activeOpacity, 0.85);
  assert.equal(normalized.lineWidth, 12);
  assert.equal(getReachVisualizerSettings().visibility, REACH_VISUALIZER_VISIBILITY.DYNAMIC);

  const document = { x: 100, y: 200, width: 1, height: 2 };
  assert.deepEqual(tokenGridRect(document, 100), { minX: 1, minY: 2, maxX: 1, maxY: 3 });
  assert.deepEqual(tokenPixelDimensions(document, 100), { width: 100, height: 200 });
  assert.equal(circleReachRadius(document, 2, 100), 300);
  const outline = squareReachOutline(document, 2, 100);
  assert.deepEqual(outline.rect, { minX: -1, minY: 0, maxX: 3, maxY: 5 });
  assert.deepEqual(outline.segments, [
    [-100, 0, 400, 0],
    [400, 0, 400, 600],
    [400, 600, -100, 600],
    [-100, 600, -100, 0]
  ]);
  assert.equal(isSquareGridType(CONST.GRID_TYPES.SQUARE), true);
  assert.equal(isSquareGridType(CONST.GRID_TYPES.GRIDLESS), false);

  const drawn = [];
  render.drawSolidGridSegments({
    beginFill: (color, alpha) => drawn.push(["begin", color, alpha]),
    drawRect: (...args) => drawn.push(["rect", ...args]),
    endFill: () => drawn.push(["end"])
  }, [[0, 0, 100, 0], [100, 0, 100, 100]], 2, 0xff0000);
  assert.deepEqual(drawn, [
    ["begin", 0xff0000, 1],
    ["rect", 0, -1, 100, 2],
    ["rect", 99, 0, 2, 100],
    ["end"]
  ]);

  const circleCalls = [];
  render.drawSolidCircle({
    lineStyle: (...args) => circleCalls.push(["line", args.length, ...args]),
    drawCircle: (...args) => circleCalls.push(["circle", ...args])
  }, 150, 3, 0x00ff00);
  assert.deepEqual(circleCalls, [
    ["line", 1, { width: 3, color: 0x00ff00, alpha: 1 }],
    ["circle", 0, 0, 150]
  ]);

  const source = readFileSync(new URL("../scripts/canvas/reach-visualizer.mjs", import.meta.url), "utf8");
  assert.match(source, /Hooks\.on\("getSceneControlButtons"/);
  assert.match(source, /controls\?\.tokens/);
  assert.match(source, /button:\s*true/);
  assert.match(source, /reachUnitsForCombatant/);
  assert.match(source, /reachUnitsForActor/);
  assert.equal(source.includes("uesrpg"), false);
  assert.equal(source.includes("lastUsed"), false);
  assert.equal(source.includes("reachMin"), false);

  const settingsSource = readFileSync(new URL("../scripts/settings.mjs", import.meta.url), "utf8");
  assert.match(settingsSource, /registerMenu\(MODULE_ID,\s*"reachVisualizerConfiguration"/);
  assert.match(settingsSource, /register\(MODULE_ID,\s*"reachVisualizer"/);
  assert.match(settingsSource, /scope:\s*"client"/);
  assert.match(settingsSource, /type:\s*Object/);
  assert.match(settingsSource, /config:\s*false/);

  const mainSource = readFileSync(new URL("../scripts/main.mjs", import.meta.url), "utf8");
  assert.match(mainSource, /registerReachVisualizerHooks\(\)/);
  assert.match(mainSource, /reachVisualizer,/);

  const valid = normalizeReachVisualizerSettings({
    visibility: REACH_VISUALIZER_VISIBILITY.ALWAYS,
    shape: REACH_VISUALIZER_SHAPE.CIRCLE
  });
  assert.equal(valid.visibility, REACH_VISUALIZER_VISIBILITY.ALWAYS);
  assert.equal(valid.shape, REACH_VISUALIZER_SHAPE.CIRCLE);
}

async function testWeaponSkillResolver() {
  const {
    resolveSkillTotal,
    resolveWeaponCategoryTotal,
    resolveWeaponSkill
  } = await import("../scripts/combat/weapon-skill-resolver.mjs");
  const owner = actor("weapon-skill");
  owner.system.cbt = 5;
  owner.items = [
    {
      id: "broadsword-skill",
      type: "skill",
      name: "Broadsword",
      flags: { aov: { cidFlag: { id: "i.skill.broadsword" } } },
      system: {
        category: "cbt",
        weaponCat: "i.weaponcat.sword-1-h",
        base: 40,
        xp: 55,
        home: 0,
        history: 0,
        pers: 0,
        dev: 0,
        effects: 0
      }
    },
    {
      id: "sax-skill",
      type: "skill",
      name: "Sax",
      flags: { aov: { cidFlag: { id: "i.skill.sax" } } },
      system: {
        category: "cbt",
        weaponCat: "i.weaponcat.sword-1-h",
        base: 70,
        xp: 0,
        home: 0,
        history: 0,
        pers: 0,
        dev: 0,
        effects: 0
      }
    },
    {
      id: "broadsword",
      type: "weapon",
      name: "Broadsword",
      system: {
        equipStatus: 1,
        skillCID: "i.skill.broadsword",
        weaponCat: "i.weaponcat.sword-1-h"
      }
    },
    {
      id: "fallback-sword",
      type: "weapon",
      name: "Fallback Sword",
      system: {
        equipStatus: 1,
        skillCID: "i.skill.unknown",
        weaponCat: "i.weaponcat.sword-1-h"
      }
    }
  ];

  assert.equal(resolveSkillTotal(owner, owner.items[0]), 100);
  assert.equal(resolveWeaponCategoryTotal(owner, "i.weaponcat.sword-1-h"), 100);
  assert.equal(resolveWeaponSkill(owner, owner.items[2]).total, 100);
  assert.equal(resolveWeaponSkill(owner, owner.items[3]).total, 50);
}

async function testAov144D100Evaluation() {
  const {
    evaluateAovD100,
    evaluateD100
  } = await import("../scripts/combat/automation-helpers.mjs");

  assert.equal(evaluateAovD100({ targetScore: 60, rollResult: 3, critChance: 5 }), 4);
  assert.equal(evaluateAovD100({ targetScore: 60, rollResult: 4, critChance: 5 }), 3);
  assert.equal(evaluateAovD100({ targetScore: 60, rollResult: 6, critChance: 10 }), 4);
  assert.equal(evaluateAovD100({ targetScore: 60, rollResult: 7, critChance: 10 }), 3);
  assert.equal(evaluateAovD100({ targetScore: 60, rollResult: 99, fumbleChance: 5 }), 0);
  assert.equal(evaluateAovD100({ targetScore: 60, rollResult: 98, fumbleChance: 5 }), 1);
  assert.equal(evaluateAovD100({ targetScore: 60, rollResult: 97, fumbleChance: 10 }), 0);
  assert.equal(evaluateAovD100({ targetScore: 4, rollResult: 5 }), 2);
  assert.equal(evaluateAovD100({ targetScore: 100, rollResult: 100 }), 0);
  assert.equal(evaluateAovD100({ targetScore: 100, rollResult: 4, critChance: 5 }), 4);
  assert.equal(evaluateD100(60, 99), 0);
}

async function testAov144CombatCardChances() {
  const {
    buildCombatAttackCard,
    getItemCritFumbleChances,
    getWeaponCritFumbleChances
  } = await import("../scripts/combat/automation-helpers.mjs");
  const { __test: adapterTest } = await import("../scripts/adapter/aov-adapter.mjs");
  const owner = actor("crit-cards");
  const swordSkill = {
    id: "sword-skill",
    type: "skill",
    name: "Sword",
    flags: { aov: { cidFlag: { id: "i.skill.sword" } } },
    system: { total: 80, critMult: 2, fumbleMult: 2, category: "cbt" }
  };
  const dodgeSkill = {
    id: "dodge-skill",
    type: "skill",
    name: "Dodge",
    flags: { aov: { cidFlag: { id: "i.skill.dodge" } } },
    system: { total: 45, critMult: 2, fumbleMult: 2, category: "agi" }
  };
  const sword = weapon("sword", "Sword", { total: 80, skillCID: "i.skill.sword" });
  const unknown = weapon("unknown", "Unknown Sword", { total: 70, skillCID: "i.skill.unknown" });
  owner.items = [swordSkill, dodgeSkill, sword, unknown];

  assert.deepEqual(getItemCritFumbleChances(swordSkill), { critChance: 10, fumbleChance: 10 });
  assert.deepEqual(getWeaponCritFumbleChances(owner, sword), { critChance: 10, fumbleChance: 10 });
  assert.deepEqual(getWeaponCritFumbleChances(owner, unknown), { critChance: 5, fumbleChance: 5 });

  const attackCard = buildCombatAttackCard({
    actor: owner,
    tokenDocument: null,
    weapon: sword,
    targetToken: { id: "target-token", document: { id: "target-token" } },
    targetNumber: 80,
    flatMod: 0
  });
  assert.equal(attackCard.critChance, 10);
  assert.equal(attackCard.fumbleChance, 10);

  const fallbackCard = buildCombatAttackCard({
    actor: owner,
    tokenDocument: null,
    weapon: unknown,
    targetToken: { id: "target-token", document: { id: "target-token" } },
    targetNumber: 70,
    flatMod: 0
  });
  assert.equal(fallbackCard.critChance, 5);
  assert.equal(fallbackCard.fumbleChance, 5);

  const dodgeCard = adapterTest.combatCardEntry({
    actor: owner,
    item: dodgeSkill,
    rollType: "SK",
    rawScore: 45,
    targetScore: 45,
    combatAction: "dodge"
  });
  assert.equal(dodgeCard.critChance, 10);
  assert.equal(dodgeCard.fumbleChance, 10);

  const parryCard = adapterTest.combatCardEntry({
    actor: owner,
    item: sword,
    rollType: "WP",
    rawScore: 80,
    targetScore: 80,
    combatAction: "parry"
  });
  assert.equal(parryCard.critChance, 10);
  assert.equal(parryCard.fumbleChance, 10);

  const noneCard = adapterTest.combatCardEntry({
    actor: owner,
    item: null,
    rollType: "SK",
    rawScore: 0,
    targetScore: 0,
    combatAction: "none"
  });
  assert.equal(noneCard.critChance, 5);
  assert.equal(noneCard.fumbleChance, 5);
}

async function testAimedEquipmentGrossDamage() {
  const aimed = await import("../scripts/combat/aimed-blow-automation.mjs");
  assert.equal(aimed.__test.grossDamage({ damageBeforeAbsorb: 12, rollVal: 3, armourAbsorb: 9 }), 12);
  assert.equal(aimed.__test.grossDamage({ rollVal: 3, armourAbsorb: 9 }), 12);
  assert.equal(aimed.__test.grossDamage({ rollVal: -1, armourAbsorb: 0 }), 0);
}

function collectScriptFiles(directoryUrl) {
  const files = [];
  for (const entry of readdirSync(directoryUrl, { withFileTypes: true })) {
    const child = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, directoryUrl);
    if (entry.isDirectory()) files.push(...collectScriptFiles(child));
    else if (entry.isFile() && entry.name.endsWith(".mjs")) files.push(child);
  }
  return files;
}

async function testRouteResolvedAoVImports() {
  const scriptRoot = new URL("../scripts/", import.meta.url);
  const offenders = collectScriptFiles(scriptRoot)
    .filter(file => statSync(file).isFile())
    .filter(file => /import\(\s*["']\/systems\/aov\/.*?\.mjs["']\s*\)/.test(readFileSync(file, "utf8")))
    .map(file => file.pathname);
  assert.deepEqual(offenders, []);
}

async function testChangedPathUtilityInvalidation() {
  const {
    actorHotbarPartsForActorChange,
    actorHotbarPartsForCombatantChange,
    flattenChangedPaths
  } = await import("../scripts/utils/changed-paths.mjs");
  assert.deepEqual(flattenChangedPaths({ flags: { [MODULE_ID]: { combatOptions: { shieldwall: { enabled: true } } } } }), [
    "flags",
    `flags.${MODULE_ID}`,
    `flags.${MODULE_ID}.combatOptions`,
    `flags.${MODULE_ID}.combatOptions.shieldwall`,
    `flags.${MODULE_ID}.combatOptions.shieldwall.enabled`
  ]);
  assert.deepEqual(
    Array.from(actorHotbarPartsForActorChange({ flags: { [MODULE_ID]: { combatOptions: { shieldwall: { enabled: true } } } } })).sort(),
    ["weaponControls", "workflow"]
  );
  assert.deepEqual(
    Array.from(actorHotbarPartsForActorChange({ flags: { [MODULE_ID]: { preparedIntent: { actionCategory: "attack" } } } })).sort(),
    ["tabBody", "weaponControls", "workflow"]
  );
  assert.deepEqual(
    Array.from(actorHotbarPartsForCombatantChange({ initiative: 14.01 })).sort(),
    ["weaponControls", "workflow"]
  );
}

async function testActorHotbarRegionRenderStructure() {
  const source = readFileSync(new URL("../scripts/apps/actor-hotbar.mjs", import.meta.url), "utf8");
  const partsBody = source.match(/static PARTS = \{([\s\S]*?)\n  \};/)?.[1] ?? "";
  assert.match(partsBody, /HOTBAR_PARTS\.SHELL/);
  assert.equal(/HOTBAR_REGIONS|RESOURCES|COMBAT_WORKFLOW|TAB_BODY|EQUIPMENT_CONTROLS/.test(partsBody), false);
  assert.match(
    source,
    /part === "workflow" \|\| part === "weaponControls" \|\| part === "equipmentControls"[\s\S]{0,160}regions\.add\(HOTBAR_REGIONS\.COMBAT_WORKFLOW\)/
  );
  assert.match(source, /regions\.has\(HOTBAR_REGIONS\.TAB_BODY\)[\s\S]{0,80}regions\.delete\(HOTBAR_REGIONS\.COMBAT_WORKFLOW\)/);

  const templateRoot = new URL("../templates/actor-hotbar/", import.meta.url);
  const hotbarTemplates = readdirSync(templateRoot)
    .filter(name => name.endsWith(".hbs"))
    .map(name => readFileSync(new URL(name, templateRoot), "utf8"));
  assert.equal(hotbarTemplates.some(template => template.includes("data-hotbar-part")), false);
  assert.equal(hotbarTemplates.some(template => template.includes('data-hotbar-region="equipmentControls"')), false);
}

async function testActorHotbarActiveEffectInvalidation() {
  const { __test } = await import("../scripts/apps/actor-hotbar.mjs");
  const parts = effect => Array.from(__test.actorHotbarPartsForActiveEffect(effect)).sort();
  const flagged = flags => ({
    flags: { [MODULE_ID]: flags },
    getFlag(module, key) {
      return this.flags[module]?.[key];
    }
  });
  const status = id => ({
    statuses: new Set([id]),
    flags: {},
    getFlag(module, key) {
      return this.flags[module]?.[key];
    }
  });

  assert.deepEqual(parts(flagged({ managedEvading: true })), ["effects", "workflow"]);
  assert.deepEqual(parts(flagged({ managedReactionPenalty: true })), ["effects", "workflow"]);
  assert.deepEqual(parts(flagged({ managedEngagement: true })), ["effects", "workflow"]);
  assert.deepEqual(parts(flagged({ managedDisengaging: true })), ["effects", "workflow"]);
  assert.deepEqual(parts(flagged({ managedKnockbackStatus: true })), ["effects", "workflow"]);
  assert.deepEqual(parts(flagged({ grapple: { immobilized: false } })), ["effects", "tabBody", "wellbeing", "workflow"]);
  assert.deepEqual(parts(flagged({ stunStatus: { location: "head" } })), ["effects", "tabBody", "wellbeing", "workflow"]);
  assert.deepEqual(parts(flagged({ injuryThreshold: { severity: 2 } })), ["effects", "resources", "tabBody", "wellbeing"]);
  assert.deepEqual(parts(flagged({ impalement: { targetKey: "weapon" } })), ["effects", "resources", "tabBody", "wellbeing"]);
  assert.deepEqual(parts(flagged({ unknownManagedEffect: true })), ["effects", "tabBody"]);
  assert.deepEqual(parts(status(`${MODULE_ID}-evading`)), ["effects", "workflow"]);
  assert.deepEqual(parts(status(`${MODULE_ID}-injury`)), ["effects", "resources", "tabBody", "wellbeing"]);
  assert.deepEqual(parts({ flags: {} }), ["effects", "resources", "tabBody"]);
}

async function testDelaySocketMetadata() {
  const { handleSocketRequest } = await import("../scripts/socket.mjs");
  const { getCombatantState } = await import("../scripts/combat/state.mjs");
  const acting = combatant("delay-acting", 0, 0, 1, {
    intent: intent("attack"),
    updatedAt: 1
  });
  acting.initiative = 16.10;
  acting.actor.system.abilities.int.total = 12;
  acting.actor.system.abilities.int.value = 12;
  const target = combatant("delay-target", 100, 0, -1, {
    intent: intent("attack"),
    updatedAt: 1
  });
  target.initiative = 14.01;
  const delayCombat = combat("delay-combat", [acting, target]);

  await handleSocketRequest({
    type: "request",
    schemaVersion: 1,
    action: "delayCombatant",
    payload: {
      combatId: delayCombat.id,
      combatantId: acting.id,
      expectedCombatantUpdatedAt: 1,
      mode: "combatant",
      targetCombatantId: target.id,
      position: "after"
    },
    from: "gm",
    requestId: "delay-after"
  });

  const delayedState = getCombatantState(acting);
  assert.equal(delayCombat.updateLog.some(update => update._id === acting.id && update.initiative === 14), true);
  assert.equal(delayedState.intent.actionCategory, "delay");
  assert.deepEqual(delayedState.intent.delay, {
    enabled: true,
    targetDex: 14,
    targetCombatantId: target.id,
    position: "after",
    tiebreakerInt: 0
  });
  assert.equal(delayedState.intent.waitInterrupt.enabled, true);

  const direct = combatant("delay-direct", 0, 0, 1, {
    intent: intent("attack"),
    updatedAt: 1
  });
  direct.actor.system.abilities.int.total = 11;
  direct.actor.system.abilities.int.value = 11;
  const directCombat = combat("delay-direct-combat", [direct]);
  await handleSocketRequest({
    type: "request",
    schemaVersion: 1,
    action: "delayCombatant",
    payload: {
      combatId: directCombat.id,
      combatantId: direct.id,
      expectedCombatantUpdatedAt: 1,
      mode: "dex",
      targetDex: ""
    },
    from: "gm",
    requestId: "delay-direct"
  });
  assert.equal(directCombat.updateLog.some(update => update._id === direct.id && update.initiative === 1.11), true);
  assert.equal(getCombatantState(direct).intent.delay.targetDex, 1);
}

async function testIntentIdempotency() {
  const { handleSocketRequest, intentsEquivalent } = await import("../scripts/socket.mjs");
  assert.equal(intentsEquivalent(intent("attack"), intent("attack")), true);
  assert.equal(intentsEquivalent(intent("attack"), intent("defend")), false);

  const staleCombatant = combatant("intent-a", 0, 0, 1, {
    intent: intent("attack"),
    updatedAt: 20
  });
  combat("intent-combat", [staleCombatant]);
  const staleNoop = await handleSocketRequest({
    type: "request",
    schemaVersion: 1,
    action: "submitIntent",
    payload: {
      combatId: "intent-combat",
      combatantId: "intent-a",
      expectedCombatantUpdatedAt: 1,
      intent: intent("attack")
    },
    from: "gm",
    requestId: "intent-noop"
  });
  assert.equal(staleNoop.intent.actionCategory, "attack");
  assert.equal(staleCombatant.getFlag(MODULE_ID, "combatantState").updatedAt, 20);

  await assert.rejects(
    () => handleSocketRequest({
      type: "request",
      schemaVersion: 1,
      action: "submitIntent",
      payload: {
        combatId: "intent-combat",
        combatantId: "intent-a",
        expectedCombatantUpdatedAt: 1,
        intent: intent("defend")
      },
      from: "gm",
      requestId: "intent-conflict"
    }),
    /StaleDocument/
  );
}

async function testIntentSingleFlight() {
  const { commitIntentCategory, __test } = await import("../scripts/ui/action-catalog.mjs");
  const baselineCombatant = combatant("intent-baseline", 0, 0, 1, { updatedAt: 1 });
  const originalBaselineSetFlag = baselineCombatant.setFlag;
  let baselineWrites = 0;
  baselineCombatant.setFlag = async (...args) => {
    baselineWrites += 1;
    return originalBaselineSetFlag(...args);
  };
  const baselineCombat = combat("single-flight-baseline-combat", [baselineCombatant]);
  await commitIntentCategory(baselineCombatant.actor, baselineCombatant, baselineCombat, "attack");

  const slowCombatant = combatant("intent-b", 0, 0, 1, { updatedAt: 1 });
  const originalSetFlag = slowCombatant.setFlag;
  let writes = 0;
  slowCombatant.setFlag = async (...args) => {
    writes += 1;
    await new Promise(resolve => setTimeout(resolve, 20));
    return originalSetFlag(...args);
  };
  const activeCombat = combat("single-flight-combat", [slowCombatant]);
  const first = commitIntentCategory(slowCombatant.actor, slowCombatant, activeCombat, "attack");
  const second = commitIntentCategory(slowCombatant.actor, slowCombatant, activeCombat, "attack");
  assert.equal(__test.pendingIntentCommits.size, 1);
  assert.equal(await first, await second);
  assert.equal(writes, baselineWrites);
  assert.equal(__test.pendingIntentCommits.size, 0);
}


async function testMovementEligibilityBlocksOverLimitEngagement() {
  const { checkMovementEngagements } = await import("../scripts/combat/movement-controller.mjs");
  const { getCombatantState } = await import("../scripts/combat/state.mjs");

  const legalMover = combatant("legal-mover", 0, 0, 1, {
    movement: {
      planStatus: "completed",
      distance: 50
    }
  });
  const legalTarget = combatant("legal-target", 100, 0, -1, {
    movement: {
      planStatus: "completed",
      distance: 50
    }
  });
  const legalCombat = combat("legal-half-move-combat", [legalMover, legalTarget]);
  assert.equal(await checkMovementEngagements(legalCombat, { includeStationary: true, reason: "regression-mov-limit-legal" }), 1);
  assert.deepEqual(getCombatantState(legalMover).engagement.partnerIds, ["legal-target"]);
  assert.deepEqual(getCombatantState(legalTarget).engagement.partnerIds, ["legal-mover"]);

  const overLimitMover = combatant("over-limit-mover", 0, 0, -1, {
    movement: {
      planStatus: "completed",
      distance: 55
    }
  });
  const stationaryTarget = combatant("stationary-target", 100, 0, 1);
  const blockedCombat = combat("over-limit-engagement-combat", [stationaryTarget, overLimitMover]);
  assert.equal(await checkMovementEngagements(blockedCombat, { includeStationary: true, reason: "regression-over-limit-blocked" }), 0);
  assert.notEqual(getCombatantState(overLimitMover).engagement?.engaged, true);
  assert.notEqual(getCombatantState(stationaryTarget).engagement?.engaged, true);
}

async function testSpecialActionD3Conversion() {
  const knockback = await import("../scripts/combat/knockback-automation.mjs");
  const grapple = await import("../scripts/combat/grapple-automation.mjs");
  const expected = new Map([[1, 1], [2, 1], [3, 2], [4, 2], [5, 3], [6, 3]]);
  for (const [d6, d3] of expected) {
    assert.equal(knockback.__test.d6TotalToD3(d6), d3);
    assert.equal(grapple.__test.d6TotalToD3(d6), d3);
  }
}

async function testGrappleThrowCandidates() {
  const { candidateThrowDestinations } = await import("../scripts/combat/grapple-automation.mjs");
  canvas.scene.width = 500;
  canvas.scene.height = 500;
  const centered = { x: 200, y: 200, width: 1, height: 1 };
  const allChoices = candidateThrowDestinations(centered, 2);
  assert.equal(allChoices.length, 24);
  assert.equal(allChoices[0].key, "-1,-1");
  assert.equal(allChoices.at(-1).key, "2,2");
  assert.deepEqual(new Set(allChoices.map(choice => choice.distance)), new Set([1, 2]));

  canvas.scene.width = 200;
  canvas.scene.height = 200;
  const cornerChoices = candidateThrowDestinations({ x: 0, y: 0, width: 1, height: 1 }, 1);
  assert.deepEqual(cornerChoices.map(choice => choice.key), ["1,0", "0,1", "1,1"]);
  assert.equal(cornerChoices.every(choice => choice.x >= 0 && choice.y >= 0), true);
}

async function testGrappleEffectMatching() {
  const { GRAPPLED_STATUS_ID, IMMOBILIZED_STATUS_ID } = await import("../scripts/constants.mjs");
  const { isMatchingGrappleEffect } = await import("../scripts/combat/grapple-automation.mjs");
  const matching = {
    disabled: false,
    statuses: new Set([GRAPPLED_STATUS_ID]),
    getFlag: (module, key) => module === MODULE_ID && key === "grapple"
      ? { sourceActorUuid: "Actor.attacker", targetActorUuid: "Actor.target" }
      : null
  };
  assert.equal(isMatchingGrappleEffect(matching, {
    attackerActorUuid: "Actor.attacker",
    targetActorUuid: "Actor.target",
    statusId: GRAPPLED_STATUS_ID
  }), true);
  assert.equal(isMatchingGrappleEffect({ ...matching, disabled: true }, {
    attackerActorUuid: "Actor.attacker",
    targetActorUuid: "Actor.target"
  }), false);
  assert.equal(isMatchingGrappleEffect(matching, {
    attackerActorUuid: "Actor.other",
    targetActorUuid: "Actor.target"
  }), false);
  assert.equal(isMatchingGrappleEffect(matching, {
    attackerActorUuid: "Actor.attacker",
    targetActorUuid: "Actor.target",
    statusId: IMMOBILIZED_STATUS_ID
  }), false);
  assert.equal(isMatchingGrappleEffect({ statuses: new Set([GRAPPLED_STATUS_ID]) }, {
    attackerActorUuid: "Actor.attacker",
    targetActorUuid: "Actor.target"
  }), false);
}

async function testSpecialActionHookRegistrationIdempotency() {
  const knockback = await import("../scripts/combat/knockback-automation.mjs");
  const grapple = await import("../scripts/combat/grapple-automation.mjs");
  const before = Hooks.registered.length;
  knockback.registerKnockbackAutomationHooks();
  knockback.registerKnockbackAutomationHooks();
  grapple.registerGrappleAutomationHooks();
  grapple.registerGrappleAutomationHooks();
  const added = Hooks.registered.slice(before);
  assert.deepEqual(added.map(entry => entry.name), ["updateChatMessage", "renderChatMessageHTML", "updateChatMessage"]);
  assert.equal(knockback.__test.isHooksRegistered(), true);
  assert.equal(grapple.__test.isHooksRegistered(), true);
}

async function testActiveEffectStatusCatalogRegistration() {
  const { GRAPPLED_STATUS_ID } = await import("../scripts/constants.mjs");
  const { alwaysShowIconMode, registerStatusEffect, statusEffectConfig } = await import("../scripts/compat/active-effects.mjs");
  const config = statusEffectConfig("aov-skjaldborg-test-status", "Test Status", "icons/svg/aura.svg");
  const grappleConfig = statusEffectConfig(GRAPPLED_STATUS_ID, "Grappled", "icons/svg/net.svg");

  assert.equal(config._id, undefined);
  assert.equal(config.showIcon, alwaysShowIconMode());
  assert.equal(grappleConfig._id.length, 16);
  assert.match(grappleConfig._id, /^[A-Za-z0-9]{16}$/);
  assert.equal(grappleConfig.id, GRAPPLED_STATUS_ID);
  assert.deepEqual(grappleConfig.statuses, [GRAPPLED_STATUS_ID]);

  CONFIG.statusEffects = {};
  assert.equal(registerStatusEffect(config).mode, "native");
  assert.equal(CONFIG.statusEffects[config.id], config);

  CONFIG.statusEffects = [];
  assert.equal(registerStatusEffect(config).mode, "module-fallback");
  assert.equal(CONFIG.statusEffects.length, 1);
  assert.equal(CONFIG.statusEffects[0], config);
  registerStatusEffect({ ...config, name: "Updated" });
  assert.equal(CONFIG.statusEffects.length, 1);
  assert.equal(CONFIG.statusEffects[0].name, "Updated");

  CONFIG.statusEffects = new Map();
  assert.equal(registerStatusEffect(config).mode, "native");
  assert.equal(CONFIG.statusEffects.get(config.id), config);
}

async function testActiveEffectDetectionAndCreation() {
  const { INJURY_STATUS_ID } = await import("../scripts/constants.mjs");
  const {
    effectHasStatus,
    injuryThresholdSeverityFromEffects,
    isModuleManagedEffect,
    moduleFlag,
    upsertActorStatusEffect,
    upsertDocumentStatusEffect
  } = await import("../scripts/compat/active-effects.mjs");

  CONFIG.ActiveEffect = {
    documentClass: class TestActiveEffect {
      static async fromStatusEffect(statusId) {
        return {
          toObject: () => ({
            _id: "source-id",
            name: `from-${statusId}`,
            img: "icons/svg/source.svg",
            statuses: [statusId],
            flags: { core: { statusId } }
          })
        };
      }
    }
  };

  const byStatuses = { statuses: new Set(["grappled"]) };
  const byCoreFlag = { statuses: new Set(), flags: { core: { statusId: "immobilized" } } };
  const managed = {
    flags: { [MODULE_ID]: { managedDisengaging: true } },
    getFlag: (module, key) => module === MODULE_ID ? managed.flags[MODULE_ID][key] : undefined
  };
  assert.equal(effectHasStatus(byStatuses, "grappled"), true);
  assert.equal(effectHasStatus(byCoreFlag, "immobilized"), true);
  assert.equal(moduleFlag(managed, "managedDisengaging"), true);
  assert.equal(isModuleManagedEffect(managed), true);
  assert.equal(injuryThresholdSeverityFromEffects([{ statuses: new Set(["aov-skjaldborg-injury"]), flags: { [MODULE_ID]: { injuryThreshold: { severity: 2 } } } }]), 2);

  const actor = {
    effects: [],
    createEmbeddedDocuments: async (_type, documents) => {
      actor.created = clone(documents[0]);
      return [{ id: "created-effect", ...documents[0] }];
    }
  };
  const created = await upsertActorStatusEffect(actor, {
    statusId: "test-status",
    name: "Created Test",
    description: "Created description",
    moduleFlags: { managedKnockbackStatus: true }
  });
  assert.equal(created.id, "created-effect");
  assert.equal(actor.created._id, undefined);
  assert.equal(actor.created.name, "Created Test");
  assert.equal(actor.created.description, "Created description");
  assert.equal(actor.created.showIcon, 2);
  assert.deepEqual(actor.created.statuses, ["test-status"]);
  assert.equal(actor.created.flags.core.statusId, "test-status");
  assert.equal(actor.created.flags[MODULE_ID].managedKnockbackStatus, true);

  const existing = {
    statuses: new Set(["test-status"]),
    update: async data => {
      existing.updated = clone(data);
      return existing;
    }
  };
  const updateActor = { effects: [existing] };
  const updated = await upsertActorStatusEffect(updateActor, {
    statusId: "test-status",
    description: "Updated description",
    moduleFlags: { managedEngagement: true }
  });
  assert.equal(updated, existing);
  assert.equal(existing.updated._id, undefined);
  assert.equal(existing.updated.description, "Updated description");
  assert.equal(existing.updated.showIcon, 2);
  assert.equal(existing.updated["flags.core.statusId"], "test-status");
  assert.equal(existing.updated[`flags.${MODULE_ID}.managedEngagement`], true);

  const item = {
    effects: [],
    createEmbeddedDocuments: async (_type, documents) => {
      item.created = clone(documents[0]);
      const effect = { id: "item-effect", ...documents[0] };
      item.effects.push(effect);
      return [effect];
    }
  };
  const itemEffect = await upsertDocumentStatusEffect(item, {
    statusId: INJURY_STATUS_ID,
    name: "Item Status",
    description: "Item-owned effect",
    moduleFlags: { injuryThreshold: { severity: 3 } }
  });
  assert.equal(itemEffect.id, "item-effect");
  assert.equal(item.created.name, "Item Status");
  assert.equal(item.created.description, "Item-owned effect");
  assert.equal(item.created.flags[MODULE_ID].injuryThreshold.severity, 3);
  assert.equal(injuryThresholdSeverityFromEffects(item.effects), 3);
}

async function testDamageEffectTrackingHelpers() {
  const { IMPALED_STATUS_ID, INJURY_STATUS_ID } = await import("../scripts/constants.mjs");
  const { statusEffectConfig } = await import("../scripts/compat/active-effects.mjs");
  const damage = await import("../scripts/combat/damage-effect-tracking.mjs");

  const weapon = { type: "weapon", system: { damType: "ct" } };
  const sourceImpale = { damageType: "i" };
  const sourceSlash = { damageType: "s" };
  const impaleCard = {
    rollType: "DM",
    successLevel: "3",
    rollVal: 4,
    targetLocID: "loc-arm"
  };

  assert.equal(damage.__test.matchesDamageSource(null, impaleCard), false);
  assert.equal(damage.__test.isImpalingDamageCard(impaleCard, { weapon, source: sourceImpale }), true);
  assert.equal(damage.__test.isImpalingDamageCard({ ...impaleCard, successLevel: "4" }, { source: sourceImpale }), true);
  assert.equal(damage.__test.isImpalingDamageCard({ ...impaleCard, successLevel: "2" }, { source: sourceImpale }), false);
  assert.equal(damage.__test.isImpalingDamageCard({ ...impaleCard, rollVal: 0 }, { source: sourceImpale }), false);
  assert.equal(damage.__test.isImpalingDamageCard({ ...impaleCard, targetLocID: "", targetWpnId: "" }, { source: sourceImpale }), false);
  assert.equal(damage.__test.isImpalingDamageCard(impaleCard, { weapon, source: sourceSlash }), false);
  assert.equal(damage.__test.isImpalingDamageCard(impaleCard, { weapon }), true);

  assert.equal(damage.__test.injurySeverity(3, 4), 0);
  assert.equal(damage.__test.injurySeverity(4, 4), 1);
  assert.equal(damage.__test.injurySeverity(7, 4), 1);
  assert.equal(damage.__test.injurySeverity(8, 4), 2);
  assert.equal(damage.__test.injurySeverity(11, 4), 2);
  assert.equal(damage.__test.injurySeverity(12, 4), 3);
  assert.equal(damage.__test.injurySeverity(12, 0), 0);
  assert.equal(damage.__test.shouldApplyInjurySeverity(0, 1), true);
  assert.equal(damage.__test.shouldApplyInjurySeverity(1, 2), true);
  assert.equal(damage.__test.shouldApplyInjurySeverity(2, 1), false);
  assert.equal(damage.__test.shouldApplyInjurySeverity(3, 3), false);

  const injuryConfig = statusEffectConfig(INJURY_STATUS_ID, "Injury", damage.__test.INJURY_EFFECT_ICON);
  assert.equal(injuryConfig.id, INJURY_STATUS_ID);
  assert.equal(injuryConfig._id.length, 16);
  assert.match(injuryConfig._id, /^[A-Za-z0-9]{16}$/);
  assert.equal(injuryConfig.img, "icons/svg/bones.svg");
  assert.equal(statusEffectConfig(INJURY_STATUS_ID, "Injury 1x", damage.__test.INJURY_EFFECT_ICON).img, injuryConfig.img);
  assert.equal(statusEffectConfig(INJURY_STATUS_ID, "Injury 2x", damage.__test.INJURY_EFFECT_ICON).img, injuryConfig.img);
  assert.equal(statusEffectConfig(INJURY_STATUS_ID, "Injury 3x", damage.__test.INJURY_EFFECT_ICON).img, injuryConfig.img);
  assert.equal(statusEffectConfig(IMPALED_STATUS_ID, "Impaled", damage.__test.IMPALED_EFFECT_ICON).img, "icons/svg/blood.svg");

  assert.equal(
    damage.__test.injuryDescriptionKey({ name: "Left Leg", system: { locType: "body" } }, 1),
    "AOV_SKJALDBORG.DamageEffects.InjuryDescriptions.Leg1x"
  );
  assert.equal(
    damage.__test.injuryDescriptionKey({ name: "Right Arm", system: { locType: "body" } }, 1),
    "AOV_SKJALDBORG.DamageEffects.InjuryDescriptions.Arm1x"
  );
  assert.equal(
    damage.__test.injuryDescriptionKey({ name: "Chest", system: { locType: "body" } }, 2),
    "AOV_SKJALDBORG.DamageEffects.InjuryDescriptions.Vital2x"
  );
  assert.equal(
    damage.__test.injuryDescriptionKey({ name: "Arm", system: { locType: "body" } }, 3),
    "AOV_SKJALDBORG.DamageEffects.InjuryDescriptions.Limb3x"
  );

  const hitLocation = {
    id: "loc-arm",
    type: "hitloc",
    name: "Right Arm",
    system: { hpMax: 4, locType: "body", npcDmg: 0 },
    effects: [],
    createCount: 0,
    createEmbeddedDocuments: async (_type, documents) => {
      hitLocation.createCount += 1;
      const created = { id: `effect-${hitLocation.createCount}`, ...clone(documents[0]) };
      hitLocation.effects.push(created);
      return [created];
    }
  };
  const targetActor = {
    id: "actor-threshold",
    uuid: "Actor.actor-threshold",
    effects: [],
    items: [hitLocation]
  };
  hitLocation.parent = targetActor;
  game.actors = new Map([[targetActor.id, targetActor]]);

  const sourceFreeMessage = {
    id: "damage-source-free",
    timestamp: Date.now(),
    flags: {
      aov: {
        chatCard: [{
          rollType: "DM",
          successLevel: "2",
          rollVal: 8,
          targetId: targetActor.id,
          targetType: "actor",
          targetLocID: ""
        }]
      },
      [MODULE_ID]: {}
    },
    getFlag(module, key) {
      return this.flags[module]?.[key];
    },
    update: async data => {
      sourceFreeMessage.updated = clone(data);
      for (const [path, value] of Object.entries(data)) {
        const parts = path.split(".");
        if (parts[0] !== "flags") continue;
        sourceFreeMessage.flags[parts[1]] ??= {};
        sourceFreeMessage.flags[parts[1]][parts[2]] = clone(value);
      }
      return sourceFreeMessage;
    }
  };
  game.messages = new Map([[sourceFreeMessage.id, sourceFreeMessage]]);

  assert.deepEqual(await damage.__test.processDamageCard(sourceFreeMessage, sourceFreeMessage.flags.aov.chatCard[0], 0), {
    status: "pending",
    reason: "target-location-unresolved",
    results: []
  });
  await damage.__test.handleMessageUpdate(sourceFreeMessage);
  assert.equal(sourceFreeMessage.getFlag(MODULE_ID, "damageEffectTracking"), undefined);

  sourceFreeMessage.flags.aov.chatCard[0].targetLocID = "loc-arm";
  const pending = await damage.__test.processDamageCard(sourceFreeMessage, sourceFreeMessage.flags.aov.chatCard[0], 0);
  assert.equal(pending.status, "pending");
  assert.equal(pending.pending.injurySeverity, 2);
  assert.equal(hitLocation.createCount, 0);

  await damage.__test.handleMessageUpdate(sourceFreeMessage);
  assert.equal(hitLocation.createCount, 0);
  assert.equal(sourceFreeMessage.getFlag(MODULE_ID, "damageEffectTracking").cards["0|loc-arm||2|8"].status, "pending");

  const wound = {
    id: "wound-arm",
    type: "wound",
    parent: targetActor,
    system: { hitLocId: "loc-arm", damage: 8 }
  };
  await damage.__test.handleAppliedItemChange(wound);
  assert.equal(targetActor.effects.length, 0);
  assert.equal(hitLocation.createCount, 1);
  assert.equal(hitLocation.effects[0].flags[MODULE_ID].injuryThreshold.severity, 2);
  assert.equal(sourceFreeMessage.getFlag(MODULE_ID, "damageEffectTracking").cards["0|loc-arm||2|8"].status, "resolved");
  await damage.__test.handleAppliedItemChange(wound);
  assert.equal(hitLocation.createCount, 1);

  const lowerMessage = {
    ...sourceFreeMessage,
    id: "damage-lower",
    flags: {
      aov: {
        chatCard: [{ ...sourceFreeMessage.flags.aov.chatCard[0], rollVal: 4 }]
      },
      [MODULE_ID]: {}
    },
    getFlag: sourceFreeMessage.getFlag,
    update: async data => {
      lowerMessage.updated = clone(data);
      for (const [path, value] of Object.entries(data)) {
        const parts = path.split(".");
        if (parts[0] !== "flags") continue;
        lowerMessage.flags[parts[1]] ??= {};
        lowerMessage.flags[parts[1]][parts[2]] = clone(value);
      }
      return lowerMessage;
    }
  };
  game.messages.set(lowerMessage.id, lowerMessage);
  await damage.__test.handleMessageUpdate(lowerMessage);
  await damage.__test.handleAppliedItemChange({ ...wound, id: "wound-lower", system: { hitLocId: "loc-arm", damage: 4 } });
  assert.equal(hitLocation.createCount, 1);

  const severeLocation = {
    ...hitLocation,
    id: "loc-leg",
    name: "Left Leg",
    effects: [],
    createCount: 0,
    createEmbeddedDocuments: async (_type, documents) => {
      severeLocation.createCount += 1;
      const created = { id: `severe-effect-${severeLocation.createCount}`, ...clone(documents[0]) };
      severeLocation.effects.push(created);
      return [created];
    }
  };
  severeLocation.parent = targetActor;
  targetActor.items.push(severeLocation);
  const severeMessage = {
    ...sourceFreeMessage,
    id: "damage-severe",
    flags: {
      aov: {
        chatCard: [{ ...sourceFreeMessage.flags.aov.chatCard[0], targetLocID: "loc-leg", rollVal: 12 }]
      },
      [MODULE_ID]: {}
    },
    getFlag: sourceFreeMessage.getFlag,
    update: async data => {
      severeMessage.updated = clone(data);
      for (const [path, value] of Object.entries(data)) {
        const parts = path.split(".");
        if (parts[0] !== "flags") continue;
        severeMessage.flags[parts[1]] ??= {};
        severeMessage.flags[parts[1]][parts[2]] = clone(value);
      }
      return severeMessage;
    }
  };
  game.messages.set(severeMessage.id, severeMessage);
  await damage.__test.handleMessageUpdate(severeMessage);
  await damage.__test.handleAppliedItemChange({ ...wound, id: "wound-severe", system: { hitLocId: "loc-leg", damage: 8 } });
  assert.equal(severeLocation.effects[0].flags[MODULE_ID].injuryThreshold.severity, 3);
  assert.equal(damage.__test.hitLocationInjurySeverity(severeLocation), 3);
  assert.equal(damage.__test.hitLocationSeverityClass(3), "aov-skjaldborg-hitloc-injury-3");

  const npcMessage = {
    ...sourceFreeMessage,
    id: "damage-npc",
    flags: {
      aov: {
        chatCard: [{ ...sourceFreeMessage.flags.aov.chatCard[0], rollVal: 8 }]
      },
      [MODULE_ID]: {}
    },
    getFlag: sourceFreeMessage.getFlag,
    update: async data => {
      npcMessage.updated = clone(data);
      for (const [path, value] of Object.entries(data)) {
        const parts = path.split(".");
        if (parts[0] !== "flags") continue;
        npcMessage.flags[parts[1]] ??= {};
        npcMessage.flags[parts[1]][parts[2]] = clone(value);
      }
      return npcMessage;
    }
  };
  game.messages.set(npcMessage.id, npcMessage);
  hitLocation.effects = [];
  hitLocation.createCount = 0;
  await damage.__test.handleMessageUpdate(npcMessage);
  await damage.__test.handleAppliedItemChange(hitLocation, { system: { npcDmg: 8 } });
  assert.equal(hitLocation.createCount, 1);
  assert.equal(hitLocation.effects[0].flags[MODULE_ID].injuryThreshold.severity, 2);
  await damage.__test.handleMessageUpdate(sourceFreeMessage);
  assert.equal(hitLocation.createCount, 1);
}

async function testActiveEffectConfigHookDisconnected() {
  const mainSource = readFileSync(new URL("../scripts/main.mjs", import.meta.url), "utf8");
  assert.equal(mainSource.includes("registerActiveEffectConfigHooks"), false);
  assert.equal(mainSource.includes("renderActiveEffectConfig"), false);
  assert.equal(existsSync(new URL("../scripts/compat/active-effect-config.mjs", import.meta.url)), false);
}

async function testActiveEffectParentAndHotbarFiltering() {
  const { effectParentActor, hotbarVisibleEffects } = await import("../scripts/compat/active-effects.mjs");
  const owner = { id: "actor-effects", documentName: "Actor" };
  const item = { id: "item-effects", documentName: "Item", parent: owner, actor: owner };
  const direct = { id: "direct", name: "Direct", parent: owner, disabled: false, isSuppressed: false };
  const gear = { id: "gear", name: "Gear", parent: item, disabled: false, isSuppressed: false };
  const managedItem = {
    id: "managed-item",
    name: "Managed",
    parent: item,
    disabled: false,
    isSuppressed: false,
    flags: { [MODULE_ID]: { grapple: { sourceActorUuid: "Actor.a", targetActorUuid: "Actor.b" } } }
  };
  const disabled = { id: "disabled", parent: owner, disabled: true };
  const actorDocument = { effects: [direct, gear, managedItem, disabled] };
  assert.equal(effectParentActor(gear), owner);
  assert.deepEqual(hotbarVisibleEffects(actorDocument).map(effect => effect.id), ["direct", "managed-item"]);
}

async function testCombatRollDialogHelpers() {
  const {
    aimedPenalty,
    itemTotal,
    targetAimedChoices,
    targetDialogChoiceState,
    targetStunLocationState
  } = await import("../scripts/apps/combat-roll-dialog-helpers.mjs");
  const target = {
    type: "npc",
    effects: [],
    getFlag: (module, key) => module === MODULE_ID && key === "readiedWeapons"
      ? { right: "weapon-ready", left: null, unlimited: false }
      : undefined,
    items: [
      { id: "loc-arm", type: "hitloc", name: "Arm", system: { locType: "body", lowRoll: 1, highRoll: 3, hpMax: 4, currHp: 4, npcAP: 1 } },
      { id: "loc-head-a", type: "hitloc", name: "Left Head", system: { locType: "body", lowRoll: 19, highRoll: 20, hpMax: 5, currHp: 5, npcAP: 2 } },
      { id: "loc-general", type: "hitloc", name: "General", system: { locType: "general", lowRoll: 0, highRoll: 0 } },
      { id: "weapon-ready", type: "weapon", name: "Shield", uuid: "Actor.target.Item.weapon-ready", system: { equipStatus: 1, currHP: 8, maxHP: 10 } },
      { id: "weapon-packed", type: "weapon", name: "Packed Axe", uuid: "Actor.target.Item.weapon-packed", system: { equipStatus: 2, currHP: 7, maxHP: 7 } }
    ]
  };

  assert.equal(itemTotal({ system: { total: "42" } }), 42);
  assert.equal(aimedPenalty(-40), -40);
  assert.equal(aimedPenalty(-10), -20);

  const aimedChoices = targetAimedChoices(target);
  assert.deepEqual(aimedChoices.map(choice => choice.value), ["hitLocation:loc-arm", "hitLocation:loc-head-a", "equipment:weapon-ready"]);
  assert.equal(aimedChoices.find(choice => choice.value === "equipment:weapon-ready").targetWeaponMaximumHp, 10);

  const stunState = targetStunLocationState(target);
  assert.equal(stunState.selectedId, "loc-head-a");

  const fullState = targetDialogChoiceState(target);
  assert.equal(fullState.hitLocations.length, 2);
  assert.equal(fullState.equippedWeapons.length, 1);
  assert.equal(fullState.stunState.selectedId, "loc-head-a");
}

async function testActorPortraitSource() {
  const { actorPortraitSource } = await import("../scripts/ui/dom-utils.mjs");
  assert.equal(
    actorPortraitSource(
      { img: "actors/hero.webp" },
      { document: { texture: { src: "tokens/hero-token.webp" } } }
    ),
    "actors/hero.webp"
  );
  assert.equal(
    actorPortraitSource(
      { img: "" },
      { document: { texture: { src: "tokens/fallback.webp" } } }
    ),
    "tokens/fallback.webp"
  );
  assert.equal(actorPortraitSource(null, null), "");
}

async function testRunicMagicDataHelpers() {
  const {
    CRAFT_RUNE_MODES,
    readWriteRunesSkill,
    runeCraftChoices,
    runeMagicConsumesPrepared,
    runeMagicNarrativeKey
  } = await import("../scripts/combat/runic-magic-data.mjs");
  const runemaster = actor("runemaster");
  runemaster.items = [
    { id: "rw", type: "skill", name: "Read/Write (runes)", flags: { aov: { cidFlag: { id: "i.skill.read-write" } } }, system: { total: 70 } },
    { id: "carp", type: "skill", name: "Craft (carpentry)", flags: { aov: { cidFlag: { id: "i.skill.craft-carpentry" } } }, system: { total: 55 } },
    { id: "mason", type: "skill", name: "Craft (masonry)", flags: { aov: { cidFlag: { id: "i.skill.craft-masonry" } } }, system: { total: 45 } },
    { id: "craft-other", type: "skill", name: "Craft (textiles)", flags: { aov: { cidFlag: { id: "i.skill.craft-textiles" } } }, system: { total: 65 } }
  ];
  const choices = runeCraftChoices(runemaster);
  assert.deepEqual(choices.map(choice => choice.mode), [CRAFT_RUNE_MODES.CARPENTRY, CRAFT_RUNE_MODES.MASONRY, CRAFT_RUNE_MODES.CUSTOM]);
  assert.equal(choices[0].skillId, "carp");
  assert.equal(choices[1].skillId, "mason");
  assert.equal(readWriteRunesSkill(runemaster).id, "rw");
  assert.equal(runeMagicNarrativeKey(4), "AOV_SKJALDBORG.RunicMagic.Results.Critical");
  assert.equal(runeMagicNarrativeKey(3), "AOV_SKJALDBORG.RunicMagic.Results.Special");
  assert.equal(runeMagicNarrativeKey(2), "AOV_SKJALDBORG.RunicMagic.Results.Success");
  assert.equal(runeMagicNarrativeKey(1), "AOV_SKJALDBORG.RunicMagic.Results.Failure");
  assert.equal(runeMagicNarrativeKey(0), "AOV_SKJALDBORG.RunicMagic.Results.Fumble");
  assert.equal(runeMagicConsumesPrepared(1), false);
  assert.equal(runeMagicConsumesPrepared(0), true);
  assert.equal(runeMagicConsumesPrepared(2), true);
  assert.equal(runeMagicConsumesPrepared(null), false);
}

async function testRunicMagicResistanceCards() {
  const { buildResistanceChatCard } = await import("../scripts/combat/automation-helpers.mjs");
  const { __test } = await import("../scripts/combat/runic-magic-cards.mjs");
  const caster = actor("runic-caster");
  caster.id = "caster";
  caster.uuid = "Actor.caster";
  caster.name = "Runemaster";
  caster.system.abilities.pow = { total: 16, value: 16 };
  const target = actor("runic-target");
  target.id = "target";
  target.uuid = "Actor.target";
  target.name = "Resentful Outlaw";
  target.system.abilities.pow = { total: 11, value: 11 };
  target.system.powResist = 10;
  const casterToken = { id: "caster-token", uuid: "Scene.scene.Token.caster-token", name: "Caster Token", actor: caster };
  const targetToken = { id: "target-token", uuid: "Scene.scene.Token.target-token", name: "Target Token", actor: target };
  game.actors = new Map([[caster.id, caster], [target.id, target]]);
  game.actors.tokens = {
    "caster-token": caster,
    "target-token": target
  };

  const generic = buildResistanceChatCard({
    actor: caster,
    tokenDocument: null,
    label: "STR",
    rawScore: 12,
    active: true
  });
  assert.equal(generic.targetScore, 60);
  assert.equal(generic.particType, "actor");

  const data = __test.buildRunicResistanceChatData({
    actor: caster,
    casterToken,
    targetActor: target,
    targetToken
  });
  assert.equal(data.cardType, "RE");
  assert.equal(data.chatCard.length, 2);
  assert.equal(data.chatCard[0].particType, "token");
  assert.equal(data.chatCard[0].particId, "caster-token");
  assert.equal(data.chatCard[0].label, "AOV_SKJALDBORG.RunicMagic.ResistanceActiveLabel");
  assert.equal(data.chatCard[0].rawScore, 16);
  assert.equal(data.chatCard[0].targetScore, 80);
  assert.equal(data.chatCard[0].flatMod, 0);
  assert.equal(data.chatCard[0].characteristic, "pow");
  assert.equal(data.chatCard[1].particType, "token");
  assert.equal(data.chatCard[1].particId, "target-token");
  assert.equal(data.chatCard[1].label, "AOV_SKJALDBORG.RunicMagic.ResistancePassiveLabel");
  assert.equal(data.chatCard[1].rawScore, 11);
  assert.equal(data.chatCard[1].targetScore, 65);
  assert.equal(data.chatCard[1].flatMod, 10);
  assert.equal(data.chatCard[1].characteristic, "pow");
}

async function testRunicMagicDetailRendering() {
  const { __test } = await import("../scripts/combat/runic-magic-cards.mjs");
  globalThis.foundry.applications.ux = {
    TextEditor: {
      implementation: {
        enrichHTML: async value => `<enriched>${value}</enriched>`
      }
    }
  };
  const item = {
    id: "rune-script",
    uuid: "Actor.caster.Item.rune-script",
    type: "runescript",
    name: "Charming",
    isOwner: true,
    system: {
      description: "<p>Full rune script description.</p>",
      shortDesc: "Short impact"
    },
    getRollData: () => ({})
  };
  const html = await __test.magicDetailHtml(item, { itemType: "runescript", resultLevel: 2 });
  assert.match(html, /data-runic-magic-details=/);
  assert.match(html, /<form class="aov aov-skjaldborg-chat skj-runic-magic-result"/);
  assert.match(html, /<div class="dice-roll" data-action="expandRoll">/);
  assert.match(html, /skj-runic-magic-detail-body/);
  assert.match(html, /skj-runic-magic-detail-row skj-runic-magic-narrative/);
  assert.match(html, /skj-runic-magic-detail-row skj-runic-magic-description/);
  assert.doesNotMatch(html, /class="rollHidden/);
  assert.doesNotMatch(html, /dice-roll expanded/);
  assert.match(html, /<span class="tag">Charming<\/span>/);
  assert.match(html, /<enriched><p>Full rune script description\.<\/p><\/enriched>/);
  assert.doesNotMatch(html, /Short impact/);
  assert.ok(html.indexOf("AOV_SKJALDBORG.RunicMagic.Results.Success") < html.indexOf("Full rune script description"));
  assert.equal(__test.magicResultNarrativeKey("seidur", 0), "AOV_SKJALDBORG.RunicMagic.SeidurResults.Fumble");

  const fallback = await __test.magicDetailHtml({
    ...item,
    name: "Empty Description",
    system: {
      description: "",
      shortDesc: "Fallback <impact>"
    }
  }, { itemType: "seidur", resultLevel: 3 });
  assert.match(fallback, /Empty Description/);
  assert.match(fallback, /Fallback &lt;impact&gt;/);
  assert.match(fallback, /AOV_SKJALDBORG\.RunicMagic\.SeidurResults\.Special/);
}

async function testRunicMagicResistanceFlowSource() {
  const socketSource = readFileSync(new URL("../scripts/socket.mjs", import.meta.url), "utf8");
  const dialogSource = readFileSync(new URL("../scripts/apps/runic-magic-dialog.mjs", import.meta.url), "utf8");
  assert.equal(socketSource.includes('cardType, flatMod: clean.flatMod'), false);
  assert.equal(socketSource.includes('cardType = clean.resistance'), false);
  assert.equal(socketSource.includes('rollActorCharacteristic(target.actor, "pow"'), false);
  assert.equal(dialogSource.includes('cardType = payload.resistance'), false);
  assert.equal(dialogSource.includes('rollActorCharacteristic(targetActor, "pow"'), false);
  assert.equal(socketSource.includes("pendingResistanceMessageIds"), false);
  assert.match(socketSource, /rollActorSkill\(actor,\s*runeSkill\.id,\s*null,\s*\{\s*cardType:\s*"unopposed",\s*flatMod:\s*clean\.flatMod\s*\}\)/);
  assert.match(socketSource, /clean\.resistance\s*&&\s*clean\.targetRefs\.length\s*&&\s*manifests/);
  assert.match(dialogSource, /rollActorSkill\(actor,\s*runeSkill\.id,\s*null,\s*\{\s*cardType:\s*"unopposed",\s*flatMod:\s*payload\.flatMod\s*\}\)/);
  assert.match(dialogSource, /payload\.resistance\s*&&\s*payload\.targetRefs\.length\s*&&\s*manifests/);
  assert.match(socketSource, /createRunicResistanceCards/);
}

async function testAutomationHelperMatching() {
  const {
    aovCards,
    idTypeMatch,
    recentFlaggedMessages
  } = await import("../scripts/combat/automation-helpers.mjs");
  const now = Date.now();
  const flagged = {
    id: "message-flagged",
    timestamp: now,
    flags: {
      aov: { chatCard: [{ rollType: "DM", targetLocID: "loc-head" }] },
      [MODULE_ID]: { sampleFlag: { resolved: false, createdAt: now, targetId: "target-a" } }
    },
    getFlag(module, key) {
      return this.flags[module]?.[key];
    }
  };
  const stale = {
    id: "message-stale",
    timestamp: now - 20 * 60 * 1000,
    flags: { [MODULE_ID]: { sampleFlag: { resolved: false, createdAt: now - 20 * 60 * 1000 } } },
    getFlag(module, key) {
      return this.flags[module]?.[key];
    }
  };
  game.messages = new Map([[flagged.id, flagged], [stale.id, stale]]);

  assert.equal(aovCards(flagged).length, 1);
  assert.equal(idTypeMatch("target-a", "actor", "target-a", "actor"), true);
  assert.equal(idTypeMatch("target-a", "actor", "target-a", "token"), false);
  assert.deepEqual(
    recentFlaggedMessages({
      flag: "sampleFlag",
      windowMs: 10 * 60 * 1000,
      predicate: entry => entry.flag.targetId === "target-a"
    }).map(entry => entry.message.id),
    ["message-flagged"]
  );
}

async function testStationaryEngagements() {
  const { checkMovementEngagements } = await import("../scripts/combat/movement-controller.mjs");
  const { getCombatantState } = await import("../scripts/combat/state.mjs");

  const friendly = combatant("stationary-friendly", 0, 0, 1);
  const hostile = combatant("stationary-hostile", 100, 0, -1);
  const stationaryCombat = combat("stationary-combat", [friendly, hostile]);
  assert.equal(await checkMovementEngagements(stationaryCombat, { includeStationary: true, reason: "regression-empty" }), 1);
  assert.deepEqual(getCombatantState(friendly).engagement.partnerIds, ["stationary-hostile"]);
  assert.deepEqual(getCombatantState(hostile).engagement.partnerIds, ["stationary-friendly"]);

  const adjacent = combatant("adjacent-friendly", 0, 0, 1);
  const bottom = combatant("bottom-hostile", 100, 0, -1);
  const moving = combatant("moving-friendly", 100, 100, 1, {
    movement: {
      planStatus: "executing",
      distance: 0
    }
  });
  const multiCombat = combat("multi-contact-combat", [adjacent, bottom, moving]);
  assert.equal(await checkMovementEngagements(multiCombat, { includeStationary: true, reason: "regression-start" }), 2);
  assert.deepEqual(new Set(getCombatantState(bottom).engagement.partnerIds), new Set(["adjacent-friendly", "moving-friendly"]));
  assert.deepEqual(getCombatantState(adjacent).engagement.partnerIds, ["bottom-hostile"]);
  assert.deepEqual(getCombatantState(moving).engagement.partnerIds, ["bottom-hostile"]);
}

installFoundryMocks();
await testReadiedWeaponsAndCombatOptions();
await testWeaponLengthReach();
await testReachVisualizerConfigAndGeometry();
await testWeaponSkillResolver();
await testAov144D100Evaluation();
await testAov144CombatCardChances();
await testAimedEquipmentGrossDamage();
await testRouteResolvedAoVImports();
await testChangedPathUtilityInvalidation();
await testActorHotbarRegionRenderStructure();
await testActorHotbarActiveEffectInvalidation();
await testDelaySocketMetadata();
await testIntentIdempotency();
await testIntentSingleFlight();
await testStationaryEngagements();
await testMovementEligibilityBlocksOverLimitEngagement();
await testSpecialActionD3Conversion();
await testGrappleThrowCandidates();
await testGrappleEffectMatching();
await testSpecialActionHookRegistrationIdempotency();
await testActiveEffectStatusCatalogRegistration();
await testActiveEffectDetectionAndCreation();
await testDamageEffectTrackingHelpers();
await testActiveEffectParentAndHotbarFiltering();
await testActiveEffectConfigHookDisconnected();
await testCombatRollDialogHelpers();
await testActorPortraitSource();
await testRunicMagicDataHelpers();
await testRunicMagicResistanceCards();
await testRunicMagicDetailRendering();
await testRunicMagicResistanceFlowSource();
await testAutomationHelperMatching();
console.log("Regression tests passed.");
