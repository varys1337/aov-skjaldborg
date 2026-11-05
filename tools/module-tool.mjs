import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { ROOT, fail, readJson, writeJson } from "./lib/workspace.mjs";
import { syntaxCheck, validateAll } from "./lib/validation.mjs";
import { buildFolder, buildRelease } from "./lib/packaging.mjs";

async function contractTests() {
  const kernel = await import("../scripts/combat/rule-kernel.mjs");
  kernel.__test.resetRules();
  kernel.registerCombatRule({
    id: "late",
    priority: 200,
    prepareAttackContext: context => {
      context.ruleMetadata.late = true;
      return { live: { ignored: true }, kept: "late" };
    }
  });
  kernel.registerCombatRule({
    id: "early",
    priority: 100,
    prepareAttackContext: context => {
      context.ruleMetadata.early = true;
      return { kept: "early" };
    }
  });
  const context = kernel.prepareAttackContext(kernel.createCombatRuleContext());
  assert.deepEqual(kernel.__test.registeredRuleIds(), ["early", "late"]);
  assert.deepEqual(context.ruleReports.map(report => report.id), ["early", "late"]);
  assert.deepEqual(context.ruleReports[1], {
    id: "late",
    stage: "prepareAttackContext",
    kept: "late"
  });
  kernel.__test.resetRules();
  const proneSource = readFileSync(join(ROOT, "scripts", "combat", "prone-automation.mjs"), "utf8");
  const aimedSource = readFileSync(join(ROOT, "scripts", "combat", "aimed-blow-automation.mjs"), "utf8");
  assert.match(proneSource, /id:\s*"prone"[\s\S]*?priority:\s*100/);
  assert.match(aimedSource, /id:\s*"aimed-blow"[\s\S]*?priority:\s*200/);

  const sanitizers = await import("../scripts/socket/sanitizers.mjs");
  const prompt = sanitizers.sanitizePromptDefensePayload({
    attackMessageId: " attack ",
    targetTokenUuid: "Scene.abc.Token.def",
    targetActorUuid: "Actor.abc",
    incomingWeaponType: "spear",
    ignored: { live: true }
  });
  assert.deepEqual(prompt, {
    attackMessageId: "attack",
    tokenUuid: "Scene.abc.Token.def",
    actorUuid: "Actor.abc",
    incomingWeaponType: "spear"
  });
  const intent = sanitizers.sanitizeCommitIntentPayload({
    combatId: "combat",
    combatantId: "combatant",
    intent: {
      status: "held",
      actionCategory: "flee",
      splitCount: 99,
      modifiers: { fullMove: true }
    }
  });
  assert.equal(intent.intent.actionCategory, "retreat");
  assert.equal(intent.intent.splitCount, 4);
  assert.equal(intent.intent.modifiers.fullMove, true);
  const combatWrite = sanitizers.sanitizeCombatWritePayload({
    combatId: " combat ",
    combatantId: " combatant ",
    actionId: " action ",
    expectedCombatUpdatedAt: "42",
    attackerCombatantId: " attacker ",
    targetCombatantId: " target "
  });
  assert.equal(combatWrite.combatId, "combat");
  assert.equal(combatWrite.combatantId, "combatant");
  assert.equal(combatWrite.actionId, "action");
  assert.equal(combatWrite.expectedCombatUpdatedAt, 42);
  assert.equal(combatWrite.attackerCombatantId, "attacker");
  assert.equal(combatWrite.targetCombatantId, "target");

  const adapterSource = readFileSync(join(ROOT, "scripts", "adapter", "aov-adapter.mjs"), "utf8");
  assert.match(adapterSource, /CORE_ROLL_PROMPT_TIMEOUT_MS\s*=\s*15000/);
  assert.match(adapterSource, /source\s*===\s*"defense"\s*&&\s*Object\.hasOwn\(options,\s*"none"\)\)\s*return\s*"none"/);
  assert.match(adapterSource, /source\s*===\s*"attack"\s*&&\s*Object\.hasOwn\(options,\s*"attack"\)\)\s*return\s*"attack"/);
  const schemaSource = readFileSync(join(ROOT, "scripts", "socket", "schema.mjs"), "utf8");
  assert.match(schemaSource, /promptDefenseRoll[\s\S]*?timeoutMs:\s*20000/);
  const socketSource = readFileSync(join(ROOT, "scripts", "socket.mjs"), "utf8");
  assert.doesNotMatch(socketSource, /switch\s*\(\s*message\.action\s*\)/);
  assert.doesNotMatch(schemaSource, /handleLegacySocketAction/);
  const socketSchema = await import("../scripts/socket/schema.mjs");
  assert.deepEqual(Object.keys(socketSchema.SOCKET_ACTIONS), [
    "initializeCombat",
    "disableCombat",
    "advancePhase",
    "advanceTurn",
    "setActionStatus",
    "submitIntent",
    "holdIntent",
    "clearIntent",
    "recordMovement",
    "clearMovement",
    "adjustInitiative",
    "delayCombatant",
    "setUtilityOptions",
    "startRuneCarving",
    "markRunePrepared",
    "castRuneScript",
    "trackSeidurRitual",
    "clearRuneMagic",
    "disruptRuneMagic",
    "activateEvade",
    "declareDisengagement",
    "resolveKnockbackDisengagement",
    "incrementReaction",
    "decrementReaction",
    "commitDefenseCard",
    "chatActionClaim",
    "promptDefenseRoll"
  ]);
  for (const descriptor of Object.values(socketSchema.SOCKET_ACTIONS)) {
    assert.equal(typeof descriptor.sanitize, "function");
    assert.equal(typeof descriptor.resolve, "function");
    assert.equal(typeof descriptor.authorize, "function");
    assert.equal(typeof descriptor.execute, "function");
    assert.equal(typeof descriptor.normalize, "function");
    assert.equal(Number.isFinite(descriptor.timeoutMs) && descriptor.timeoutMs > 0, true);
  }
  assert.equal(socketSchema.SOCKET_ACTIONS.initializeCombat.timeoutMs, 10000);
  assert.equal(socketSchema.SOCKET_ACTIONS.promptDefenseRoll.timeoutMs, 20000);
  assert.deepEqual(socketSchema.normalizeSocketActionResult("recordMovement", {
    accepted: false,
    ignoredReason: "stale-revision",
    routeId: "route",
    routeRevision: 3,
    planStatus: "planned",
    draft: false
  }), {
    accepted: false,
    action: "recordMovement",
    ignoredReason: "stale-revision",
    routeId: "route",
    routeRevision: 3,
    planStatus: "planned",
    draft: false
  });
  const defenseSummary = socketSchema.normalizeSocketActionResult("commitDefenseCard", {
    accepted: true,
    defenseMessageId: "message",
    ignoredDocument: { uuid: "Actor.unsafe" }
  });
  assert.deepEqual(defenseSummary, {
    accepted: true,
    action: "commitDefenseCard",
    defenseMessageId: "message"
  });
  const previousHooks = globalThis.Hooks;
  let nextHookId = 1;
  const observedHooks = [];
  globalThis.Hooks = {
    on(eventName, handler) {
      observedHooks.push({ eventName, handler, once: false });
      return nextHookId++;
    },
    once(eventName, handler) {
      observedHooks.push({ eventName, handler, once: true });
      return nextHookId++;
    },
    off() {}
  };
  try {
    const registry = await import("../scripts/core/feature-registry.mjs");
    registry.__test.reset();
    registry.registerFeature({
      id: "contract-feature",
      label: "Contract Feature",
      initialize: hooks => {
        hooks.on("updateCombat", () => undefined);
        hooks.once("ready", () => undefined);
      }
    });
    registry.initializeRegisteredFeatures();
    registry.initializeRegisteredFeatures();
    const report = registry.getFeatureRegistryReport();
    assert.equal(observedHooks.length, 2);
    assert.equal(report.hookCount, 2);
    assert.equal(report.hookCountSource, "tracked");
    assert.equal(report.features[0].trackedHookCount, 2);
    assert.equal(report.features[0].declaredHookCount, 0);
  } finally {
    globalThis.Hooks = previousHooks;
  }
  const changedPaths = await import("../scripts/utils/changed-paths.mjs");
  assert.equal(changedPaths.combatTrackerAffectedByCombatChange({ active: true }), false);
  assert.equal(changedPaths.combatTrackerAffectedByCombatChange({
    flags: { "aov-skjaldborg": { combatState: { phase: "action" } } }
  }), true);
  assert.equal(changedPaths.combatTrackerAffectedByCombatantChange({ sort: 10 }), false);
  assert.equal(changedPaths.combatTrackerAffectedByCombatantChange({ initiative: 12 }), true);
  const versions = await import("../scripts/utils/version.mjs");
  assert.equal(versions.compareVersions("14.365.0", "14.365"), 0);
  assert.equal(versions.compareVersions("14.365", "14.364"), 1);
  assert.equal(versions.compareVersions("14.363", "14.365"), -1);
  assert.equal(versions.versionAtLeast("14.365.0", "14.365"), true);
  assert.equal(versions.versionAtLeast("", "14.365"), false);
  const chatMessages = await import("../scripts/compat/chat-message.mjs");
  assert.deepEqual(
    chatMessages.chatMessageOperation(chatMessages.CHAT_MESSAGE_DELIVERY.BACKGROUND, {}, "14.365"),
    { notify: false, scroll: false }
  );
  assert.deepEqual(
    chatMessages.chatMessageOperation(chatMessages.CHAT_MESSAGE_DELIVERY.BACKGROUND, {}, "14.364"),
    {}
  );
  assert.deepEqual(
    chatMessages.chatMessageOperation(
      chatMessages.CHAT_MESSAGE_DELIVERY.BACKGROUND,
      { notify: true },
      "14.365"
    ),
    { notify: true, scroll: false }
  );
  const dialogBaseSource = readFileSync(join(ROOT, "scripts", "apps", "base", "dialog-v2.mjs"), "utf8");
  assert.match(dialogBaseSource, /typeof this\._refit !== "function"/);
  assert.match(dialogBaseSource, /queueMicrotask/);
  assert.match(dialogBaseSource, /if \(this\.rendered\) this\._refit\(nextPosition\)/);
  await combatPlanContractTests();
  await provenanceContractTests();
  await recoveryContractTests();
  await actionUiPlanContractTests();
  await maintenancePackagingContractTests();
  const legacyRegressions = join(ROOT, "tools", "regression-tests.mjs");
  if (existsSync(legacyRegressions)) {
    const result = spawnSync(process.execPath, [legacyRegressions], { cwd: ROOT, stdio: "inherit", windowsHide: true });
    if (result.error) throw result.error;
    if (result.status !== 0) fail(`Regression suite failed (exit ${result.status}).`);
  }
  console.log("contracts: rules, sockets, serialization, versions, AppV2 refits, and chat delivery passed");
}

