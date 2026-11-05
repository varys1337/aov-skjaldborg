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
const documentQueues = new Map();
const movementActivity = new Map();

function enqueueWrite(queues, key, metadata, operation, activity = null) {
  if (typeof operation !== "function") throw new TypeError("A queued document write requires an operation function.");
  const previous = queues.get(key)?.promise ?? Promise.resolve();
  activity?.();
  const promise = previous.catch(() => undefined).then(() => {
    activity?.();
    return operation();
  });
  queues.set(key, { ...metadata, promise });
  void promise.finally(() => {
    if (queues.get(key)?.promise === promise) queues.delete(key);
    activity?.();
  }).catch(() => undefined);
  return promise;
}

/** Serialize authoritative writes to an exact document, including chat claims. */
export function enqueueDocumentWrite(documentUuid, operation) {
  if (!documentUuid) throw new TypeError("A queued document write requires a UUID.");
  return enqueueWrite(documentQueues, String(documentUuid), {}, operation);
}

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
  const key = queueKey(combatId, combatantId);
  return enqueueWrite(combatantQueues, key, {
    combatId: combatId ?? null,
    combatantId: combatantId ?? null,
    movement
  }, operation, movement ? () => markMovementActivity(combatId) : null);
}

/**
 * Await all currently known queued Combatant writes for a Combat. The loop also
 * catches writes which were enqueued while an earlier batch was settling.
 *
 * @param {string|null|undefined} combatId Combat id.
 * @param {{deadline?: number}} [options={}] Optional absolute wait deadline.
 * @returns {Promise<boolean>} Whether all writes settled before the deadline.
 */
export async function awaitCombatantWrites(combatId, { deadline = Infinity } = {}) {
  if (!combatId) return true;
  while (true) {
    const pending = Array.from(combatantQueues.values())
      .filter(entry => entry.combatId === combatId)
      .map(entry => entry.promise);
    if (!pending.length) return true;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    if (!Number.isFinite(remaining)) {
      await Promise.allSettled(pending);
      continue;
    }
    let timer;
    try {
      const settled = await Promise.race([
        Promise.allSettled(pending).then(() => true),
        new Promise(resolve => { timer = globalThis.setTimeout(() => resolve(false), remaining); })
      ]);
      if (!settled) return false;
    } finally {
      globalThis.clearTimeout(timer);
    }
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
  quietMs = Math.max(0, Number(quietMs) || 0);
  const deadline = startedAt + Math.max(0, Number(timeoutMs) || 0);

  while (true) {
    if (!await awaitCombatantWrites(combatId, { deadline })) return false;

    const lastActivity = Math.max(startedAt, movementActivity.get(combatId) ?? 0);
    const quietFor = Date.now() - lastActivity;
    const hasPending = Array.from(combatantQueues.values()).some(entry => entry.combatId === combatId);
    if (!hasPending && quietFor >= quietMs) return true;
    if (Date.now() >= deadline) return false;

    await delay(Math.min(deadline - Date.now(), Math.max(1, Math.min(50, quietMs - quietFor))));
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
