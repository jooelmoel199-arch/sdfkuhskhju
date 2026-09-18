import { createGame, enqueueInput, step } from "./game";
import { hitChanceFromRolls, magicMaxHit, playerMagicDefenceLevel, projectileHitDelay, standardMaxHit } from "./combat-formulas";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const game = createGame();
game.players.player.x=13; game.players.opponent.x=14;
game.players.player.pid=2; game.players.opponent.pid=1;

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
earlyPid.players.player.x = 13;
earlyPid.players.opponent.x = 14;
enqueueInput(earlyPid, { type: "attack", targetId: "opponent" });
step(earlyPid);
assert(earlyPid.events.some(e => e.type === "attack"), "early-PID player should attack on its turn");
assert(earlyPid.events.some(e => e.type === "hit" || e.type === "miss"), "later-PID defender should process the melee hit on the same tick");
const latePid = createGame();
latePid.players.player.pid=2;
latePid.players.opponent.pid=1;
latePid.players.player.x=13;
latePid.players.opponent.x=14;
enqueueInput(latePid,{type:"attack",targetId:"opponent"});
step(latePid);
assert(!latePid.events.some(e=>e.type==="hit"||e.type==="miss"),"higher-PID attacker should incur one processing-order tick");
step(latePid);
assert(latePid.events.some(e=>e.type==="hit"||e.type==="miss"),"higher-PID melee hit should resolve on the defender's later processing tick");
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
special.players.player.hp=Math.max(1,special.players.player.hp-20);
const beforeFoodAfterWound=special.players.player.hp;
enqueueInput(special, { type: "eat" });
step(special);
assert(special.players.player.inventory.food === 9, "eating should consume one food");
assert(special.players.player.hp >= beforeFoodAfterWound, "eating should not reduce HP");

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
enqueueInput(styled,{type:"move",x:12,y:10});step(styled);
assert(styled.players.player.x===11 && styled.players.player.y===10,"2D movement should follow a path one tile per tick");
enqueueInput(styled,{type:"move",x:12,y:10});step(styled);
assert(Number(styled.players.player.x)===12 && Number(styled.players.player.y)===10,"pathing should continue one tile per tick");
const prayed=createGame();
enqueueInput(prayed,{type:"prayer",prayer:"protect_melee"});step(prayed);
const prayerBefore=prayed.players.player.prayerPoints;
for(let i=0;i<3;i++) step(prayed);
assert(prayed.players.player.prayerPoints===prayerBefore,"prayer should not drain before the configured resistance is reached");
step(prayed);
assert(prayed.players.player.prayerPoints===prayerBefore-1,"active prayer should drain after five active ticks at zero prayer bonus");
// Pure formula regressions keep the engine tied to the modern OSRS equations.
assert(standardMaxHit(83,44)===14,"rune-scimitar style baseline should use the 0.5 max-hit formula");
assert(Math.abs(hitChanceFromRolls(100,200)-(100/(2*201)))<1e-12,"under-roll accuracy formula should match OSRS");
assert(Math.abs(hitChanceFromRolls(300,200)-(1-(202/(2*301))))<1e-12,"over-roll accuracy formula should match OSRS");
assert(magicMaxHit(8,0.02)===8,"Mystic Might's current 2% magic damage bonus should be applied after the spell base hit");
assert(playerMagicDefenceLevel(75,70,1.15,1)===89,"magic defence should weight boosted Magic at 70% and Defence at 30%");
assert(projectileHitDelay("ranged",1)===1 && projectileHitDelay("ranged",8)===2 && projectileHitDelay("ranged",9)===3,"bow hit-delay breakpoints should match modern distance table");
assert(projectileHitDelay("magic",1)===1 && projectileHitDelay("magic",2)===2 && projectileHitDelay("magic",5)===3 && projectileHitDelay("magic",10)===4,"standard magic projectile hit-delay breakpoints should match modern distance table");
const prayerStack=createGame();
prayerStack.players.player.prayerPoints=20;
enqueueInput(prayerStack,{type:"prayer",prayer:"eagle_eye"});step(prayerStack);
enqueueInput(prayerStack,{type:"prayer",prayer:"protect_range"});step(prayerStack);
assert(prayerStack.players.player.activePrayers.includes("eagle_eye") && prayerStack.players.player.activePrayers.includes("protect_range"),"offensive and overhead prayers should coexist");
assert(prayerStack.players.player.prayer==="protect_range","latest selected prayer should remain exposed for client compatibility");
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
if(xpHit){
  assert(xpGame.players.player.xp.attack === (xpHit.damage??0)*4, "accurate melee should award 4 combat XP per damage");
  assert(xpGame.players.player.xp.hitpoints === (xpHit.damage??0)*4/3, "melee hitpoints XP should be 4/3 per damage");
}

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
assert(Number(inputBacklog.pendingInputs.length)===0,"queued inputs should drain on later ticks");