/** Read-only incident classification, bounded searches, privacy and AppV2 actions. */
async function recoveryContractTests() {
  const names = ["foundry", "game", "requestAnimationFrame"];
  const originals = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const { runtimeSettings, refreshRuntimeSetting } = await import("../scripts/runtime-settings.mjs");
  const originalRuntimeSettings = structuredClone(runtimeSettings);
  try {
    const { MODULE_ID } = await import("../scripts/constants.mjs");
    const audit = await import("../scripts/combat/action-recovery-audit.mjs");
    const evidence = await import("../scripts/combat/action-claim-evidence.mjs");
    const provenance = await import("../scripts/combat/result-provenance.mjs");
    const messages = new Map(), documents = new Map();
    const gm = { id: "gm", name: "Primary GM", active: true, isGM: true };
    const other = { id: "other", name: "Other GM", active: true, isGM: true };
    const actor = { id: "actor", uuid: "Actor.actor" };
    const weapon = { uuid: "Actor.actor.Item.weapon", parent: actor };
    const ammunition = { uuid: "Actor.actor.Item.ammo", parent: actor, system: { quantity: 4 }, testUserPermission: () => true };
    const targetActor = { uuid: "Actor.target" };
    const target = { uuid: "Scene.scene.Token.target", actor: targetActor };
    const targetB = { uuid: "Scene.scene.Token.targetB", actor: { uuid: "Actor.targetB" } };
    for (const doc of [actor, weapon, ammunition, targetActor, target, targetB]) documents.set(doc.uuid, doc);
    const users = new Map([[gm.id, gm], [other.id, other]]);
    let reads = 0, writes = 0, downloads = 0;
    const message = (id, flags = {}) => {
      const doc = { id, uuid: `ChatMessage.${id}`, visible: true, isContentVisible: true, flags: { [MODULE_ID]: flags },
        getFlag(scope, key) { reads++; return this.flags[scope]?.[key]; }, canUserModify: () => false,
        update() { writes++; throw new Error("Read-only audit attempted a write"); } };
      messages.set(id, doc); return doc;
    };
    class AppFixture {
      constructor() { this.options = this.constructor.DEFAULT_OPTIONS; this.rendered = true; this.renderCalls = 0; }
      _canRender() {} async _prepareContext() { return {}; } async _onRender() {} async _onFirstRender() {} _onClose() {}
      async render() { this.renderCalls++; return this; }
      async close() { this._onClose({}); this.rendered = false; return this; }
    }
    globalThis.game = { user: gm, users, messages, combats: new Map(), combat: null,
      aovSkjaldborg: { capabilities: { runtimeEnabled: true } }, i18n: { localize: key => key, format: (key, values) => `${key}:${JSON.stringify(values)}` } };
    globalThis.foundry = { utils: { fromUuidSync: uuid => documents.get(uuid), saveDataToFile: () => { downloads++; } },
      applications: { api: { ApplicationV2: AppFixture, HandlebarsApplicationMixin: base => base } } };
    globalThis.requestAnimationFrame = () => 1; // Explicitly flush the existing coordinator in these fixtures.
    const subject = { actorUuid: actor.uuid, weaponUuid: weapon.uuid, targetTokenUuid: target.uuid, targetActorUuid: targetActor.uuid };
    const makeSource = (id, state = "claimed", extra = {}, split = false) => message(id, {
      [split ? "splitAttack" : "targetQueue"]: split ? { ...subject, targetTokenUuid: null, targetActorUuid: null, sourceWorkflow: "missile" }
        : { workflow: "missile", actorUuid: actor.uuid, entries: [{ ...subject, ammunitionUuid: ammunition.uuid }] },
      actionClaims: { version: 1, context: null, entries: {
        [split ? "split" : "target-0"]: { state, attemptId: `attempt-${id}`, userId: gm.id, claimedAt: Date.now() - 70000,
          subject: split ? { ...subject, targetTokenUuid: null, targetActorUuid: null } : { ...subject }, ...extra }
      } }
    });
    const addResult = (source, id, { split = false, targetToken = target, batchIndex = 0, batchSize = 1 } = {}) => {
      const slot = split ? "split" : "target-0", claim = source.flags[MODULE_ID].actionClaims.entries[slot];
      const actionClaim = { version: 1, key: evidence.chatActionClaimKey(source, slot), attemptId: claim.attemptId };
      const doc = message(id, { actionClaim, combatCardBatch: { batchId: `batch-${source.id}`, batchIndex, batchSize },
        combatProvenance: provenance.attackProvenance(id, { actor, weapon, targetActor: targetToken.actor, targetToken, actionClaim }) });
      doc.flags.aov = { cardType: "CO", state: "open", chatCard: [{}] }; return doc;
    };
    const rowFor = source => audit.inspectCombatActionRecovery({ scope: "all", sourceMessageId: source.id, includeCommitted: true }).rows[0];
    const reserved = makeSource("reserved");
    assert.equal(rowFor(reserved).evidenceClass, "Reserved");
    assert.equal(rowFor(reserved).canRelease, false, "B01 gate disables even an unstarted release");
    assert.equal(rowFor(makeSource("executing", "executing")).evidenceClass, "Executing");
    const spent = makeSource("spent", "executing", { ammunitionUuid: ammunition.uuid, ammunitionChange: { before: 5, after: 4, count: 1 } });
    assert.equal(rowFor(spent).evidenceClass, "ExecutingSpent");
    const resultSource = makeSource("has-result", "executing");
    const result = addResult(resultSource, "exact-result");
    assert.equal(rowFor(resultSource).evidenceClass, "ResultFound");
    assert.equal(rowFor(resultSource).results[0].attackProof, true);
    result.flags[MODULE_ID].combatProvenance.cards[0].sourceCardIndex = 1;
    assert.equal(rowFor(resultSource).results[0].attackProof, false, "wrong native source-card index is never creation proof");
    result.flags[MODULE_ID].combatProvenance.cards[0].sourceCardIndex = 0;
    const split = makeSource("partial", "executing", { targetTokenUuids: [target.uuid, targetB.uuid] }, true);
    addResult(split, "split-zero", { split: true, batchSize: 2 });
    assert.equal(rowFor(split).evidenceClass, "PartialSplit");
    split.flags[MODULE_ID].actionClaims.entries.split.state = "committed";
    assert.equal(audit.inspectCombatActionRecovery({ scope: "all", sourceMessageId: split.id }).rows[0].evidenceClass, "PartialSplit",
      "a committed flag cannot hide an incomplete split batch");
    const committed = makeSource("committed", "committed"); addResult(committed, "committed-result");
    committed.flags[MODULE_ID].targetQueue.entries[0].resolved = true;
    assert.equal(rowFor(committed).evidenceClass, "Committed");
    assert.equal(rowFor(committed).canReconcile, false);
    const unknown = makeSource("unknown"); unknown.flags[MODULE_ID].actionClaims.version = 99;
    assert.equal(rowFor(unknown).evidenceClass, "Malformed");
    unknown.flags[MODULE_ID].actionClaims.entries = {};
    assert.equal(rowFor(unknown).evidenceClass, "Malformed", "an unknown empty schema is still inspectable");
    const corrupted = makeSource("corrupted"); corrupted.flags[MODULE_ID].actionClaims.entries = [];
    assert.equal(rowFor(corrupted).evidenceClass, "Malformed");
    const badReceipt = makeSource("bad-receipt", "claimed", { ammunitionChange: { before: 5, after: 2, count: 1 } });
    assert.equal(rowFor(badReceipt).evidenceClass, "Malformed");
    const contradictoryReceipt = makeSource("claimed-spent", "claimed", { ammunitionChange: { before: 5, after: 4, count: 1 } });
    assert.equal(rowFor(contradictoryReceipt).evidenceClass, "Malformed");
    documents.delete(ammunition.uuid);
    assert.equal(rowFor(spent).reasons.includes("AmmunitionUnavailable"), true);
    assert.deepEqual(rowFor(spent).receipt, { before: 5, after: 4, count: 1 }, "deleting ammunition never erases its receipt");
    documents.set(ammunition.uuid, ammunition);
    resultSource.flags[MODULE_ID].actionClaims.entries["target-0"].resultMessageIds = [result.id];
    result.isContentVisible = false;
    assert.equal(rowFor(resultSource).results[0].available, false);
    result.isContentVisible = true;
    const hidden = makeSource("private"); hidden.visible = false;
    hidden.getFlag = () => { throw new Error("Hidden flags were inspected"); };
    assert.equal(audit.inspectCombatActionRecovery({ scope: "all", sourceMessageId: hidden.id }).rows.length, 0);
    const stored = structuredClone(spent.flags);
    spent.flags[MODULE_ID].privateSecret = "DO_NOT_EXPORT";
    const exported = audit.recoveryDiagnosticSummary({ scope: "all", sourceMessageId: spent.id });
    assert.equal(exported.includes("DO_NOT_EXPORT"), false);
    assert.equal(exported.includes(gm.name), false);
    delete spent.flags[MODULE_ID].privateSecret;
    assert.deepEqual(spent.flags, stored);
    game.user = other;
    assert.equal(rowFor(spent).canRelease, false, "a secondary GM cannot turn inspection into repair");
    game.user = { id: "player", isGM: false };
    assert.throws(() => audit.inspectCombatActionRecovery(), /GmOnly/);
    assert.throws(() => audit.recoveryDiagnosticSummary(), /GmOnly/);
    game.user = gm;
    messages.delete(resultSource.id);
    const orphan = audit.inspectCombatActionRecovery({ scope: "all", sourceMessageId: resultSource.id }).rows[0];
    assert.equal(orphan.sourceAvailable, false);
    assert.equal(orphan.reasons.includes("SourceUnavailable"), true);
    assert.equal(writes, 0);
    messages.clear();
    for (let i = 0; i < 5000; i++) message(`history-${i}`);
    for (let i = 0; i < 50; i++) makeSource(`incident-${i}`, "executing");
    reads = 0;
    const large = audit.inspectCombatActionRecovery({ scope: "all" });
    assert.equal(large.totalRows, 50);
    assert.equal(large.rows.length, 25);
    assert.equal(large.pages, 2);
    assert.equal(large.searchIncomplete, true);
    assert.ok(reads < 6000, "flag inspection is bounded to one loaded-message window");
    assert.equal(audit.inspectCombatActionRecovery({ scope: "all", page: 1 }).rows.length, 25);
    assert.equal(audit.inspectCombatActionRecovery({ scope: "all", historyPage: 1 }).rows.length, 0);

    const registeredSettings = new Map(), menus = new Map();
    game.settings = {
      menus,
      register(namespace, key, config) { registeredSettings.set(`${namespace}.${key}`, config); },
      registerMenu(namespace, key, config) { menus.set(`${namespace}.${key}`, config); },
      get(namespace, key) { return registeredSettings.get(`${namespace}.${key}`)?.default; }
    };
    const { registerSettings } = await import("../scripts/settings.mjs");
    registerSettings();
    const recoveryMenuKey = `${MODULE_ID}.combatActionRecovery`;
    const changeDebug = registeredSettings.get(`${MODULE_ID}.debug`).onChange;
    assert.equal(menus.has(recoveryMenuKey), false, "recovery menu is absent with debugging off at startup");
    changeDebug(true);
    const menuType = menus.get(recoveryMenuKey).type;
    assert.equal(menus.get(recoveryMenuKey).restricted, true);
    changeDebug(true);
    let debugClosed = false, debugCleared = false;
    menuType.current = { evidenceRevision: 0, element: { replaceChildren() { debugCleared = true; } },
      close() { debugClosed = true; menuType.current = null; } };
    changeDebug(false);
    assert.equal(menus.has(recoveryMenuKey), false, "disabling debugging removes the recovery menu");
    assert.equal(debugClosed && debugCleared, true, "disabling debugging clears and closes the console");
    await assert.rejects(() => menuType.open(), /DebugRequired/);
    assert.throws(() => new menuType()._canRender({}), /DebugRequired/);
    refreshRuntimeSetting("debug", true);

    const ui = await import("../scripts/apps/combat-action-recovery.mjs?recovery-contract");
    const app = new ui.CombatActionRecovery();
    const actions = ui.CombatActionRecovery.DEFAULT_OPTIONS.actions;
    assert.equal(actions.release, undefined); assert.equal(actions.reconcile, undefined);
    app._canRender({});
    game.user = { id: "player", isGM: false };
    assert.throws(() => app._canRender({}), /GmOnly/);
    game.user = gm;
    const events = new Map();
    const hooks = { on(name, callback) { const callbacks = events.get(name) ?? []; callbacks.push(callback); events.set(name, callbacks); } };
    ui.registerCombatActionRecoveryHooks(hooks);
    const hookCount = [...events.values()].reduce((sum, list) => sum + list.length, 0);
    ui.registerCombatActionRecoveryHooks(hooks);
    assert.equal([...events.values()].reduce((sum, list) => sum + list.length, 0), hookCount);
    const preview = { isConnected: true, textContent: "", replaceChildren() { this.textContent = ""; } };
    app.element = { querySelector: () => preview, replaceChildren() { preview.textContent = ""; preview.isConnected = false; } };
    ui.CombatActionRecovery.current = app;
    const previewSource = messages.get("incident-0");
    app.preview = { sourceMessageId: previewSource.id, slot: "target-0", attemptId: "attempt-incident-0" };
    let finishPreview;
    previewSource.renderHTML = () => new Promise(resolve => { finishPreview = resolve; });
    const context = await app._prepareContext({});
    const rendering = app._onRender(context, {});
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(typeof finishPreview, "function");
    events.get("userConnected")[0](other, false);
    finishPreview({ textContent: "PRIVATE STALE TEXT" });
    await rendering;
    assert.equal(preview.textContent, "");
    assert.equal(ui.CombatActionRecovery.current, null);
    await actions.refresh.call(app, { preventDefault() {} });
    actions.exportSummary.call(app, { preventDefault() {} });
    assert.equal(downloads, 1);
    assert.equal(writes, 0, "inspection, refresh, export and handover never write documents");
    console.log("recovery contracts: evidence classes, partial batches, privacy, source/item deletion, bounded history, read-only AppV2 actions, export and delayed GM handover passed");
  } finally {
    Object.assign(runtimeSettings, originalRuntimeSettings);
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  }
}

/** Source identity, ambiguity and Token isolation; never touches a world. */
async function provenanceContractTests() {
  const names = ["foundry", "game", "canvas", "ui", "fromUuid", "fromUuidSync"];
  const originals = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  try {
    const { MODULE_ID, DAMAGE_EFFECT_SOURCE_FLAG } = await import("../scripts/constants.mjs");
    const provenance = await import("../scripts/combat/result-provenance.mjs");
    const damage = await import("../scripts/combat/damage-effect-tracking.mjs");
    const aimed = await import("../scripts/combat/aimed-blow-automation.mjs");
    const missile = await import("../scripts/combat/missile-automation.mjs");
    const disarm = await import("../scripts/combat/disarm-automation.mjs");
    const prone = await import("../scripts/combat/prone-damage-automation.mjs");
    const { AoVAdapter } = await import("../scripts/adapter/aov-adapter.mjs");
    const messages = new Map(), documents = new Map();
    const actor = { id: "attacker", uuid: "Actor.attacker", items: new Map() };
    const defender = { id: "defender", uuid: "Actor.defender", items: new Map() };
    const weapon = { id: "spear", uuid: "Actor.attacker.Item.spear", type: "weapon" };
    actor.items.set(weapon.id, weapon);
    const token = { id: "target", uuid: "Scene.scene.Token.target", actor: defender };
    documents.set(token.uuid, token);
    const gm = { id: "gm", active: true, isGM: true };
    globalThis.game = { user: gm, users: [gm], messages, actors: new Map([[actor.id, actor], [defender.id, defender]]),
      combat: null, settings: { get: () => false }, i18n: { localize: key => key } };
    const getProperty = (value, path) => path.split(".").reduce((entry, key) => entry?.[key], value);
    const setProperty = (value, path, entry) => {
      const parts = path.split("."); const key = parts.pop();
      const parent = parts.reduce((object, part) => object[part] ??= {}, value); parent[key] = entry;
    };
    globalThis.foundry = { utils: { deepClone: structuredClone, getProperty,
      fromUuidSync: uuid => documents.get(uuid) ?? null }, applications: { handlebars: { renderTemplate: async () => "unchanged native card" } } };
    globalThis.fromUuid = async uuid => documents.get(uuid) ?? null;
    globalThis.ui = { chat: { collection: messages }, notifications: { warn() {} } };
    globalThis.canvas = { scene: { tokens: new Map() }, tokens: { placeables: [] } };
    const message = (id, cards, moduleFlags = {}) => {
      const document = { id, uuid: `ChatMessage.${id}`, timestamp: Date.now(),
        flags: { aov: { cardType: "CO", state: "open", chatCard: cards }, [MODULE_ID]: moduleFlags },
        getFlag(scope, key) { return this.flags[scope]?.[key]; },
        async setFlag(scope, key, value) { this.flags[scope] ??= {}; this.flags[scope][key] = value; return this; },
        async update(data) { for (const [key, value] of Object.entries(data)) setProperty(this, key, structuredClone(value)); return this; } };
      messages.set(id, document); return document;
    };
    const sourceCard = { rollType: "WP", particId: actor.id, particType: "actor", targetId: defender.id, targetType: "actor", skillId: weapon.id };
    const sourceFlag = { resolved: false, sourceMessageId: "first", createdAt: Date.now(),
      attackerActorUuid: actor.uuid, attackerActorId: actor.id, attackerParticipantId: actor.id, attackerParticipantType: "actor",
      targetActorUuid: defender.uuid, targetActorId: defender.id, targetParticipantId: defender.id, targetParticipantType: "actor",
      targetTokenUuid: token.uuid, weaponUuid: weapon.uuid, weaponId: weapon.id, damageType: "i",
      hitLocationId: "head", targetWeaponId: "shield", stage: "attack" };
    const flags = id => Object.fromEntries([DAMAGE_EFFECT_SOURCE_FLAG, "aimedBlow", "missileShot", "disarm"].map(key => [key, { ...sourceFlag, sourceMessageId: id }]));
    const makeSource = id => message(id, [{ ...sourceCard }], { ...flags(id), combatProvenance: provenance.attackProvenance(id,
      { actor, weapon, targetActor: defender, targetToken: token, damageType: "i" }) });
    const first = makeSource("first"), second = makeSource("second");
    const makeResult = (id, source, resultCardIndex = 0) => message(id,
      Array.from({ length: resultCardIndex + 1 }, () => ({ ...sourceCard, rollType: "DM", rollVal: 5 })),
      source ? { combatProvenance: provenance.resultProvenance(source, { resultCardIndex }) } : {});
    const resultA = makeResult("damageA", first), resultB = makeResult("damageB", second);
    const consumers = [
      [damage.__test.findDamageSource, "source"], [aimed.__test.findMatchingAimedSource, "aimed"],
      [missile.__test.findMatchingMissileShot, "shot"], [disarm.__test.findMatchingDisarmSource, "disarm"]
    ];
    for (const [find] of consumers) {
      assert.equal(find(resultB, resultB.flags.aov.chatCard[0]).message.id, "second");
      assert.equal(find(resultA, resultA.flags.aov.chatCard[0]).message.id, "first", "out-of-order results keep their own parent");
    }
    first.flags[MODULE_ID][DAMAGE_EFFECT_SOURCE_FLAG].resolved = true;
    first.flags[MODULE_ID][DAMAGE_EFFECT_SOURCE_FLAG].createdAt = Date.now() - 1200000;
    assert.equal(damage.__test.findDamageSource(resultA, resultA.flags.aov.chatCard[0]).message.id, "first", "source markers cannot invalidate result-side proof");
    const unlinked = makeResult("unlinked", null);
    assert.equal(damage.__test.findDamageSource(unlinked, unlinked.flags.aov.chatCard[0]).reason, "unlinked-modern-source");
    assert.equal(aimed.__test.findMatchingAimedSource(unlinked, unlinked.flags.aov.chatCard[0]), null);
    const multi = makeResult("multi", first, 1);
    assert.equal(provenance.resolveDamageProvenance(multi, multi.flags.aov.chatCard[0]).resolution, "missing");
    assert.equal(provenance.resolveDamageProvenance(multi, multi.flags.aov.chatCard[1]).message.id, "first");
    resultA.flags[MODULE_ID].proneDamageRules = { sourceMessageId: "second", sourceCardIndex: 0 };
    assert.equal(provenance.resolveDamageProvenance(resultA, resultA.flags.aov.chatCard[0]).resolution, "ambiguous");
    delete resultA.flags[MODULE_ID].proneDamageRules;
    resultA.flags[MODULE_ID].combatProvenance.cards[0].sourceCardIndex = 1;
    assert.equal(provenance.resolveDamageProvenance(resultA, resultA.flags.aov.chatCard[0]).resolution, "missing");
    resultA.flags[MODULE_ID].combatProvenance = provenance.resultProvenance(first);
    messages.delete("first");
    assert.equal(damage.__test.findDamageSource(resultA, resultA.flags.aov.chatCard[0]).resolution, "missing", "deleted source must not select second");
    messages.set("first", first);
    documents.delete(token.uuid);
    assert.equal(provenance.resolveDamageProvenance(resultA, resultA.flags.aov.chatCard[0]).resolution, "missing");
    documents.set(token.uuid, token);
    first.flags[MODULE_ID][DAMAGE_EFFECT_SOURCE_FLAG].targetTokenUuid = "Scene.scene.Token.neighbor";
    assert.equal(damage.__test.findDamageSource(resultA, resultA.flags.aov.chatCard[0]).resolution, "ambiguous");
    first.flags[MODULE_ID][DAMAGE_EFFECT_SOURCE_FLAG].targetTokenUuid = token.uuid;
    assert.equal(provenance.defenseMatchesProvenance(first, defender, token), true);
    assert.equal(provenance.defenseMatchesProvenance(first, defender, { ...token, uuid: "Scene.scene.Token.neighbor" }), false);
    assert.equal(provenance.defenseMatchesProvenance(first, defender, token, 1), false);
    await assert.rejects(AoVAdapter.commitDefenseCard({ attackMessageId: "first", actorUuid: defender.uuid,
      tokenUuid: "Scene.scene.Token.deleted", actionOption: "none" }), /DefenseActorUnavailable/);
    const defensePayload = { attackMessageId: "first", actorUuid: defender.uuid, tokenUuid: token.uuid, actionOption: "none" };
    const [committed, concurrent] = await Promise.all([AoVAdapter.commitDefenseCard(defensePayload), AoVAdapter.commitDefenseCard(defensePayload)]);
    assert.equal(committed.accepted, true);
    assert.equal(concurrent.accepted, false);
    assert.equal(first.flags.aov.chatCard.length, 2);
    assert.equal(first.flags[MODULE_ID].combatProvenance.cards[1].stage, "defense");
    assert.equal(first.flags[MODULE_ID].combatProvenance.cards[1].sourceCardIndex, 0);
    const replay = await AoVAdapter.commitDefenseCard({ attackMessageId: "first", actorUuid: defender.uuid, tokenUuid: token.uuid, actionOption: "none" });
    assert.equal(replay.accepted, false);
    assert.equal(first.flags.aov.chatCard.length, 2);
    const syntheticA = { id: "shared", uuid: "Scene.scene.Token.one.Actor.shared" };
    const syntheticB = { id: "shared", uuid: "Scene.scene.Token.two.Actor.shared" };
    const tokenA = { id: "one", uuid: "Scene.scene.Token.one", actor: syntheticA };
    const tokenB = { id: "two", uuid: "Scene.scene.Token.two", actor: syntheticB };
    documents.set(tokenA.uuid, tokenA); documents.set(tokenB.uuid, tokenB);
    const tokenSource = message("tokenSource", [{ ...sourceCard, targetId: tokenA.id, targetType: "token" }], {
      combatProvenance: provenance.attackProvenance("tokenSource", { actor, weapon, targetActor: syntheticA, targetToken: tokenA })
    });
    const tokenResult = message("tokenResult", [{ ...tokenSource.flags.aov.chatCard[0], rollType: "DM" }], {
      combatProvenance: provenance.resultProvenance(tokenSource)
    });
    assert.equal(provenance.resolveDamageProvenance(tokenResult, tokenResult.flags.aov.chatCard[0]).resolution, "exact");
    tokenResult.flags.aov.chatCard[0].targetId = tokenB.id;
    assert.equal(provenance.resolveDamageProvenance(tokenResult, tokenResult.flags.aov.chatCard[0]).resolution, "ambiguous");
    assert.equal(damage.__test.pendingMatchesAppliedItem({ targetActorId: "shared", targetActorUuid: syntheticA.uuid, hitLocationId: "head" },
      { type: "wound", parent: syntheticB, system: { hitLocId: "head" } }), false, "shared base Actor IDs never cross synthetic Actors");
    const pendingEntry = { status: "pending", resolved: false, targetActorId: defender.id, targetActorUuid: defender.uuid,
      hitLocationId: "head", damageCardIndex: 0, finalDamage: 5 };
    const pendingA = message("pendingA", [{ ...sourceCard, rollType: "DM" }], { damageEffectTracking: { cards: { pending: { ...pendingEntry } } } });
    const pendingB = message("pendingB", [{ ...sourceCard, rollType: "DM" }], { damageEffectTracking: { cards: { pending: { ...pendingEntry } } } });
    await damage.__test.handleAppliedItemChange({ uuid: "Actor.defender.Item.wound", type: "wound", parent: defender, system: { hitLocId: "head", damage: 5 } });
    assert.equal(pendingA.flags[MODULE_ID].damageEffectTracking.cards.pending.resolved, false);
    assert.equal(pendingB.flags[MODULE_ID].damageEffectTracking.cards.pending.resolved, false, "indistinguishable applications never use FIFO as proof");
    const parentUpdate = second.update;
    second.update = async () => { throw new Error("parent update interrupted"); };
    const returned = makeResult("returned", null);
    const originalWarn = console.warn;
    const capturedWarnings = [];
    try {
      console.warn = (...args) => capturedWarnings.push(args);
      await prone.__test.markDamageMessage(returned.id, second, { index: 0, card: second.flags.aov.chatCard[0], sourceFlag }, { oneDieHitLocation: true });
    } finally { console.warn = originalWarn; }
    assert.equal(capturedWarnings.length, 1);
    assert.equal(provenance.resolveDamageProvenance(returned, returned.flags.aov.chatCard[0]).message.id, "second");
    second.update = parentUpdate;
    assert.equal(prone.__test.sourceFlagForDamageButton(message("defenseIndex", [{ ...sourceCard }, { ...sourceCard }],
      { proneAttackModifier: { damageRules: { oneDieHitLocation: true } } }), { dataset: { card: "1" } }), null);
    messages.clear();
    const legacyA = message("legacyA", [{ ...sourceCard }], flags("legacyA"));
    const historicalResult = makeResult("historicalResult", null);
    assert.equal(damage.__test.findDamageSource(historicalResult, historicalResult.flags.aov.chatCard[0]).resolution, "missing", "a core-native result never invents a Skjaldborg origin");
    historicalResult.flags[MODULE_ID].damageEffectTracking = { cards: { unresolved: { status: "unresolved", reason: "native-result-has-no-source" } } };
    assert.equal(damage.__test.findDamageSource(historicalResult, historicalResult.flags.aov.chatCard[0]).resolution, "missing", "new unresolved tracking must not become a legacy back door");
    historicalResult.flags[MODULE_ID].damageEffectTracking = { cards: { old: { status: "pending" } } };
    assert.equal(damage.__test.findDamageSource(historicalResult, historicalResult.flags.aov.chatCard[0]).resolution, "legacy");
    message("legacyB", [{ ...sourceCard }], flags("legacyB"));
    assert.equal(damage.__test.findDamageSource(historicalResult, historicalResult.flags.aov.chatCard[0]).resolution, "ambiguous");
    messages.delete("legacyB");
    legacyA.flags[MODULE_ID][DAMAGE_EFFECT_SOURCE_FLAG].createdAt = Date.now() - 600001;
    assert.equal(damage.__test.findDamageSource(historicalResult, historicalResult.flags.aov.chatCard[0]).resolution, "missing");
    historicalResult.flags[MODULE_ID].combatProvenance = { version: 99, cards: {} };
    assert.equal(damage.__test.findDamageSource(historicalResult, historicalResult.flags.aov.chatCard[0]).resolution, "missing");
    console.log("provenance contracts: exact card/parent identity, adjacent attacks, Token isolation, unresolved native results, historical ambiguity, defense replay, and interrupted parent writes passed");
  } finally {
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  }
}

