import { performanceDiagnostics } from "../performance/performance-monitor.mjs";

const STAGES = Object.freeze([
  "prepareAttackContext",
  "prepareDefenseContext",
  "prepareDamageContext",
  "prepareHitLocationContext",
  "decorateChatCard"
]);

const rules = new Map();

function normalizePriority(priority) {
  const number = Number(priority);
  return Number.isFinite(number) ? number : 0;
}

function orderedRules() {
  return Array.from(rules.values())
    .sort((left, right) => left.priority - right.priority || left.id.localeCompare(right.id));
}

function assertPlainRule(rule) {
  if (!rule || typeof rule !== "object") throw new TypeError("Combat rule must be an object.");
  const id = String(rule.id ?? "").trim();
  if (!id) throw new TypeError("Combat rule id is required.");
  return id;
}

function primitiveReportValue(value, depth = 0) {
  if (depth > 2) return undefined;
  if (value === null || value === undefined) return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string") return value.slice(0, 200);
  if (typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.slice(0, 20).map(entry => primitiveReportValue(entry, depth + 1)).filter(entry => entry !== undefined);
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value).slice(0, 30)
      .filter(([_key, entry]) => entry === null || ["string", "number", "boolean"].includes(typeof entry))
      .map(([key, entry]) => [key.slice(0, 80), primitiveReportValue(entry, depth + 1)])
      .filter(([_key, entry]) => entry !== undefined));
  }
  return undefined;
}

function appendRuleReport(context, id, stage, report) {
  if (!report || typeof report !== "object") return;
  context.ruleReports.push({
    ...primitiveReportValue(report),
    id,
    stage
  });
}

/** Copy bounded primitive report data at the submitted action boundary. */
export function serializeCombatRuleReports(reports) {
  return Array.isArray(reports) ? reports.slice(0, 20).map(value => primitiveReportValue(value)).filter(value => value && !Array.isArray(value) && typeof value === "object") : [];
}

/** Local GM diagnostics only: no documents, names, UUIDs, chat writes or logs. */
export function recordCombatRuleTrace(payload, committed) {
  if (globalThis.game?.user?.isGM !== true || !performanceDiagnostics.enabled()) return;
  const start = performance.now();
  const finite = value => Number.isFinite(Number(value)) ? Number(value) : 0;
  const additive = Object.fromEntries([
    "situationalModifier", "aimedModifier", "disarmModifier", "stunModifier", "augmentModifier", "proneModifier", "evadingModifier"
  ].map(key => [key, finite(payload[key])]));
  const providers = serializeCombatRuleReports(payload.ruleReports)
    .filter(report => rules.has(report.id) && STAGES.includes(report.stage)).map(report => ({
    id: report.id, stage: report.stage,
    values: Object.fromEntries(Object.entries(report).filter(([_key, value]) => typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))))
  }));
  const trace = {
    version: 1, stage: "committed-card", workflow: payload.workflowType === "missile" ? "missile" : "melee",
    submitted: { baseChance: finite(payload.baseChance), targetNumber: finite(payload.targetNumber), additive,
      rangeMultiplier: payload.missileRange?.enabled === true ? finite(payload.missileRange.multiplier) : 1,
      intoMeleeDivisor: payload.missileIntoMelee?.enabled === true ? finite(payload.missileIntoMelee.combatantCount) : 1 },
    coreCheckBonus: finite(payload.coreOptions?.checkBonus),
    nativeActionModifier: finite(committed.nativeActionModifier),
    mountedCap: { active: payload.mountedCap?.active === true, modifier: finite(payload.mountedCap?.modifier) },
    committed: { flatModifier: finite(committed.flatModifier), encumbrance: finite(committed.encumbrance), targetNumber: finite(committed.targetNumber) },
    providers
  };
  performanceDiagnostics.recordMeasure("combat.ruleAttribution", performance.now() - start, trace);
}

export function combatRuleDiagnostics() {
  if (globalThis.game?.user?.isGM !== true || !performanceDiagnostics.enabled()) return null;
  return performanceDiagnostics.report().measures["combat.ruleAttribution"] ?? null;
}

function runStage(stage, context, ...args) {
  if (!context || typeof context !== "object") context = createCombatRuleContext();
  for (const rule of orderedRules()) {
    const handler = rule[stage];
    if (typeof handler !== "function") continue;
    const report = handler(context, ...args);
    appendRuleReport(context, rule.id, stage, report);
  }
  return context;
}

/**
 * Register one combat rule provider for deterministic rule-context preparation.
 *
 * Re-registering the same id replaces the previous provider. This keeps module
 * reloads idempotent and avoids duplicate handler execution.
 *
 * @param {object} rule Rule provider.
 * @param {string} rule.id Stable rule id.
 * @param {number} [rule.priority=0] Lower priorities run first.
 * @returns {object} The normalized registered rule.
 */
export function registerCombatRule(rule) {
  const id = assertPlainRule(rule);
  const normalized = {
    ...rule,
    id,
    priority: normalizePriority(rule.priority)
  };
  rules.set(id, normalized);
  return normalized;
}

/**
 * Create a transient rule context for one attack, defense, damage, or chat flow.
 *
 * The context may carry live Foundry documents while a workflow is being
 * prepared, but the kernel-owned report data is primitive-only.
 *
 * @param {object} [seed={}] Initial context.
 * @returns {object}
 */
export function createCombatRuleContext(seed = {}) {
  return {
    ...seed,
    ruleMetadata: {
      ...(seed.ruleMetadata ?? {})
    },
    ruleReports: serializeCombatRuleReports(seed.ruleReports)
  };
}

/**
 * Run registered attack-context providers in deterministic order.
 *
 * @param {object} context Combat rule context.
 * @returns {object}
 */
export function prepareAttackContext(context) {
  return runStage("prepareAttackContext", context);
}

/**
 * Run registered defense-context providers in deterministic order.
 *
 * @param {object} context Combat rule context.
 * @returns {object}
 */
export function prepareDefenseContext(context) {
  return runStage("prepareDefenseContext", context);
}

/**
 * Run registered damage-context providers in deterministic order.
 *
 * @param {object} context Combat rule context.
 * @returns {object}
 */
export function prepareDamageContext(context) {
  return runStage("prepareDamageContext", context);
}

/**
 * Run registered hit-location providers in deterministic order.
 *
 * @param {object} context Combat rule context.
 * @returns {object}
 */
export function prepareHitLocationContext(context) {
  return runStage("prepareHitLocationContext", context);
}

/**
 * Allow registered rules to decorate a rendered chat card.
 *
 * @param {object} context Combat rule context.
 * @param {HTMLElement} html Pending chat HTML.
 * @returns {object}
 */
export function decorateChatCard(context, html) {
  return runStage("decorateChatCard", context, html);
}

export const __test = {
  registeredRuleIds: () => orderedRules().map(rule => rule.id),
  resetRules: () => rules.clear()
};
