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
// PID/turn order can make a zero-delay melee hit land during the defender's current turn.
const earlyPid = createGame();
earlyPid.players.player.id = "a_player";
earlyPid.players.opponent.id = "z_opponent";
earlyPid.players.player.x = 13;
earlyPid.players.opponent.x = 14;
enqueueInput(earlyPid, { type: "attack", targetId: "opponent" });
step(earlyPid);
assert(earlyPid.events.some(e => e.type === "attack"), "early-PID player should attack on its turn");
assert(earlyPid.events.some(e => e.type === "hit" || e.type === "miss"), "later-PID defender should process the melee hit on the same tick");
// Protection must be applied exactly once at hit resolution, not when the hit is queued.
const rawGame = createGame();
rawGame.players.player.x = 13;
rawGame.players.opponent.x = 14;
rawGame.players.player.attack = 1000;
rawGame.players.player.strength = 1000;
rawGame.players.opponent.defence = 1;
enqueueInput(rawGame, { type: "attack", targetId: "opponent" });
step(rawGame);
const rawHit = rawGame.events.find(e => e.type === "hit");
assert(rawHit !== undefined && (rawHit.damage ?? 0) > 0, "high-accuracy melee attack should produce test damage");

const prayerGame = createGame();
prayerGame.players.player.x = 13;
prayerGame.players.opponent.x = 14;
prayerGame.players.player.attack = 1000;
prayerGame.players.player.strength = 1000;
prayerGame.players.opponent.defence = 1;
prayerGame.players.opponent.prayer = "protect_melee";
enqueueInput(prayerGame, { type: "attack", targetId: "opponent" });
step(prayerGame);
const prayerHit = prayerGame.events.find(e => e.type === "hit");
assert(prayerHit !== undefined, "protected high-accuracy melee attack should still hit");
assert((prayerHit.damage ?? 0) === Math.floor((rawHit?.damage ?? 0) * 0.6), "protection prayer should reduce queued melee damage by 40% exactly once");

const protectedGame = createGame();
protectedGame.players.player.id = "z_player";
protectedGame.players.opponent.id = "a_opponent";
protectedGame.players.player.x = 13;
protectedGame.players.opponent.x = 14;
enqueueInput(protectedGame, { type: "attack", targetId: "opponent" });
step(protectedGame);
protectedGame.players.opponent.prayer = "protect_melee";
step(protectedGame);
const protectedHit = protectedGame.events.find(e => e.type === "hit");
assert(protectedHit !== undefined, "protected melee attack should still register as a hit");

// Repeated attack clicks during cooldown must not reset the weapon timer.
enqueueInput(game, { type: "attack", targetId: "opponent" });
step(game);
assert(game.players.player.attackQueuedTick === 5, "reselecting a target during cooldown must preserve the next attack tick");


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
assert(ranged.players.player.targetId === "opponent", "out-of-range attack retains its target");
assert(!ranged.events.some(e => e.type === "attack"), "out-of-range attack cannot resolve");
step(ranged);
step(ranged);
assert(ranged.players.player.x === 3, "persistent attack interaction should keep moving toward the target");
step(ranged);
assert(ranged.events.some(e => e.type === "attack"), "queued attack resolves once movement reaches range");

// Special attacks consume energy only when the attack actually resolves.
const special = createGame();
enqueueInput(special, { type: "attack", targetId: "opponent" });
step(special);
const energyBefore = special.players.player.inventory.specialEnergy;
enqueueInput(special, { type: "special" });
assert(special.players.player.inventory.specialEnergy === energyBefore, "queueing special must not spend energy");
step(special);
assert(special.players.player.inventory.specialEnergy === energyBefore, "special must remain queued while out of melee range");
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

const xpGame = createGame();
xpGame.players.player.x = 13;
xpGame.players.opponent.x = 14;
xpGame.players.player.attack = 1000;
xpGame.players.player.strength = 1000;
xpGame.players.opponent.defence = 1;
enqueueInput(xpGame, { type: "attack", targetId: "opponent" });
step(xpGame);
const xpHit = xpGame.events.find(e => e.type === "hit");
assert(xpHit !== undefined && (xpGame.players.player.xp.attack + xpGame.players.player.xp.hitpoints) > 0, "resolved melee damage should award combat xp");

const boosted = createGame();
boosted.players.player.x = 13;
boosted.players.opponent.x = 14;
boosted.players.player.attack = 50;
boosted.players.player.strength = 50;
boosted.players.opponent.defence = 50;
boosted.players.player.prayer = "superhuman_strength";
boosted.players.player.attackStyle = "aggressive";
enqueueInput(boosted, { type: "attack", targetId: "opponent" });
step(boosted);
const boostedAttack = boosted.events.find(e => e.type === "attack");
assert(boostedAttack !== undefined && (boostedAttack.attackRoll ?? 0) > 0, "prayer-boosted attack should produce an attack roll");


const minions=createGame();
assert(minions.players.goblin_guard_1 !== undefined, "goblin guard minion should spawn");
assert(minions.players.goblin_guard_1.hp === 40, "goblin guard should use simple minion stats");
step(minions);
assert(minions.players.goblin_guard_1.targetId === "player", "goblin guard should automatically target the player");


// More than the per-tick processing budget remains queued rather than being dropped.
const inputBacklog=createGame();
for(let i=0;i<12;i++) enqueueInput(inputBacklog,{type:"move",x:2+i%10,y:2});
step(inputBacklog);
assert(inputBacklog.pendingInputs.length===2,"input backlog must survive the per-tick processing cap");
step(inputBacklog);
assert(inputBacklog.pendingInputs.length===0,"queued inputs should drain on later ticks");