/** Exercise hotbar update routing and ring-owned DOM listeners without a world. */
async function actionUiPlanContractTests() {
  const names = ["foundry", "game", "canvas", "ui", "document", "Hooks", "Element", "HTMLElement", "MouseEvent", "window"];
  const originals = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  class ElementFixture extends EventTarget {
    constructor(dataset = {}) {
      super();
      this.dataset = dataset;
      this.children = [];
      this.listeners = new Set();
      this.isConnected = true;
      this.classes = new Set();
      this.classList = {
        add: (...names) => names.forEach(name => this.classes.add(name)),
        remove: (...names) => names.forEach(name => this.classes.delete(name)),
        toggle: (name, enabled) => enabled ? this.classes.add(name) : this.classes.delete(name)
      };
      this.styles = new Map();
      this.style = { setProperty: (key, value) => this.styles.set(key, value) };
    }
    addEventListener(type, callback, options = {}) {
      const entry = { type, callback, capture: options.capture === true };
      this.listeners.add(entry);
      options.signal?.addEventListener("abort", () => this.listeners.delete(entry), { once: true });
      super.addEventListener(type, callback, options);
    }
    closest(selector) {
      if ((selector === "[data-action-id]" && this.dataset.actionId)
        || (selector === "[data-action]" && this.dataset.action)) return this;
      return this.parentElement?.closest(selector) ?? null;
    }
    append(child) { child.parentElement = this; this.children.push(child); return child; }
    querySelectorAll(selector) {
      return this.children.flatMap(child => [child, ...child.querySelectorAll(selector)])
        .filter(child => selector === ".collapsed" && child.classes.has("collapsed"));
    }
    replaceWith(replacement) {
      this.parentElement.regions.set(this.region, replacement);
      replacement.region = this.region;
      replacement.parentElement = this.parentElement;
    }
  }
  class MouseEventFixture extends Event {
    constructor(type, target, button = 0) {
      super(type, { cancelable: true, bubbles: true });
      this.fixtureTarget = target;
      this.button = button;
    }
    get target() { return this.fixtureTarget; }
  }
  class ApplicationFixture {
    static DEFAULT_OPTIONS = {};
    async _prepareContext() { return {}; }
    async _onRender() {}
    _onClose(options) { this.baseCloseOptions = options; }
    setPosition(position) { this.position = position; return position; }
    async close(options) { this._onClose(options); this.rendered = false; return this; }
  }
  const timers = new Map();
  let nextTimer = 0;
  const windowFixture = new ElementFixture();
  Object.assign(windowFixture, {
    innerWidth: 1024, innerHeight: 768,
    setTimeout(callback) { const id = ++nextTimer; timers.set(id, callback); return id; },
    clearTimeout(id) { timers.delete(id); }
  });
  const settings = new Map([["enableActorHotbar", true], ["actionRingMaxItems", 2], ["actionUiTheme", "aov"]]);
  const events = new Map();
  const hooks = { on(name, callback) { const listeners = events.get(name) ?? []; listeners.push(callback); events.set(name, listeners); },
    callAll(name, ...args) { for (const callback of events.get(name) ?? []) callback(...args); } };
  const settle = () => new Promise(resolve => setImmediate(resolve));
  let ActorHotbar, ActionRing;
  try {
    globalThis.Element = globalThis.HTMLElement = ElementFixture;
    globalThis.MouseEvent = MouseEventFixture;
    globalThis.window = windowFixture;
    globalThis.Hooks = hooks;
    globalThis.foundry = {
      utils: { deepClone: structuredClone },
      applications: {
        api: { ApplicationV2: ApplicationFixture, DialogV2: ApplicationFixture, HandlebarsApplicationMixin: base => base },
        handlebars: { loadTemplates: async () => {}, renderTemplate: async (_template, context) => {
          const element = new ElementFixture(); element.context = context; return element;
        } }
      }
    };
    globalThis.document = { documentElement: { clientWidth: 1024, clientHeight: 768 }, querySelectorAll: () => [], getElementById: () => null };
    globalThis.canvas = { ready: true, tokens: { controlled: [] }, clientCoordinatesFromCanvas: point => point };
    globalThis.ui = { notifications: { warn() {}, error() {} } };
    globalThis.game = { combat: null, macros: new Map(), user: { id: "reader", isGM: true },
      settings: { get: (_module, key) => settings.get(key) }, i18n: { localize: key => key, format: key => key, lang: "en" } };
    const { MODULE_ID, ACTION_CATEGORIES } = await import("../scripts/constants.mjs");
    const changed = await import("../scripts/utils/changed-paths.mjs");
    const { regionsForInvalidation } = await import("../scripts/apps/actor-hotbar/regions.mjs");
    const sorted = values => [...values].sort();
    for (const payload of [
      { flags: { [MODULE_ID]: { actorHotbarQuickAccess: [] } } },
      { [`flags.${MODULE_ID}.actorHotbarQuickAccess`]: [] },
      { [`flags.${MODULE_ID}.actorHotbarQuickAccess.0.id`]: "spear" }
    ]) {
      const parts = changed.actorHotbarPartsForActorChange(payload);
      assert.deepEqual([...parts], ["quickAccess"]);
      assert.deepEqual(regionsForInvalidation(parts), ["portraitQuickAccess"]);
    }
    for (const payload of [
      { flags: { [MODULE_ID]: { actorHotbarOrder: { combat: ["spear", "axe"] } } } },
      { [`flags.${MODULE_ID}.actorHotbarOrder.combat`]: ["spear", "axe"] },
      { [`flags.${MODULE_ID}.actorHotbarOrder.combat.0`]: "spear" },
      { flags: { [MODULE_ID]: { actorHotbarOrder: {}, actorHotbarQuickAccess: [] } } }
    ]) {
      const parts = changed.actorHotbarPartsForActorChange(payload);
      assert.deepEqual(sorted(parts), ["quickAccess", "tabBody"]);
      assert.deepEqual(sorted(regionsForInvalidation(parts)), ["portraitQuickAccess", "tabBody"]);
    }
    for (const payload of [{}, { flags: { [MODULE_ID]: { unrelated: true, quickAccess: [], actionOrder: {} } } }, { system: { description: "text" } }]) {
      assert.deepEqual([...changed.actorHotbarPartsForActorChange(payload)], []);
    }
    assert.deepEqual(sorted(changed.actorHotbarPartsForActorChange({ [`flags.${MODULE_ID}.combatOptions`]: {} })), ["weaponControls", "workflow"]);
    assert.deepEqual(sorted(changed.actorHotbarPartsForActorChange({ [`flags.${MODULE_ID}.preparedIntent`]: {} })), ["tabBody", "weaponControls", "workflow"]);
    assert.deepEqual(sorted(changed.actorHotbarPartsForActorChange({ system: { hp: { value: 5 } } })), ["resources", "wellbeing"]);
    assert.deepEqual(sorted(changed.actorHotbarPartsForItemChange({ system: { equipStatus: 1 } })), ["equipment", "quickAccess", "tabBody"]);
    assert.deepEqual(sorted(changed.actorHotbarPartsForCombatantChange({ [`flags.${MODULE_ID}.combatantState.reactionCount`]: 1 })), ["weaponControls", "workflow"]);
    assert.deepEqual(sorted(changed.actorHotbarPartsForCombatChange({ round: 4 })), ["tabBody", "weaponControls", "workflow"]);

    const catalog = await import("../scripts/ui/action-catalog.mjs");
    const expectedSlots = (...ids) => Array.from({ length: catalog.getQuickAccessCircleCount() }, (_, index) => ids[index] ?? null);
    const { PresentationCache } = await import("../scripts/ui/presentation-cache.mjs");
    const { RenderCoordinator } = await import("../scripts/ui/render-coordinator.mjs");
    ({ ActorHotbar } = await import("../scripts/apps/actor-hotbar.mjs"));
    const hotbarHooks = await import("../scripts/apps/actor-hotbar/hooks.mjs");
    let itemRolls = 0, itemSheets = 0, intentWrites = 0;
    const items = ["axe", "spear"].map(id => ({ id, uuid: `Actor.reader.Item.${id}`, name: id, type: "weapon",
      system: { equipStatus: 1, total: 80 }, async roll() { itemRolls++; }, sheet: { async render() { itemSheets++; } } }));
    items.get = id => items.find(item => item.id === id);
    const remoteFlags = {}, writerFlags = {};
    const actor = { id: "actor", uuid: "Actor.actor", documentName: "Actor", type: "character", isOwner: true, items,
      system: { abilities: { dex: { total: 12 } } }, getFlag: (_module, key) => remoteFlags[key],
      async setFlag(_module, key, value) { remoteFlags[key] = structuredClone(value); if (key === "preparedIntent") intentWrites++; return this; },
      async unsetFlag(_module, key) { delete remoteFlags[key]; if (key === "preparedIntent") intentWrites++; return this; } };
    game.user.character = actor;
    const root = new ElementFixture();
    root.regions = new Map(["portraitQuickAccess", "tabBody", "resources", "headerEffects", "combatWorkflow"].map(region => {
      const element = new ElementFixture(); element.region = region; element.parentElement = root; return [region, element];
    }));
    const actions = () => PresentationCache.get(actor, "actions", () => catalog.prepareActorActions(actor));
    let fullRenders = 0, captures = 0, restores = 0, preparations = 0;
    const view = Object.assign(Object.create(ActorHotbar.prototype), {
      actor, rendered: true, element: root, tabGroups: { sheet: "skills" }, position: { left: 80, top: 90 },
      _clampCurrentPosition() {}, async render() { fullRenders++; }, async _prepareContext() { return { actor }; },
      async _prepareRegionContext(region) {
        preparations++;
        return { region, actions: actions().weapons.map(action => action.id),
          quick: catalog.prepareActorQuickAccess(actor, { prepared: actions(), statGroups: [] }).slots.map(slot => slot.action?.id ?? null) };
      },
      _currentRegionElement: region => root.regions.get(region), _regionElementFromHtml: element => element,
      _captureScrollPositions() { captures++; }, _restoreScrollPositions() { restores++; }, _syncRenderedWeaponControls() {}, _assertHotbarInvariants() {}
    });
    ActorHotbar.current = view;
    hotbarHooks.registerActorHotbarHooks(ActorHotbar, hooks);
    hotbarHooks.registerActorHotbarHooks(ActorHotbar, hooks);
    assert.equal(events.get("updateActor").length, 1);
    await RenderCoordinator.flush(); // Clear the initial full-render request and earlier combat fixtures.
    fullRenders = 0;
    const writer = { getFlag: (_module, key) => writerFlags[key], async setFlag(_module, key, value) {
      writerFlags[key] = structuredClone(value);
      remoteFlags[key] = structuredClone(value);
      hooks.callAll("updateActor", actor, { flags: { [MODULE_ID]: { [key]: value } } }, {}, "writer");
      return this;
    } };
    assert.deepEqual(actions().weapons.map(action => action.id), ["axe", "spear"]);
    assert.deepEqual(catalog.prepareActorQuickAccess(actor).slots.map(slot => slot.action?.id ?? null), expectedSlots("axe", "spear"));
    const resources = root.regions.get("resources");
    await catalog.persistActionOrder(writer, "combat", ["spear", "axe", "spear"]);
    await RenderCoordinator.flush();
    assert.deepEqual(writerFlags.actorHotbarOrder.combat, ["spear", "axe"], "saved sorting remains normalized by the existing helper");
    assert.deepEqual(root.regions.get("tabBody").context.actions, ["spear", "axe"]);
    assert.deepEqual(root.regions.get("portraitQuickAccess").context.quick, expectedSlots("spear", "axe"), "remote order updates refresh fallback slots");
    assert.equal(root.regions.get("resources"), resources);
    const actionBody = root.regions.get("tabBody");
    await catalog.persistActorQuickAccess(writer, [{ kind: "item", id: "axe" }, null]);
    await RenderCoordinator.flush();
    assert.deepEqual(root.regions.get("portraitQuickAccess").context.quick, expectedSlots("axe"));
    assert.equal(writerFlags.actorHotbarQuickAccess.length, 12);
    assert.equal(root.regions.get("tabBody"), actionBody, "quick-slot updates do not replace the action body");
    await catalog.persistActionOrder(writer, "combat", ["axe", "spear"]);
    await RenderCoordinator.flush();
    assert.deepEqual(root.regions.get("portraitQuickAccess").context.quick, expectedSlots("axe"), "custom slots survive a reorder");
    const beforeCombined = preparations;
    hooks.callAll("updateActor", actor, { [`flags.${MODULE_ID}.actorHotbarOrder`]: {}, [`flags.${MODULE_ID}.actorHotbarQuickAccess`]: [] }, {}, "reader");
    await RenderCoordinator.flush();
    assert.equal(preparations - beforeCombined, 2, "both flags share one union of two regions");
    const beforeIgnored = preparations;
    for (const changedActor of [{ ...actor, id: "unrelated" }, actor]) {
      hooks.callAll("updateActor", changedActor, changedActor.id === actor.id ? {} : { [`flags.${MODULE_ID}.actorHotbarOrder`]: {} });
    }
    hooks.callAll("updateActor", actor, { [`flags.${MODULE_ID}.unrelated`]: true });
    await RenderCoordinator.flush();
    assert.equal(preparations, beforeIgnored, "other Actors and unrelated/empty updates do not refresh this view");
    assert.equal(fullRenders, 0, "known regions never fall back to a shell render");
    assert.equal(captures, restores);
    assert.equal(ActorHotbar.current, view);
    assert.equal(view.tabGroups.sheet, "skills");
    await ActorHotbar.renderInvalidated({ parts: ["unknown-region"] });
    assert.equal(fullRenders, 1, "unknown regions retain the safe full-render fallback");
    assert.deepEqual(sorted(hotbarHooks.actorHotbarPartsForActiveEffect({ statuses: new Set(["prone"]) })), ["effects", "workflow"]);
    await maintenanceHotbarContractTests({ ActorHotbar, view, actor, hooks, PresentationCache, RenderCoordinator });

    const ringModule = await import("../scripts/apps/action-ring.mjs");
    ({ ActionRing } = ringModule);
    const token = { actor, center: { x: 400, y: 300 } };
    await catalog.persistActorQuickAccess(writer, [{ kind: "item", id: "spear" }]);
    await RenderCoordinator.flush();
    assert.deepEqual((await new ActionRing({ token })._prepareContext({})).actions.map(action => action.id), ["spear"],
      "a newly opened ring reads the latest saved slots without another watcher");
    const makeRing = () => {
      const ring = new ActionRing({ token });
      ring.element = new ElementFixture(); ring.rendered = true;
      const action = ring.element.append(new ElementFixture({ action: "activate", actionKind: "item", actionId: "axe" }));
      const icon = action.append(new ElementFixture()); action.classList.add("collapsed");
      return { ring, action, icon };
    };
    let { ring, action, icon } = makeRing();
    ActionRing.current = ring;
    let primaryCaptures = 0;
    ring._onActionCapturePointerDown = event => { primaryCaptures++; return ActionRing.prototype._onActionCapturePointerDown.call(ring, event); };
    await ring._onRender({}, {});
    assert.equal(ring.element.listeners.size, 4);
    assert.equal([...ring.element.listeners].filter(listener => listener.capture).length, 3);
    const firstTimer = timers.get(ring._expandTimeout);
    await ring._onRender({}, {});
    settings.set("actionUiTheme", "classic");
    await ring._onRender({}, {});
    assert.equal(ring.element.listeners.size, 4, "three renders retain one set of root listeners");
    assert.equal(ring.element.classes.has("skj-theme-classic"), true);
    assert.equal(ring.element.classes.has("skj-theme-aov"), false);
    assert.equal(ring.element.styles.get("left"), "234px");
    assert.equal(ring.element.styles.get("top"), "134px");
    firstTimer();
    assert.equal(action.classes.has("collapsed"), true, "an earlier same-root timer cannot expand a newer render");
    ring.element.dispatchEvent(new MouseEventFixture("pointerdown", icon));
    assert.equal(primaryCaptures, 1);
    assert.equal(ActionRing.current, ring, "a primary action press is not background dismissal");
    for (const type of ["pointerdown", "auxclick"]) {
      const event = new MouseEventFixture(type, icon, 2);
      ring.element.dispatchEvent(event);
      assert.equal(event.defaultPrevented, true);
    }
    assert.equal(itemRolls, 0);
    assert.equal(itemSheets, 0);
    ring.element.dispatchEvent(new MouseEventFixture("pointerdown", ring.element, 2));
    assert.equal(ActionRing.current, ring, "secondary background presses retain their existing non-dismissal behavior");
    const oldRoot = ring.element, oldTimer = timers.get(ring._expandTimeout);
    const replacement = new ElementFixture();
    const replacementAction = replacement.append(new ElementFixture({ action: "activate", actionKind: "item", actionId: "axe" }));
    replacementAction.classList.add("collapsed");
    ring.element = replacement;
    await ring._onRender({}, {});
    assert.equal(oldRoot.listeners.size, 0);
    assert.equal(replacement.listeners.size, 4);
    const beforeOldEvent = primaryCaptures;
    oldRoot.dispatchEvent(new MouseEventFixture("pointerdown", icon));
    oldTimer();
    assert.equal(primaryCaptures, beforeOldEvent, "old-root events have no listeners after replacement");
    assert.equal(replacementAction.classes.has("collapsed"), true);
    const expand = timers.get(ring._expandTimeout);
    timers.delete(ring._expandTimeout); expand();
    assert.equal(replacementAction.classes.has("collapsed"), false, "the current root still expands normally");
    const contextEvent = new MouseEventFixture("contextmenu", replacementAction, 2);
    replacement.dispatchEvent(contextEvent);
    await settle();
    assert.equal(contextEvent.defaultPrevented, true);
    assert.equal(itemSheets, 1, "right-click opens Item details exactly once");
    assert.equal(itemRolls, 0);
    assert.equal(ActionRing.current, null);
    assert.equal(replacement.listeners.size, 0);
    assert.equal(ring._delegatedControlsRoot, null);
    assert.equal(ring._delegatedControlsAbort, null);
    assert.deepEqual(ring.baseCloseOptions, { animate: false });
    replacement.dispatchEvent(new MouseEventFixture("contextmenu", replacementAction, 2));
    await settle();
    assert.equal(itemSheets, 1, "closed-root events cannot run stale actions");

    ({ ring, action, icon } = makeRing()); ActionRing.current = ring;
    await ring._onRender({}, {});
    await ActionRing.onActivate.call(ring, new MouseEventFixture("click", icon), action);
    assert.equal(itemRolls, 1, "primary activation executes the existing Item action once");
    assert.equal(ring.element.listeners.size, 0);
    ({ ring, action } = makeRing()); ActionRing.current = ring;
    await ring._onRender({}, {});
    await ActionRing.onActivate.call(ring, new MouseEventFixture("click", action, 2), action);
    assert.equal(itemRolls, 1, "secondary activation never rolls an Item");
    assert.equal(ActionRing.current, ring);
    await ActionRing.closeAll();
    const { AoVAdapter } = await import("../scripts/adapter/aov-adapter.mjs");
    const originalStatCheck = AoVAdapter.executeAovActorStatCheck;
    let statChecks = 0, macros = 0;
    try {
      AoVAdapter.executeAovActorStatCheck = async (source, detail) => {
        assert.equal(source, actor); assert.deepEqual(detail, { property: "ability", characteristic: "dex" }); statChecks++;
      };
      game.macros.set("macro", { async execute() { macros++; } });
      for (const [kind, id] of [["stat", "ability:dex"], ["macro", "macro"]]) {
        ({ ring, action } = makeRing()); ActionRing.current = ring;
        action.dataset.actionKind = kind; action.dataset.actionId = id;
        await ring._onRender({}, {});
        await ActionRing.onActivate.call(ring, new MouseEventFixture("click", action), action);
        assert.equal(ActionRing.current, null);
      }
      assert.equal(statChecks, 1);
      assert.equal(macros, 1);
    } finally { AoVAdapter.executeAovActorStatCheck = originalStatCheck; }
    ({ ring, action } = makeRing()); ActionRing.current = ring;
    action.dataset.actionKind = "intent"; action.dataset.actionId = ACTION_CATEGORIES.ATTACK;
    await ring._onRender({}, {});
    ring.element.dispatchEvent(new MouseEventFixture("contextmenu", action, 2));
    await settle();
    assert.equal(intentWrites, 1, "right-click intent keeps its distinct declaration behavior");
    assert.equal(remoteFlags.preparedIntent.actionCategory, ACTION_CATEGORIES.ATTACK);
    assert.equal(itemRolls, 1);
    ({ ring, action } = makeRing()); ActionRing.current = ring;
    action.dataset.actionKind = "intent"; action.dataset.actionId = ACTION_CATEGORIES.ATTACK;
    await ring._onRender({}, {});
    ring.element.dispatchEvent(new MouseEventFixture("contextmenu", action, 2));
    await settle();
    assert.equal(intentWrites, 2);
    assert.equal(remoteFlags.preparedIntent, undefined, "the next intent context action clears that declaration once");
    ({ ring, action } = makeRing()); ActionRing.current = ring;
    await ring._onRender({}, {});
    const closeTimer = timers.get(ring._expandTimeout), closeRoot = ring.element;
    closeRoot.dispatchEvent(new MouseEventFixture("pointerdown", closeRoot));
    await settle();
    assert.equal(ActionRing.current, null, "primary background press dismisses the ring");
    assert.equal(closeRoot.listeners.size, 0);
    const newRing = makeRing(); ActionRing.current = newRing.ring;
    await newRing.ring._onRender({}, {});
    closeTimer();
    assert.equal(newRing.action.classes.has("collapsed"), true, "a closed ring's timer cannot touch a new instance");
    await ActionRing.closeAll();

    const beforeHookCounts = new Map([...events].map(([name, callbacks]) => [name, callbacks.length]));
    const beforeResizeCount = [...windowFixture.listeners].filter(listener => listener.type === "resize").length;
    ringModule.registerActionRingHooks(hooks);
    ringModule.registerActionRingHooks(hooks);
    for (const name of ["renderTokenHUD", "canvasPan", "controlToken", "canvasTearDown"]) {
      assert.equal(events.get(name).length - (beforeHookCounts.get(name) ?? 0), 1);
    }
    assert.equal([...windowFixture.listeners].filter(listener => listener.type === "resize").length - beforeResizeCount, 1);
    ({ ring } = makeRing()); ActionRing.current = ring;
    let positions = 0;
    const setPosition = ring.setPosition.bind(ring);
    ring.setPosition = (...args) => { positions++; return setPosition(...args); };
    for (let index = 0; index < 3; index++) await ring._onRender({}, {});
    assert.equal(positions, 3, "theme and positioning still run on every render");
    windowFixture.dispatchEvent(new Event("resize"));
    assert.equal(positions, 4, "resize has one global positioning handler after repeated renders");
    await ActionRing.closeAll();
    for (const name of ["canvasPan", "controlToken", "canvasTearDown"]) {
      ({ ring } = makeRing()); ActionRing.current = ring;
      await ring._onRender({}, {});
      hooks.callAll(name);
      await settle();
      assert.equal(ActionRing.current, null);
      assert.equal(ring.element.listeners.size, 0);
    }
    await RenderCoordinator.flush();
    console.log("action UI contracts: saved-action synchronization, targeted regions, fallback/custom slots, ring root lifetime, input routing, and timer cleanup passed");
  } finally {
    if (ActionRing?.current) await ActionRing.closeAll();
    if (ActorHotbar) ActorHotbar.current = null;
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  }
}

