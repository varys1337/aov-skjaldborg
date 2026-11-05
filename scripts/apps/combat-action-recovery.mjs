import { MODULE_ID } from "../constants.mjs";
import { ACTION_CLAIMS_FLAG } from "../combat/action-claim-evidence.mjs";
import { assertRecoveryGm, canReadRecoveryMessage, inspectCombatActionRecovery, normalizeRecoveryFilters, recoveryDiagnosticSummary } from "../combat/action-recovery-audit.mjs";
import { firstActiveGm } from "../utils/authority.mjs";
import { hasAnyChangedPath } from "../utils/changed-paths.mjs";
import { RenderCoordinator } from "../ui/render-coordinator.mjs";
import { runtimeSettings } from "../runtime-settings.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;
const localize = key => game.i18n.localize(`AOV_SKJALDBORG.Recovery.${key}`);
const GROUPS = ["Malformed", "PartialSplit", "ResultFound", "ExecutingSpent", "Executing", "Reserved", "Pending", "Committed"];
let hooksRegistered = false;

/** A GM-only evidence viewer. No repair handler is registered while B01 is partial. */
export class CombatActionRecovery extends HandlebarsApplicationMixin(ApplicationV2) {
  static current = null;
  static DEFAULT_OPTIONS = {
    id: "aov-skjaldborg-combat-action-recovery", classes: ["aov-skjaldborg", "skj-recovery"], tag: "form",
    position: { width: 940, height: 720 },
    window: { title: "AOV_SKJALDBORG.Recovery.Title", resizable: true, contentClasses: ["skj-recovery-content"] },
    form: { handler: CombatActionRecovery.onFilter, closeOnSubmit: false, submitOnChange: false },
    actions: {
      refresh: CombatActionRecovery.onRefresh, previous: CombatActionRecovery.onPrevious, next: CombatActionRecovery.onNext,
      older: CombatActionRecovery.onOlder, newer: CombatActionRecovery.onNewer,
      viewSource: CombatActionRecovery.onViewSource, viewResult: CombatActionRecovery.onViewResult,
      exportSummary: CombatActionRecovery.onExport
    }
  };
  static PARTS = { content: { template: "modules/aov-skjaldborg/templates/combat-action-recovery.hbs" } };

  // Only navigation preferences are retained. Incident/effect state is always re-read.
  filters = normalizeRecoveryFilters();
  preview = null;
  evidenceRevision = 0;

  static async open() {
    assertRecoveryGm();
    if (runtimeSettings.debug !== true) throw new Error(localize("DebugRequired"));
    return (this.current ?? new this()).render({ force: true });
  }

  get title() { return localize("Title"); }

  /** Documented AppV2 render permission gate. */
  _canRender(options) {
    assertRecoveryGm();
    if (runtimeSettings.debug !== true) throw new Error(localize("DebugRequired"));
    if (game.aovSkjaldborg?.capabilities?.runtimeEnabled !== true) throw new Error(localize("Unavailable"));
    return super._canRender(options);
  }

