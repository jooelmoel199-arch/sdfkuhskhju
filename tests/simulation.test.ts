function equal(actual: unknown, expected: unknown, message: string): void {
  if (actual !== expected) throw new Error(message + ` (expected ${String(expected)}, got ${String(actual)})`);
}

function ok(value: unknown, message: string): void {
  if (!value) throw new Error(message);
}

function deepEqualSet(actual: Set<unknown>, expected: Set<unknown>, message: string): void {
  if (actual.size !== expected.size || [...actual].some(value => !expected.has(value))) {
    throw new Error(message);
  }
}

import { createPrototypeState, createPvpTestState } from "../moba/factory";
import { advanceTick, tickRunner } from "../moba/simulation";
import { shopCatalog } from "../moba/economy";
import { distanceHitDelay, meleeHitTick, projectileHitTick } from "../combat/pendingHits";
import { rollDragonClawsSpecial } from "../combat/resolve";
import { zeroBonuses, effectiveDefenceLevel, effectiveAttackLevel } from "../combat/formulas";
import { drainPlayerCommands, enqueuePlayerCommand, makeStrongCommand } from "../combat/commandQueue";
import { queueClientCommand } from "../moba/simulation";

function testPrototypeShape() {
  const state = createPrototypeState();
  equal(state.players.length, 10, "prototype should have five players per team");
  deepEqualSet(new Set(state.players.map(player => player.role)), new Set(["top", "middle", "bottom", "support", "jungle"]), "roster should cover all five MOBA positions");
  equal(state.towers.length, 6, "prototype should have two towers per lane");
  equal(state.jungleCamps.length, 5, "prototype should have four jungle camps plus one river boss");
  equal(state.tick, 0, "simulation starts at tick zero");
}


function testPvpTestLane() {
  const state = createPvpTestState();
  equal(state.pvpTest, true, "PvP test state should be marked as test mode");
  equal(state.players.length, 2, "PvP test lane should contain exactly two players");
  equal(state.towers.length, 0, "PvP test lane should not contain towers");
  equal(state.minions.length, 0, "PvP test lane should not contain minions");
  equal(state.blue.currentHp, 99, "PvP test player should start at 99 HP");
  equal(state.blue.prayerPoints, 99, "PvP test player should start at 99 Prayer");
  ok(state.blue.inventory.some(item => item.id === "dragon_claws"), "PvP test loadout should contain dragon claws");
  ok(state.blue.inventory.some(item => item.id === "armadyl_godsword"), "PvP test loadout should contain AGS");
  ok(state.blue.inventory.some(item => item.id === "armadyl_crossbow"), "PvP test loadout should contain ACB");
  ok(state.blue.inventory.some(item => item.id === "ancient_staff"), "PvP test loadout should contain an ice spell weapon");
}

function testSameTickPrayerFlickConsumesNoPrayer() {
  const state = createPvpTestState();
  state.humanControl = { attackEnabled: false, laneId: "middle", attackTargetId: state.red.id };
  queueClientCommand(state, { kind: "prayer", prayerId: "protect_from_melee" });
  queueClientCommand(state, { kind: "prayer", prayerId: "protect_from_melee" });

  const before = state.blue.prayerPoints;
  advanceTick(state);
  advanceTick(state);

  equal(state.blue.prayerPoints, before, "activating and deactivating a prayer within one client tick should not drain prayer");
  ok(!state.blue.activePrayers.includes("protect_from_melee"), "same-tick prayer flick should finish inactive");
}

function testVengeanceCastIsIndependentOfAttackCycle() {
  const state = createPvpTestState();
  state.blue = {
    ...state.blue,
    attackTimer: { lastAttackTick: 0, weaponCooldownTicks: 6, additiveAttackDelayTicks: 0 },
    vengeanceActive: false,
    vengeanceCooldownUntilTick: 0
  };
  state.players = state.players.map(player => player.id === state.blue.id ? state.blue : player);
  queueClientCommand(state, { kind: "vengeance" });
  advanceTick(state);
  equal(state.blue.vengeanceActive, false, "Vengeance command should still be in client delivery on the first tick");

  advanceTick(state);
  equal(state.blue.vengeanceActive, true, "Vengeance should activate on its client-input tick");
  equal(state.blue.attackTimer.lastAttackTick, 0, "Vengeance cast should not alter the attack cycle");
  equal(state.blue.vengeanceCooldownUntilTick, 51, "Vengeance should set a 50-tick cooldown from its cast tick");
}

function testVengeanceReflectsAndConsumesOnImpact() {
  const state = createPvpTestState();
  state.red = {
    ...state.red,
    equipment: { ...state.red.equipment, weapon: undefined },
    activePrayers: [],
    currentHp: 99,
    vengeanceActive: true,
    vengeanceCooldownUntilTick: 999,
    vengeanceExpiresAtTick: 50
  };
  state.blue = {
    ...state.blue,
    equipment: { ...state.blue.equipment, weapon: undefined },
    currentHp: 99
  };
  state.players = state.players.map(player =>
    player.id === state.red.id ? state.red :
    player.id === state.blue.id ? state.blue : player
  );
  state.humanControl = { attackEnabled: false, laneId: "middle", attackTargetId: state.red.id };
  state.pendingHits.push({
    id: "vengeance-impact-test",
    dueTick: 0,
    attackerId: state.blue.id,
    targetId: state.red.id,
    attackerPid: state.blue.pid,
    targetPid: state.red.pid,
    style: "slash",
    attackType: "aggressive",
    landed: true,
    hitChance: 1,
    rawDamage: 20,
    createdTick: 0
  });

  advanceTick(state);

  equal(state.red.currentHp, 79, "Vengeance should not reduce the damage taken by its owner");
  equal(state.blue.currentHp, 84, "Vengeance should reflect 75 percent of actual damage");
  equal(state.red.vengeanceActive, false, "Vengeance should be consumed by the first successful damaging hit");
  ok(
    state.combatEvents.some(event =>
      event.vengeance === true &&
      event.attackerId === state.red.id &&
      event.targetId === state.blue.id &&
      event.damage === 15
    ),
    "Vengeance reflection should be represented as a reactive combat event"
  );
}