/** Exercise the existing combat boundaries with throwaway document fixtures. */
async function combatPlanContractTests() {
  const globalNames = ["foundry", "game", "canvas", "ui", "CONFIG", "fromUuid", "HTMLFormElement", "FormData", "document", "Hooks"];
  const originalGlobals = new Map(globalNames.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const clone = value => structuredClone(value);
  const merge = (source, patch) => {
    const result = clone(source);
    for (const [key, value] of Object.entries(patch)) {
      result[key] = value && typeof value === "object" && !Array.isArray(value)
        && result[key] && typeof result[key] === "object" && !Array.isArray(result[key])
        ? merge(result[key], value) : clone(value);
    }
    return result;
  };
  class ApplicationFixture { static DEFAULT_OPTIONS = {}; }
  const messages = new Map();
  const uuidDocuments = new Map();
  let randomId = 0;
  globalThis.foundry = {
    utils: { deepClone: clone, mergeObject: merge, randomID: () => `fixture-${++randomId}` },
    applications: { api: {
      DialogV2: ApplicationFixture,
      ApplicationV2: ApplicationFixture,
      HandlebarsApplicationMixin: base => base
    } }
  };
  globalThis.game = {
    user: { id: "gm", isGM: true },
    users: new Map(),
    messages,
    settings: { get: () => undefined },
    i18n: { localize: key => key, format: key => key, lang: "en" }
  };
  globalThis.canvas = { scene: { grid: { distance: 5, units: "ft" } }, tokens: { placeables: [] } };
  globalThis.ui = { notifications: { warn() {}, error() {}, info() {} } };
  globalThis.CONFIG = { ActiveEffect: {} };
  globalThis.Hooks = { callAll() {} };
  globalThis.document = { createElement: () => ({ textContent: "", get innerHTML() { return this.textContent; } }) };
  globalThis.fromUuid = async uuid => uuidDocuments.get(uuid) ?? null;
  globalThis.HTMLFormElement = class {};
  globalThis.FormData = class {
    constructor(form) { this.values = form?.values ?? { weaponId: "deleted-weapon" }; }
    get(name) { const value = this.values[name]; return Array.isArray(value) ? value[0] ?? null : value ?? null; }
    getAll(name) { const value = this.values[name]; return Array.isArray(value) ? value : value === undefined ? [] : [value]; }
  };
  let restoreAdapter = () => undefined;
  try {
    const { MODULE_ID, EVADING_STATUS_ID, GRAPPLED_STATUS_ID } = await import("../scripts/constants.mjs");
    const { AoVAdapter } = await import("../scripts/adapter/aov-adapter.mjs");
    const batchWorkflow = AoVAdapter.rollDialogCombatWorkflowBatch;
    restoreAdapter = () => { AoVAdapter.rollDialogCombatWorkflowBatch = batchWorkflow; };
    const state = await import("../scripts/combat/state.mjs");
    const resolution = await import("../scripts/combat/resolution-queue.mjs");
    const actor = {
      id: "actor", uuid: "Actor.actor", name: "Actor", type: "character", items: [], effects: [],
      system: { hp: { max: 10 }, abilities: { dex: { total: 12 }, int: { total: 10 } } },
      getFlag: () => undefined
    };
    const makeCombat = () => {
      let combatState = {};
      const combatantState = state.defaultCombatantState();
      combatantState.intent.status = "committed";
      combatantState.movement = { ...combatantState.movement, planStatus: "completed", distance: 10 };
      const combatant = {
        id: "combatant", name: "Actor", actor, initiative: 20,
        getFlag: () => combatantState
      };
      const combat = {
        id: "combat", uuid: "Combat.combat", round: 4, turn: 0, combatants: [combatant], writes: [],
        getFlag: () => combatState,
        async setFlag(_scope, _key, data) { combatState = data; },
        async updateEmbeddedDocuments(name, updates, options) {
          combat.writes.push({ name, updates: clone(updates), options: clone(options) });
          if (combat.fail) throw new Error("cancelled document write");
          for (const update of updates) {
            Object.assign(combatantState, update[`flags.${MODULE_ID}.combatantState`] ?? {});
            if (Object.hasOwn(update, "initiative")) combatant.initiative = update.initiative;
          }
          return [combatant];
        }
      };
      combatant.parent = combat;
      return { combat, combatant, combatantState };
    };
    for (const operation of [resolution.applyMovementDexResults, resolution.buildResolutionQueue,
      combat => resolution.refreshImmediateResolutionActions(combat, combat.combatants[0])]) {
      const fixture = makeCombat();
      await operation(fixture.combat);
      assert.equal(fixture.combat.writes.length, 1, "DEX and initiative share one embedded update");
      const write = fixture.combat.writes[0];
      assert.equal(write.updates[0].initiative, fixture.combatantState.dexLedger.projectedInitiative);
      assert.equal(write.options.turnEvents, false);
      assert.equal(write.options.combatTurn, 0);
      const rejected = makeCombat();
      rejected.combat.fail = true;
      await assert.rejects(operation(rejected.combat), /cancelled document write/);
      assert.equal(rejected.combatant.initiative, 20);
      assert.equal(rejected.combatantState.dexLedger, null);
    }
    const unchanged = makeCombat();
    await resolution.applyMovementDexResults(unchanged.combat);
    unchanged.combat.writes.length = 0;
    await resolution.buildResolutionQueue(unchanged.combat);
    assert.equal(Object.hasOwn(unchanged.combat.writes[0].updates[0], "initiative"), false);
    const movementWrite = makeCombat();
    await resolution.applyMovementDexResults(movementWrite.combat);
    assert.equal(movementWrite.combat.writes[0].options[MODULE_ID].movementDexProjection, true);

    const effects = await import("../scripts/compat/active-effects.mjs");
    assert.equal(await effects.safeDeleteActiveEffect({ id: "effect", delete: async () => undefined }), false);
    assert.equal(await effects.safeDeleteActiveEffect({ id: "effect", delete: async () => ({ id: "effect" }) }), true);
    const grapple = await import("../scripts/combat/grapple-automation.mjs");
    const pair = { attackerActorUuid: "Actor.source", targetActorUuid: actor.uuid, statusId: GRAPPLED_STATUS_ID };
    const hold = {
      statuses: new Set([GRAPPLED_STATUS_ID]),
      flags: { [MODULE_ID]: { grapple: { sourceActorUuid: pair.attackerActorUuid, targetActorUuid: actor.uuid } } }
    };
    assert.equal(grapple.isMatchingGrappleEffect(hold, pair), true);
    for (const inactive of [{ ...hold, disabled: true }, { ...hold, isSuppressed: true }, { ...hold, active: false }]) {
      assert.equal(grapple.isMatchingGrappleEffect(inactive, pair), false);
      assert.equal(grapple.isMatchingGrappleEffect(inactive, { ...pair, activeOnly: false }), true);
      assert.equal(grapple.isMatchingGrappleEffect(inactive, { ...pair, activeOnly: false, attackerActorUuid: "Actor.other" }), false);
    }
    const evade = await import("../scripts/combat/evade-status.mjs");
    const expired = {
      id: "evading", statuses: new Set([EVADING_STATUS_ID]), disabled: true, isSuppressed: true,
      flags: { [MODULE_ID]: { managedEvading: true, evade: { combatId: "combat", expiresAtLogicalRound: 2 } } }
    };
    assert.equal(evade.__test.evadingEffectExpired(expired, { id: "combat" }, 2), true);
    assert.equal(evade.__test.evadingEffectExpired(expired, { id: "other" }, 2), false);
    assert.equal(evade.__test.evadingEffectExpired(expired, { id: "combat" }, 1), false);
    expired.delete = async () => undefined;
    const evadingActor = { id: "evader", uuid: "Actor.evader", effects: [expired] };
    const evadeCombat = { id: "combat", round: 4, combatants: [{ actor: evadingActor }] };
    assert.equal(await evade.removeExpiredEvadingEffects(evadeCombat), 0, "cancelled deletion is not counted");
    expired.delete = async () => expired;
    assert.equal(await evade.removeExpiredEvadingEffects(evadeCombat), 1, "default expiry uses the current logical round");
    const damageTracking = await import("../scripts/combat/damage-effect-tracking.mjs");
    const impaledItem = { id: "location", name: "Arm", documentName: "Item", effects: [],
      async createEmbeddedDocuments(_name, data) {
        const created = data.map(source => ({ ...source,
          async update(patch) {
            for (const [path, value] of Object.entries(patch)) {
              if (path === `flags.${MODULE_ID}.impalement`) this.flags[MODULE_ID].impalement = clone(value);
            }
            return this;
          }
        }));
        this.effects.push(...created);
        return created;
      }
    };
    const impaleRequest = { card: { rollVal: 5, successLevel: "3" }, index: 0, targetActor: actor,
      attackerActor: actor, weapon: { id: "spear", uuid: "Actor.actor.Item.spear", name: "Spear", system: {} },
      targetItem: impaledItem, stuckIn: "hitLocation" };
    await damageTracking.__test.applyImpaledEffect({ ...impaleRequest, message: { id: "damage-first" } });
    await damageTracking.__test.applyImpaledEffect({ ...impaleRequest, message: { id: "damage-second" } });
    assert.equal(impaledItem.effects.length, 2, "independent impales on one location retain their own source records");
    await damageTracking.__test.applyImpaledEffect({ ...impaleRequest, message: { id: "damage-second" } });
    assert.equal(impaledItem.effects.length, 2, "retrying a damage card updates only its own impale");
    assert.equal(impaledItem.effects[0].flags[MODULE_ID].impalement.damageMessageId, "damage-first");

    const { AttackRollDialog } = await import("../scripts/apps/attack-roll-dialog.mjs");
    const { MissileRollDialog } = await import("../scripts/apps/missile-roll-dialog.mjs");
    const kernel = await import("../scripts/combat/rule-kernel.mjs");
    const tokenA = { uuid: "Scene.scene.Token.a" };
    const tokenB = { uuid: "Scene.scene.Token.b" };
    const scopedData = { active: true, actorUuid: "Actor.evader", tokenUuid: tokenA.uuid,
      combatId: "evade-combat", combatantId: "evader-a", expiresAtLogicalRound: 3 };
    const scopedEffect = { statuses: new Set([EVADING_STATUS_ID]),
      flags: { [MODULE_ID]: { managedEvading: true, evade: scopedData } } };
    const sharedActor = { uuid: scopedData.actorUuid, effects: [scopedEffect], items: [], system: {} };
    tokenA.actor = sharedActor;
    tokenB.actor = sharedActor;
    game.combats = new Map([[scopedData.combatId, { id: scopedData.combatId, round: 4 }]]);
    const condition = (workflowType, token = tokenA) => kernel.prepareAttackContext(kernel.createCombatRuleContext({
      workflowType, attackerActor: actor, targetActor: sharedActor, targetToken: token
    }));
    assert.equal(condition("missile").evadingModifier, -40);
    assert.equal(condition("melee").evadingModifier, 0);
    assert.equal(condition("missile", tokenB).evadingModifier, 0, "one linked Token's declaration does not apply to another");
    for (const inactive of ["disabled", "isSuppressed"]) {
      scopedEffect[inactive] = true;
      assert.equal(condition("missile").evadingModifier, 0);
      delete scopedEffect[inactive];
    }
    game.combats.get(scopedData.combatId).round = 6;
    assert.equal(condition("missile").evadingModifier, 0, "expired declarations do not depend on cleanup timing");
    game.combats.get(scopedData.combatId).round = 4;
    sharedActor.effects.unshift({ ...scopedEffect, flags: { [MODULE_ID]: { managedEvading: true,
      evade: { ...scopedData, expiresAtLogicalRound: 2 } } } });
    assert.equal(condition("missile").evadingModifier, -40, "an expired duplicate cannot mask a current declaration");
    assert.equal(evade.__test.sameEvadeSource(scopedEffect, scopedData), true);
    assert.equal(evade.__test.sameEvadeSource(scopedEffect, { ...scopedData, tokenUuid: tokenB.uuid }), false);
    assert.equal(evade.__test.sameEvadeSource(scopedEffect, { ...scopedData, combatantId: "another" }), false);
    assert.equal(evade.__test.sameEvadeSource({ ...scopedEffect, flags: { [MODULE_ID]: { evade: scopedData } } }, scopedData), false,
      "a manual status is never adopted as a managed source");
    assert.equal(evade.__test.evadingEffectExpired({ ...expired, flags: { [MODULE_ID]: { evade: scopedData } } }, { id: scopedData.combatId }, 10), false,
      "expiry never removes an unmanaged manual source");
    const sourceActor = { id: "source-scoped", uuid: "Actor.source-scoped", effects: [] };
    const sourceCombat = { id: "sources", round: 4 };
    const sourceCombatant = (id, tokenUuid) => ({ id, actor: sourceActor, token: { uuid: tokenUuid, actor: sourceActor } });
    const makeEffect = data => ({ ...clone(data), id: `effect-${++randomId}`,
      async update(patch) {
        for (const [path, value] of Object.entries(patch)) {
          if (path.startsWith(`flags.${MODULE_ID}.`)) this.flags[MODULE_ID][path.slice(`flags.${MODULE_ID}.`.length)] = clone(value);
          else this[path] = clone(value);
        }
        return this;
      },
      async delete() { sourceActor.effects = sourceActor.effects.filter(effect => effect !== this); return this; }
    });
    sourceActor.createEmbeddedDocuments = async (_name, data) => {
      const created = data.map(makeEffect);
      sourceActor.effects.push(...created);
      return created;
    };
    CONFIG.ActiveEffect.documentClass = class {};
    const manualEvade = makeEffect({ statuses: [EVADING_STATUS_ID], flags: { [MODULE_ID]: {} } });
    sourceActor.effects.push(manualEvade);
    const declaredA = await evade.activateEvadingForActor(sourceActor, { combat: sourceCombat, combatant: sourceCombatant("a", tokenA.uuid) });
    const declaredB = await evade.activateEvadingForActor(sourceActor, { combat: sourceCombat, combatant: sourceCombatant("b", tokenB.uuid) });
    const refreshedA = await evade.activateEvadingForActor(sourceActor, { combat: sourceCombat, combatant: sourceCombatant("a", tokenA.uuid) });
    assert.equal(refreshedA.effectId, declaredA.effectId);
    assert.notEqual(declaredA.effectId, declaredB.effectId);
    assert.equal(sourceActor.effects.length, 3, "refresh preserves the other Token declaration and manual status");
    assert.equal(sourceActor.effects.includes(manualEvade), true);
    const scopedHold = { ...hold, flags: { [MODULE_ID]: { grapple: {
      ...hold.flags[MODULE_ID].grapple, sourceTokenUuid: tokenA.uuid, targetTokenUuid: tokenB.uuid
    } } } };
    assert.equal(grapple.isMatchingGrappleEffect(scopedHold, { ...pair, attackerTokenUuid: tokenA.uuid, targetTokenUuid: tokenB.uuid }), true);
    assert.equal(grapple.isMatchingGrappleEffect(scopedHold, { ...pair, attackerTokenUuid: tokenB.uuid, targetTokenUuid: tokenA.uuid }), false);
    assert.equal(grapple.isMatchingGrappleEffect(hold, { ...pair, attackerTokenUuid: tokenA.uuid }), false,
      "legacy Actor-only data cannot silently satisfy an exact Token hold");
    const missileWeapon = { id: "bow", type: "weapon", system: { total: 100, weaponType: "missile", damage: "1D6" } };
    const missile = Object.create(MissileRollDialog.prototype);
    Object.assign(missile, { actor, weapon: missileWeapon, weaponId: missileWeapon.id,
      targetActor: sharedActor, targetToken: tokenA, activeTargetKey: "a", damageTypeSelections: new Map(), targetOptionValues: new Map(),
      _getAvailableWeapon: () => missileWeapon, _readSplitAttackState: () => ({ enabled: false, forced: false, valid: true }) });
    actor.effects.push({ statuses: new Set(["prone"]) });
    const missileForm = { values: { situationalModifier: "20", augmentOptions: ["range", "intoMelee"],
      missileRangeBand: "medium", combatantCount: "2" } };
    const missileState = missile._readFormState(missileForm, { key: "a", actor: sharedActor, token: tokenA });
    assert.equal(missileState.proneModifier, -40);
    assert.equal(missileState.evadingModifier, -40);
    assert.equal(missileState.targetNumber, 10, "(100 + 20 - 40 - 40) × 0.5 ÷ 2 preserves modifier order");
    assert.equal(missile._readFormState(missileForm, { key: "b", actor: sharedActor, token: tokenB }).targetNumber, 20,
      "target changes rebuild condition contributions from that Token");
    scopedEffect.disabled = true;
    assert.equal(missile._readFormState(missileForm, { key: "a", actor: sharedActor, token: tokenA }).targetNumber, 20,
      "submit reads current effect activity rather than the old preview");
    delete scopedEffect.disabled;
    actor.effects.length = 0;
    const submitted = { ...missileState, coreOptions: { checkBonus: 5 }, actorUuid: "Actor.secret", notes: "private GM note" };
    const flatModifier = AoVAdapter.__testAttackFlatModifier(submitted, missileWeapon);
    assert.equal(flatModifier, -85);
    const { refreshRuntimeSetting, runtimeSettings } = await import("../scripts/runtime-settings.mjs");
    const { performanceDiagnostics } = await import("../scripts/performance/performance-monitor.mjs");
    const originalDiagnostics = runtimeSettings.performanceDiagnostics;
    const originalDebug = runtimeSettings.debug;
    try {
      refreshRuntimeSetting("performanceDiagnostics", false);
      refreshRuntimeSetting("debug", false);
      performanceDiagnostics.reset();
      kernel.recordCombatRuleTrace(submitted, { flatModifier, encumbrance: -5, targetNumber: 10 });
      assert.equal(kernel.combatRuleDiagnostics(), null);
      assert.equal(performanceDiagnostics.report().metadata.measureCount, 0, "default play records no attribution");
      refreshRuntimeSetting("performanceDiagnostics", true);
      kernel.recordCombatRuleTrace(submitted, { flatModifier, encumbrance: -5, targetNumber: 10 });
      const report = kernel.combatRuleDiagnostics();
      assert.equal(report.last.detail.submitted.targetNumber, 10);
      assert.equal(report.last.detail.submitted.additive.evadingModifier, -40);
      assert.equal(report.last.detail.committed.targetNumber, 10);
      assert.equal(report.last.detail.coreCheckBonus, 5);
      assert.equal(report.last.detail.providers.find(provider => provider.id === "evading-target").values.evadingModifier, -40);
      assert.doesNotMatch(JSON.stringify(report), /Actor\.secret|private GM note|Scene\.scene|Actor\.evader/);
      game.user.isGM = false;
      kernel.recordCombatRuleTrace(submitted, { flatModifier: 999 });
      assert.equal(kernel.combatRuleDiagnostics(), null, "players cannot read GM attribution");
      assert.equal(performanceDiagnostics.report().measures["combat.ruleAttribution"].count, 1);
      game.user.isGM = true;
      for (let index = 0; index < 55; index++) kernel.recordCombatRuleTrace(submitted, { flatModifier });
      assert.equal(kernel.combatRuleDiagnostics().count, 50, "existing bounded diagnostic retention is reused");
      const cycle = [];
      cycle.push(cycle);
      assert.doesNotThrow(() => JSON.stringify(kernel.serializeCombatRuleReports([cycle, { finite: 10, invalid: Infinity, document: actor }])));
      assert.deepEqual(kernel.serializeCombatRuleReports([{ finite: 10, invalid: Infinity, document: actor }]), [{ finite: 10 }]);
    } finally {
      game.user.isGM = true;
      refreshRuntimeSetting("performanceDiagnostics", originalDiagnostics);
      refreshRuntimeSetting("debug", originalDebug);
      performanceDiagnostics.reset();
    }
    const attack = Object.create(AttackRollDialog.prototype);
    Object.assign(attack, { actor, availableWeaponIds: [], weapon: { id: "deleted-weapon", system: { total: 80 } },
      targetOptionValues: new Map(), damageTypeSelections: new Map(), targetSnapshots: [], activeTargetKey: "" });
    assert.equal(attack._readFormState({}).weapon, null, "a deleted weapon cannot fall back to its stale document");
    for (const Dialog of [AttackRollDialog, MissileRollDialog]) {
      let submissions = 0;
      let finish;
      const workflow = new Promise(resolve => { finish = resolve; });
      AoVAdapter.rollDialogCombatWorkflowBatch = async () => { submissions++; return workflow; };
      const dialog = Object.create(Dialog.prototype);
      Object.assign(dialog, { actor, targetSnapshots: [{}],
        _captureForm() {}, _activeTarget: () => ({}),
        _readFormState: () => ({ weapon: {}, splitAttack: { valid: true } }),
        _buildDamageContext: () => ({}), _buildPayload: () => ({}), async close() {} });
      const form = new HTMLFormElement();
      const pendingSubmission = dialog._submit(form);
      assert.equal(await dialog._submit(form), null, "a second click cannot submit an in-flight dialog again");
      finish([{ started: true }]);
      assert.notEqual(await pendingSubmission, null);
      assert.equal(submissions, 1);
      assert.equal(dialog._submitting, false);
    }

    const targetQueue = await import("../scripts/combat/dialog-target-queue.mjs");
    let splitData = { actorUuid: actor.uuid, secondChance: 50, sourceWorkflow: "attack", resolved: false };
    const source = { id: "split", getFlag: (_scope, flag) => flag === "splitAttack" ? splitData : null,
      async update(data) { splitData = clone(data[`flags.${MODULE_ID}.splitAttack`]); } };
    messages.set(source.id, source);
    uuidDocuments.set(actor.uuid, actor);
    const originalShow = AttackRollDialog.show;
    try {
      AttackRollDialog.show = async () => ({});
      await targetQueue.__test.resolveSplitAttack(source);
      assert.equal(splitData.resolved, false, "opening and closing a split dialog is not a commit");
    } finally { AttackRollDialog.show = originalShow; }
    const linked = (id, tokenUuid) => ({ id, getFlag: (_scope, flag) => flag === "combatCardBatch"
      ? { sourceMessageId: source.id, actorUuid: actor.uuid, targetTokenUuid: tokenUuid } : null });
    messages.set("first", linked("first", "Scene.scene.Token.first"));
    const sourceUpdate = source.update;
    source.update = async () => { throw new Error("prompt update failed"); };
    await assert.rejects(targetQueue.completeSplitAttack(source.id), /prompt update failed/);
    assert.equal(splitData.resolved, false);
    source.update = sourceUpdate;
    assert.equal(await targetQueue.completeSplitAttack(source.id), true, "creation-time link survives a failed prompt update");
    messages.set("second", linked("second", "Scene.scene.Token.second"));
    assert.equal(await targetQueue.completeSplitAttack(source.id), true);
    assert.deepEqual(splitData.resultMessageIds, ["first", "second"]);
    assert.equal(await targetQueue.completeSplitAttack("deleted-source"), false);
    await assert.rejects(targetQueue.completeSplitAttack("deleted-source", { actorUuid: actor.uuid }), /MissingDocuments/);
    await assert.rejects(targetQueue.completeSplitAttack(source.id, { actorUuid: "Actor.other" }), /MissingDocuments/);

    let ammunitionWrites = 0;
    const ammunition = { id: "ammo", uuid: "Actor.actor.Item.ammo", parent: actor, type: "gear", system: { quantity: 3 },
      async update(data) { ammunitionWrites++; this.system.quantity = data["system.quantity"]; } };
    const weapon = { id: "weapon", uuid: "Actor.actor.Item.weapon", parent: actor, type: "weapon", system: { weaponType: "missile" } };
    const target = { uuid: "Actor.target" };
    for (const document of [ammunition, weapon, target]) uuidDocuments.set(document.uuid, document);
    const entry = { actorUuid: actor.uuid, weaponUuid: weapon.uuid, targetActorUuid: target.uuid,
      ammunitionUuid: ammunition.uuid, ammunitionRequired: true, resolved: false };
    let queueData = { workflow: "missile", entries: [entry] };
    let claimsData = { version: 1, context: null, entries: {} };
    const queueMessage = { id: "queue", uuid: "ChatMessage.queue",
      getFlag: (_scope, flag) => flag === "targetQueue" ? queueData : flag === "actionClaims" ? claimsData : null,
      async update(data) {
        if (data[`flags.${MODULE_ID}.targetQueue`]) queueData = clone(data[`flags.${MODULE_ID}.targetQueue`]);
        if (data[`flags.${MODULE_ID}.actionClaims`]) claimsData = clone(data[`flags.${MODULE_ID}.actionClaims`]);
        return this;
      }
    };
    messages.set(queueMessage.id, queueMessage);
    let batchFailure = false;
    foundry.documents = { async modifyBatch(operations) {
      if (batchFailure) throw new Error("atomic batch cancelled");
      return Promise.all(operations.map(async operation => {
        if (operation.documentName === "Item") {
          assert.equal(operation.parent, actor);
          assert.equal(operation.updates[0]._id, ammunition.id);
          await ammunition.update(operation.updates[0]);
          return [ammunition];
        }
        return [await messages.get(operation.updates[0]._id).update(operation.updates[0])];
      }));
    } };
    AoVAdapter.rollDialogCombatWorkflowBatch = async () => [{ started: false }];
    await targetQueue.__test.resolveQueueEntry(queueMessage, 0);
    assert.equal(ammunitionWrites, 0, "cancelled attack options cannot consume queued ammunition");
    let workflowStarts = 0;
    AoVAdapter.rollDialogCombatWorkflowBatch = async (payloads, options) => {
      if (!await options.beforeCreate(payloads)) return [{ started: false }];
      workflowStarts++;
      const result = { id: "queue-result", getFlag: (_scope, flag) => flag === "actionClaim" ? payloads[0].actionClaim : null };
      messages.set(result.id, result);
      return [{ started: true, attackMessageId: result.id }];
    };
    await Promise.all([targetQueue.__test.resolveQueueEntry(queueMessage, 0), targetQueue.__test.resolveQueueEntry(queueMessage, 0)]);
    assert.equal(workflowStarts, 1, "concurrent full queue workflows create one attack");
    assert.equal(ammunitionWrites, 1);
    assert.equal(queueData.entries[0].resolved, true);
    queueData = { workflow: "missile", entries: [{ ...entry, targetTokenUuid: "Scene.scene.Token.deleted" }] };
    await targetQueue.__test.resolveQueueEntry(queueMessage, 0);
    assert.equal(ammunitionWrites, 1, "a missing exact Token cannot silently fall back to an Actor");
    game.user.isGM = false;
    queueData = { workflow: "missile", entries: [entry] };
    await assert.rejects(targetQueue.__test.resolveQueueEntry(queueMessage, 0), /NotOwner/);
    assert.equal(ammunitionWrites, 1);
    game.user.isGM = true;

    // The persisted row, rather than socket request identity or client memory,
    // arbitrates two owners and survives authority changes and late cards.
    const owner = { id: "owner", active: true, isGM: false };
    const otherOwner = { id: "other-owner", active: true, isGM: false };
    actor.testUserPermission = user => [owner.id, otherOwner.id].includes(user.id);
    game.users.set(owner.id, owner);
    game.users.set(otherOwner.id, otherOwner);
    const claimRequest = (stage, index = 0, extra = {}) => ({ sourceMessageId: queueMessage.id, kind: "target", index, stage, ...extra });
    const resetClaims = () => {
      queueData = { workflow: "missile", actorUuid: actor.uuid, entries: [clone(entry), clone(entry)] };
      claimsData = { version: 1, context: null, entries: {} };
      messages.delete("queue-result");
      messages.delete("late-result");
      ammunition.system.quantity = 3;
    };
    resetClaims();
    const concurrent = await Promise.all([owner, otherOwner].map(user => targetQueue.updateChatActionClaim(claimRequest("reserve"), user)));
    assert.equal(concurrent.filter(result => result.accepted).length, 1, "two clients reserve one exact row only once");
    const firstClaim = concurrent[0];
    assert.equal((await targetQueue.updateChatActionClaim(claimRequest("reserve", 1), otherOwner)).accepted, true, "another row remains independent");
    await targetQueue.updateChatActionClaim(claimRequest("release", 0, { attemptId: firstClaim.attemptId }), owner);
    assert.equal(claimsData.entries["target-0"].state, "pending", "cancellation before execution is retryable");
    const reservation = await targetQueue.updateChatActionClaim(claimRequest("reserve"), owner);
    await assert.rejects(targetQueue.updateChatActionClaim(claimRequest("execute", 0, { attemptId: reservation.attemptId, weaponUuid: "Actor.other.Item.weapon" }), owner), /MissingDocuments/);
    assert.equal(claimsData.entries["target-0"].state, "claimed");
    const execution = await targetQueue.updateChatActionClaim(claimRequest("execute", 0, { attemptId: reservation.attemptId, weaponUuid: weapon.uuid }), owner);
    assert.equal(execution.ammunitionRequired, true);
    const writesBeforeConsume = ammunitionWrites;
    batchFailure = true;
    await assert.rejects(targetQueue.updateChatActionClaim(claimRequest("consume", 0, { attemptId: reservation.attemptId }), owner), /atomic batch cancelled/);
    assert.equal(ammunition.system.quantity, 3);
    assert.equal(claimsData.entries["target-0"].ammunitionChange, undefined, "a cancelled batch persists neither spend nor receipt");
    assert.equal(claimsData.entries["target-0"].state, "claimed", "a failed resource boundary remains unstarted and releasable");
    batchFailure = false;
    const consumed = await targetQueue.updateChatActionClaim(claimRequest("consume", 0, { attemptId: reservation.attemptId }), owner);
    assert.deepEqual(consumed.ammunitionChange, { before: 3, after: 2, count: 1 });
    await targetQueue.updateChatActionClaim(claimRequest("consume", 0, { attemptId: reservation.attemptId }), owner);
    assert.equal(ammunitionWrites, writesBeforeConsume + 1, "replaying consumption cannot spend twice");
    await targetQueue.updateChatActionClaim(claimRequest("release", 0, { attemptId: reservation.attemptId }), owner);
    claimsData.entries["target-0"].claimedAt = 0;
    owner.active = false;
    assert.equal((await targetQueue.updateChatActionClaim(claimRequest("reserve"), otherOwner)).state, "executing", "execution never expires into a blind retry");
    const nextGm = { id: "next-gm", active: true, isGM: true };
    const originalGm = game.user;
    game.user = nextGm;
    game.users.set(nextGm.id, nextGm);
    const proof = { version: 1, key: reservation.key, attemptId: reservation.attemptId };
    messages.set("late-result", { id: "late-result", getFlag: (_scope, flag) => flag === "actionClaim" ? proof : null });
    const reconciled = await targetQueue.updateChatActionClaim(claimRequest("reconcile"), nextGm);
    assert.equal(reconciled.state, "committed", "the next GM reconciles a late card from persisted identities");
    assert.deepEqual(queueData.entries[0].resultMessageIds, ["late-result"]);
    assert.equal((await targetQueue.updateChatActionClaim(claimRequest("reserve"), otherOwner)).state, "committed");
    game.users.delete(nextGm.id);
    game.user = originalGm;
    owner.active = true;
    resetClaims();
    const abandoned = await targetQueue.updateChatActionClaim(claimRequest("reserve"), owner);
    owner.active = false;
    const reclaimed = await targetQueue.updateChatActionClaim(claimRequest("reserve"), otherOwner);
    assert.equal(reclaimed.accepted, true);
    assert.notEqual(reclaimed.attemptId, abandoned.attemptId, "only an unstarted reservation can be abandoned");
    owner.active = true;
    resetClaims();
    queueMessage.blind = true;
    await assert.rejects(targetQueue.updateChatActionClaim(claimRequest("reserve"), owner), /NotOwner/);
    delete queueMessage.blind;
    queueMessage.whisper = [otherOwner.id];
    await assert.rejects(targetQueue.updateChatActionClaim(claimRequest("reserve"), owner), /NotOwner/);
    delete queueMessage.whisper;
    await assert.rejects(targetQueue.updateChatActionClaim(claimRequest("reserve"), { id: "stranger", isGM: false }), /NotOwner/);
    assert.deepEqual(claimsData.entries, {});
    claimsData.context = { combatId: "deleted", logicalRound: 1, phase: "melee" };
    await assert.rejects(targetQueue.updateChatActionClaim(claimRequest("reserve"), owner), /StaleDocument/);
    assert.deepEqual(claimsData.entries, {});
    claimsData.context = null;
    claimsData.version = 2;
    await assert.rejects(targetQueue.updateChatActionClaim(claimRequest("reserve"), owner), /StaleDocument/);
    resetClaims();
    ammunition.system.quantity = 0;
    await assert.rejects(targetQueue.updateChatActionClaim(claimRequest("reserve"), owner), /AmmunitionDepleted/);
    assert.deepEqual(claimsData.entries, {}, "a queue with no ammunition fails before claiming");
    ammunition.system.quantity = 3;
    const emptyClaim = await targetQueue.updateChatActionClaim(claimRequest("reserve"), owner);
    ammunition.system.quantity = 0;
    await assert.rejects(targetQueue.updateChatActionClaim(claimRequest("execute", 0, { attemptId: emptyClaim.attemptId, weaponUuid: weapon.uuid }), owner), /AmmunitionDepleted/);
    assert.equal(claimsData.entries["target-0"].state, "claimed");
    await targetQueue.updateChatActionClaim(claimRequest("release", 0, { attemptId: emptyClaim.attemptId }), owner);
    uuidDocuments.delete(weapon.uuid);
    await assert.rejects(targetQueue.updateChatActionClaim(claimRequest("reserve"), owner), /MissingDocuments/);
    uuidDocuments.set(weapon.uuid, weapon);
    queueData.entries[0].targetTokenUuid = "Scene.scene.Token.deleted";
    await assert.rejects(targetQueue.updateChatActionClaim(claimRequest("reserve"), owner), /MissingDocuments/);
    resetClaims();
    const deletedBeforeSpend = await targetQueue.updateChatActionClaim(claimRequest("reserve"), owner);
    await targetQueue.updateChatActionClaim(claimRequest("execute", 0, { attemptId: deletedBeforeSpend.attemptId, weaponUuid: weapon.uuid }), owner);
    uuidDocuments.delete(target.uuid);
    await assert.rejects(targetQueue.updateChatActionClaim(claimRequest("consume", 0, { attemptId: deletedBeforeSpend.attemptId }), owner), /MissingDocuments/);
    assert.equal(ammunition.system.quantity, 3, "deletion before the resource boundary cannot consume ammunition");
    uuidDocuments.set(target.uuid, target);

    let splitClaims = { version: 1, context: null, entries: {} };
    const splitClaimMessage = { id: "claimed-split", uuid: "ChatMessage.claimed-split",
      getFlag: (_scope, flag) => flag === "splitAttack" ? { actorUuid: actor.uuid, weaponUuid: weapon.uuid, sourceWorkflow: "missile", resolved: false }
        : flag === "actionClaims" ? splitClaims : null,
      async update(data) { if (data[`flags.${MODULE_ID}.actionClaims`]) splitClaims = clone(data[`flags.${MODULE_ID}.actionClaims`]); return this; }
    };
    messages.set(splitClaimMessage.id, splitClaimMessage);
    uuidDocuments.set(tokenA.uuid, tokenA);
    const splitRequest = stage => ({ sourceMessageId: splitClaimMessage.id, kind: "split", stage });
    const splitReservation = await targetQueue.updateChatActionClaim(splitRequest("reserve"), owner);
    const { sanitizeChatActionClaimPayload } = await import("../scripts/socket/sanitizers.mjs");
    const splitExecution = sanitizeChatActionClaimPayload({ ...splitRequest("execute"), attemptId: splitReservation.attemptId,
      weaponUuid: weapon.uuid, ammunitionUuid: ammunition.uuid, targetTokenUuids: [tokenA.uuid, tokenA.uuid] });
    await targetQueue.updateChatActionClaim(splitExecution, owner);
    const splitSpend = await targetQueue.updateChatActionClaim({ ...splitRequest("consume"), attemptId: splitReservation.attemptId }, owner);
    assert.equal(splitSpend.ammunitionChange.count, 2, "two attacks at the same Token each consume their own ammunition");
    assert.equal(ammunition.system.quantity, 1);

    const socket = await import("../scripts/socket.mjs");
    const schema = await import("../scripts/socket/schema.mjs");
    game.user = owner;
    let unownedStart = false;
    assert.deepEqual(await socket.runClaimedChatAction({ sourceMessageId: queueMessage.id, kind: "target", index: 0 }, async () => { unownedStart = true; }), []);
    assert.equal(unownedStart, false, "no active GM means no action effects");
    const selectedGm = { id: "selected-gm", active: true, isGM: true };
    const secondaryGm = { id: "secondary-gm", active: true, isGM: true };
    game.users.set(selectedGm.id, selectedGm);
    game.users.set(secondaryGm.id, secondaryGm);
    game.user = secondaryGm;
    game.socket = { emit(_channel, envelope) {
      assert.equal(envelope.to, selectedGm.id);
      throw new Error("forwarded to selected GM");
    } };
    await assert.rejects(socket.requestGm("chatActionClaim", claimRequest("reserve")), /forwarded to selected GM/);
    game.users.delete(selectedGm.id);
    game.users.delete(secondaryGm.id);
    delete game.socket;
    game.user = originalGm;
    let executions = 0;
    let release;
    let started;
    const entered = new Promise(resolve => { started = resolve; });
    const pending = new Promise(resolve => { release = resolve; });
    schema.bindSocketActionRuntime("commitDefenseCard", {
      execute() { executions++; started(); return pending; }
    });
    const envelope = { from: "gm", requestId: "same-request", action: "commitDefenseCard", payload: {} };
    const first = socket.handleSocketRequest(envelope);
    await entered;
    const second = socket.handleSocketRequest(envelope);
    release({ accepted: false, cancelled: true });
    const outcomes = await Promise.all([first, second]);
    assert.equal(executions, 1);
    assert.equal(outcomes.every(result => result.accepted === false && result.cancelled === true), true);
    assert.equal(outcomes[1].duplicate, true);
    assert.equal((await socket.handleSocketRequest(envelope)).accepted, false);
    await assert.rejects(socket.handleSocketRequest({ ...envelope, payload: { actionOption: "dodge" } }), /reusing an id/);
    const failure = new Error("failed authoritative operation");
    schema.bindSocketActionRuntime("commitDefenseCard", { execute() { executions++; throw failure; } });
    const rejectedEnvelope = { ...envelope, requestId: "failed-request" };
    await assert.rejects(socket.handleSocketRequest(rejectedEnvelope), error => error === failure);
    await assert.rejects(socket.handleSocketRequest(rejectedEnvelope), error => error === failure);
    assert.equal(executions, 2, "failed deliveries replay their real error without executing again");
    await assert.rejects(socket.handleSocketRequest({ ...envelope, from: "unknown" }), /unknown User/);
    const originalNow = Date.now;
    let now = originalNow();
    try {
      Date.now = () => now;
      let longExecutions = 0;
      let finishLongRequest;
      let enterLongRequest;
      const longRequestEntered = new Promise(resolve => { enterLongRequest = resolve; });
      const longRequest = new Promise(resolve => { finishLongRequest = resolve; });
      schema.bindSocketActionRuntime("commitDefenseCard", {
        execute() { longExecutions++; enterLongRequest(); return longRequest; }
      });
      const longEnvelope = { ...envelope, requestId: "long-request" };
      const initial = socket.handleSocketRequest(longEnvelope);
      await longRequestEntered;
      now += 120000;
      const duplicate = socket.handleSocketRequest(longEnvelope);
      finishLongRequest({ accepted: true, combatAction: "parry" });
      const results = await Promise.all([initial, duplicate]);
      assert.equal(longExecutions, 1, "an in-flight operation does not expire with the completed-request TTL");
      const reaction = await import("../scripts/combat/reaction-automation.mjs");
      assert.equal(reaction.defenseResultUsesReaction(results[1]), false, "a replay cannot spend another reaction");
      now += 60001;
      await socket.handleSocketRequest(longEnvelope);
      assert.equal(longExecutions, 2, "completed request retention remains bounded by the existing TTL");
    } finally { Date.now = originalNow; }
    await maintenanceWriteContractTests();
    await maintenanceRenderContractTests();
    await maintenanceExtractionContractTests();
    await releaseCompatibilityContractTests();
    console.log("combat contracts: coalesced writes, source-scoped effects, contextual modifiers, private diagnostics, persisted claims, cancellation, failures, and duplicate outcomes passed");
  } finally {
    restoreAdapter();
    for (const [name, descriptor] of originalGlobals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  }
}

/** Local controls must recover from failures while document hooks stay active. */
async function maintenanceHotbarContractTests({ ActorHotbar, view, actor, hooks, PresentationCache, RenderCoordinator }) {
  const originalError = console.error;
  const errors = [];
  const itemCount = actor.items.length;
  console.error = (...args) => errors.push(args);
  view._magicPreparationUpdatesPending = new Set();
  try {
    for (const [method, type, field, category] of [
      ["onToggleXp", "skill", "xpCheck", "skills"],
      ["onToggleMagicPrepared", "runescript", "prepared", "magic"]
    ]) {
      for (const fail of [false, true]) {
        let finish;
        const wait = new Promise(resolve => { finish = resolve; });
        const item = { id: "maintenance-item", type, actor, parent: actor, system: { [field]: false },
          async update(patch) {
            await wait;
            if (fail) throw new Error("expected control failure");
            this.system[field] = patch[`system.${field}`];
            hooks.callAll("updateItem", this, patch);
            return this;
          } };
        actor.items.push(item);
        PresentationCache.invalidate(actor);
        assert.equal(PresentationCache.get(actor, category, () => item.system[field]), false);
        const attributes = new Map();
        const target = { dataset: { itemId: item.id }, disabled: false,
          setAttribute: (key, value) => attributes.set(key, value), removeAttribute: key => attributes.delete(key) };
        const event = { preventDefault() {}, stopImmediatePropagation() {} };
        const operation = ActorHotbar[method].call(view, event, target);
        assert.equal(target.disabled, true);
        const cached = PresentationCache.get(actor, "stats", () => ({ old: true }));
        hooks.callAll("updateActor", actor, { "system.abilities.dex.total": 12 });
        assert.notEqual(PresentationCache.get(actor, "stats", () => ({ current: true })), cached,
          "unrelated Actor updates invalidate caches while a control is pending");
        const equipment = PresentationCache.get(actor, "equipment", () => ({ old: true }));
        hooks.callAll("updateItem", { parent: actor, actor }, { "system.equipStatus": 1 });
        assert.notEqual(PresentationCache.get(actor, "equipment", () => ({ current: true })), equipment,
          "unrelated Item updates are not suppressed by pending controls");
        finish();
        const result = await operation;
        assert.equal(result, fail ? null : item);
        assert.equal(target.disabled, false);
        assert.equal(attributes.has("aria-busy"), false);
        assert.equal(view._xpUpdatePending, false);
        assert.equal(view._magicPreparationUpdatesPending.size, 0);
        assert.equal(PresentationCache.get(actor, category, () => item.system[field]), !fail,
          "display data follows the authoritative Item after settlement");
        actor.items.pop();
      }
    }
    assert.equal(errors.length, 2, "each failed control uses its existing error path");
  } finally {
    actor.items.length = itemCount;
    PresentationCache.invalidate(actor);
    console.error = originalError;
    await RenderCoordinator.flush();
  }
}

/** Exercise deadlines and migration retries without persistent Foundry data. */
async function maintenanceWriteContractTests() {
  const queue = await import("../scripts/combat/authoritative-write-queue.mjs");
  let release;
  const order = [];
  const blocked = queue.enqueueCombatantWrite("maintenance-timeout", "token", () => new Promise(resolve => { release = resolve; }), { movement: true });
  const later = queue.enqueueCombatantWrite("maintenance-timeout", "token", () => order.push("later"));
  try {
    const timeout = await Promise.race([
      queue.settleMovementWrites("maintenance-timeout", { quietMs: 5, timeoutMs: 20 }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("Movement deadline was not enforced")), 500))
    ]);
    assert.equal(timeout, false);
    assert.equal(queue.hasPendingCombatantWrites("maintenance-timeout"), true, "timeout must not remove queued writes");
    assert.deepEqual(order, [], "a later write cannot bypass the blocked write");
  } finally { release(); }
  await Promise.all([blocked, later]);
  assert.deepEqual(order, ["later"]);
  assert.equal(await queue.settleMovementWrites("maintenance-timeout", { quietMs: 0, timeoutMs: 100 }), true);
  await assert.rejects(queue.enqueueCombatantWrite("maintenance-rejection", "token", () => { throw new Error("write failed"); }), /write failed/);
  assert.equal(await queue.enqueueCombatantWrite("maintenance-rejection", "token", () => "recovered"), "recovered");

  let releaseMovement;
  const blockedMovement = queue.enqueueCombatantWrite("maintenance-start", "token", () => new Promise(resolve => { releaseMovement = resolve; }), { movement: true });
  const originalWarn = ui.notifications.warn;
  let warnings = 0, stateWrites = 0;
  let phase = "movement";
  const combat = { id: "maintenance-start", uuid: "Combat.maintenance-start", round: 1, combatants: [],
    getFlag: () => ({ enabled: true, phase, movementRun: { status: "none" } }),
    async setFlag() { stateWrites++; } };
  try {
    ui.notifications.warn = () => { warnings++; };
    const { startMovementPhase } = await import("../scripts/combat/movement-controller.mjs");
    assert.equal(await startMovementPhase(combat), null, "a timed-out run does not report completion");
    assert.equal(stateWrites, 0, "no movement status is written before plans settle");
    phase = "intent";
    const { PhaseController } = await import("../scripts/combat/phase-controller.mjs");
    assert.equal((await PhaseController.advance(combat, "movement")).phase, "intent");
    assert.equal(stateWrites, 0, "a pending plan prevents the phase transition");
    assert.equal(warnings, 2);
  } finally {
    releaseMovement(); await blockedMovement;
    ui.notifications.warn = originalWarn;
  }

  const migrations = await import("../scripts/settings.mjs");
  const original = { settings: game.settings, user: game.user, users: game.users, combats: game.combats };
  const primary = { id: "maintenance-primary", isGM: true, active: true };
  const secondary = { id: "maintenance-secondary", isGM: true, active: true };
  try {
    game.users = new Map([[primary.id, primary], [secondary.id, secondary]]);
    game.combats = [];
    for (const [method, marker, failureKey, initial] of [
      ["migrateLegacyReportSettings", "reportSettingsMigrated", "reportPhaseIntent", { chatReports: true }],
      ["migrateCombatTrackingSettings", "combatTrackingMigrationVersion", "adaptiveCheckpointBatching", {}],
      ["migrateUnifiedDebugSetting", "debugSettingsMigrated", "movementDebugEnabled", { movementDebugEnabled: true }],
      ["migrateV14WorldState", "v14MigrationVersion", "v14MigrationLastRun", {}]
    ]) {
      const values = new Map(Object.entries(initial));
      const writes = [];
      let fail = true;
      game.settings = {
        get: (_scope, key) => values.get(key),
        async set(_scope, key, value) {
          writes.push(key);
          if (fail && key === failureKey) throw new Error("migration write failed");
          values.set(key, value);
        }
      };
      game.user = secondary;
      await migrations[method]();
      assert.deepEqual(writes, [], `${method} must not run on the secondary GM`);
      game.user = primary;
      await assert.rejects(migrations[method](), /migration write failed/);
      assert.equal(values.has(marker), false, `${method} must remain retryable`);
      fail = false;
      await migrations[method]();
      assert.equal(writes.at(-1), marker, `${method} must persist its marker last`);
      if (method === "migrateUnifiedDebugSetting") assert.equal(values.get("debug"), true);
      const count = writes.length;
      await migrations[method]();
      assert.equal(writes.length, count, `${method} must be idempotent`);
    }
    const clientWrites = [];
    game.user = { id: "maintenance-player", isGM: false };
    game.settings = { get: () => 0, async set(_scope, key) { clientWrites.push(key); } };
    await migrations.migrateActionUiSettings();
    assert.equal(clientWrites.at(-1), "actionUiMigrationVersion", "client settings still migrate for a player");
  } finally { Object.assign(game, original); }
  console.log("maintenance write contracts: bounded waits, queue recovery, migration retries, GM authority, and client migration passed");
}