  async _prepareContext(options) {
    assertRecoveryGm();
    const context = await super._prepareContext(options);
    const audit = inspectCombatActionRecovery(this.filters);
    this.filters = audit.filters;
    const rows = audit.rows.map(row => ({ ...row,
      stateLabel: localize(`States.${row.state}`),
      ageLabel: row.ageSeconds === null || row.ageSeconds === undefined ? localize("Unknown")
        : game.i18n.format("AOV_SKJALDBORG.Recovery.Age", { seconds: row.ageSeconds }),
      claimantLabel: row.claimantName || row.claimantId || localize("Unknown"),
      contextLabel: row.context ? `${row.context.combatId} / ${row.context.logicalRound ?? "?"} / ${row.context.phase}` : localize("NoSavedContext"),
      resultsLabel: game.i18n.format("AOV_SKJALDBORG.Recovery.ResultCount", { found: row.exactResultCount ?? 0, expected: row.expectedCount ?? "?" }),
      reasonLabels: row.reasons.map(reason => localize(`Reasons.${reason}`)),
      results: row.results.map(result => ({ ...result,
        proofLabel: localize(result.attackProof ? "AttackCardProof" : result.claimProof ? "ClaimProofOnly" : "ResultUnverified")
      }))
    }));
    return { ...context, ...audit, evidenceRevision: this.evidenceRevision,
      groups: GROUPS.map(key => ({ label: localize(`Classes.${key}`), rows: rows.filter(row => row.evidenceClass === key) })).filter(group => group.rows.length),
      hasRows: rows.length > 0, currentScope: audit.filters.scope === "current", allScope: audit.filters.scope === "all",
      pageLabel: game.i18n.format("AOV_SKJALDBORG.Recovery.Page", { page: audit.page + 1, pages: audit.pages, count: audit.totalRows }),
      historyLabel: game.i18n.format("AOV_SKJALDBORG.Recovery.History", { page: audit.historyPage + 1, pages: audit.historyPages, count: audit.inspectedMessageCount }),
      hasPrevious: audit.page > 0, hasNext: audit.page + 1 < audit.pages,
      hasOlder: audit.historyPage + 1 < audit.historyPages,
      hasNewer: audit.historyPage > 0,
      selectedGm: game.users?.get?.(audit.authorityId)?.name || audit.authorityId || localize("Unknown"),
      secondaryGm: audit.authorityId !== game.user.id,
      previewLabel: this.preview?.resultMessageId || this.preview?.sourceMessageId || localize("NoPreview")
    };
  }

  async _onFirstRender(context, options) {
    await super._onFirstRender(context, options);
    if (CombatActionRecovery.current && CombatActionRecovery.current !== this) await CombatActionRecovery.current.close();
    CombatActionRecovery.current = this;
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    if (game.user?.isGM !== true || runtimeSettings.debug !== true || (firstActiveGm()?.id ?? "") !== context.authorityId) {
      this.element.replaceChildren();
      void this.close();
      return;
    }
    if (!this.preview) return;
    const selected = this.preview;
    const previewElement = this.element.querySelector("[data-recovery-preview]");
    const audit = inspectCombatActionRecovery({ scope: "all", sourceMessageId: selected.sourceMessageId, slot: selected.slot,
      historyPage: this.filters.historyPage, includeCommitted: true });
    const row = audit.rows.find(row => row.slot === selected.slot && row.attemptId === selected.attemptId);
    const result = selected.resultMessageId ? row?.results.find(result => result.messageId === selected.resultMessageId && result.claimProof && result.available) : null;
    const id = selected.resultMessageId ? result?.messageId : row?.sourceAvailable ? row.sourceMessageId : null;
    const message = id ? game.messages?.get?.(id) : null;
    if (!canReadRecoveryMessage(message)) { if (previewElement) previewElement.textContent = localize("PreviewUnavailable"); return; }
    let html;
    try { html = await message.renderHTML({ canClose: false, canDelete: false }); }
    catch (_error) {
      if (previewElement?.isConnected && this.preview === selected && this.evidenceRevision === context.evidenceRevision) previewElement.textContent = localize("PreviewUnavailable");
      return;
    }
    // A delayed render cannot reattach private text after closure, selection,
    // permission changes, deletion or GM handover. Never insert native buttons.
    if (!previewElement?.isConnected || this.preview !== selected || this.evidenceRevision !== context.evidenceRevision || !canReadRecoveryMessage(message)
      || runtimeSettings.debug !== true || game.messages?.get?.(id) !== message || (firstActiveGm()?.id ?? "") !== context.authorityId) return;
    previewElement.textContent = String(html.textContent ?? "").slice(0, 12000);
  }

  _onClose(options) {
    this.evidenceRevision += 1;
    if (CombatActionRecovery.current === this) CombatActionRecovery.current = null;
    this.preview = null;
    super._onClose(options);
  }