function testVengeanceCooldownBlocksRecast() {
  const state = createPvpTestState();
  state.blue = {
    ...state.blue,
    vengeanceActive: false,
    vengeanceCooldownUntilTick: 20
  };
  state.players = state.players.map(player => player.id === state.blue.id ? state.blue : player);
  queueClientCommand(state, { kind: "vengeance" }, false);
  advanceTick(state);
  equal(state.blue.vengeanceActive, false, "Vengeance should not reactivate while its cooldown is running");
  equal(state.blue.vengeanceCooldownUntilTick, 20, "failed Vengeance cast should preserve its cooldown");
}

function testHumanPrayerInputIsOneShot() {
  const state = createPvpTestState();
  state.humanControl = {
    attackEnabled: false,
    laneId: "middle",
    attackTargetId: state.red.id,
    activatePrayer: "protect_from_melee"
  };
  advanceTick(state);
  ok(state.blue.activePrayers.includes("protect_from_melee"), "prayer input should activate overhead");
  advanceTick(state);
  ok(state.blue.activePrayers.includes("protect_from_melee"), "prayer should remain active until another explicit toggle");
}

function testQueuedHitResolvesOnTargetTurn() {
  const state = createPvpTestState();
  state.red = { ...state.red, equipment: { ...state.red.equipment, weapon: undefined }, activePrayers: [] };
  state.players = state.players.map(player => player.id === state.red.id ? state.red : player);
  state.pendingHits.push({
    id: "test-hit",
    dueTick: 0,
    attackerId: state.blue.id,
    targetId: state.red.id,
    attackerPid: state.blue.pid,
    targetPid: state.red.pid,
    style: "slash",
    attackType: "aggressive",
    landed: true,
    hitChance: 1,
    rawDamage: 99,
    createdTick: 0
  });
  state.humanControl = { attackEnabled: false, laneId: "middle", attackTargetId: state.red.id };
  advanceTick(state);
  equal(state.red.alive, true, "lethal hitsplat should leave death queued until the following tick");
  equal(state.red.currentHp, 0, "lethal hitsplat should set HP to zero before death resolves");
  equal(state.red.kills, 0, "zero-HP queued-death target must not retaliate");

  advanceTick(state);
  equal(state.red.alive, false, "queued death should resolve before the target's next combat turn");
}

function testGearSwapCanAttackSameTick() {
  const state = createPvpTestState();
  state.blue = {
    ...state.blue,
    tile: { x: 19, y: state.blue.tile.y },
    attackTimer: { lastAttackTick: -10, weaponCooldownTicks: 0, additiveAttackDelayTicks: 0 }
  };
  state.players = state.players.map(player => player.id === state.blue.id ? state.blue : player);
  state.red = { ...state.red, tile: { x: 20, y: state.red.tile.y } };
  state.players = state.players.map(player => player.id === state.red.id ? state.red : player);
  state.humanControl = {
    attackEnabled: true,
    laneId: "middle",
    attackTargetId: state.red.id,
    equipItemId: "armadyl_godsword"
  };
  advanceTick(state);
  equal(state.blue.equipment.weapon?.id, "armadyl_godsword", "AGS should equip on the input tick");
  ok(state.pendingHits.length > 0 || state.combatEvents.some(event => event.attackerId === state.blue.id),
    "gear switch should not consume the entire player turn");
  equal(state.blue.attackType, "aggressive", "AGS should select its default aggressive style");
}

function testFoodAddsToCombatTimer() {
  const state = createPvpTestState();
  state.blue = {
    ...state.blue,
    attackTimer: { lastAttackTick: 0, weaponCooldownTicks: 4, additiveAttackDelayTicks: 0 }
  };
  state.players = state.players.map(player => player.id === state.blue.id ? state.blue : player);
  const startingSharks = state.blue.inventory.find(item => item.id === "shark")?.quantity ?? 0;
  state.humanControl = {
    attackEnabled: true,
    laneId: "middle",
    attackTargetId: state.red.id,
    consumeItemId: "shark"
  };
  state.blue = {
    ...state.blue,
    attackTimer: { lastAttackTick: 0, weaponCooldownTicks: 4, additiveAttackDelayTicks: 0 },
    eatDelayUntilTick: 0
  };
  state.players = state.players.map(player => player.id === state.blue.id ? state.blue : player);
  advanceTick(state);
  equal(state.blue.inventory.find(item => item.id === "shark")?.quantity, startingSharks - 1, "shark should be consumed once");
  equal(state.blue.attackTimer.additiveAttackDelayTicks, 3, "shark should add three ticks to the attack cycle");
}

function testPotionDoesNotDelayAttackCycle() {
  const state = createPvpTestState();
  state.blue = {
    ...state.blue,
    attackTimer: { lastAttackTick: 0, weaponCooldownTicks: 4, additiveAttackDelayTicks: 0 }
  };
  state.players = state.players.map(player => player.id === state.blue.id ? state.blue : player);
  const starting = state.blue.inventory.find(item => item.id === "prayer_potion")?.quantity ?? 0;
  state.humanControl = { attackEnabled: false, laneId: "middle" };
  queueClientCommand(state, { kind: "eat", itemId: "prayer_potion" }, false);
  advanceTick(state);

  equal(state.blue.inventory.find(item => item.id === "prayer_potion")?.quantity, starting - 1, "potion should be consumed");
  equal(state.blue.attackTimer.additiveAttackDelayTicks, 0, "drinking a potion should not add an attack-cycle delay");
  equal(state.blue.potionDelayUntilTick, 3, "potion consumption should start its separate three-tick repeat timer");
}

function testFoodAndPotionCanChainInOneTick() {
  const state = createPvpTestState();
  const startingSharks = state.blue.inventory.find(item => item.id === "shark")?.quantity ?? 0;
  const startingPots = state.blue.inventory.find(item => item.id === "prayer_potion")?.quantity ?? 0;
  state.humanControl = { attackEnabled: false, laneId: "middle" };

  queueClientCommand(state, { kind: "eat", itemId: "shark" }, false);
  queueClientCommand(state, { kind: "eat", itemId: "prayer_potion" }, false);
  advanceTick(state);

  equal(state.blue.inventory.find(item => item.id === "shark")?.quantity, startingSharks - 1, "food should be consumed before the potion");
  equal(state.blue.inventory.find(item => item.id === "prayer_potion")?.quantity, startingPots - 1, "potion should be chainable after food");
  equal(state.blue.potionDelayUntilTick, 3, "chained potion should start its own repeat timer");
}

