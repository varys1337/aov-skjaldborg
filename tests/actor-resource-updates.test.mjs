import assert from "node:assert/strict";

Object.assign(globalThis, {
  game: {
    i18n: {
      lang: "en",
      localize: key => key === "TYPES.Item.wound" ? "Wound" : key
    }
  }
});

const { AoVAdapter } = await import("../scripts/adapter/aov-adapter.mjs");

function makeItem(id, type, system = {}, sort = 0, name = id) {
  return { id, type, system: { ...system }, sort, name };
}

function makeActor({ type, hp, mp = { value: 4, max: 8, availMax: 6 }, items = [] }) {
  const calls = [];
  const actor = {
    id: "actor-1",
    type,
    isOwner: true,
    system: { hp: { ...hp }, mp: { ...mp } },
    items,
    async update(data) {
      calls.push(["update", data]);
      if (Object.hasOwn(data, "system.mp.value")) this.system.mp.value = data["system.mp.value"];
      return this;
    },
    async updateEmbeddedDocuments(documentName, updates) {
      calls.push(["updateEmbeddedDocuments", documentName, updates]);
      for (const update of updates) {
        const item = this.items.find(candidate => candidate.id === update._id);
        if (!item) continue;
        if (Object.hasOwn(update, "system.damage")) item.system.damage = update["system.damage"];
        if (Object.hasOwn(update, "system.npcDmg")) item.system.npcDmg = update["system.npcDmg"];
      }
      return updates;
    },
    async deleteEmbeddedDocuments(documentName, ids) {
      calls.push(["deleteEmbeddedDocuments", documentName, ids]);
      this.items = this.items.filter(item => !ids.includes(item.id));
      return ids;
    },
    async createEmbeddedDocuments(documentName, data) {
      calls.push(["createEmbeddedDocuments", documentName, data]);
      return data;
    },
    calls
  };
  return actor;
}

{
  const actor = makeActor({ type: "character", hp: { value: 8, max: 12 } });
  await AoVAdapter.updateActorResource(actor, "mp", 99);
  assert.equal(actor.system.mp.value, 6, "MP must clamp to available maximum");
  assert.deepEqual(actor.calls[0], ["update", { "system.mp.value": 6 }]);
}

{
  const wound = makeItem("w1", "wound", { damage: 4, hitLocId: "general" });
  const location = makeItem("general", "hitloc", { locType: "general", npcDmg: 0 });
  const actor = makeActor({ type: "character", hp: { value: 8, max: 12 }, items: [location, wound] });
  await AoVAdapter.updateActorResource(actor, "hp", 10);
  assert.equal(wound.system.damage, 2, "character healing must reduce wound damage");
  assert.equal(actor.calls.some(call => call[0] === "update"), false, "derived character HP must not be updated directly");
}

{
  const location = makeItem("general", "hitloc", { locType: "general", npcDmg: 0 });
  const actor = makeActor({ type: "character", hp: { value: 12, max: 12 }, items: [location] });
  await AoVAdapter.updateActorResource(actor, "hp", 7);
  const create = actor.calls.find(call => call[0] === "createEmbeddedDocuments");
  assert.equal(create[1], "Item");
  assert.deepEqual(create[2][0].system, { damage: 5, hitLocId: "general" });
}

{
  const location = makeItem("torso", "hitloc", { locType: "torso", npcDmg: 3 });
  const actor = makeActor({ type: "npc", hp: { value: 9, max: 12 }, items: [location] });
  await AoVAdapter.updateActorResource(actor, "hp", 11);
  assert.equal(location.system.npcDmg, 1, "NPC healing must reduce hit location damage");
}

{
  const location = makeItem("general", "hitloc", { locType: "general", npcDmg: 1 });
  const actor = makeActor({ type: "npc", hp: { value: 11, max: 12 }, items: [location] });
  await AoVAdapter.updateActorResource(actor, "hp", 6);
  assert.equal(location.system.npcDmg, 6, "NPC damage must increase hit location damage");
}

process.stdout.write("actor resource update tests passed\n");
