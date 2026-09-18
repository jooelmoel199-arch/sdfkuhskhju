import { createCombatRules, type CombatRules } from "./combat-rules";
import { findPath, MAP_HEIGHT, MAP_WIDTH, type Tile } from "./pathfinding";

export type Team = "blue" | "red";
export type Prayer = "protect_melee" | "protect_mage" | "protect_range" | null;
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
export interface Equipment {
  weapon: string; attackSpeed: number; attackBonus: number; strengthBonus: number;
  specialCost: number; specialMultiplier: number;
}
export interface Player {
  id:string; name:string; team:Team; x:number; y:number; destinationX:number; destinationY:number;
  hp:number; maxHp:number; prayerPoints:number; maxPrayerPoints:number;
  attack:number; strength:number; defence:number; equipment:Equipment; inventory:Inventory;
  prayer:Prayer; attackStyle:AttackStyle; targetId:string|null; nextAttackTick:number;
  attackQueuedTick:number|null; hitQueuedTick:number|null; pendingHitDamage:number; pendingHitRoll:number; pendingDefenceRoll:number; pendingSpecial:boolean; specialQueued:boolean; path:Tile[];
}
export interface CombatEvent {
  tick:number; type:"attack_queued"|"attack_cancelled"|"attack"|"hit"|"miss"|"eat"|"special_queued"|"special"|"move"|"prayer"|"attack_style"|"death";
  attacker?:string; defender?:string; damage?:number; attackRoll?:number; defenceRoll?:number;
  special?:boolean; x?:number; y?:number; prayer?:Prayer; style?:AttackStyle; reason?:string;
}
export interface QueuedInput { sequence:number; receivedTick:number; command:InputCommand; }
export interface GameState { tick:number; nextInputSequence:number; players:Record<string,Player>; pendingInputs:QueuedInput[]; events:CombatEvent[]; readonly combatRules:CombatRules; }

const styleBonus={accurate:{attack:3,strength:0,defence:0},aggressive:{attack:0,strength:3,defence:0},defensive:{attack:0,strength:0,defence:3},controlled:{attack:1,strength:1,defence:1}} as const;

function makePlayer(id:string,name:string,team:Team,x:number,y:number):Player{
  return {id,name,team,x,y,destinationX:x,destinationY:y,hp:99,maxHp:99,prayerPoints:20,maxPrayerPoints:20,
    attack:75,strength:75,defence:70,equipment:{weapon:"rune_scimitar",attackSpeed:4,attackBonus:45,strengthBonus:44,specialCost:50,specialMultiplier:1.25},
    inventory:{slots:[{id:"rune_scimitar",quantity:1},{id:"lobster",quantity:10},{id:"coins",quantity:2500},null,null,null,null,null,null,null,null,null],food:10,specialEnergy:100,coins:2500},prayer:null,attackStyle:"accurate",targetId:null,nextAttackTick:0,attackQueuedTick:null,hitQueuedTick:null,pendingHitDamage:0,pendingHitRoll:0,pendingDefenceRoll:0,pendingSpecial:false,specialQueued:false,path:[]};
}

export function createGame():GameState{
  const players={player:makePlayer("player","Player","blue",10,10),opponent:makePlayer("opponent","Opponent","red",14,10)};
  return {tick:0,nextInputSequence:1,pendingInputs:[],events:[],players,combatRules:createCombatRules()};
}
export function enqueueInput(state:GameState,command:InputCommand):void{state.pendingInputs.push({sequence:state.nextInputSequence++,receivedTick:state.tick,command});}
function event(state:GameState,e:CombatEvent):void{state.events.push(e);if(state.events.length>300)state.events.splice(0,state.events.length-300);}
function clampTile(x:number,y:number):Tile{return{x:Math.max(1,Math.min(MAP_WIDTH-2,Math.round(x))),y:Math.max(1,Math.min(MAP_HEIGHT-2,Math.round(y)))}};
function setDestination(p:Player,x:number,y:number){const t=clampTile(x,y);p.destinationX=t.x;p.destinationY=t.y;p.path=findPath({x:p.x,y:p.y},t);}