function testPotionThenFoodIsBlockedByPotionActionDelay() {
  const state = createPvpTestState();
  const startingSharks = state.blue.inventory.find(item => item.id === "shark")?.quantity ?? 0;
  const startingPots = state.blue.inventory.find(item => item.id === "prayer_potion")?.quantity ?? 0;
  state.humanControl = { attackEnabled: false, laneId: "middle" };

  queueClientCommand(state, { kind: "eat", itemId: "prayer_potion" }, false);
  queueClientCommand(state, { kind: "eat", itemId: "shark" }, false);
  advanceTick(state);

  equal(state.blue.inventory.find(item => item.id === "prayer_potion")?.quantity, startingPots - 1, "potion should be consumed");
  equal(state.blue.inventory.find(item => item.id === "shark")?.quantity, startingSharks, "normal food should be blocked immediately after a potion");
}

function testKarambwanCombo() {
  const state = createPvpTestState();
  state.blue = {
    ...state.blue,
    attackTimer: { lastAttackTick: 0, weaponCooldownTicks: 4, additiveAttackDelayTicks: 0 }
  };
  state.players = state.players.map(player => player.id === state.blue.id ? state.blue : player);
  const startingSharks = state.blue.inventory.find(item => item.id === "shark")?.quantity ?? 0;
  const startingKarambwans = state.blue.inventory.find(item => item.id === "karambwan")?.quantity ?? 0;
  state.humanControl = {
    attackEnabled: true,
    laneId: "middle",
    attackTargetId: state.red.id,
    consumeItemId: "shark",
    comboConsumableId: "karambwan"
  };
  advanceTick(state);
  equal(state.blue.inventory.find(item => item.id === "shark")?.quantity, startingSharks - 1, "combo shark should be consumed");
  equal(state.blue.inventory.find(item => item.id === "karambwan")?.quantity, startingKarambwans - 1, "karambwan should be consumed on the same tick");
  equal(state.blue.attackTimer.additiveAttackDelayTicks, 5, "shark plus karambwan should add five ticks");
}

function testWaveCadence() {
  const state = createPrototypeState();
  for (let i = 0; i < 16; i += 1) advanceTick(state);
  equal(state.tick, 16, "16 simulation steps should advance through authoritative tick 15");
  equal(state.minions.length, 18, "one three-lane wave should create 18 minions");
  deepEqualSet(new Set(state.minions.map(minion => minion.laneId)), new Set(["top", "middle", "bottom"]), "wave should populate all lanes");
}

function testProjectileDelay() {
  const state = createPvpTestState();
  const rangedWeapon = shopCatalog.find(item => item.id === "magic_shortbow");
  ok(rangedWeapon, "magic shortbow should exist in shop");
  state.blue = {
    ...state.blue,
    tile: { x: 10, y: 20 },
    zone: "lane",
    equipment: { ...state.blue.equipment, weapon: { ...rangedWeapon, attackRange: 8 } },
    attackType: "rapid_ranged"
  };
  state.players = state.players.map(player => player.id === state.blue.id ? state.blue : player);
  state.players = state.players.map(player => player.id === state.red.id ? { ...player, tile: { x: 20, y: 20 }, zone: "lane" } : player);
  state.red = state.players.find(player => player.id === state.red.id)!;
  state.humanControl = {
    attackEnabled: true,
    laneId: "middle",
    attackTargetId: state.red.id
  };
  queueClientCommand(state, { kind: "attack-target", targetId: state.red.id });
  queueClientCommand(state, { kind: "move", x: state.red.tile.x, y: state.red.tile.y });
  state.rng = (() => {
    let call = 0;
    return () => (call++ % 2 === 0 ? 0 : 0.999999);
  })();

  advanceTick(state);
  advanceTick(state);
  if (state.projectiles.length !== 1) {
    throw new Error(
      "ranged attack should create a projectile; blue=" + JSON.stringify(state.blue.tile) +
      " red=" + JSON.stringify(state.red.tile) +
      " gate context logs=" + state.log.slice(-12).map(entry => "[" + entry.tick + "] " + entry.message).join(" | ")
    );
  }
  equal(state.projectiles[0].hitTick - state.projectiles[0].createdTick, 3, "8-tile bow projectile should use a 3-tick hit delay");
}

function testOsrsHitTiming() {
  equal(distanceHitDelay("ranged", 1), 2, "bows should hit in 2 ticks at distance 1");
  equal(distanceHitDelay("ranged", 8), 3, "bows should hit in 3 ticks at distance 8");
  equal(distanceHitDelay("ranged", 9), 4, "bows should hit in 4 ticks at distance 9");
  equal(distanceHitDelay("ranged", 2), 2, "bows should hit in 2 ticks at distance 2");
  equal(distanceHitDelay("ranged", 3), 3, "bows should hit in 3 ticks at distance 3");
  equal(distanceHitDelay("magic", 2), 3, "magic should hit in 3 ticks at distance 2");
  equal(distanceHitDelay("magic", 8), 5, "magic should hit in 5 ticks at distance 8");
  equal(distanceHitDelay("magic", 1), 2, "magic should hit in 2 ticks at distance 1");
  equal(distanceHitDelay("magic", 4), 3, "magic should hit in 3 ticks at distance 4");
  equal(distanceHitDelay("magic", 5), 4, "magic should hit in 4 ticks at distance 5");
  equal(meleeHitTick(10, 1, 2), 10, "higher-priority attacker should land melee damage on the same tick");
  equal(meleeHitTick(10, 2, 1), 11, "lower-priority attacker should incur a one-tick processing delay");
  equal(projectileHitTick(10, "ranged", 8, 1, 2), 13, "higher-priority ranged attack uses the 3-tick projectile delay");
  equal(projectileHitTick(10, "ranged", 8, 2, 1), 14, "lower-priority ranged attack gets the processing-order tick");
}

function testPlayerMagicFormula() {
  const levels = { attack: 70, strength: 70, defence: 70, ranged: 70, magic: 80 };
  equal(effectiveAttackLevel(levels, "magic", "accurate", 1), 88, "player spell accuracy should use Magic level + 8");
  equal(effectiveDefenceLevel(levels, "magic", "accurate", 1, 1), 85, "player magic defence should be 70% Magic + 30% Defence + 8");
}

