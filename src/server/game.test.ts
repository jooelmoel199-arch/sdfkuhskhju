import { createGame, enqueueInput, step } from "./game";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const game = createGame();

// Inputs are not applied until a simulation tick.
enqueueInput(game, { type: "attack", targetId: "opponent" });
assert(game.players.player.targetId === null, "input must wait for the tick");
step(game);

assert(game.tick === 1, "tick should advance");
assert(game.players.player.targetId === "opponent", "attack input should acquire target");
assert(game.events.some(e => e.type === "attack_queued"), "attack should be queued");
step(game);
assert(game.events.some(e => e.type === "hit" || e.type === "miss"), "queued hit should resolve on the following tick");
assert(game.players.player.nextAttackTick === 5, "rune scimitar should use a 4-tick cooldown");

const hpAfterAttack = game.players.opponent.hp;
step(game);
step(game);
step(game);
assert(game.players.opponent.hp === hpAfterAttack, "cooldown must prevent early reattack");

step(game);
assert(game.players.opponent.hp <= hpAfterAttack, "attack should be eligible again on cooldown tick");

// The request is held in combat state: a target can be out of range and
// become attackable after movement without requiring another attack packet.
const ranged = createGame();
ranged.players.player.x = 0;
ranged.players.opponent.x = 5;
enqueueInput(ranged, { type: "attack", targetId: "opponent" });
step(ranged);
assert(ranged.players.player.attackQueuedTick !== null, "out-of-range attack remains queued");
assert(!ranged.events.some(e => e.type === "attack"), "out-of-range attack cannot resolve");

enqueueInput(ranged, { type: "move", x: 4, y: 10 });
step(ranged);
assert(ranged.events.some(e => e.type === "attack"), "queued attack resolves after entering range");

// Special attacks consume energy only when the attack actually resolves.
const special = createGame();
enqueueInput(special, { type: "attack", targetId: "opponent" });
step(special);
const energyBefore = special.players.player.inventory.specialEnergy;
enqueueInput(special, { type: "special" });
assert(special.players.player.inventory.specialEnergy === energyBefore, "queueing special must not spend energy");
step(special);
assert(special.players.player.inventory.specialEnergy === energyBefore - 50, "special spends energy on resolution");
assert(special.events.some(e => e.type === "special" && e.special), "special resolution event expected");

// Basic inventory/prayer/movement are authoritative inputs too.
const beforeFood = special.players.player.hp;
enqueueInput(special, { type: "eat" });
step(special);
assert(special.players.player.inventory.food === 9, "eating should consume one food");
assert(special.players.player.hp >= beforeFood, "eating should not reduce HP");

enqueueInput(special, { type: "move", x: 14, y: 10 });
step(special);
assert(special.players.player.x === 14, "movement input should be authoritative");

enqueueInput(special, { type: "prayer", prayer: "protect_melee" });
step(special);
assert(special.players.player.prayer === "protect_melee", "prayer input should update server state");

enqueueInput(special, { type: "stop_attack" });
step(special);
assert(special.players.player.targetId === null, "stop attack must clear the target");
assert(special.players.player.attackQueuedTick === null, "stop attack must clear queued combat");


const styled=createGame();
enqueueInput(styled,{type:"attack_style",style:"aggressive"});step(styled);
assert(styled.players.player.attackStyle==="aggressive","attack style should be authoritative");
enqueueInput(styled,{type:"move",x:12,y:14});step(styled);
assert(styled.players.player.x===11 && styled.players.player.y===10,"2D movement should follow a path one tile per tick");
enqueueInput(styled,{type:"move",x:12,y:14});step(styled);
assert(styled.players.player.x===12 && styled.players.player.y===10,"pathing should continue one tile per tick");
const prayed=createGame();
enqueueInput(prayed,{type:"prayer",prayer:"protect_melee"});step(prayed);
const prayerBefore=prayed.players.player.prayerPoints;
step(prayed);
assert(prayed.players.player.prayerPoints===prayerBefore,"prayer drains on the configured cadence");
step(prayed);
assert(prayed.players.player.prayerPoints===prayerBefore-1,"active prayer should drain server-side");
console.log("server combat queue tests passed");