const rangedGame=createGame();
rangedGame.players.player.x=10;rangedGame.players.player.y=10;
rangedGame.players.opponent.x=14;rangedGame.players.opponent.y=10;
enqueueInput(rangedGame,{type:"item_action",slot:3,action:"equip"});
step(rangedGame);
assert(rangedGame.players.player.equipment.attackType==="ranged","shortbow should switch the authoritative attack type");
const arrowsBefore=rangedGame.players.player.inventory.slots[4]?.quantity??0;
enqueueInput(rangedGame,{type:"attack",targetId:"opponent"});
step(rangedGame);
const rangedProjectile=rangedGame.events.find(e=>e.type==="projectile");
assert(rangedProjectile!==undefined,"ranged attack should emit a projectile event");
assert((rangedGame.players.player.inventory.slots[4]?.quantity??0)===arrowsBefore-1,"ranged attack should consume one arrow");
assert(rangedGame.players.opponent.hp===99,"ranged projectile should not resolve on its source tick");
assert((rangedProjectile.resolveTick??0)===rangedGame.tick+2,"a 4-tile bow shot should have a 2-tick hit delay");
const rangedPidDelay=createGame();
rangedPidDelay.players.player.x=10;rangedPidDelay.players.opponent.x=14;
rangedPidDelay.players.player.pid=2;rangedPidDelay.players.opponent.pid=1;
enqueueInput(rangedPidDelay,{type:"item_action",slot:3,action:"equip"});step(rangedPidDelay);
enqueueInput(rangedPidDelay,{type:"attack",targetId:"opponent"});step(rangedPidDelay);
const rangedPidProjectile=rangedPidDelay.events.find(e=>e.type==="projectile");
assert(rangedPidProjectile!==undefined && (rangedPidProjectile.resolveTick??0)===rangedPidDelay.tick+3,"projectile impact should gain one processing-order tick when the defender has earlier PID");
assert(rangedGame.pendingHits.length===1&&rangedGame.pendingHits[0].delivery==="projectile","projectile should live in the state combat queue");
step(rangedGame);
assert(rangedGame.events.filter(e=>e.type==="hit"||e.type==="miss").length===0,"ranged projectile should still be travelling after one tick");
step(rangedGame);
assert(rangedGame.events.some(e=>e.type==="hit"||e.type==="miss"),"ranged projectile should resolve at its arrival tick");
assert(Number(rangedGame.pendingHits.length)===0,"resolved projectile should leave the combat queue");
const emptyAmmo=createGame();
emptyAmmo.players.player.x=10;emptyAmmo.players.opponent.x=14;
emptyAmmo.players.player.inventory.slots[4]={id:"bronze_arrow",quantity:1};
enqueueInput(emptyAmmo,{type:"item_action",slot:3,action:"equip"});step(emptyAmmo);
enqueueInput(emptyAmmo,{type:"attack",targetId:"opponent"});step(emptyAmmo);
assert(emptyAmmo.players.player.inventory.slots[4]===null,"last arrow should be removed from the inventory");
step(emptyAmmo);step(emptyAmmo);step(emptyAmmo);step(emptyAmmo);
assert(emptyAmmo.players.player.targetId===null,"running out of arrows should cancel the active ranged interaction");

const rangedProtected=createGame();
rangedProtected.players.player.x=10;rangedProtected.players.player.y=10;
rangedProtected.players.opponent.x=14;rangedProtected.players.opponent.y=10;
enqueueInput(rangedProtected,{type:"item_action",slot:3,action:"equip"});step(rangedProtected);
enqueueInput(rangedProtected,{type:"prayer",prayer:"protect_range"});step(rangedProtected);
enqueueInput(rangedProtected,{type:"attack",targetId:"opponent"});step(rangedProtected);
assert(rangedProtected.players.player.prayer==="protect_range","ranged protection prayer should be authoritative");
step(rangedProtected);