function testDragonClawsSpecial() {
  const result = rollDragonClawsSpecial({
    style: "slash",
    attackType: "aggressive",
    attackerLevels: { attack: 99, strength: 99, defence: 99, ranged: 99, magic: 99 },
    defenderLevels: { attack: 1, strength: 1, defence: 1, ranged: 1, magic: 1 },
    attackerBonuses: { ...zeroBonuses, slash_attack_bonus: 132, melee_strength_bonus: 114 },
    defenderBonuses: { ...zeroBonuses },
    defenderPrayers: [],
    attackerIsPlayer: true,
    rng: () => 0
  });
  equal(result.damages.length, 4, "Dragon claws should generate four hitsplats");
  ok(result.damages.every(damage => damage >= 0), "Dragon claws damage should never be negative");
  ok(result.damages.reduce((sum, damage) => sum + damage, 0) > 0, "Dragon claws should land against a very low defence target");
}

function testQueuedHitUsesImpactPrayer() {
  const state = createPvpTestState();
  state.blue = { ...state.blue, currentHp: 99, tile: { x: 19, y: state.blue.tile.y } };
  state.red = {
    ...state.red,
    currentHp: 99,
    tile: { x: 20, y: state.red.tile.y },
    activePrayers: [],
    equipment: { ...state.red.equipment, weapon: undefined }
  };
  state.players = state.players.map(player =>
    player.id === state.blue.id ? state.blue :
    player.id === state.red.id ? state.red : player
  );
  state.pendingHits.push({
    id: "impact-prayer-test",
    dueTick: 1,
    attackerId: state.red.id,
    targetId: state.blue.id,
    attackerPid: state.red.pid,
    targetPid: state.blue.pid,
    style: "ranged",
    attackType: "rapid_ranged",
    landed: true,
    hitChance: 1,
    rawDamage: 20,
    createdTick: 0
  });
  state.humanControl = { attackEnabled: false, laneId: "middle", attackTargetId: state.red.id };

  advanceTick(state);
  queueClientCommand(state, { kind: "prayer", prayerId: "protect_from_missiles" }, false);
  advanceTick(state);

  equal(state.blue.currentHp, 87, "missile protection should reduce a queued 20 damage hit to 12 at impact");
}





function testPidTurnPreventsDeadPlayerAction() {
  const state = createPvpTestState();
  ok(state.red.equipment.weapon, "red dummy should start with a weapon");
  state.blue = {
    ...state.blue,
    tile: { x: 19, y: state.blue.tile.y },
    attackTimer: { lastAttackTick: -10, weaponCooldownTicks: 4, additiveAttackDelayTicks: 0 }
  };
  state.red = {
    ...state.red,
    tile: { x: 20, y: state.red.tile.y },
    attackTimer: { lastAttackTick: -10, weaponCooldownTicks: 4, additiveAttackDelayTicks: 0 },
    currentHp: 1
  };
  state.players = state.players.map(player =>
    player.id === state.blue.id ? state.blue :
    player.id === state.red.id ? state.red : player
  );
  state.pidOrder = [state.blue.id, state.red.id];
  state.pendingHits.push({
    id: "pid-turn-lethal",
    dueTick: 0,
    attackerId: state.blue.id,
    targetId: state.red.id,
    attackerPid: state.blue.pid,
    targetPid: state.red.pid,
    style: "slash",
    attackType: "aggressive",
    landed: true,
    hitChance: 1,
    rawDamage: 10,
    createdTick: 0
  });
  state.humanControl = {
    attackEnabled: true,
    laneId: "middle",
    attackTargetId: state.red.id
  };

  advanceTick(state);

  ok(state.red.alive && state.red.currentHp === 0, "lethal damage should leave the lower-PID player at zero HP until the next tick");
  ok(
    !state.combatEvents.some(event => event.tick === 0 && event.attackerId === state.red.id),
    "a player reduced to zero during its PID turn must not execute combat later that tick"
  );

  advanceTick(state);
  ok(!state.red.alive, "queued death should resolve on the following tick");
}

function testPidTurnRunsPrayerBeforeIncomingImpact() {
  const state = createPvpTestState();
  state.blue = { ...state.blue, currentHp: 99, tile: { x: 19, y: state.blue.tile.y }, activePrayers: [] };
  state.red = { ...state.red, tile: { x: 20, y: state.red.tile.y }, equipment: { ...state.red.equipment, weapon: undefined } };
  state.players = state.players.map(player =>
    player.id === state.blue.id ? state.blue :
    player.id === state.red.id ? state.red : player
  );
  state.pidOrder = [state.red.id, state.blue.id];
  state.pendingHits.push({
    id: "pid-prayer-order",
    dueTick: 0,
    attackerId: state.red.id,
    targetId: state.blue.id,
    attackerPid: state.red.pid,
    targetPid: state.blue.pid,
    style: "ranged",
    attackType: "rapid_ranged",
    landed: true,
    hitChance: 1,
    rawDamage: 20,
    createdTick: 0
  });
  state.humanControl = {
    attackEnabled: false,
    laneId: "middle",
    attackTargetId: state.red.id,
    activatePrayer: "protect_from_missiles"
  };

  advanceTick(state);

  equal(state.blue.currentHp, 87, "the target's prayer command must execute before its queued impact on its PID turn");
}

function testPvPDummyProvidesIncomingPressure() {
  const state = createPvpTestState();
  state.humanControl = { attackEnabled: false, laneId: "middle", attackTargetId: state.red.id };
  advanceTick(state);
  ok(state.red.activePrayers.includes("protect_from_melee"), "dummy should use a defensive prayer for its melee weapon");
  for (let i = 0; i < 5; i += 1) advanceTick(state);
  ok(
    state.pendingHits.some(hit => hit.attackerId === state.red.id) ||
    state.combatEvents.some(event => event.attackerId === state.red.id),
    "active PvP dummy should eventually produce incoming damage"
  );
}

function testMissedFreezeDoesNotApply() {
  const state = createPvpTestState();
  state.pendingHits.push({
    id: "missed-freeze-test",
    dueTick: 1,
    attackerId: state.blue.id,
    targetId: state.red.id,
    attackerPid: state.blue.pid,
    targetPid: state.red.pid,
    style: "magic",
    attackType: "accurate",
    landed: false,
    hitChance: 0,
    rawDamage: 0,
    freezeTicks: 20,
    createdTick: 0
  });
  state.humanControl = { attackEnabled: false, laneId: "middle", attackTargetId: state.red.id };
  advanceTick(state);
  advanceTick(state);
  equal(state.red.locks.freezeUntilTick, -1, "a missed ice spell must not freeze its target");
}

