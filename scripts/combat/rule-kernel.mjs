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

function primitiveReportValue(value) {
  if (value === null || value === undefined) return value;
  if (["string", "number", "boolean"].includes(typeof value)) return value;
  if (Array.isArray(value)) return value.map(primitiveReportValue).filter(entry => entry !== undefined);
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value)
      .filter(([_key, entry]) => entry === null || ["string", "number", "boolean"].includes(typeof entry))
      .map(([key, entry]) => [key, entry]));
  }
  return undefined;
}

function appendRuleReport(context, id, stage, report) {
  if (!report || typeof report !== "object") return;
  context.ruleReports.push({
    id,
    stage,
    ...primitiveReportValue(report)
  });
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
    ruleReports: Array.isArray(seed.ruleReports)
      ? seed.ruleReports.map(entry => primitiveReportValue(entry)).filter(Boolean)
      : []
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
 * @param {HTMLElement|ArrayLike<HTMLElement>} html Pending chat HTML.
 * @returns {object}
 */
export function decorateChatCard(context, html) {
  return runStage("decorateChatCard", context, html);
}

export const __test = {
  registeredRuleIds: () => orderedRules().map(rule => rule.id),
  resetRules: () => rules.clear()
};