/** Deferred work must not overwrite a newer render/cache generation. */
async function maintenanceRenderContractTests() {
  const { PresentationCache } = await import("../scripts/ui/presentation-cache.mjs");
  const { RenderCoordinator } = await import("../scripts/ui/render-coordinator.mjs");
  const { runtimeSettings } = await import("../scripts/runtime-settings.mjs");
  const monitor = await import("../scripts/performance/performance-monitor.mjs");
  const actor = { uuid: "Actor.maintenance-cache" };
  let builds = 0, resolveOld;
  const old = PresentationCache.getAsync(actor, "history", () => { builds++; return new Promise(resolve => { resolveOld = resolve; }); });
  const duplicate = PresentationCache.getAsync(actor, "history", () => { throw new Error("duplicate build"); });
  await Promise.resolve();
  assert.equal(builds, 1);
  PresentationCache.invalidate(actor, ["history"]);
  const fresh = await PresentationCache.getAsync(actor, "history", () => "fresh");
  resolveOld("stale");
  assert.deepEqual(await Promise.all([old, duplicate]), ["stale", "stale"], "existing readers retain their own result");
  assert.equal(fresh, "fresh");
  assert.equal(await PresentationCache.getAsync(actor, "history", () => "unexpected"), "fresh", "an invalidated build cannot repopulate the cache");
  let finishAll;
  const all = PresentationCache.getAsync(actor, "all", () => new Promise(resolve => { finishAll = resolve; }));
  await Promise.resolve();
  PresentationCache.invalidate(actor);
  finishAll("obsolete"); await all;
  assert.equal(await PresentationCache.getAsync(actor, "all", () => "rebuilt"), "rebuilt");
  await assert.rejects(PresentationCache.getAsync(actor, "failure", () => { throw new Error("builder failed"); }), /builder failed/);
  assert.equal(await PresentationCache.getAsync(actor, "failure", () => "retry"), "retry");

  const previous = { debug: runtimeSettings.debug, performanceDiagnostics: runtimeSettings.performanceDiagnostics };
  try {
    runtimeSettings.debug = runtimeSettings.performanceDiagnostics = false;
    let details = 0;
    assert.equal(await monitor.measureAsync("maintenance-disabled", () => 42, () => { details++; }), 42);
    assert.equal(details, 0);
    runtimeSettings.performanceDiagnostics = true;
    const before = monitor.performanceReport().metadata.pendingMeasureCount;
    const mark = monitor.markStart("maintenance-toggle");
    runtimeSettings.performanceDiagnostics = false;
    monitor.markEnd(mark);
    assert.equal(monitor.performanceReport().metadata.pendingMeasureCount, before);
    runtimeSettings.performanceDiagnostics = true;
    await monitor.measureAsync("maintenance-toggle-async", () => { runtimeSettings.performanceDiagnostics = false; }, () => { details++; });
    assert.equal(details, 0);
    assert.equal(monitor.performanceReport().metadata.pendingMeasureCount, before);
    runtimeSettings.performanceDiagnostics = true;
    const originalFailure = new Error("operation failed");
    await assert.rejects(monitor.measureAsync("maintenance-failure", () => { throw originalFailure; }, () => { throw new Error("detail failed"); }), error => error === originalFailure);
  } finally { Object.assign(runtimeSettings, previous); }

  await RenderCoordinator.flush();
  const originals = new Map(["requestAnimationFrame", "cancelAnimationFrame"].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const frames = new Map(); let nextFrame = 0;
  const warnings = []; const originalWarn = console.warn;
  let finishRender;
  try {
    globalThis.requestAnimationFrame = callback => { frames.set(++nextFrame, callback); return nextFrame; };
    globalThis.cancelAnimationFrame = id => frames.delete(id);
    console.warn = (...args) => warnings.push(args);
    const calls = [];
    let active = 0, maximumActive = 0;
    RenderCoordinator.register("maintenance-delayed", async detail => {
      maximumActive = Math.max(maximumActive, ++active);
      calls.push(detail);
      if (calls.length === 1) await new Promise(resolve => { finishRender = resolve; });
      active--;
    });
    RenderCoordinator.register("maintenance-failed", () => { throw new Error("surface failed"); });
    let healthy = 0;
    RenderCoordinator.register("maintenance-healthy", () => { healthy++; });
    RenderCoordinator.invalidate("maintenance-delayed", { parts: ["first"], reason: "initial", positionOnly: true });
    assert.equal(frames.size, 1);
    const flush = RenderCoordinator.flush();
    assert.equal(RenderCoordinator.flush(), flush, "explicit flushes share the active drain");
    assert.equal(frames.size, 0, "manual flush cancels its redundant scheduled frame");
    await Promise.resolve();
    RenderCoordinator.invalidate("maintenance-delayed", { parts: ["second"], tokenIds: ["A"], reason: "second", positionOnly: true });
    RenderCoordinator.invalidate("maintenance-delayed", { parts: ["third"], tokenIds: ["B"], combatantIds: ["C"], reason: "third", full: true });
    RenderCoordinator.invalidate("maintenance-delayed", { reason: "fourth", positionOnly: true });
    RenderCoordinator.invalidate("maintenance-failed");
    RenderCoordinator.invalidate("maintenance-healthy");
    assert.equal(frames.size, 0, "in-flight invalidations belong to the same serialized drain");
    finishRender(); await flush;
    assert.equal(maximumActive, 1);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[1].parts, ["second", "third"]);
    assert.deepEqual(calls[1].tokenIds, ["A", "B"]);
    assert.deepEqual(calls[1].combatantIds, ["C"]);
    assert.deepEqual(calls[1].reasons, ["second", "third", "fourth"]);
    assert.equal(calls[1].full, true);
    assert.equal(calls[1].positionOnly, false);
    assert.equal(healthy, 1, "surface failure cannot discard a later refresh");
    assert.equal(warnings.length, 1);
    RenderCoordinator.invalidate("maintenance-healthy");
    const callback = frames.values().next().value; frames.clear(); callback();
    await RenderCoordinator.flush();
    assert.equal(healthy, 2, "scheduled and manual drains use the same path");
  } finally {
    finishRender?.();
    console.warn = originalWarn;
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
    for (const surface of ["maintenance-delayed", "maintenance-failed", "maintenance-healthy"]) RenderCoordinator.register(surface, () => undefined);
  }
  console.log("maintenance render contracts: serialized surfaces, error isolation, cache generations, and opt-in diagnostics passed");
}