function testDragonClawsExposeRawDamageForImpactPrayer() {
  const result = rollDragonClawsSpecial({
    style: "slash",
    attackType: "aggressive",
    attackerLevels: { attack: 99, strength: 99, defence: 99, ranged: 99, magic: 99 },
    defenderLevels: { attack: 1, strength: 1, defence: 1, ranged: 1, magic: 1 },
    attackerBonuses: { ...zeroBonuses, slash_attack_bonus: 132, melee_strength_bonus: 114 },
    defenderBonuses: { ...zeroBonuses },
    defenderPrayers: ["protect_from_melee"],
    attackerIsPlayer: true,
    rng: () => 0
  });
  equal(result.rawDamages.length, 4, "Dragon claws should expose four raw impact values");
  equal(result.damages.reduce((sum, damage) => sum + damage, 0),
    result.rawDamages.reduce((sum, damage) => sum + Math.floor(damage * 0.6), 0),
    "launch-time prayer view should remain consistent with raw claws damage");
}


function testFoodBeforeReadyAttackDoesNotCreateCooldown() {
  const state = createPvpTestState();
  state.blue = {
    ...state.blue,
    attackTimer: { lastAttackTick: 0, weaponCooldownTicks: 0, additiveAttackDelayTicks: 0 }
  };
  state.players = state.players.map(player => player.id === state.blue.id ? state.blue : player);
  state.humanControl = {
    attackEnabled: false,
    laneId: "middle",
    attackTargetId: state.red.id,
    consumeItemId: "shark"
  };

  advanceTick(state);

  equal(state.blue.attackTimer.additiveAttackDelayTicks, 0,
    "eating while the attack cycle is ready must not create a new attack delay");
}

function testClientCommandQueueIsFifoAndCapped() {
  const first = makeStrongCommand({ kind: "equip", itemId: "abyssal_whip" }, 1, 0, 0);
  const weak = {
    kind: "special" as const,
    targetId: "red-dummy",
    priority: "weak" as const,
    id: "weak-2",
    sequence: 2,
    issuedTick: 0,
    executeTick: 0
  };
  const interrupted = enqueuePlayerCommand([first, weak], makeStrongCommand({ kind: "prayer", prayerId: "protect_from_melee" }, 3, 0, 0));
  ok(!interrupted.some(command => command.priority === "weak"), "a strong client command should interrupt stale weak queue entries");

  let queue = interrupted;
  for (let sequence = 4; sequence <= 15; sequence += 1) {
    queue = enqueuePlayerCommand(queue, makeStrongCommand({ kind: "special", targetId: "red-dummy" }, sequence, 0, 0));
  }
  const drained = drainPlayerCommands(queue, 0, 10);
  equal(drained.commands.length, 10, "client input should process at most ten queued commands per tick");
  equal(drained.queue.length, queue.length - 10, "commands beyond the client-input cap must remain queued");
  ok(
    drained.commands.every((command, index) => index === 0 || command.sequence > drained.commands[index - 1].sequence),
    "client input commands should preserve FIFO sequence"
  );
}

function testTargetMemoryExpiresAfterFiveTicks() {
  const state = createPvpTestState();
  state.humanControl = { attackEnabled: false, laneId: "middle" };
  queueClientCommand(state, { kind: "attack-target", targetId: state.red.id });

  advanceTick(state);
  equal(state.blue.lastTargetId, undefined, "target command should still be in client delivery on the first tick");
  advanceTick(state);

  equal(state.blue.lastTargetId, state.red.id, "target interaction should remember the selected target");
  equal(state.blue.lastTargetTimeoutTicks, 5, "target memory should start at five ticks when the interaction is processed");

  for (let tick = 0; tick < 5; tick += 1) advanceTick(state);

  equal(state.blue.lastTargetId, undefined, "target memory should expire after five subsequent ticks");
  equal(state.blue.lastTargetTimeoutTicks, 0, "expired target memory should clear its timeout");
}


function testQueuedAttackTargetHasOneTickLatency() {
  const state = createPvpTestState();
  state.humanControl = { attackEnabled: true, laneId: "middle" };
  const targetId = state.red.id;
  queueClientCommand(state, { kind: "attack-target", targetId });

  advanceTick(state);
  equal(state.humanControl?.attackTargetId, undefined, "attack target should not be selected before the next client-input tick");

  advanceTick(state);
  equal(state.humanControl?.attackTargetId, targetId, "attack target should become active when queued client input is processed");
}

function testQueuedMovementAndAttackPreserveFifo() {
  const state = createPvpTestState();
  queueClientCommand(state, { kind: "attack-target", targetId: state.red.id });
  queueClientCommand(state, { kind: "move", x: 18, y: state.blue.tile.y });

  advanceTick(state);
  advanceTick(state);
  equal(state.humanControl?.attackTargetId, state.red.id, "queued attack selection should execute in sequence");
  equal(state.humanControl?.moveTargetX, 18, "queued movement should execute after the target command in FIFO order");
}

function testClientCommandHasOneTickInputLatency() {
  const state = createPvpTestState();
  ok(state.blue.equipment.weapon?.id === "rune_scimitar", "fixture should begin with rune scimitar equipped");
  queueClientCommand(state, { kind: "equip", itemId: "abyssal_whip" });

  advanceTick(state);
  equal(state.blue.equipment.weapon?.id, "rune_scimitar", "a command clicked during the current tick should not execute until the next server tick");

  advanceTick(state);
  equal(state.blue.equipment.weapon?.id, "abyssal_whip", "the queued client command should execute on the following server tick");
}

function testStandardSpecialQueuesUntilAttackCycleIsReady() {
  const state = createPvpTestState();
  state.red = { ...state.red, equipment: { ...state.red.equipment, weapon: undefined } };
  state.players = state.players.map(player => player.id === state.red.id ? state.red : player);
  state.blue = {
    ...state.blue,
    equipment: {
      ...state.blue.equipment,
      weapon: shopCatalog.find(item => item.id === "armadyl_godsword")
    },
    attackTimer: { lastAttackTick: 0, weaponCooldownTicks: 6, additiveAttackDelayTicks: 0 },
    specEnergy: 100
  };
  state.players = state.players.map(player => player.id === state.blue.id ? state.blue : player);
  state.humanControl = { attackEnabled: true, laneId: "middle", attackTargetId: state.red.id };
  queueClientCommand(state, { kind: "special" });

  advanceTick(state);
  equal(state.blue.specialActive, false, "the click itself is still in the client input queue on the first server tick");
  equal(state.clientCommands[state.blue.id]?.length, 1, "special input should have one tick of delivery latency");

  advanceTick(state);
  equal(state.blue.specialActive, true, "delivered special input should arm the standard special bar");
  equal(state.blue.specEnergy, 100, "arming a standard special should not spend energy while the weapon is on cooldown");

  for (let tick = 0; tick < 6; tick += 1) advanceTick(state);
  equal(state.blue.specialActive, false, "standard special should deactivate after the special attack executes");
  equal(state.blue.specEnergy, 50.1, "standard special should spend 50 energy and then regenerate on later ticks");
}

