/**
 * Create a small requestAnimationFrame-backed redraw scheduler.
 *
 * @param {Function} callback Redraw callback receiving the latest reason.
 * @param {object} [options={}] Test hooks for frame scheduling.
 * @returns {{schedule: function(string=): void, flush: function(string=): void, cancel: function(): void}}
 */
export function createRedrawScheduler(callback, options = {}) {
  let pending = false;
  let frameId = null;
  let lastReason = "";
  const requestFrame = options.requestFrame
    ?? globalThis.requestAnimationFrame
    ?? (fn => globalThis.setTimeout(fn, 16));
  const cancelFrame = options.cancelFrame
    ?? globalThis.cancelAnimationFrame
    ?? globalThis.clearTimeout;

  function clearPending() {
    if (pending && frameId !== null) cancelFrame(frameId);
    pending = false;
    frameId = null;
  }

  function flush(reason = "manual") {
    const flushReason = String(reason || lastReason || "manual");
    clearPending();
    lastReason = "";
    callback(flushReason);
  }

  function schedule(reason = "unknown") {
    lastReason = String(reason || "unknown");
    if (pending) return;
    pending = true;
    frameId = requestFrame(() => flush(lastReason));
  }

  function cancel() {
    clearPending();
    lastReason = "";
  }

  return { schedule, flush, cancel };
}
