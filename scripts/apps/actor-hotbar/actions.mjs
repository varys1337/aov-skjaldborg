import { measureAsync } from "../../performance/performance-monitor.mjs";

/**
 * Lazy-load the Attack Roll dialog only when the Attack intent is invoked.
 *
 * @param {object} context Dialog context.
 * @returns {Promise<unknown>}
 */
export async function openAttackRollDialog(context) {
  return measureAsync("attackDialog.open", async () => {
    const { AttackRollDialog } = await import("../attack-roll-dialog.mjs");
    return AttackRollDialog.show(context);
  });
}

/**
 * Lazy-load the Missile Roll dialog only when the Missile intent is invoked.
 *
 * @param {object} context Dialog context.
 * @returns {Promise<unknown>}
 */
export async function openMissileRollDialog(context) {
  return measureAsync("missileDialog.open", async () => {
    const { MissileRollDialog } = await import("../missile-roll-dialog.mjs");
    return MissileRollDialog.show(context);
  });
}

export async function openDisengageDialog(context) {
  return measureAsync("disengageDialog.open", async () => {
    const { DisengageDialog } = await import("../disengage-dialog.mjs");
    return DisengageDialog.show(context);
  });
}

export async function openKnockbackRollDialog(context) {
  return measureAsync("knockbackDialog.open", async () => {
    const { KnockbackRollDialog } = await import("../knockback-roll-dialog.mjs");
    return KnockbackRollDialog.show(context);
  });
}

export async function openGrappleRollDialog(context) {
  return measureAsync("grappleDialog.open", async () => {
    const { GrappleRollDialog } = await import("../grapple-roll-dialog.mjs");
    return GrappleRollDialog.show(context);
  });
}

export async function openDelayDialog(context) {
  return measureAsync("delayDialog.open", async () => {
    const { DelayDialog } = await import("../delay-dialog.mjs");
    return DelayDialog.show(context);
  });
}

export async function openUtilityDialog(context) {
  return measureAsync("utilityDialog.open", async () => {
    const { UtilityDialog } = await import("../utility-dialog.mjs");
    return UtilityDialog.show(context);
  });
}

export async function openRunicMagicDialog(context) {
  return measureAsync("runicMagicDialog.open", async () => {
    const { RunicMagicDialog } = await import("../runic-magic-dialog.mjs");
    return RunicMagicDialog.show(context);
  });
}
