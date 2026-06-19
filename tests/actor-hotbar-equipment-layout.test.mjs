import assert from "node:assert/strict";
import fs from "node:fs";

const hotbar = fs.readFileSync("scripts/apps/actor-hotbar.mjs", "utf8");
const catalog = fs.readFileSync("scripts/ui/action-catalog.mjs", "utf8");
const template = fs.readFileSync("templates/actor-hotbar.hbs", "utf8");
const css = fs.readFileSync("styles/skjadlborg.css", "utf8");
const language = JSON.parse(fs.readFileSync("lang/en.json", "utf8"));

assert.match(hotbar, /\{ id: "equip", label: "AOV_SKJADLBORG\.ActorHotbar\.Tabs\.Equip" \}/);
assert.match(hotbar, /prepareActorEquipment\(this\.actor\)/);
assert.match(hotbar, /showEquipTab/);
assert.match(hotbar, /_activateEquipmentEditing\(\)/);
assert.match(hotbar, /cycleActorEquipmentStatus\(this\.actor, target\.dataset\.equipmentId\)/);
assert.match(hotbar, /updateActorEquipmentQuantity\(this\.actor, itemId, input\.value\)/);

assert.match(catalog, /export function prepareActorEquipment\(actor\)/);
assert.match(catalog, /EQUIPMENT_ITEM_TYPES = new Set\(\["weapon", "gear", "armour"\]\)/);
assert.match(catalog, /item\.type === "weapon"/);
assert.match(catalog, /total: String\(finiteNumber\(item\.system\?\.total\)/);
assert.match(catalog, /item\.system\?\.special \? "\*" : ""/);
assert.match(catalog, /hitPoints: `\$\{currentHp \?\? 0\}\/\$\{maximumHp \?\? 0\}`/);
assert.match(catalog, /item\.type === "gear"/);
assert.match(catalog, /item\.type === "armour"/);
assert.match(catalog, /actor\.updateEmbeddedDocuments\("Item"/);
assert.match(catalog, /"system\.equipStatus": next/);
assert.match(catalog, /"system\.quantity": quantity/);

assert.match(template, /data-tab="equip"/);
assert.match(template, /skj-equipment-tab-panel/);
assert.match(template, /data-action="openEquipment"/);
assert.match(template, /skj-equipment-grid-weapon/);
assert.match(template, /EquipmentHeaders\.Percentage/);
assert.match(template, /EquipmentHeaders\.DamageBonus/);
assert.match(template, /data-action="activate" data-action-kind="item"/);
assert.match(template, /data-action="toggleEquipment"/);
assert.match(template, /data-equipment-quantity/);
assert.match(template, /skj-hotbar-header-row/);
const navIndex = template.indexOf('class="skj-hotbar-tabs tabs"');
const effectsIndex = template.indexOf('class="skj-effect-row"');
assert.ok(navIndex >= 0 && effectsIndex > navIndex);

assert.match(css, /\.skj-quick-slot\s*\{[^}]*height:\s*42px;/s);
assert.match(css, /\.skj-quick-slot\s*\{[^}]*width:\s*42px;/s);
assert.match(template, /skj-workflow-pips-combat/);
assert.match(css, /\.skj-workflow-pips\s*\{[^}]*margin:\s*6px auto 0;/s);
assert.match(css, /\.skj-equipment-groups/);
assert.match(css, /\.skj-equipment-grid-weapon/);
assert.match(css, /\.skj-equipment-grid-weapon\s*\{[^}]*grid-template-columns:/s);
assert.match(css, /\.skj-equipment-grid-armour/);
assert.equal(language.AOV_SKJADLBORG.ActorHotbar.Tabs.Equip, "Equipment");
assert.equal(language.AOV_SKJADLBORG.ActorHotbar.EquipmentHeaders.Damage, "Damage");
assert.equal(language.AOV_SKJADLBORG.ActorHotbar.EquipmentHeaders.HP, "HP");

assert.match(hotbar, /prepareReadiedWeaponState\(this\.actor\)/);
assert.match(hotbar, /data-readied-weapon-select/);
assert.match(hotbar, /requestGm\("adjustInitiative"/);
assert.match(hotbar, /static async onToggleReadiedWeapon/);
assert.match(hotbar, /static async onDropReadiedWeapon/);
assert.match(hotbar, /clearReadiedWeapon\(this\.actor\)/);
assert.match(catalog, /getReadiedWeapon\(actor\)\?\.id \?\? null/);
assert.match(template, /data-action="toggleReadiedWeapon"/);
assert.match(template, /data-action="dropReadiedWeapon"/);
assert.doesNotMatch(template, /data-action="drawWeapon"/);
assert.doesNotMatch(template, /data-action="sheatheWeapon"/);
assert.match(template, /skj-readied-weapon-label/);
assert.match(template, /skj-equipment-row skj-equipment-grid-weapon \{\{#if readied\}\}readied/);
assert.match(css, /\.skj-weapon-action-strip/);
assert.match(css, /\.skj-equipment-row\.readied/);
assert.equal(language.AOV_SKJADLBORG.Weapons.Draw, "Draw");
assert.equal(language.AOV_SKJADLBORG.Weapons.Sheathe, "Sheathe");
assert.equal(language.AOV_SKJADLBORG.Weapons.Drop, "Drop");
assert.equal(language.AOV_SKJADLBORG.Weapons.DropHint, "Clear the currently readied weapon without changing initiative.");

process.stdout.write("actor hotbar equipment and alignment tests passed\n");