  static async onFilter(event, form, formData) {
    event.preventDefault();
    assertRecoveryGm();
    this.filters = normalizeRecoveryFilters(formData.object);
    this.preview = null;
    await this.render();
  }
  static async onRefresh(event) { event.preventDefault(); assertRecoveryGm(); await this.render(); }
  static async onPrevious(event) { event.preventDefault(); assertRecoveryGm(); this.filters.page = Math.max(0, this.filters.page - 1); await this.render(); }
  static async onNext(event) { event.preventDefault(); assertRecoveryGm(); this.filters.page += 1; await this.render(); }
  static async onOlder(event) { event.preventDefault(); assertRecoveryGm(); this.filters.historyPage += 1; this.filters.page = 0; this.preview = null; await this.render(); }
  static async onNewer(event) { event.preventDefault(); assertRecoveryGm(); this.filters.historyPage = Math.max(0, this.filters.historyPage - 1); this.filters.page = 0; this.preview = null; await this.render(); }

  static async onViewSource(event, target) {
    event.preventDefault(); assertRecoveryGm();
    this.preview = { sourceMessageId: target.dataset.sourceId, slot: target.dataset.slot, attemptId: target.dataset.attemptId };
    await this.render();
  }
  static async onViewResult(event, target) {
    event.preventDefault(); assertRecoveryGm();
    this.preview = { sourceMessageId: target.dataset.sourceId, slot: target.dataset.slot,
      attemptId: target.dataset.attemptId, resultMessageId: target.dataset.resultId };
    await this.render();
  }
  static onExport(event) {
    event.preventDefault(); assertRecoveryGm();
    foundry.utils.saveDataToFile(recoveryDiagnosticSummary(this.filters), "application/json", "skjaldborg-recovery-audit.json");
  }
}

/** Targeted invalidation only while the on-demand console is open. */
export function registerCombatActionRecoveryHooks(hooks = globalThis.Hooks) {
  if (hooksRegistered) return;
  hooksRegistered = true;
  RenderCoordinator.register("combatRecovery", () => {
    const app = CombatActionRecovery.current;
    if (!app?.rendered) return;
    if (game.user?.isGM !== true) return app.close();
    return app.render();
  });
  const invalidate = () => {
    const app = CombatActionRecovery.current;
    if (!app?.rendered) return;
    // Remove stale evidence immediately, before the coalesced render.
    app.evidenceRevision += 1;
    app.element.querySelector("[data-recovery-preview]")?.replaceChildren();
    RenderCoordinator.invalidate("combatRecovery", { reason: "claim-evidence-change" });
  };
  const relevant = message => message?.id === CombatActionRecovery.current?.preview?.sourceMessageId
    || message?.id === CombatActionRecovery.current?.preview?.resultMessageId
    || (canReadRecoveryMessage(message) && (message?.getFlag?.(MODULE_ID, ACTION_CLAIMS_FLAG)
      || message?.getFlag?.(MODULE_ID, "actionClaim") || message?.getFlag?.(MODULE_ID, "targetQueue") || message?.getFlag?.(MODULE_ID, "splitAttack")));
  hooks.on("createChatMessage", message => { if (CombatActionRecovery.current?.rendered && relevant(message)) invalidate(); });
  hooks.on("deleteChatMessage", message => { if (CombatActionRecovery.current?.rendered && relevant(message)) invalidate(); });
  hooks.on("updateChatMessage", (message, changed) => {
    if (!CombatActionRecovery.current?.rendered) return;
    if (hasAnyChangedPath(changed, ["whisper", "blind", "ownership"])) CombatActionRecovery.current.element.querySelector(".skj-recovery__incidents")?.replaceChildren();
    if (hasAnyChangedPath(changed, ["flags.aov-skjaldborg", "whisper", "blind", "ownership"]) || relevant(message)) invalidate();
  });
  hooks.on("updateCombat", invalidate);
  hooks.on("deleteCombat", invalidate);
  const closeOnAuthorityChange = () => {
    const app = CombatActionRecovery.current;
    if (!app) return;
    app.element?.replaceChildren();
    void app.close();
  };
  hooks.on("userConnected", user => { if (user?.isGM) closeOnAuthorityChange(); });
  hooks.on("updateUser", (user, changed) => {
    if (user?.id === game.user?.id || hasAnyChangedPath(changed, ["role", "active"])) closeOnAuthorityChange();
  });
  hooks.on("updateItem", invalidate);
  hooks.on("deleteItem", invalidate);
  hooks.on("updateToken", invalidate);
  hooks.on("deleteToken", invalidate);
  hooks.on("deleteActor", invalidate);
}
