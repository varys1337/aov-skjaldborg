/**
 * Serialize GM-authoritative Combatant writes which originate from module
 * socket requests.
 *
 * Foundry socket listeners may begin handling several requests before an
 * earlier Document update has completed. Since Combatant flags are persisted
 * as one merged object, concurrent read/merge/write operations can otherwise
 * overwrite a newer movement revision with an older ruler draft.
 */

const combatantQueues = new Map();
const movementActivity = new Map();

/** @returns {Promise<void>} */
function delay(milliseconds) {
  return new Promise(resolve => globalThis.setTimeout(resolve, milliseconds));
}

/**
 * Build a stable queue key.
 *
 * @param {string|null|undefined} combatId Combat id.
 * @param {string|null|undefined} combatantId Combatant id.
 * @returns {string}
 */
function queueKey(combatId, combatantId) {
  return `${combatId ?? "no-combat"}:${combatantId ?? "no-combatant"}`;
}

/**
 * Record movement-channel activity for phase-entry synchronization.
 *
 * @param {string|null|undefined} combatId Combat id.
 * @returns {void}
 */
function markMovementActivity(combatId) {
  if (!combatId) return;
  movementActivity.set(combatId, Date.now());
}

/**
 * Enqueue one authoritative Combatant write after any prior write for the same
 * Combatant. Rejections are returned to the original caller without poisoning
 * later queue entries.
 *
 * @template T
 * @param {string|null|undefined} combatId Combat id.
 * @param {string|null|undefined} combatantId Combatant id.
 * @param {() => Promise<T>|T} operation Write operation.
 * @param {{movement?: boolean}} [options={}] Queue metadata.
 * @returns {Promise<T>}
 */
export function enqueueCombatantWrite(combatId, combatantId, operation, { movement = false } = {}) {
  if (typeof operation !== "function") throw new TypeError("A queued Combatant write requires an operation function.");

  const key = queueKey(combatId, combatantId);
  const previous = combatantQueues.get(key)?.promise ?? Promise.resolve();
  if (movement) markMovementActivity(combatId);

  const promise = previous
    .catch(() => undefined)
    .then(async () => {
      if (movement) markMovementActivity(combatId);
      return operation();
    });

  const entry = {
    combatId: combatId ?? null,
    combatantId: combatantId ?? null,
    movement,
    promise
  };
  combatantQueues.set(key, entry);

  void promise.finally(() => {
    if (combatantQueues.get(key)?.promise === promise) combatantQueues.delete(key);
    if (movement) markMovementActivity(combatId);
  }).catch(() => undefined);

  return promise;
}

/**
 * Await all currently known queued Combatant writes for a Combat. The loop also
 * catches writes which were enqueued while an earlier batch was settling.
 *
 * @param {string|null|undefined} combatId Combat id.
 * @returns {Promise<void>}
 */
export async function awaitCombatantWrites(combatId) {
  if (!combatId) return;
  while (true) {
    const pending = Array.from(combatantQueues.values())
      .filter(entry => entry.combatId === combatId)
      .map(entry => entry.promise);
    if (!pending.length) return;
    await Promise.allSettled(pending);
  }
}

/**
 * Wait for movement writes to become quiet before the GM snapshots plans for
 * Movement phase execution. A short quiet window catches socket requests which
 * are already in transit, while the hard deadline prevents a broken client
 * from holding phase progression indefinitely.
 *
 * @param {string|null|undefined} combatId Combat id.
 * @param {{quietMs?: number, timeoutMs?: number}} [options={}] Settle policy.
 * @returns {Promise<boolean>} Whether the queue reached a quiet state.
 */
export async function settleMovementWrites(combatId, { quietMs = 200, timeoutMs = 2000 } = {}) {
  if (!combatId) return true;
  const startedAt = Date.now();
  const deadline = startedAt + Math.max(quietMs, timeoutMs);

  while (true) {
    await awaitCombatantWrites(combatId);

    const lastActivity = Math.max(startedAt, movementActivity.get(combatId) ?? 0);
    const quietFor = Date.now() - lastActivity;
    const hasPending = Array.from(combatantQueues.values()).some(entry => entry.combatId === combatId);
    if (!hasPending && quietFor >= quietMs) return true;
    if (Date.now() >= deadline) return false;

    await delay(Math.max(10, Math.min(50, quietMs - quietFor)));
  }
}

/**
 * Test/debug helper exposing whether a Combat currently has queued writes.
 *
 * @param {string|null|undefined} combatId Combat id.
 * @returns {boolean}
 */
export function hasPendingCombatantWrites(combatId) {
  return Array.from(combatantQueues.values()).some(entry => entry.combatId === combatId);
}