/** Preserve launcher and route facade behavior after moving their owners. */
async function maintenanceExtractionContractTests() {
  const launchers = await import("../scripts/apps/dialog-launchers.mjs");
  const facade = await import("../scripts/apps/actor-hotbar/actions.mjs");
  assert.deepEqual(Object.keys(facade), Object.keys(launchers));
  const context = { actor: { id: "launcher-actor" }, originEvent: { shiftKey: true } };
  for (const [name, file, className] of [
    ["openAttackRollDialog", "attack-roll-dialog", "AttackRollDialog"],
    ["openMissileRollDialog", "missile-roll-dialog", "MissileRollDialog"],
    ["openDisengageDialog", "disengage-dialog", "DisengageDialog"],
    ["openKnockbackRollDialog", "knockback-roll-dialog", "KnockbackRollDialog"],
    ["openGrappleRollDialog", "grapple-roll-dialog", "GrappleRollDialog"],
    ["openDelayDialog", "delay-dialog", "DelayDialog"],
    ["openUtilityDialog", "utility-dialog", "UtilityDialog"],
    ["openRunicMagicDialog", "runic-magic-dialog", "RunicMagicDialog"]
  ]) {
    assert.equal(facade[name], launchers[name]);
    const Dialog = (await import(`../scripts/apps/${file}.mjs`))[className];
    const original = Dialog.show;
    try {
      Dialog.show = async payload => { assert.equal(payload, context); return null; };
      assert.equal(await facade[name](context), null, `${name} forwards context and cancellation unchanged`);
    } finally { Dialog.show = original; }
  }
  const route = await import("../scripts/combat/movement-route.mjs");
  const controller = await import("../scripts/combat/movement-controller.mjs");
  assert.equal(controller.mergeMovementRoutes, route.mergeMovementRoutes);
  assert.equal(controller.normalizeMovementRoute, route.normalizeMovementRoute);
  const a = { x: 10, y: 10 }, b = { x: 20, y: 10 }, c = { x: 20, y: 20 };
  assert.deepEqual(route.cleanMovementRoute([null, a, a, b, a]), [a, b, a]);
  assert.deepEqual(route.cleanMovementRoute([a, b, a], a), [b, a]);
  assert.deepEqual(route.mergeMovementRoutes([a, b], [b, c]), [a, b, c]);
  assert.deepEqual(route.mergeMovementRoutes([a, b, a], [a, c]), [a, b, a, c]);
  assert.deepEqual(route.mergeMovementRoutes([a, b], [a, b, c], c), [a, b, c]);
  const { ActorHotbar } = await import("../scripts/apps/actor-hotbar.mjs");
  const { openActorItem } = await import("../scripts/ui/action-catalog.mjs");
  const rendered = [];
  const sheet = { async render(options) { rendered.push(options); return this; } };
  const nativeActor = { sheet, items: new Map([["item", { sheet }]]) };
  assert.equal(await ActorHotbar.onOpenActor.call({ actor: nativeActor }), sheet);
  assert.equal(await openActorItem(nativeActor, "item"), sheet);
  assert.deepEqual(rendered, [{ force: true }, { force: true }], "native sheets retain ownership of image-editing flows");
  console.log("maintenance extraction contracts: shared launchers, cancellation, and ordered movement routes passed");
}