function processInput(state:GameState,command:InputCommand):void{
 const p=state.players.player;if(!p||p.hp<=0)return;
 switch(command.type){
  case "attack":{const target=state.players[command.targetId];if(!target||target.hp<=0||target.team===p.team)return;p.targetId=target.id;setDestination(p,target.x,target.y);p.attackQueuedTick=state.tick;p.specialQueued=false;event(state,{tick:state.tick,type:"attack_queued",attacker:p.id,defender:target.id});return;}
  case "stop_attack":p.targetId=null;p.attackQueuedTick=null;p.hitQueuedTick=null;p.pendingHitDamage=0;p.pendingSpecial=false;p.specialQueued=false;p.path=[];event(state,{tick:state.tick,type:"attack_cancelled",attacker:p.id});return;
  case "move":setDestination(p,command.x,command.y);p.targetId=null;p.attackQueuedTick=null;p.specialQueued=false;event(state,{tick:state.tick,type:"move",attacker:p.id,x:p.destinationX,y:p.destinationY});return;
  case "attack_style":p.attackStyle=command.style;event(state,{tick:state.tick,type:"attack_style",attacker:p.id,style:p.attackStyle});return;
  case "prayer":if(command.prayer!==null&&p.prayerPoints<=0)return;p.prayer=command.prayer;event(state,{tick:state.tick,type:"prayer",attacker:p.id,prayer:p.prayer});return;
  case "item_action":{const stack=p.inventory.slots[command.slot];if(!stack||stack.quantity<=0)return;if(command.action==="eat"&&stack.id==="lobster"&&p.hp<p.maxHp){stack.quantity--;p.inventory.food=Math.max(0,p.inventory.food-1);p.hp=Math.min(p.maxHp,p.hp+12);event(state,{tick:state.tick,type:"eat",attacker:p.id,damage:-12});if(stack.quantity===0)p.inventory.slots[command.slot]=null;return;}if(command.action==="equip"&&stack.id==="rune_scimitar"){p.equipment.weapon="rune_scimitar";p.equipment.attackSpeed=4;p.equipment.attackBonus=45;p.equipment.strengthBonus=44;event(state,{tick:state.tick,type:"attack_style",attacker:p.id,reason:"equipped rune scimitar"});return;}return;}
  case "eat":{const slot=p.inventory.slots.findIndex(v=>v?.id==="lobster");if(slot>=0)processInput(state,{type:"item_action",slot,action:"eat"});return;}
  case "special":if(p.targetId&&p.inventory.specialEnergy>=p.equipment.specialCost&&p.attackQueuedTick!==null){p.specialQueued=true;event(state,{tick:state.tick,type:"special_queued",attacker:p.id,defender:p.targetId,special:true});}return;
 }
}
function deterministicRoll(seed:number):number{const x=Math.sin(seed*12.9898)*43758.5453;return x-Math.floor(x);}
function inMeleeRange(a:Player,b:Player):boolean{return Math.max(Math.abs(a.x-b.x),Math.abs(a.y-b.y))<=1;}
function nearestMeleeTile(from:Tile,target:Tile):Tile {
  const candidates:Tile[]=[
    {x:target.x-1,y:target.y},{x:target.x+1,y:target.y},
    {x:target.x,y:target.y-1},{x:target.x,y:target.y+1}
  ].filter(t=>t.x>=1&&t.x<MAP_WIDTH-1&&t.y>=1&&t.y<MAP_HEIGHT-1);
  let best=candidates[0]??target,bestLen=Number.POSITIVE_INFINITY;
  for(const tile of candidates){
    const path=findPath(from,tile);
    if(path.length<bestLen){best=tile;bestLen=path.length;}
  }
  return best;
}
function resolveAttack(state:GameState,a:Player):void{
 if(!a.targetId||a.attackQueuedTick===null||state.tick<a.attackQueuedTick)return;
 const d=state.players[a.targetId];if(!d||d.hp<=0){a.targetId=null;a.attackQueuedTick=null;a.hitQueuedTick=null;a.pendingHitDamage=0;a.pendingSpecial=false;a.specialQueued=false;return;}
 if(!inMeleeRange(a,d)){const goal=nearestMeleeTile({x:a.x,y:a.y},{x:d.x,y:d.y});setDestination(a,goal.x,goal.y);return;}
 const special=a.specialQueued, bonus=styleBonus[a.attackStyle];
 const effectiveAttack=a.attack+bonus.attack+8, effectiveDefence=d.defence+8;
 const attackRoll=effectiveAttack*(a.equipment.attackBonus+64), defenceRoll=effectiveDefence*(64+styleBonus[d.attackStyle].defence*4);
 const rules=state.combatRules.onAttack(a.id,d.id,attackRoll,defenceRoll);
 // OSRS-style player combat separates the attack turn from the hit evaluation.
 // We record the attack now and resolve its queued hit on the following tick.
 const baseMaxHit=Math.max(1,Math.floor(((a.strength+bonus.strength+8)*(a.equipment.strengthBonus+64))/640));
 const maxHit=special?Math.max(1,Math.floor(baseMaxHit*a.equipment.specialMultiplier)):baseMaxHit;
 const damage=rules.hit?Math.min(d.hp,Math.floor(deterministicRoll(state.tick*1009+a.x*97+a.y*53)*(maxHit+1))):0;
 a.nextAttackTick=state.tick+a.equipment.attackSpeed;a.attackQueuedTick=state.tick+a.equipment.attackSpeed;a.hitQueuedTick=state.tick+1;
 if(special){a.inventory.specialEnergy-=a.equipment.specialCost;event(state,{tick:state.tick,type:"special",attacker:a.id,defender:d.id,special:true});}
 event(state,{tick:state.tick,type:"attack",attacker:a.id,defender:d.id,attackRoll,defenceRoll,special});
 a.pendingHitDamage=damage;a.pendingHitRoll=attackRoll;a.pendingDefenceRoll=defenceRoll;a.pendingSpecial=special;
 a.hitQueuedTick=state.tick+1;
}
function movementStage(state:GameState):void{
 for(const p of Object.values(state.players)){
   if(p.hp<=0)continue;
   if(p.targetId){const t=state.players[p.targetId];if(t&&t.hp>0&&!inMeleeRange(p,t)){const goal=nearestMeleeTile({x:p.x,y:p.y},{x:t.x,y:t.y});setDestination(p,goal.x,goal.y);}}
   if(p.path.length){const next=p.path.shift()!;p.x=next.x;p.y=next.y;}
 }
}
function prayerStage(state:GameState):void{
 for(const p of Object.values(state.players)){
   if(!p.prayer)continue;
   if(state.tick%2===0){p.prayerPoints=Math.max(0,p.prayerPoints-1);if(p.prayerPoints===0)p.prayer=null;}
 }
}
function resolveQueuedHits(state:GameState):void{
 for(const a of Object.values(state.players)){
   if(a.hitQueuedTick!==state.tick)continue;
   const d=a.targetId?state.players[a.targetId]:undefined;
   const damage=a.pendingHitDamage;
   const attackRoll=a.pendingHitRoll;
   const defenceRoll=a.pendingDefenceRoll;
   const special=a.pendingSpecial;
   a.hitQueuedTick=null;a.pendingHitDamage=0;a.pendingSpecial=false;
   if(!d||d.hp<=0)continue;
   if(damage>0)d.hp=Math.max(0,d.hp-damage);
   event(state,{tick:state.tick,type:damage>0?"hit":"miss",attacker:a.id,defender:d.id,damage,attackRoll,defenceRoll,special});
   if(d.hp<=0){d.targetId=null;d.attackQueuedTick=null;d.hitQueuedTick=null;a.targetId=null;event(state,{tick:state.tick,type:"death",attacker:a.id,defender:d.id});}
 }
}
export function step(state:GameState):void{
 state.tick++;
 const inputs=state.pendingInputs.splice(0).sort((a,b)=>a.sequence-b.sequence).slice(0,10);for(const input of inputs)processInput(state,input.command);
 resolveQueuedHits(state);
 movementStage(state);prayerStage(state);for(const p of Object.values(state.players))resolveAttack(state,p);
}
