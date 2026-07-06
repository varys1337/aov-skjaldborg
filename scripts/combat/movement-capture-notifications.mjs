import { performanceDiagnostics } from "../performance/performance-monitor.mjs";

const MOVEMENT_CAPTURE_NOTIFICATION_WINDOW_MS = 350;
const movementCaptureNotificationBatches = new Map();

/**
 * Batch movement-captured confirmations without flooding the UI during rapid
 * ruler corrections.
 *
 * @param {{combatId?: string|null, combatantId?: string|null, tokenId?: string|null}} detail Capture detail.
 * @returns {void}
 */
export function notifyMovementPlanCaptured(detail = {}) {
  const notificationKey = detail.combatId || "no-combat";
  const batch = movementCaptureNotificationBatches.get(notificationKey) ?? {
    combatantIds: new Set(),
    tokenIds: new Set(),
    count: 0,
    timer: null
  };
  batch.count += 1;
  if (detail.combatantId) batch.combatantIds.add(detail.combatantId);
  if (detail.tokenId) batch.tokenIds.add(detail.tokenId);
  if (batch.timer) {
    performanceDiagnostics.count("movement.capture.notification.suppressed", 1, {
      combatId: detail.combatId ?? null,
      combatantId: detail.combatantId ?? null,
      tokenId: detail.tokenId ?? null
    });
    return;
  }

  batch.timer = globalThis.setTimeout(() => {
    movementCaptureNotificationBatches.delete(notificationKey);
    const combatantCount = Math.max(batch.combatantIds.size, batch.tokenIds.size, batch.count);
    const message = combatantCount > 1
      ? game.i18n.format("AOV_SKJALDBORG.MovementAutomation.PlansCaptured", { count: combatantCount })
      : game.i18n.localize("AOV_SKJALDBORG.MovementAutomation.PlanCaptured");
    ui.notifications.info(message);
    performanceDiagnostics.count("movement.capture.notification.shown", 1, {
      combatId: detail.combatId ?? null,
      count: combatantCount
    });
  }, MOVEMENT_CAPTURE_NOTIFICATION_WINDOW_MS);

  movementCaptureNotificationBatches.set(notificationKey, batch);
}
