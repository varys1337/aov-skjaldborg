import { actionThemeClasses, applyActionTheme } from "../../ui/dom-utils.mjs";

const { DialogV2 } = foundry.applications.api;

export const ACTION_DIALOG_WIDTHS = Object.freeze({ standard: 560, compact: 520 });

/**
 * Resolve the opening width with the same viewport margin as the dialog CSS.
 *
 * @param {number} [width=ACTION_DIALOG_WIDTHS.standard] Preferred width.
 * @returns {{width: number, height: string}} ApplicationV2 opening position.
 */
export function actionDialogPosition(width = ACTION_DIALOG_WIDTHS.standard) {
  const viewportWidth = globalThis.window?.innerWidth;
  return {
    width: Number.isFinite(viewportWidth) ? Math.min(width, Math.max(0, viewportWidth - 32)) : width,
    height: "auto"
  };
}

/**
 * DialogV2 base with coalesced Foundry 14.365 content refitting.
 *
 * Foundry 14.365 introduced ApplicationV2#_refit for applications whose
 * natural size changes without a complete render. The method is guarded so
 * the module retains its declared 14.363 minimum and simply keeps the earlier
 * automatic positioning behavior when the API is unavailable.
 */
export class SkjDialogV2 extends DialogV2 {
  static DEFAULT_OPTIONS = { ...DialogV2.DEFAULT_OPTIONS, classes: ["skj-action-dialog-window"] };

  constructor(options = {}) {
    super({ ...options, classes: [...(options.classes ?? []), ...actionThemeClasses()] });
  }

  /** Apply the palette to the frame before AppV2 inserts it into the document. */
  async _renderFrame(options) {
    const frame = await super._renderFrame(options);
    applyActionTheme(frame);
    return frame;
  }

  #contentRefitQueued = false;
  #contentRefitPosition = {};

  /**
   * Refit this dialog after synchronous DOM visibility/content changes.
   * Multiple changes in the same task are collapsed into one refit.
   *
   * @param {object} [positionUpdate={}] Position data forwarded to `_refit`.
   * @returns {boolean} Whether native refitting is available.
   */
  requestContentRefit(positionUpdate = {}) {
    if (typeof this._refit !== "function") return false;
    this.#contentRefitPosition = {
      ...this.#contentRefitPosition,
      ...(positionUpdate ?? {})
    };
    if (this.#contentRefitQueued) return true;
    this.#contentRefitQueued = true;
    queueMicrotask(() => {
      this.#contentRefitQueued = false;
      const nextPosition = this.#contentRefitPosition;
      this.#contentRefitPosition = {};
      if (this.rendered) this._refit(nextPosition);
    });
    return true;
  }
}