function testGraniteMaulSpecialDoesNotPersistOutOfReach() {
  const state = createPvpTestState();
  state.red = {
    ...state.red,
    equipment: { ...state.red.equipment, weapon: undefined },
    tile: { x: 35, y: state.red.tile.y }
  };
  state.blue = {
    ...state.blue,
    tile: { x: 5, y: state.blue.tile.y },
    equipment: {
      ...state.blue.equipment,
      weapon: shopCatalog.find(item => item.id === "granite_maul")
    }
  };
  state.players = state.players.map(player =>
    player.id === state.blue.id ? state.blue :
    player.id === state.red.id ? state.red : player
  );
  state.humanControl = { attackEnabled: true, laneId: "middle", attackTargetId: state.red.id };

  // Two bar clicks arm the short-lived double-spec preload even when the target
  // is currently outside melee range.
  queueClientCommand(state, { kind: "special" }, false);
  queueClientCommand(state, { kind: "special" }, false);
  advanceTick(state);

  equal(state.blue.specialActive, false, "the second Gmaul bar click should turn the active bar off");
  equal(state.blue.gmaulPreloaded, true, "two Gmaul clicks should create the short preload state");
  equal(state.blue.queuedSpecialAttacks, 0, "preloading should not create a phantom impact while out of reach");
}


function testGraniteMaulSpecialIgnoresAttackCooldown() {
  const state = createPvpTestState();
  state.blue = {
    ...state.blue,
    tile: { x: 19, y: state.blue.tile.y },
    attackTimer: { lastAttackTick: 0, weaponCooldownTicks: 7, additiveAttackDelayTicks: 0 },
    equipment: { ...state.blue.equipment, weapon: shopCatalog.find(item => item.id === "granite_maul") }
  };
  state.red = {
    ...state.red,
    tile: { x: 20, y: state.red.tile.y },
    activePrayers: [],
    equipment: { ...state.red.equipment, weapon: undefined }
  };
  state.players = state.players.map(player =>
    player.id === state.blue.id ? state.blue :
    player.id === state.red.id ? state.red : player
  );
  state.humanControl = { attackEnabled: true, laneId: "middle", attackTargetId: state.red.id };

  queueClientCommand(state, { kind: "special" }, false);
  advanceTick(state);

  equal(state.blue.specialActive, true, "first Gmaul bar click should activate the special");
  equal(state.blue.specEnergy, 100, "arming the Gmaul should not spend energy");
  equal(state.blue.attackTimer.lastAttackTick, 0, "arming the Gmaul should not touch the normal attack cycle");

  queueClientCommand(state, { kind: "attack-target", targetId: state.red.id }, false);
  advanceTick(state);

  equal(state.blue.specEnergy, 50, "target click should release one Gmaul Quick Smash");
  equal(state.blue.attackTimer.lastAttackTick, 0, "Gmaul special should not start the normal 7-tick cycle");
  equal(state.blue.specialActive, false, "Gmaul should deactivate after firing");
  advanceTick(state);
  ok(
    state.combatEvents.some(event =>
      event.attackerId === state.blue.id &&
      event.targetId === state.red.id &&
      event.special === true
    ),
    "Gmaul special should create a marked special impact"
  );
}

function testGraniteMaulDoubleSpecConsumesTwoQueues() {
  const state = createPvpTestState();
  state.blue = {
    ...state.blue,
    tile: { x: 19, y: state.blue.tile.y },
    equipment: { ...state.blue.equipment, weapon: shopCatalog.find(item => item.id === "granite_maul") },
    gmaulEquippedTick: 0,
    gmaulSpecBarVisibleTick: 0,
    attackTimer: { lastAttackTick: 0, weaponCooldownTicks: 7, additiveAttackDelayTicks: 0 }
  };
  state.red = { ...state.red, activePrayers: [], equipment: { ...state.red.equipment, weapon: undefined } };
  state.players = state.players.map(player =>
    player.id === state.blue.id ? state.blue :
    player.id === state.red.id ? state.red : player
  );
  state.humanControl = { attackEnabled: true, laneId: "middle", attackTargetId: state.red.id };

  // Two bar clicks arm the modern two-hit preload.
  queueClientCommand(state, { kind: "special" }, false);
  queueClientCommand(state, { kind: "special" }, false);
  advanceTick(state);
  equal(state.blue.gmaulPreloaded, true, "two Gmaul bar clicks should create the short double-spec preload");
  equal(state.blue.queuedSpecialAttacks, 0, "arming the double preload should not fire yet");

  // Target click releases the two queued specials.
  queueClientCommand(state, { kind: "attack-target", targetId: state.red.id }, false);
  advanceTick(state);

  equal(state.blue.specEnergy, 0, "two queued Gmaul specials should consume 100 special energy");
  equal(state.blue.queuedSpecialAttacks, 0, "both queued Gmaul specials should be consumed together");
  equal(
    state.combatEvents.filter(event => event.attackerId === state.blue.id && event.special).length,
    2,
    "double Gmaul should create two same-tick special impacts"
  );
}

function testGraniteMaulSpecialAutoReleasesRecentTarget() {
  const state = createPvpTestState();
  state.blue = {
    ...state.blue,
    equipment: { ...state.blue.equipment, weapon: shopCatalog.find(item => item.id === "granite_maul") },
    tile: { x: 19, y: state.blue.tile.y },
    attackTimer: { lastAttackTick: -7, weaponCooldownTicks: 7, additiveAttackDelayTicks: 0 }
  };
  state.red = {
    ...state.red,
    equipment: { ...state.red.equipment, weapon: undefined },
    tile: { x: 20, y: state.red.tile.y }
  };
  state.players = state.players.map(player =>
    player.id === state.blue.id ? state.blue :
    player.id === state.red.id ? state.red : player
  );
  state.humanControl = { attackEnabled: true, laneId: "middle", attackTargetId: state.red.id };

  advanceTick(state);
  equal(state.blue.lastGmaulTargetId, state.red.id, "a normal Gmaul attack should remember its target");

  queueClientCommand(state, { kind: "special" }, false);
  advanceTick(state);
  equal(state.blue.specEnergy, 50, "activating Gmaul within five ticks of a prior Gmaul attack should auto-release Quick Smash");
  equal(state.blue.specialActive, false, "auto-released Gmaul should deactivate after the special attack");
}

