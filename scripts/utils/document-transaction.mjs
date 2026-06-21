import { incrementCounter, measureAsync } from "../performance/performance-monitor.mjs";

export class DocumentTransaction {
  constructor() {
    this.itemUpdatesByActor = new Map();
    this.combatantUpdatesByCombat = new Map();
  }

  updateItem(actor, itemId, update) {
    if (!actor || !itemId || !update) return this;
    const updates = this.itemUpdatesByActor.get(actor) ?? [];
    updates.push({ _id: itemId, ...update });
    this.itemUpdatesByActor.set(actor, updates);
    return this;
  }

  updateCombatant(combat, combatantId, update) {
    if (!combat || !combatantId || !update) return this;
    const updates = this.combatantUpdatesByCombat.get(combat) ?? [];
    updates.push({ _id: combatantId, ...update });
    this.combatantUpdatesByCombat.set(combat, updates);
    return this;
  }

  get empty() {
    return !this.itemUpdatesByActor.size && !this.combatantUpdatesByCombat.size;
  }

  async commit(options = {}) {
    const results = [];
    await measureAsync("documentTransaction.commit", async () => {
      for (const [actor, updates] of this.itemUpdatesByActor.entries()) {
        incrementCounter("documentTransaction.items", updates.length);
        results.push(await actor.updateEmbeddedDocuments("Item", updates, options.itemOptions ?? {}));
      }
      for (const [combat, updates] of this.combatantUpdatesByCombat.entries()) {
        incrementCounter("documentTransaction.combatants", updates.length);
        results.push(await combat.updateEmbeddedDocuments("Combatant", updates, options.combatantOptions ?? {}));
      }
    }, () => ({
      actorGroups: this.itemUpdatesByActor.size,
      combatGroups: this.combatantUpdatesByCombat.size
    }));
    return results;
  }
}

export function createDocumentTransaction() {
  return new DocumentTransaction();
}
