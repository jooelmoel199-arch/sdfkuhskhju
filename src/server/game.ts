import { createCombatRules, type CombatRules } from "./combat-rules";
import { findPath, MAP_HEIGHT, MAP_WIDTH, type Tile } from "./pathfinding";
import { MELEE_STYLE_BONUS, WEAPONS, weaponAttackBonus, weaponStance, type AttackType } from "./combat-definitions";

export type Team = "blue" | "red";
export type Prayer = "protect_melee" | "protect_mage" | "protect_range" | "burst_of_strength" | "clarity_of_thought" | "superhuman_strength" | "improved_reflexes" | "incredible_reflexes" | "ultimate_strength" | "steel_skin" | null;
export type AttackStyle = "accurate" | "aggressive" | "defensive" | "controlled";
export type ItemAction = "eat" | "equip" | "unequip";
export interface ItemStack { id:string; quantity:number; }

export type InputCommand =
  | { type: "attack"; targetId: string }
  | { type: "move"; x: number; y: number }
  | { type: "prayer"; prayer: Prayer }
  | { type: "attack_style"; style: AttackStyle }
  | { type: "item_action"; slot:number; action:ItemAction }
  | { type: "eat" }
  | { type: "special" }
  | { type: "stop_attack" };

export interface Inventory { slots:Array<ItemStack|null>; food: number; specialEnergy: number; coins: number; }
export interface CombatXp { attack:number; strength:number; defence:number; ranged:number; magic:number; hitpoints:number; }
export interface PendingHit { sourceTick:number; resolveTick:number; sequence:number; attackerId:string; defenderId:string; attackType:AttackType; attackStyle:AttackStyle; attackRoll:number; defenceRoll:number; hitChance:number; succeeded:boolean; rawDamage:number; special:boolean; }
export interface Equipment {
  weapon: string; attackType: AttackType; attackRange: number; attackSpeed: number; attackBonus: number; strengthBonus: number;
  specialCost: number; specialMultiplier: number; defenceBonus: number; defenceStab: number; defenceSlash: number; defenceCrush: number;
}
export interface Player {
  id:string; name:string; team:Team; x:number; y:number; destinationX:number; destinationY:number;
  hp:number; maxHp:number; prayerPoints:number; maxPrayerPoints:number;
  attack:number; strength:number; defence:number; xp:CombatXp; equipment:Equipment; inventory:Inventory;
  prayer:Prayer; attackStyle:AttackStyle; targetId:string|null; nextAttackTick:number;
  attackQueuedTick:number|null; hitQueuedTick:number|null; pendingHit:PendingHit|null; specialQueued:boolean; path:Tile[];
}
export interface CombatEvent {
  tick:number; type:"attack_queued"|"attack_cancelled"|"attack"|"hit"|"miss"|"eat"|"special_queued"|"special"|"move"|"prayer"|"attack_style"|"death";
  attacker?:string; defender?:string; damage?:number; attackRoll?:number; defenceRoll?:number;
  special?:boolean; hitChance?:number; x?:number; y?:number; prayer?:Prayer; style?:AttackStyle; reason?:string;
}
export interface QueuedInput { sequence:number; receivedTick:number; command:InputCommand; }
export interface GameState { tick:number; nextInputSequence:number; nextCombatSequence:number; players:Record<string,Player>; pendingInputs:QueuedInput[]; events:CombatEvent[]; readonly combatRules:CombatRules; }

const styleBonus=MELEE_STYLE_BONUS;

function makePlayer(id:string,name:string,team:Team,x:number,y:number):Player{
  return {id,name,team,x,y,destinationX:x,destinationY:y,hp:99,maxHp:99,prayerPoints:20,maxPrayerPoints:20,
    attack:75,strength:75,defence:70,xp:{attack:0,strength:0,defence:0,ranged:0,magic:0,hitpoints:0},equipment:{...WEAPONS.rune_scimitar, defenceBonus:0, defenceStab:0, defenceSlash:0, defenceCrush:0},
    inventory:{slots:[{id:"rune_scimitar",quantity:1},{id:"lobster",quantity:10},{id:"coins",quantity:2500},null,null,null,null,null,null,null,null,null],food:10,specialEnergy:100,coins:2500},prayer:null,attackStyle:"accurate",targetId:null,nextAttackTick:0,attackQueuedTick:null,hitQueuedTick:null,pendingHit:null,specialQueued:false,path:[]};
}