const magicGame=createGame();
magicGame.players.player.x=10;magicGame.players.player.y=10;
magicGame.players.opponent.x=14;magicGame.players.opponent.y=10;
enqueueInput(magicGame,{type:"item_action",slot:7,action:"equip"});step(magicGame);
assert(magicGame.players.player.equipment.attackType==="magic","fire strike should switch the authoritative attack type");
const fireBefore=magicGame.players.player.inventory.slots[5]?.quantity??0;
const airBefore=magicGame.players.player.inventory.slots[6]?.quantity??0;
enqueueInput(magicGame,{type:"attack",targetId:"opponent"});step(magicGame);
const magicSpell=magicGame.events.find(e=>e.type==="spell");
assert(magicSpell!==undefined,"magic attack should emit a spell event");
assert((magicGame.players.player.inventory.slots[5]?.quantity??0)===fireBefore-1,"magic attack should consume one fire rune");
assert((magicGame.players.player.inventory.slots[6]?.quantity??0)===airBefore-3,"magic attack should consume three air runes");
assert((magicSpell.resolveTick??0)===magicGame.tick+2,"a 4-tile standard spell should have a 2-tick hit delay");
step(magicGame);
assert(magicGame.events.filter(e=>e.type==="hit"||e.type==="miss").length===0,"magic spell should still be travelling after one tick");
step(magicGame);
assert(magicGame.events.some(e=>e.type==="hit"||e.type==="miss"),"spell should resolve at its arrival tick");
assert(magicGame.pendingHits.length===0,"resolved spell should leave the combat queue");
assert(magicGame.players.player.xp.magic>=11.5,"Fire Strike should award its base Magic XP when resolved");
assert(magicSpell.reason==="fire_strike","spell delivery should identify its definition");
const rapid=createGame();
rapid.players.player.x=10;rapid.players.opponent.x=14;
enqueueInput(rapid,{type:"item_action",slot:3,action:"equip"});step(rapid);
enqueueInput(rapid,{type:"ranged_style",style:"rapid"});step(rapid);
enqueueInput(rapid,{type:"attack",targetId:"opponent"});step(rapid);
assert(rapid.players.player.nextAttackTick===rapid.tick+3,"rapid ranged style should reduce the weapon cycle by one tick");
const rangedReach=createGame();
rangedReach.players.player.x=10;rangedReach.players.opponent.x=18;
enqueueInput(rangedReach,{type:"item_action",slot:3,action:"equip"});step(rangedReach);
enqueueInput(rangedReach,{type:"attack",targetId:"opponent"});step(rangedReach);
assert(!rangedReach.events.some(e=>e.type==="projectile"),"standard shortbow range should stop at 7 tiles");
enqueueInput(rangedReach,{type:"ranged_style",style:"longrange"});step(rangedReach);
enqueueInput(rangedReach,{type:"attack",targetId:"opponent"});step(rangedReach);
assert(rangedReach.events.some(e=>e.type==="projectile"),"longrange should extend a shortbow's reach by two tiles");
const ammoAccuracy=createGame();
ammoAccuracy.players.player.x=10;ammoAccuracy.players.opponent.x=14;
enqueueInput(ammoAccuracy,{type:"item_action",slot:3,action:"equip"});step(ammoAccuracy);
const ammoAccuracyBefore=ammoAccuracy.players.player.inventory.slots.find(v=>v?.id==="bronze_arrow")?.quantity??0;
enqueueInput(ammoAccuracy,{type:"attack",targetId:"opponent"});step(ammoAccuracy);
const arrowsAfter=ammoAccuracy.players.player.inventory.slots.find(v=>v?.id==="bronze_arrow")?.quantity??0;
assert(arrowsAfter===ammoAccuracyBefore-1,"ranged attack should consume exactly one ammunition unit");
const magicDefence=createGame();
magicDefence.players.player.x=10;magicDefence.players.opponent.x=14;
enqueueInput(magicDefence,{type:"item_action",slot:7,action:"equip"});step(magicDefence);
enqueueInput(magicDefence,{type:"prayer",prayer:"mystic_might"});step(magicDefence);
assert(magicDefence.players.player.prayer==="mystic_might","mystic might should be selectable while testing magic combat");


console.log("ranged and magic combat queue tests passed");

// Ice Barrage freeze state is applied when the projectile resolves, not when cast.
const freezeGame=createGame();
enqueueInput(freezeGame,{type:"item_action",slot:8,action:"equip"});step(freezeGame);
enqueueInput(freezeGame,{type:"attack",targetId:"opponent"});step(freezeGame);
assert(freezeGame.players.player.equipment.spellId==="ice_barrage","Ice Barrage should be selectable from the authoritative inventory");
assert(freezeGame.pendingHits.some(h=>h.attackType==="magic"&&h.freezeTicks===33),"Ice Barrage freeze duration should be snapshotted into the queued hit");
const freezeBefore=freezeGame.players.opponent.freezeUntilTick;
for(let i=0;i<5;i++)step(freezeGame);
assert(freezeGame.players.opponent.freezeUntilTick>freezeBefore,"successful Ice Barrage should apply a server-side freeze on impact");
