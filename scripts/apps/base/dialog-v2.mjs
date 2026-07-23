const { DialogV2 } = foundry.applications.api;

/**
 * DialogV2 base with coalesced Foundry 14.365 content refitting.
 *
 * Foundry 14.365 introduced ApplicationV2#_refit for applications whose
 * natural size changes without a complete render. The method is guarded so
 * the module retains its declared 14.363 minimum and simply keeps the earlier
 * automatic positioning behavior when the API is unavailable.
 */
export class SkjDialogV2 extends DialogV2 {
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