export function createGame():GameState{
  const players={
    player:makePlayer("player","Player","blue",10,10),
    opponent:makePlayer("opponent","Opponent","red",14,10),
    goblin_guard_1:makePlayer("goblin_guard_1","Goblin guard","red",18,8),
    goblin_guard_2:makePlayer("goblin_guard_2","Goblin guard","red",18,12),
    goblin_guard_3:makePlayer("goblin_guard_3","Goblin guard","red",21,10)
  };
  for(const id of ["goblin_guard_1","goblin_guard_2","goblin_guard_3"]){
    const g=players[id];
    g.attack=45; g.strength=45; g.defence=35; g.hp=40; g.maxHp=40;
    g.inventory.specialEnergy=0; g.targetId="player"; g.attackStyle="aggressive";
    g.attackQueuedTick=0;
  }
  return {tick:0,nextInputSequence:1,nextCombatSequence:1,pendingInputs:[],events:[],players,combatRules:createCombatRules()};
}
export function enqueueInput(state:GameState,command:InputCommand):void{state.pendingInputs.push({sequence:state.nextInputSequence++,receivedTick:state.tick,command});}
function event(state:GameState,e:CombatEvent):void{state.events.push(e);if(state.events.length>300)state.events.splice(0,state.events.length-300);}
function clampTile(x:number,y:number):Tile{return{x:Math.max(1,Math.min(MAP_WIDTH-2,Math.round(x))),y:Math.max(1,Math.min(MAP_HEIGHT-2,Math.round(y)))}};
function setDestination(p:Player,x:number,y:number){const t=clampTile(x,y);p.destinationX=t.x;p.destinationY=t.y;p.path=findPath({x:p.x,y:p.y},t);}