/** Source/runtime compatibility for the supported Foundry/AoV release pair. */
async function releaseCompatibilityContractTests() {
  const { detectV14Capabilities } = await import("../scripts/compat/capabilities.mjs");
  const messageMode = await import("../scripts/compat/aov-message-mode.mjs");
  const initiative = await import("../scripts/compat/aov-adjust-initiative.mjs");
  const original = { config: globalThis.CONFIG, hooks: globalThis.Hooks, release: game.release,
    system: game.system, socket: game.socket, documents: foundry.documents, handlebars: foundry.applications.handlebars };
  class AoVCombat {
    rollInitiative() { game.settings.get("core", "rollMode"); throw new Error("Deprecated native path reached"); }
  }
  class AoVCombatTracker {
    adjustInit() {}
    static async adjDex() { const dismissed = null; return dismissed.adjOther; }
  }
  class TokenFixture { move() {} getCompleteMovementPath() {} }
  class SceneFixture { moveTokens() {} }
  try {
    globalThis.CONFIG = { Combat: { documentClass: AoVCombat }, ui: { combat: AoVCombatTracker }, Token: {}, Item: {} };
    globalThis.Hooks = { ...globalThis.Hooks, on() {} };
    foundry.documents = { TokenDocument: TokenFixture, Scene: SceneFixture };
    foundry.applications.handlebars = { renderTemplate() {} };
    game.release = { generation: 14, version: "14.370" };
    game.system = { id: "aov", version: "14.7" };
    game.socket = { on() {}, emit() {} };
    assert.equal(detectV14Capabilities().runtimeEnabled, true);
    game.release.version = "14.369";
    assert.equal(detectV14Capabilities().runtimeEnabled, false);
    assert.equal(detectV14Capabilities().hardBlockers.includes("Foundry 14.370+"), true);
    game.release.version = "14.370";
    game.system.version = "14.6";
    assert.equal(detectV14Capabilities().runtimeEnabled, false);
    assert.equal(detectV14Capabilities().hardBlockers.includes("AoV 14.7+"), true);
    game.system.version = "14.7";

    assert.equal(messageMode.installAoVMessageModeCompatibility(), true);
    const patched = AoVCombat.prototype.rollInitiative;
    assert.equal(messageMode.installAoVMessageModeCompatibility(), true);
    assert.equal(AoVCombat.prototype.rollInitiative, patched);
    const updates = [];
    const owned = { isOwner: true, getInitiativeRoll: () => ({ total: 18, async evaluate() {} }) };
    const combat = Object.assign(new AoVCombat(), { turn: 0, combatants: new Map([["owned", owned], ["other", { isOwner: false }]]),
      async updateEmbeddedDocuments(type, data, options) { updates.push({ type, data, options }); } });
    assert.equal(await combat.rollInitiative(["owned", "other"], { updateTurn: false }), combat);
    assert.deepEqual(updates, [{ type: "Combatant", data: [{ _id: "owned", initiative: 18 }], options: { turnEvents: false, combatTurn: 0 } }]);
    assert.equal(initiative.installAdjustInitiativeDismissGuard(), true);
    const guarded = AoVCombatTracker.adjDex;
    assert.equal(initiative.installAdjustInitiativeDismissGuard(), true);
    assert.equal(AoVCombatTracker.adjDex, guarded);
    assert.equal(await AoVCombatTracker.adjDex(), 0, "closing the native dialog remains a cancellation");
  } finally {
    globalThis.CONFIG = original.config; globalThis.Hooks = original.hooks;
    game.release = original.release; game.system = original.system; game.socket = original.socket;
    foundry.documents = original.documents; foundry.applications.handlebars = original.handlebars;
  }
  console.log("release compatibility contracts: 14.370/14.7 minimums, initiative guards, and native delegation passed");
}