function testGraniteMaulSpecialExpiresAfterThreeTicks() {
  const state = createPvpTestState();
  state.blue = {
    ...state.blue,
    equipment: { ...state.blue.equipment, weapon: shopCatalog.find(item => item.id === "granite_maul") },
    gmaulEquippedTick: 0,
    gmaulSpecBarVisibleTick: 0,
    gmaulPreloaded: true,
    gmaulPreloadExpiresAtTick: 2
  };
  state.players = state.players.map(player => player.id === state.blue.id ? state.blue : player);
  state.humanControl = { attackEnabled: false, laneId: "middle" };

  advanceTick(state);
  advanceTick(state);
  advanceTick(state);

  equal(state.blue.gmaulPreloaded, false, "Gmaul double-spec preload must expire after its short timer");
  equal(state.blue.gmaulPreloadExpiresAtTick, undefined, "expired Gmaul preload must clear its expiry");
}

function testSwitchingAwayClearsGmaulQueue() {
  const state = createPvpTestState();
  state.blue = {
    ...state.blue,
    equipment: { ...state.blue.equipment, weapon: shopCatalog.find(item => item.id === "granite_maul") },
    gmaulEquippedTick: 0,
    gmaulSpecBarVisibleTick: 0,
    gmaulPreloaded: true,
    gmaulPreloadExpiresAtTick: 5
  };
  state.players = state.players.map(player => player.id === state.blue.id ? state.blue : player);
  queueClientCommand(state, { kind: "equip", itemId: "abyssal_whip" }, false);
  state.humanControl = { attackEnabled: false, laneId: "middle" };
  advanceTick(state);

  equal(state.blue.equipment.weapon?.id, "abyssal_whip", "queued weapon swap should execute");
  equal(state.blue.gmaulPreloaded, false, "switching away from Gmaul should clear its queued special");
  equal(state.blue.gmaulSpecBarVisibleTick, undefined, "Gmaul spec-bar state should clear when leaving the weapon");
}





function testAuthoritativeStageOrder() {
  equal(
    tickRunner.stageNames.join(">"),
    "client-input>npc-turns>player-turns>pending-hits>lock-decay>respawns",
    "server tick should process client input before NPCs and PID-ordered players"
  );
}


function testFoodDelayExpiresAfterOneAttackCycle() {
  const state = createPvpTestState();
  state.blue = {
    ...state.blue,
    attackTimer: { lastAttackTick: 0, weaponCooldownTicks: 4, additiveAttackDelayTicks: 3 }
  };
  state.players = state.players.map(player => player.id === state.blue.id ? state.blue : player);
  state.humanControl = { attackEnabled: false, laneId: "middle", attackTargetId: state.red.id };
  // tick 7 is the first ready tick; execute that authoritative turn as well.
  for (let i = 0; i < 8; i += 1) advanceTick(state);
  equal(state.blue.attackTimer.additiveAttackDelayTicks, 0,
    "expired food delay must be consumed instead of persisting into future attack cycles");
}

function testNpcHitQueuesIntoPlayerTurn() {
  const state = createPvpTestState();
  state.blue = { ...state.blue, currentHp: 99, activePrayers: [] };
  state.players = state.players.map(player => player.id === state.blue.id ? state.blue : player);
  state.pendingHits.push({
    id: "npc-queue-test",
    dueTick: 0,
    attackerId: "tower-test",
    targetId: state.blue.id,
    attackerPid: -1,
    targetPid: state.blue.pid,
    style: "crush",
    attackType: "accurate",
    landed: true,
    hitChance: 1,
    rawDamage: 20,
    createdTick: 0
  });
  state.humanControl = { attackEnabled: false, laneId: "middle", attackTargetId: state.red.id };
  advanceTick(state);
  equal(state.blue.currentHp, 79, "queued NPC damage should resolve during the player's turn");
}

function testPlayerNpcImpactWaitsForNpcTurn() {
  // PVP fixtures have no towers, so use the prototype fixture for an actual NPC.
  const prototype = createPrototypeState();
  const targetTower = prototype.towers.find(candidate => candidate.team === "red" && candidate.laneId === "middle")!;
  prototype.pendingNpcHits.push({
    id: "player-npc-queue-test",
    dueTick: 0,
    attackerId: prototype.blue.id,
    targetId: targetTower.id,
    attackerPid: prototype.blue.pid,
    targetPid: -1,
    style: "slash",
    attackType: "aggressive",
    landed: true,
    hitChance: 1,
    rawDamage: 20,
    createdTick: 0
  });
  const before = targetTower.currentHp;
  advanceTick(prototype);
  equal(targetTower.currentHp, before - 20, "player->NPC queued damage should resolve on the NPC turn");
}

function testFoodAndPrayerCanPrecedeImpact() {
  const state = createPvpTestState();
  state.blue = {
    ...state.blue,
    currentHp: 60,
    attackTimer: { lastAttackTick: 0, weaponCooldownTicks: 4, additiveAttackDelayTicks: 0 }
  };
  state.players = state.players.map(player => player.id === state.blue.id ? state.blue : player);
  state.pendingHits.push({
    id: "food-prayer-impact-test",
    dueTick: 1,
    attackerId: state.red.id,
    targetId: state.blue.id,
    attackerPid: state.red.pid,
    targetPid: state.blue.pid,
    style: "ranged",
    attackType: "rapid_ranged",
    landed: true,
    hitChance: 1,
    rawDamage: 20,
    createdTick: 0
  });
  state.humanControl = {
    attackEnabled: false,
    laneId: "middle",
    attackTargetId: state.red.id,
    consumeItemId: "shark"
  };
  advanceTick(state);
  const healed = state.blue.currentHp;
  state.humanControl.activatePrayer = "protect_from_missiles";
  advanceTick(state);
  equal(state.blue.currentHp, healed - 12, "impact should use the current protection prayer after the food tick");
  ok(state.blue.attackTimer.additiveAttackDelayTicks >= 3, "food should still delay the next attack cycle");
}