function processInput(state:GameState,command:InputCommand):void{
 const p=state.players.player;if(!p||p.hp<=0)return;
 switch(command.type){
  case "attack":{const target=state.players[command.targetId];if(!target||target.hp<=0||target.team===p.team)return;p.targetId=target.id;setDestination(p,target.x,target.y);p.attackQueuedTick=Math.max(state.tick,p.nextAttackTick);p.specialQueued=false;event(state,{tick:state.tick,type:"attack_queued",attacker:p.id,defender:target.id});return;}
  case "stop_attack":p.targetId=null;p.attackQueuedTick=null;p.hitQueuedTick=null;p.pendingHit=null;p.specialQueued=false;p.path=[];event(state,{tick:state.tick,type:"attack_cancelled",attacker:p.id});return;
  case "move":setDestination(p,command.x,command.y);p.targetId=null;p.attackQueuedTick=null;p.specialQueued=false;event(state,{tick:state.tick,type:"move",attacker:p.id,x:p.destinationX,y:p.destinationY});return;
  case "attack_style":p.attackStyle=command.style;event(state,{tick:state.tick,type:"attack_style",attacker:p.id,style:p.attackStyle});return;
  case "prayer":if(command.prayer!==null&&p.prayerPoints<=0)return;p.prayer=command.prayer;event(state,{tick:state.tick,type:"prayer",attacker:p.id,prayer:p.prayer});return;
  case "item_action":{const stack=p.inventory.slots[command.slot];if(!stack||stack.quantity<=0)return;if(command.action==="eat"&&stack.id==="lobster"&&p.hp<p.maxHp){stack.quantity--;p.inventory.food=Math.max(0,p.inventory.food-1);p.hp=Math.min(p.maxHp,p.hp+12);event(state,{tick:state.tick,type:"eat",attacker:p.id,damage:-12});if(stack.quantity===0)p.inventory.slots[command.slot]=null;return;}if(command.action==="equip"&&stack.id==="rune_scimitar"){Object.assign(p.equipment, WEAPONS.rune_scimitar);event(state,{tick:state.tick,type:"attack_style",attacker:p.id,reason:"equipped rune scimitar"});return;}return;}
  case "eat":{const slot=p.inventory.slots.findIndex(v=>v?.id==="lobster");if(slot>=0)processInput(state,{type:"item_action",slot,action:"eat"});return;}
  case "special":if(p.targetId&&p.inventory.specialEnergy>=p.equipment.specialCost&&p.attackQueuedTick!==null){p.specialQueued=true;event(state,{tick:state.tick,type:"special_queued",attacker:p.id,defender:p.targetId,special:true});}return;
 }
}
function deterministicRoll(seed:number):number{const x=Math.sin(seed*12.9898)*43758.5453;return x-Math.floor(x);}
function inMeleeRange(a:Player,b:Player):boolean{const distance=Math.abs(a.x-b.x)+Math.abs(a.y-b.y);return distance>0&&distance<=a.equipment.attackRange;}
function nearestMeleeTile(from:Tile,target:Tile,range:number):Tile {
  const candidates:Tile[]=[];
  for(let dx=-range;dx<=range;dx++) for(let dy=-range;dy<=range;dy++) {
    if(Math.abs(dx)+Math.abs(dy)!==range) continue;
    const t={x:target.x+dx,y:target.y+dy};
    if(t.x>=1&&t.x<MAP_WIDTH-1&&t.y>=1&&t.y<MAP_HEIGHT-1)candidates.push(t);
  }
  let best=candidates[0]??target,bestLen=Number.POSITIVE_INFINITY;
  for(const tile of candidates){
    const path=findPath(from,tile);
    if(path.length<bestLen){best=tile;bestLen=path.length;}
  }
  return best;
}
function resolveAttack(state:GameState,a:Player):void{
 if(!a.targetId||a.attackQueuedTick===null||state.tick<a.attackQueuedTick)return;
 const d=state.players[a.targetId];if(!d||d.hp<=0){a.targetId=null;a.attackQueuedTick=null;a.hitQueuedTick=null;a.pendingHit=null;a.specialQueued=false;return;}
 if(!inMeleeRange(a,d)){const goal=nearestMeleeTile({x:a.x,y:a.y},{x:d.x,y:d.y},a.equipment.attackRange);setDestination(a,goal.x,goal.y);return;}
 const special=a.specialQueued, bonus=styleBonus[a.attackStyle];
 const attackerPrayer=prayerModifiers(a), defenderPrayer=prayerModifiers(d);
 const effectiveAttack=effectiveLevel(a.attack,attackerPrayer.attack,bonus.attack);
 const effectiveDefence=effectiveLevel(d.defence,defenderPrayer.defence,styleBonus[d.attackStyle].defence);
 const weapon=WEAPONS[a.equipment.weapon] ?? WEAPONS.rune_scimitar;
 const stance=weaponStance(weapon, a.attackStyle);
 const attackBonus=weaponAttackBonus(weapon, a.attackStyle);
 const defenceBonus=stance.attackType==="stab"?d.equipment.defenceStab:stance.attackType==="crush"?d.equipment.defenceCrush:d.equipment.defenceSlash;
 const attackRoll=effectiveAttack*(attackBonus+64), defenceRoll=effectiveDefence*(defenceBonus+64);
 const hitChance=attackRoll<=defenceRoll
   ? attackRoll/(2*(defenceRoll+1))
   : 1-(defenceRoll+2)/(2*(attackRoll+1));
 const accuracyRoll=deterministicRoll(state.tick*7919+a.x*97+a.y*53+d.x*31+d.y*17);
 const rules=state.combatRules.onAttack(a.id,d.id,accuracyRoll,hitChance,attackRoll,defenceRoll);
 // OSRS max-hit formula: floor((effective strength * (strength bonus + 64) + 320) / 640).
 const effectiveStrength=effectiveLevel(a.strength,attackerPrayer.strength,bonus.strength);
 const baseMaxHit=Math.max(1,Math.floor((effectiveStrength*(weapon.strengthBonus+64)+320)/640));
 const maxHit=special?Math.max(1,Math.floor(baseMaxHit*a.equipment.specialMultiplier)):baseMaxHit;
 let damage=rules.hit?Math.floor(deterministicRoll(state.tick*1009+a.x*97+a.y*53)*(maxHit+1)):0;
 a.nextAttackTick=state.tick+a.equipment.attackSpeed;a.attackQueuedTick=state.tick+a.equipment.attackSpeed;
 // Standard melee has no projectile travel delay; PvP processing order can add one tick.
 // If the defender has already taken their turn, the queued hit waits for their next turn.
 const hitTick=a.id.localeCompare(d.id)<0?state.tick:state.tick+1;
 a.hitQueuedTick=hitTick;
 if(special){a.inventory.specialEnergy-=a.equipment.specialCost;event(state,{tick:state.tick,type:"special",attacker:a.id,defender:d.id,special:true});}
 event(state,{tick:state.tick,type:"attack",attacker:a.id,defender:d.id,attackRoll,defenceRoll,hitChance,special});
 a.pendingHitDamage=damage;a.pendingHitSucceeded=rules.hit;a.pendingHitRoll=attackRoll;a.pendingDefenceRoll=defenceRoll;a.pendingHitTargetId=d.id;a.pendingAttackType=weapon.attackType;a.pendingSpecial=special;
}
function movementStageForPlayer(state:GameState,p:Player):void{
 if(p.hp<=0)return;
 if(p.targetId){const t=state.players[p.targetId];if(t&&t.hp>0&&!inMeleeRange(p,t)){const goal=nearestMeleeTile({x:p.x,y:p.y},{x:t.x,y:t.y},p.equipment.attackRange);setDestination(p,goal.x,goal.y);}}
 if(p.path.length){const next=p.path.shift()!;p.x=next.x;p.y=next.y;}
}
function prayerModifiers(p:Player):{attack:number;strength:number;defence:number}{
 switch(p.prayer){
  case "burst_of_strength": return {attack:1,strength:1.05,defence:1};
  case "clarity_of_thought": return {attack:1.05,strength:1,defence:1};
  case "superhuman_strength": return {attack:1,strength:1.1,defence:1};
  case "improved_reflexes": return {attack:1.1,strength:1,defence:1};
  case "incredible_reflexes": return {attack:1.15,strength:1,defence:1};
  case "ultimate_strength": return {attack:1,strength:1.15,defence:1};
  case "steel_skin": return {attack:1,strength:1,defence:1.15};
  default: return {attack:1,strength:1,defence:1};
 }
}
function effectiveLevel(base:number,multiplier:number,style:number):number{return Math.floor(base*multiplier)+style+8;}
function prayerStageForPlayer(state:GameState,p:Player):void{
 if(!p.prayer)return;
 if(state.tick%2===0){p.prayerPoints=Math.max(0,p.prayerPoints-1);if(p.prayerPoints===0)p.prayer=null;}
}
function awardMeleeXp(a:Player, damage:number):void{
 if(damage<=0)return;
 const units=damage*4/3;
 switch(a.attackStyle){
  case "accurate": a.xp.attack+=units; break;
  case "aggressive": a.xp.strength+=units; break;
  case "defensive": a.xp.defence+=units; break;
  case "controlled": a.xp.attack+=units/3; a.xp.strength+=units/3; a.xp.defence+=units/3; break;
 }
 a.xp.hitpoints+=units/3;
}
function resolveQueuedHitForPlayer(state:GameState,p:Player):void{
 const incoming=Object.values(state.players)
   .filter(a=>a.id!==p.id&&a.pendingHit?.resolveTick===state.tick&&a.pendingHit.defenderId===p.id)
   .sort((a,b)=>(a.pendingHit!.sequence-b.pendingHit!.sequence)||a.id.localeCompare(b.id));
 for(const a of incoming){
   const hit=a.pendingHit!;
   const rawDamage=hit.rawDamage;
   const attackRoll=hit.attackRoll;
   const defenceRoll=hit.defenceRoll;
   const special=hit.special;
   const attackType=hit.attackType;
   const succeeded=hit.succeeded;
   a.hitQueuedTick=null;a.pendingHit=null;
   if(p.hp<=0)continue;
   // Protection is evaluated on the defender turn, so prayer flicks affect the queued hit.
   const protectedByPrayer=(attackType==="melee"&&p.prayer==="protect_melee");
   const damage=protectedByPrayer?Math.floor(rawDamage*0.6):rawDamage;
   if(damage>0){p.hp=Math.max(0,p.hp-damage);awardMeleeXp(a,damage);}
   event(state,{tick:state.tick,type:succeeded?"hit":"miss",attacker:a.id,defender:p.id,damage,attackRoll,defenceRoll,special});
   if(p.hp<=0){
     p.targetId=null;p.attackQueuedTick=null;p.hitQueuedTick=null;p.pendingHit=null;
     a.targetId=null;
     event(state,{tick:state.tick,type:"death",attacker:a.id,defender:p.id});
     break;
   }
 }
}
export function step(state:GameState):void{
 state.tick++;
 const inputs=state.pendingInputs.splice(0).sort((a,b)=>a.sequence-b.sequence).slice(0,10);
 for(const input of inputs)processInput(state,input.command);
 // Player turns are deliberately ordered by stable player id. A hit is queued
 // onto the defender and resolves when that defender reaches their turn, which
 // preserves the PvP ordering asymmetry documented for OSRS.
 const players=Object.values(state.players).sort((a,b)=>a.id.localeCompare(b.id));
 for(const p of players){
   resolveQueuedHitForPlayer(state,p);
   prayerStageForPlayer(state,p);
   movementStageForPlayer(state,p);
   resolveAttack(state,p);
 }
}