/** Check release prerequisites and deterministic archives in a temporary folder. */
async function maintenancePackagingContractTests() {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { resolve, dirname, basename, sep } = await import("node:path");
  const { inflateRawSync } = await import("node:zlib");
  const { validateAoVContract } = await import("./lib/validation.mjs");
  const { copyRuntimeSource, createDeterministicZip, validateReleaseTag } = await import("./lib/packaging.mjs");
  const temporary = mkdtempSync(join(tmpdir(), "aov-skjaldborg-contract-"));
  try {
    const metadata = { manifest: readJson(join(ROOT, "module.json")) };
    assert.equal(validateReleaseTag(undefined), `v${metadata.manifest.version}`);
    assert.equal(validateReleaseTag(`v${metadata.manifest.version}`), `v${metadata.manifest.version}`);
    assert.throws(() => validateReleaseTag("v0.6.0"), /does not match module version/);
    assert.throws(() => validateAoVContract(metadata, { required: true, systemPath: join(temporary, "missing") }), /required for release builds/);
    const runtime = join(temporary, "runtime");
    copyRuntimeSource(runtime);
    const first = join(temporary, "first.zip"), second = join(temporary, "second.zip");
    createDeterministicZip(runtime, first);
    createDeterministicZip(runtime, second);
    const archive = readFileSync(first);
    assert.deepEqual(archive, readFileSync(second), "identical input produces identical archive bytes");
    const names = [];
    let offset = 0;
    while (archive.readUInt32LE(offset) === 0x04034B50) {
      const compressedSize = archive.readUInt32LE(offset + 18);
      const nameSize = archive.readUInt16LE(offset + 26), extraSize = archive.readUInt16LE(offset + 28);
      const name = archive.subarray(offset + 30, offset + 30 + nameSize).toString("utf8");
      assert.equal(name.startsWith("aov-skjaldborg/"), true);
      const relative = name.slice("aov-skjaldborg/".length);
      assert.equal(relative.split("/").some(part => [".maintenance", "node_modules", "tools", "src"].includes(part)), false);
      const contentOffset = offset + 30 + nameSize + extraSize;
      const content = inflateRawSync(archive.subarray(contentOffset, contentOffset + compressedSize));
      assert.deepEqual(content, readFileSync(join(runtime, relative)), `archive content matches ${relative}`);
      names.push(name);
      offset = contentOffset + compressedSize;
    }
    assert.equal(names.includes("aov-skjaldborg/scripts/apps/dialog-launchers.mjs"), true);
    assert.equal(archive.readUInt32LE(offset), 0x02014B50, "central directory follows the runtime entries");
    assert.deepEqual(names, names.slice().sort((a, b) => a.localeCompare(b)));
  } finally {
    // Validate the final absolute deletion target before recursively removing fixtures.
    const absolute = resolve(temporary);
    if (dirname(absolute) !== resolve(tmpdir()) || !basename(absolute).startsWith("aov-skjaldborg-contract-")
      || !absolute.startsWith(`${resolve(tmpdir())}${sep}`)) throw new Error("Unsafe temporary fixture cleanup path");
    rmSync(absolute, { recursive: true, force: true });
  }
  console.log("maintenance packaging contracts: required AoV source, deterministic archives, and runtime contents passed");
}

function replaceConstantVersion(source, name, version) {
  const pattern = new RegExp(`(export const ${name} = ")[^"]+(";)`);
  if (!pattern.test(source)) fail(`Unable to locate ${name} in scripts/constants.mjs`);
  return source.replace(pattern, `$1${version}$2`);
}

function setVersion(version) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    fail(`Invalid semantic version "${version}"`);
  }
  const manifestPath = join(ROOT, "module.json");
  const packagePath = join(ROOT, "package.json");
  const lockPath = join(ROOT, "package-lock.json");
  const constantsPath = join(ROOT, "scripts", "constants.mjs");
  const manifest = readJson(manifestPath);
  const packageJson = readJson(packagePath);
  const packageLock = readJson(lockPath);
  manifest.version = version;
  manifest.download = String(manifest.download ?? "").replace(
    /\/releases\/download\/v[^/]+\//,
    `/releases/download/v${version}/`
  );
  packageJson.version = version;
  packageLock.version = version;
  packageLock.packages[""].version = version;
  const constants = replaceConstantVersion(readFileSync(constantsPath, "utf8"), "MODULE_VERSION", version);
  writeJson(manifestPath, manifest);
  writeJson(packagePath, packageJson);
  writeJson(lockPath, packageLock);
  writeFileSync(constantsPath, constants, "utf8");
  console.log(`set-version: ${version}`);
}

const [command = "validate", ...args] = process.argv.slice(2);
try {
  if (command === "syntax") syntaxCheck();
  else if (command === "validate") validateAll();
  else if (command === "contracts") await contractTests();
  else if (command === "build-folder") buildFolder();
  else if (command === "build") {
    if (args.length && (args.length !== 2 || args[0] !== "--tag" || !args[1])) fail("Usage: build [--tag v<version>]");
    buildRelease({ tag: args[1] });
  }
  else if (command === "set-version") setVersion(args[0] ?? "");
  else fail(`Unknown command "${command}"`);
}
catch (error) {
  console.error(error?.stack ?? error);
  process.exitCode = 1;
}