function testLethalHitQueuesDeathForNextTick() {
  const state = createPvpTestState();
  state.red = { ...state.red, currentHp: 5, activePrayers: [], prayerPoints: 0 };
  state.players = state.players.map(player => player.id === state.red.id ? state.red : player);
  state.pendingHits.push({
    id: "queued-death-test",
    dueTick: 0,
    attackerId: state.blue.id,
    targetId: state.red.id,
    attackerPid: state.blue.pid,
    targetPid: state.red.pid,
    style: "slash",
    attackType: "aggressive",
    landed: true,
    hitChance: 1,
    rawDamage: 20,
    createdTick: 0
  });
  state.humanControl = { attackEnabled: true, laneId: "middle", attackTargetId: state.red.id };
  advanceTick(state);
  equal(state.red.alive, true, "lethal hitsplat should queue death rather than immediately remove the player");
  equal(state.red.currentHp, 0, "lethal hitsplat should leave the victim at zero HP while death is queued");
  equal(state.pendingDeaths.length, 1, "a lethal hitsplat should create a next-tick death command");

  advanceTick(state);
  equal(state.red.alive, false, "queued death should resolve on the following tick");
  equal(state.red.deaths, 1, "queued death should increment the death count once");
}

function testQueuedHitBeatsPrayerDrain() {
  const state = createPvpTestState();
  state.red = {
    ...state.red,
    equipment: { ...state.red.equipment, weapon: undefined },
    currentHp: 5,
    prayerPoints: 1,
    activePrayers: ["redemption"],
    prayerDrainAccumulator: 59
  };
  state.players = state.players.map(player => player.id === state.red.id ? state.red : player);
  state.pendingHits.push({
    id: "redemption-before-drain-test",
    dueTick: 0,
    attackerId: state.blue.id,
    targetId: state.red.id,
    attackerPid: state.blue.pid,
    targetPid: state.red.pid,
    style: "slash",
    attackType: "aggressive",
    landed: true,
    hitChance: 1,
    rawDamage: 20,
    createdTick: 0
  });
  state.humanControl = { attackEnabled: false, laneId: "middle", attackTargetId: state.red.id };
  advanceTick(state);
  equal(state.red.alive, true, "queued hit should resolve before prayer drain can consume Redemption");
  equal(state.red.currentHp, 24, "Redemption should trigger before the timer drain");
}
 
function testRedemptionSavesLethalHit() {
  const state = createPvpTestState();
  state.red = { ...state.red, equipment: { ...state.red.equipment, weapon: undefined } };
  state.players = state.players.map(player => player.id === state.red.id ? state.red : player);
  state.red = {
    ...state.red,
    currentHp: 5,
    prayerPoints: 99,
    activePrayers: ["redemption"]
  };
  state.players = state.players.map(player => player.id === state.red.id ? state.red : player);
  state.pendingHits.push({
    id: "redemption-test",
    dueTick: 1,
    attackerId: state.blue.id,
    targetId: state.red.id,
    attackerPid: state.blue.pid,
    targetPid: state.red.pid,
    style: "slash",
    attackType: "aggressive",
    landed: true,
    hitChance: 1,
    rawDamage: 20,
    createdTick: 0
  });
  state.humanControl = { attackEnabled: false, laneId: "middle", attackTargetId: state.red.id };
  advanceTick(state);
  advanceTick(state);
  equal(state.red.alive, true, "Redemption should prevent a lethal queued hit from killing the target");
  equal(state.red.currentHp, 24, "Redemption should restore the target to at least 25% of 99 HP");
  equal(state.red.prayerPoints, 0, "Redemption should consume the remaining prayer");
}

function testCampRespawnSchedule() {
  const state = createPrototypeState();
  const camp = state.jungleCamps[0];
  state.jungleCamps[0] = { ...camp, alive: false, currentHp: 0, respawnAtTick: 1 };
  advanceTick(state);
  equal(state.jungleCamps[0].alive, false, "camp should remain dead before respawn tick");
  advanceTick(state);
  equal(state.jungleCamps[0].alive, true, "neutral camp should respawn on its scheduled tick");
  equal(state.jungleCamps[0].currentHp, state.jungleCamps[0].maxHp, "respawned camp should be full HP");
}

testPrototypeShape();
testPvpTestLane();
testAuthoritativeStageOrder();
testVengeanceCastIsIndependentOfAttackCycle();
testVengeanceReflectsAndConsumesOnImpact();
testVengeanceCooldownBlocksRecast();
testHumanPrayerInputIsOneShot();
testSameTickPrayerFlickConsumesNoPrayer();
testQueuedHitResolvesOnTargetTurn();
testGearSwapCanAttackSameTick();
testFoodAddsToCombatTimer();
testPotionDoesNotDelayAttackCycle();
testFoodAndPotionCanChainInOneTick();
testPotionThenFoodIsBlockedByPotionActionDelay();
testKarambwanCombo();
testWaveCadence();
testProjectileDelay();
testOsrsHitTiming();
testPlayerMagicFormula();
testDragonClawsSpecial();
testClientCommandQueueIsFifoAndCapped();
testClientCommandHasOneTickInputLatency();
testQueuedAttackTargetHasOneTickLatency();
testTargetMemoryExpiresAfterFiveTicks();
testQueuedMovementAndAttackPreserveFifo();




testStandardSpecialQueuesUntilAttackCycleIsReady();
testGraniteMaulSpecialDoesNotPersistOutOfReach();
testGraniteMaulSpecialIgnoresAttackCooldown();
testGraniteMaulDoubleSpecConsumesTwoQueues();
testGraniteMaulSpecialAutoReleasesRecentTarget();
testGraniteMaulSpecialExpiresAfterThreeTicks();
testSwitchingAwayClearsGmaulQueue();

testPidTurnPreventsDeadPlayerAction();
testPidTurnRunsPrayerBeforeIncomingImpact();
testPvPDummyProvidesIncomingPressure();
testMissedFreezeDoesNotApply();
testDragonClawsExposeRawDamageForImpactPrayer();
testFoodAndPrayerCanPrecedeImpact();
testFoodDelayExpiresAfterOneAttackCycle();
testNpcHitQueuesIntoPlayerTurn();
testPlayerNpcImpactWaitsForNpcTurn();
testQueuedHitUsesImpactPrayer();
testLethalHitQueuesDeathForNextTick();
testQueuedHitBeatsPrayerDrain();
testRedemptionSavesLethalHit();
testCampRespawnSchedule();

console.log("All simulation tests passed.");
