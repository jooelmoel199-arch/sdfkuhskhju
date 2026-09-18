import { createCombatRules, type CombatRules } from "./combat-rules";
import { findPath, MAP_HEIGHT, MAP_WIDTH, type Tile } from "./pathfinding";
import { AMMUNITION, MELEE_STYLE_BONUS, SPELLS, WEAPONS, weaponAttackBonus, weaponStance, type AttackType } from "./combat-definitions";
import { effectiveCombatLevel, hitChanceFromRolls, magicMaxHit, playerMagicDefenceLevel, prayerDrainResistance, projectileHitDelay, standardMaxHit } from "./combat-formulas";

export type Team = "blue" | "red";
export type Prayer = "protect_melee" | "protect_mage" | "protect_range" | "eagle_eye" | "mystic_might" | "burst_of_strength" | "clarity_of_thought" | "superhuman_strength" | "improved_reflexes" | "incredible_reflexes" | "ultimate_strength" | "steel_skin" | null;
export type PrayerName = Exclude<Prayer,null>;
export type AttackStyle = "accurate" | "aggressive" | "defensive" | "controlled";
export type ItemAction = "eat" | "equip" | "unequip";
export type RangedStyle = "accurate" | "rapid" | "longrange";
export type MagicStyle = "standard" | "defensive";
export interface ItemStack { id:string; quantity:number; }

export type InputCommand =
  | { type: "attack"; targetId: string }
  | { type: "move"; x: number; y: number }
  | { type: "prayer"; prayer: Prayer }
  | { type: "attack_style"; style: AttackStyle }
  | { type: "ranged_style"; style: RangedStyle }
  | { type: "magic_style"; style: MagicStyle }
  | { type: "item_action"; slot:number; action:ItemAction }
  | { type: "eat" }
  | { type: "special" }
  | { type: "stop_attack" };

export interface Inventory { slots:Array<ItemStack|null>; food: number; specialEnergy: number; coins: number; }
export interface CombatXp { attack:number; strength:number; defence:number; ranged:number; magic:number; hitpoints:number; }
export interface PendingHit { sourceTick:number; resolveTick:number; sequence:number; attackerId:string; defenderId:string; attackType:AttackType; attackStyle:AttackStyle; attackRoll:number; defenceRoll:number; hitChance:number; succeeded:boolean; rawDamage:number; special:boolean; baseXp:number; delivery:"melee"|"projectile"|"spell"; }
export interface Equipment {
  weapon: string; attackType: AttackType; attackRange: number; attackSpeed: number; attackBonus: number; strengthBonus: number; magicAttackBonus?: number; magicDamageBonus?: number; prayerBonus?: number;
  specialCost: number; specialMultiplier: number; defenceBonus: number; defenceStab: number; defenceSlash: number; defenceCrush: number;
  ammoId?: string; spellId?: string;
}
export interface Player {
  pid:number; id:string; name:string; team:Team; x:number; y:number; destinationX:number; destinationY:number;
  hp:number; maxHp:number; prayerPoints:number; maxPrayerPoints:number;
  attack:number; strength:number; defence:number; ranged:number; magic:number; xp:CombatXp; equipment:Equipment; inventory:Inventory;
  prayer:Prayer; activePrayers:PrayerName[]; prayerNextDrainTick:number|null; prayerDrainCounter:number; attackStyle:AttackStyle; rangedStyle:RangedStyle; magicStyle:MagicStyle; targetId:string|null; nextAttackTick:number;
  attackQueuedTick:number|null; hitQueuedTick:number|null; specialQueued:boolean; path:Tile[]; freezeUntilTick:number;
}
export interface CombatEvent {
  tick:number; type:"attack_queued"|"attack_cancelled"|"attack"|"hit"|"miss"|"eat"|"special_queued"|"special"|"move"|"prayer"|"attack_style"|"death"|"projectile"|"spell";
  attacker?:string; defender?:string; damage?:number; attackRoll?:number; defenceRoll?:number;
  special?:boolean; hitChance?:number; x?:number; y?:number; sourceX?:number; sourceY?:number; prayer?:Prayer; style?:AttackStyle; reason?:string; resolveTick?:number; attackType?:AttackType;
}
export interface QueuedInput { sequence:number; receivedTick:number; command:InputCommand; }
export interface GameState { tick:number; nextInputSequence:number; nextCombatSequence:number; players:Record<string,Player>; pendingInputs:QueuedInput[]; pendingHits:PendingHit[]; events:CombatEvent[]; readonly combatRules:CombatRules; }

const styleBonus=MELEE_STYLE_BONUS;
const PRAYER_DRAIN_EFFECT:Record<Exclude<Prayer,null>,number>={
 protect_melee:12,protect_mage:12,protect_range:12,
 eagle_eye:12,mystic_might:12,
 burst_of_strength:3,clarity_of_thought:3,superhuman_strength:6,improved_reflexes:6,incredible_reflexes:12,ultimate_strength:12,steel_skin:12
};

function makePlayer(pid:number,id:string,name:string,team:Team,x:number,y:number):Player{
  return {pid,id,name,team,x,y,destinationX:x,destinationY:y,hp:99,maxHp:99,prayerPoints:20,maxPrayerPoints:20,
    attack:75,strength:75,defence:70,ranged:75,magic:75,xp:{attack:0,strength:0,defence:0,ranged:0,magic:0,hitpoints:0},equipment:{weapon:WEAPONS.rune_scimitar.id,...WEAPONS.rune_scimitar, defenceBonus:0, defenceStab:0, defenceSlash:0, defenceCrush:0},
    inventory:{slots:[{id:"rune_scimitar",quantity:1},{id:"lobster",quantity:10},{id:"coins",quantity:2500},{id:"shortbow",quantity:1},{id:"bronze_arrow",quantity:250},{id:"fire_rune",quantity:100},{id:"air_rune",quantity:300},{id:"fire_strike",quantity:1},{id:"ice_barrage",quantity:1},{id:"death_rune",quantity:100},{id:"chaos_rune",quantity:400},{id:"water_rune",quantity:600},null,null,null,null,null],food:10,specialEnergy:100,coins:2500},prayer:null,activePrayers:[],prayerNextDrainTick:null,prayerDrainCounter:0,attackStyle:"accurate",rangedStyle:"accurate",magicStyle:"standard",targetId:null,nextAttackTick:0,attackQueuedTick:null,hitQueuedTick:null,specialQueued:false,path:[],freezeUntilTick:0};
}

export function createGame():GameState{
  const players:Record<string,Player>={
    player:makePlayer(1,"player","Player","blue",10,10),
    opponent:makePlayer(2,"opponent","Opponent","red",14,10),
    goblin_guard_1:makePlayer(100,"goblin_guard_1","Goblin guard","red",18,8),
    goblin_guard_2:makePlayer(101,"goblin_guard_2","Goblin guard","red",18,12),
    goblin_guard_3:makePlayer(102,"goblin_guard_3","Goblin guard","red",21,10)
  };
  for(const id of ["goblin_guard_1","goblin_guard_2","goblin_guard_3"]){
    const g=players[id];
    g.attack=45; g.strength=45; g.defence=35; g.hp=40; g.maxHp=40;
    g.inventory.specialEnergy=0; g.targetId="player"; g.attackStyle="aggressive";
    g.attackQueuedTick=0;
  }
  return {tick:0,nextInputSequence:1,nextCombatSequence:1,pendingInputs:[],pendingHits:[],events:[],players,combatRules:createCombatRules()};
}
export function enqueueInput(state:GameState,command:InputCommand):void{state.pendingInputs.push({sequence:state.nextInputSequence++,receivedTick:state.tick,command});}
function event(state:GameState,e:CombatEvent):void{state.events.push(e);if(state.events.length>300)state.events.splice(0,state.events.length-300);}
function clampTile(x:number,y:number):Tile{return{x:Math.max(1,Math.min(MAP_WIDTH-2,Math.round(x))),y:Math.max(1,Math.min(MAP_HEIGHT-2,Math.round(y)))}};
function setDestination(p:Player,x:number,y:number){const t=clampTile(x,y);p.destinationX=t.x;p.destinationY=t.y;p.path=findPath({x:p.x,y:p.y},t);}

function processInput(state:GameState,command:InputCommand):void{
 const p=state.players.player;if(!p||p.hp<=0)return;
 switch(command.type){
  case "attack":{const target=state.players[command.targetId];if(!target||target.hp<=0||target.team===p.team)return;p.targetId=target.id;setDestination(p,target.x,target.y);p.attackQueuedTick=Math.max(state.tick,p.nextAttackTick);p.specialQueued=false;event(state,{tick:state.tick,type:"attack_queued",attacker:p.id,defender:target.id});return;}
  case "stop_attack":p.targetId=null;p.attackQueuedTick=null;p.hitQueuedTick=null;p.specialQueued=false;p.path=[];state.pendingHits=state.pendingHits.filter(hit=>hit.attackerId!==p.id);event(state,{tick:state.tick,type:"attack_cancelled",attacker:p.id});return;
  case "move":setDestination(p,command.x,command.y);p.targetId=null;p.attackQueuedTick=null;p.specialQueued=false;event(state,{tick:state.tick,type:"move",attacker:p.id,x:p.destinationX,y:p.destinationY});return;
  case "attack_style":p.attackStyle=command.style;event(state,{tick:state.tick,type:"attack_style",attacker:p.id,style:p.attackStyle});return;
  case "ranged_style":p.rangedStyle=command.style;event(state,{tick:state.tick,type:"attack_style",attacker:p.id,reason:"ranged:"+p.rangedStyle});return;
  case "magic_style":p.magicStyle=command.style;event(state,{tick:state.tick,type:"attack_style",attacker:p.id,reason:"magic:"+p.magicStyle});return;
  case "prayer":{
   if(command.prayer===null){p.activePrayers=[];p.prayer=null;p.prayerNextDrainTick=null;event(state,{tick:state.tick,type:"prayer",attacker:p.id,prayer:null});return;}
   if(p.prayerPoints<=0)return;
   const group=(prayer:PrayerName):"overhead"|"offence"|"defence"|"other"=>{
     if(prayer==="protect_melee"||prayer==="protect_mage"||prayer==="protect_range")return "overhead";
     if(prayer==="burst_of_strength"||prayer==="clarity_of_thought"||prayer==="superhuman_strength"||prayer==="improved_reflexes"||prayer==="incredible_reflexes"||prayer==="ultimate_strength"||prayer==="eagle_eye"||prayer==="mystic_might")return "offence";
     if(prayer==="steel_skin")return "defence";
     return "other";
   };
   const index=p.activePrayers.indexOf(command.prayer);
   if(index>=0)p.activePrayers.splice(index,1);
   else{
     const g=group(command.prayer);
     if(g!=="other")p.activePrayers=p.activePrayers.filter(active=>group(active)!==g);
     p.activePrayers.push(command.prayer);
   }
   p.prayer=p.activePrayers[p.activePrayers.length-1]??null;
   p.prayerNextDrainTick=p.activePrayers.length?state.tick+1:null;
   event(state,{tick:state.tick,type:"prayer",attacker:p.id,prayer:p.prayer});
   return;
 }
  case "item_action":{const stack=p.inventory.slots[command.slot];if(!stack||stack.quantity<=0)return;if(command.action==="eat"&&stack.id==="lobster"&&p.hp<p.maxHp){stack.quantity--;p.inventory.food=Math.max(0,p.inventory.food-1);p.hp=Math.min(p.maxHp,p.hp+12);event(state,{tick:state.tick,type:"eat",attacker:p.id,damage:-12});if(stack.quantity===0)p.inventory.slots[command.slot]=null;return;}if(command.action==="equip"){
      if(stack.id==="rune_scimitar"){Object.assign(p.equipment,{...WEAPONS.rune_scimitar,defenceBonus:0,defenceStab:0,defenceSlash:0,defenceCrush:0});delete p.equipment.ammoId;delete p.equipment.spellId;event(state,{tick:state.tick,type:"attack_style",attacker:p.id,reason:"equipped rune scimitar"});return;}
      if(stack.id==="shortbow"){Object.assign(p.equipment,{...WEAPONS.shortbow,defenceBonus:0,defenceStab:0,defenceSlash:0,defenceCrush:0,ammoId:"bronze_arrow"});delete p.equipment.spellId;event(state,{tick:state.tick,type:"attack_style",attacker:p.id,reason:"equipped shortbow"});return;}
      if(stack.id==="fire_strike"||stack.id==="ice_barrage"){const spell=SPELLS[stack.id];Object.assign(p.equipment,{...WEAPONS.fire_strike,attackSpeed:spell.attackSpeed,attackRange:spell.attackRange,magicAttackBonus:spell.magicAttackBonus,defenceBonus:0,defenceStab:0,defenceSlash:0,defenceCrush:0,spellId:spell.id});delete p.equipment.ammoId;event(state,{tick:state.tick,type:"attack_style",attacker:p.id,reason:"selected "+stack.id});return;}
      return;
    }return;}
  case "eat":{const slot=p.inventory.slots.findIndex(v=>v?.id==="lobster");if(slot>=0)processInput(state,{type:"item_action",slot,action:"eat"});return;}
  case "special":if(p.equipment.specialCost>0&&p.targetId&&p.inventory.specialEnergy>=p.equipment.specialCost&&p.attackQueuedTick!==null){p.specialQueued=true;event(state,{tick:state.tick,type:"special_queued",attacker:p.id,defender:p.targetId,special:true});}return;
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
function combatDistance(a:Player,b:Player):number{return Math.max(Math.abs(a.x-b.x),Math.abs(a.y-b.y));}
function inAttackRange(a:Player,b:Player):boolean{return combatDistance(a,b)>0&&combatDistance(a,b)<=a.equipment.attackRange;}
function consumeResource(p:Player,id:string,amount:number):boolean{
  const stack=p.inventory.slots.find(v=>v?.id===id);
  if(!stack||stack.quantity<amount)return false;
  stack.quantity-=amount;if(stack.quantity===0){const i=p.inventory.slots.indexOf(stack);p.inventory.slots[i]=null;}return true;
}
function consumeResources(p:Player,requirements:Record<string,number>):boolean{
  for(const [id,amount] of Object.entries(requirements)){
    const stack=p.inventory.slots.find(v=>v?.id===id);
    if(!stack||stack.quantity<amount)return false;
  }
  for(const [id,amount] of Object.entries(requirements))consumeResource(p,id,amount);
  return true;
}
function rangedStyleBonuses(style:RangedStyle):{level:number;defence:number}{
  if(style==="longrange")return {level:0,defence:3};
  return style==="accurate"?{level:3,defence:0}:{level:0,defence:0};
}
function magicStyleBonuses(style:MagicStyle):{level:number;defence:number}{return style==="defensive"?{level:0,defence:3}:{level:0,defence:0};}
function awardCombatXp(a:Player,damage:number,attackType:AttackType,baseXp=0):void{
 if(attackType==="magic"&&baseXp>0)a.xp.magic+=baseXp;
 if(damage<=0)return;
 if(attackType==="melee"){switch(a.attackStyle){case "accurate":a.xp.attack+=damage*4;break;case "aggressive":a.xp.strength+=damage*4;break;case "defensive":a.xp.defence+=damage*4;break;case "controlled":a.xp.attack+=damage*4/3;a.xp.strength+=damage*4/3;a.xp.defence+=damage*4/3;break;}}
 else if(attackType==="ranged"){if(a.rangedStyle==="longrange"){a.xp.ranged+=damage*2;a.xp.defence+=damage*2;}else a.xp.ranged+=damage*4;}
 else {a.xp.magic+=(a.magicStyle==="defensive"?damage*4/3:damage*2);if(a.magicStyle==="defensive")a.xp.defence+=damage;}
 a.xp.hitpoints+=damage*4/3;
}
function resolveMeleeAttack(state:GameState,a:Player,d:Player):void{
 const special=a.specialQueued, bonus=styleBonus[a.attackStyle], attackerPrayer=prayerModifiers(a), defenderPrayer=prayerModifiers(d);
 const effectiveAttack=effectiveLevel(a.attack,attackerPrayer.attack,bonus.attack), effectiveDefence=effectiveLevel(d.defence,defenderPrayer.defence,styleBonus[d.attackStyle].defence);
 const weapon=WEAPONS[a.equipment.weapon]??WEAPONS.rune_scimitar, stance=weaponStance(weapon,a.attackStyle), attackBonus=weaponAttackBonus(weapon,a.attackStyle);
 const defenceBonus=stance.attackType==="stab"?d.equipment.defenceStab:stance.attackType==="crush"?d.equipment.defenceCrush:d.equipment.defenceSlash;
 const attackRoll=effectiveAttack*(attackBonus+64),defenceRoll=effectiveDefence*(defenceBonus+64);
 const hitChance=hitChanceFromRolls(attackRoll,defenceRoll);
 const rules=state.combatRules.onAttack(a.id,d.id,deterministicRoll(state.tick*7919+a.x*97+a.y*53+d.x*31+d.y*17),hitChance,attackRoll,defenceRoll);
 const effectiveStrength=effectiveLevel(a.strength,attackerPrayer.strength,bonus.strength);
 const baseMaxHit=standardMaxHit(effectiveStrength,weapon.strengthBonus);
 const maxHit=special?Math.max(1,Math.floor(baseMaxHit*a.equipment.specialMultiplier)):baseMaxHit;
 const damage=rules.hit?Math.floor(deterministicRoll(state.tick*1009+a.x*97+a.y*53)*(maxHit+1)):0;
 a.nextAttackTick=state.tick+a.equipment.attackSpeed;a.attackQueuedTick=a.nextAttackTick;
 const hitTick=a.pid<d.pid?state.tick:state.tick+1;a.hitQueuedTick=hitTick;
 if(special){a.inventory.specialEnergy-=a.equipment.specialCost;event(state,{tick:state.tick,type:"special",attacker:a.id,defender:d.id,special:true});}
 event(state,{tick:state.tick,type:"attack",attacker:a.id,defender:d.id,attackRoll,defenceRoll,hitChance,special,attackType:"melee"});
 state.pendingHits.push({sourceTick:state.tick,resolveTick:hitTick,sequence:state.nextCombatSequence++,attackerId:a.id,defenderId:d.id,attackType:"melee",attackStyle:a.attackStyle,attackRoll,defenceRoll,hitChance,succeeded:rules.hit,rawDamage:damage,special,baseXp:0,delivery:"melee"});
}
function resolveRangedOrMagicAttack(state:GameState,a:Player,d:Player):void{
 const ranged=a.equipment.attackType==="ranged", style=ranged?rangedStyleBonuses(a.rangedStyle):magicStyleBonuses(a.magicStyle);
 const attackerPrayer=prayerModifiers(a),defenderPrayer=prayerModifiers(d);
 const effectiveAttack=effectiveLevel(ranged?a.ranged:a.magic,ranged?attackerPrayer.rangedAttack:attackerPrayer.magicAttack,style.level);
 const effectiveDefence=effectiveLevel(d.defence,defenderPrayer.defence,styleBonus[d.attackStyle].defence+style.defence);
 const attackBonus=ranged?a.equipment.attackBonus+(AMMUNITION[a.equipment.ammoId??""]?.attackBonus??0):(a.equipment.magicAttackBonus??0), defenceBonus=d.equipment.defenceBonus;
 const effectiveMagicDefence=playerMagicDefenceLevel(d.magic,d.defence,defenderPrayer.magicDefence,defenderPrayer.defence);
 const rangedDefence=effectiveDefence, magicDefence=effectiveMagicDefence;
 const attackRoll=effectiveAttack*(attackBonus+64),defenceRoll=(ranged?rangedDefence:magicDefence)*(defenceBonus+64);
 const hitChance=hitChanceFromRolls(attackRoll,defenceRoll);
 const rules=state.combatRules.onAttack(a.id,d.id,deterministicRoll(state.tick*7919+a.x*97+a.y*53+d.x*31+d.y*17),hitChance,attackRoll,defenceRoll);
 let damage=0;
 if(rules.hit){
   const ammo=AMMUNITION[a.equipment.ammoId??""]; const spell=SPELLS[a.equipment.spellId??""];
   const effectiveRangedStrength=effectiveLevel(a.ranged,attackerPrayer.rangedStrength,style.level);
 const maxHit=ranged?standardMaxHit(effectiveRangedStrength,a.equipment.strengthBonus+(ammo?.rangedStrength??0)):magicMaxHit(spell?.maxHit??0,(a.equipment.magicDamageBonus??0)+attackerPrayer.magicDamage);
   damage=Math.floor(deterministicRoll(state.tick*1009+a.x*97+a.y*53+d.x*31+d.y*17)*(maxHit+1));
 }
 let resourceOk=false;
 if(ranged) resourceOk=Boolean(a.equipment.ammoId)&&consumeResource(a,a.equipment.ammoId!,1);
 else {
   const spell=SPELLS[a.equipment.spellId??""];
   resourceOk=Boolean(spell)&&consumeResources(a,spell.runes);
 }
 if(!resourceOk){a.targetId=null;a.attackQueuedTick=null;a.hitQueuedTick=null;a.specialQueued=false;event(state,{tick:state.tick,type:"attack_cancelled",attacker:a.id,defender:d.id,reason:ranged?"out_of_ammo":"missing_runes"});return;}
 const attackSpeed=ranged?(a.rangedStyle==="rapid"?Math.max(1,a.equipment.attackSpeed-1):a.rangedStyle==="longrange"?a.equipment.attackSpeed+1:a.equipment.attackSpeed):a.equipment.attackSpeed;
 a.nextAttackTick=state.tick+attackSpeed;a.attackQueuedTick=a.nextAttackTick;
  const distance=combatDistance(a,d);
  const travelTicks=projectileHitDelay(ranged?"ranged":"magic",distance);
  const travelTick=state.tick+travelTicks+(d.pid<a.pid?1:0);
  event(state,{tick:state.tick,type:ranged?"projectile":"spell",attacker:a.id,defender:d.id,x:d.x,y:d.y,sourceX:a.x,sourceY:a.y,reason:ranged?(a.equipment.ammoId??"projectile"):(a.equipment.spellId??"spell"),resolveTick:travelTick,attackType:ranged?"ranged":"magic"});
 event(state,{tick:state.tick,type:"attack",attacker:a.id,defender:d.id,attackRoll,defenceRoll,hitChance,attackType:ranged?"ranged":"magic"});
 a.hitQueuedTick=travelTick;
 state.pendingHits.push({sourceTick:state.tick,resolveTick:travelTick,sequence:state.nextCombatSequence++,attackerId:a.id,defenderId:d.id,attackType:ranged?"ranged":"magic",attackStyle:a.attackStyle,attackRoll,defenceRoll,hitChance,succeeded:rules.hit,rawDamage:damage,special:false,baseXp:ranged?0:(SPELLS[a.equipment.spellId??""]?.baseXp??0),delivery:ranged?"projectile":"spell"});
}
function resolveAttack(state:GameState,a:Player):void{
 if(!a.targetId||a.attackQueuedTick===null||state.tick<a.attackQueuedTick)return;
 const d=state.players[a.targetId];if(!d||d.hp<=0){a.targetId=null;a.attackQueuedTick=null;a.hitQueuedTick=null;a.specialQueued=false;state.pendingHits=state.pendingHits.filter(hit=>hit.attackerId!==a.id);return;}
 const attackRange=a.equipment.attackType==="ranged"&&a.rangedStyle==="longrange"?a.equipment.attackRange+2:a.equipment.attackRange;
 if(combatDistance(a,d)>0&&combatDistance(a,d)>attackRange){if(a.equipment.attackType==="melee"){const goal=nearestMeleeTile({x:a.x,y:a.y},{x:d.x,y:d.y},a.equipment.attackRange);setDestination(a,goal.x,goal.y);}return;}
 if(a.equipment.attackType==="melee")resolveMeleeAttack(state,a,d);else resolveRangedOrMagicAttack(state,a,d);
}
function movementStageForPlayer(state:GameState,p:Player):void{
 if(p.hp<=0)return;
 if(p.freezeUntilTick>state.tick){p.path=[];return;}
 if(p.targetId){const t=state.players[p.targetId];if(t&&t.hp>0&&p.equipment.attackType==="melee"&&!inAttackRange(p,t)){const goal=nearestMeleeTile({x:p.x,y:p.y},{x:t.x,y:t.y},p.equipment.attackRange);setDestination(p,goal.x,goal.y);}}
 if(p.path.length){const next=p.path.shift()!;p.x=next.x;p.y=next.y;}
}
function prayerModifiers(p:Player):{attack:number;strength:number;defence:number;rangedAttack:number;rangedStrength:number;magicAttack:number;magicDefence:number;magicDamage:number}{
 const result={attack:1,strength:1,defence:1,rangedAttack:1,rangedStrength:1,magicAttack:1,magicDefence:1,magicDamage:0};
 const prayers:PrayerName[]=p.activePrayers.length?p.activePrayers:(p.prayer?[p.prayer]:[]);
 for(const prayer of prayers){
   switch(prayer){
     case "eagle_eye":result.rangedAttack*=1.15;result.rangedStrength*=1.15;break;
     case "mystic_might":result.magicAttack*=1.15;result.magicDefence*=1.15;result.magicDamage+=0.02;break;
     case "burst_of_strength":result.strength*=1.05;break;
     case "clarity_of_thought":result.attack*=1.05;break;
     case "superhuman_strength":result.strength*=1.10;break;
     case "improved_reflexes":result.attack*=1.10;break;
     case "incredible_reflexes":result.attack*=1.15;break;
     case "ultimate_strength":result.strength*=1.15;break;
     case "steel_skin":result.defence*=1.15;break;
   }
 }
 return result;
}
const effectiveLevel=effectiveCombatLevel;
function prayerStageForPlayer(state:GameState,p:Player):void{
 const prayers=p.activePrayers.length?p.activePrayers:(p.prayer?[p.prayer]:[]);
 if(!prayers.length)return;
 const effect=prayers.reduce((total,prayer)=>total+PRAYER_DRAIN_EFFECT[prayer],0);
 p.prayerDrainCounter+=effect;
 const resistance=prayerDrainResistance(p.equipment.prayerBonus??0);
 while(p.prayerDrainCounter>=resistance&&p.prayerPoints>0){p.prayerDrainCounter-=resistance;p.prayerPoints--;}
 if(p.prayerPoints<=0){p.prayerPoints=0;p.prayer=null;p.prayerDrainCounter=0;p.prayerNextDrainTick=null;}
}
function resolveQueuedHitForPlayer(state:GameState,p:Player):void{
 const incoming=state.pendingHits
   .filter(hit=>hit.resolveTick===state.tick&&hit.defenderId===p.id)
   .sort((a,b)=>a.sequence-b.sequence);
 for(const hit of incoming){
   const a=state.players[hit.attackerId];
   if(!a)continue;
   const rawDamage=hit.rawDamage;
   const spell=hit.attackType==="magic"?SPELLS[state.players[hit.attackerId]?.equipment.spellId??""]:undefined;
   const attackRoll=hit.attackRoll;
   const defenceRoll=hit.defenceRoll;
   const special=hit.special;
   const attackType=hit.attackType;
   const succeeded=hit.succeeded;
   a.hitQueuedTick=null;
   if(p.hp<=0){continue;}
   // Protection is evaluated on the defender turn, so prayer flicks affect the queued hit.
   const prayers=p.activePrayers.length?p.activePrayers:(p.prayer?[p.prayer]:[]);
   const protectedByPrayer=(attackType==="melee"&&prayers.includes("protect_melee"))||(attackType==="ranged"&&prayers.includes("protect_range"))||(attackType==="magic"&&prayers.includes("protect_mage"));
   const damage=protectedByPrayer?Math.min(rawDamage,Math.floor(rawDamage*0.6)):rawDamage;
   if(damage>0)p.hp=Math.max(0,p.hp-damage);
   awardCombatXp(a,damage,attackType,hit.baseXp);
   if(attackType==="magic"&&succeeded&&spell?.freezeTicks)p.freezeUntilTick=Math.max(p.freezeUntilTick,state.tick+spell.freezeTicks);
   event(state,{tick:state.tick,type:succeeded?"hit":"miss",attacker:a.id,defender:p.id,damage,attackRoll,defenceRoll,special,attackType,reason:hit.delivery});
   if(p.hp<=0){
     p.targetId=null;p.attackQueuedTick=null;p.hitQueuedTick=null;
     a.targetId=null;
     event(state,{tick:state.tick,type:"death",attacker:a.id,defender:p.id});
     break;
   }
 }
}
export function step(state:GameState):void{
 state.tick++;
 state.pendingInputs.sort((a,b)=>a.sequence-b.sequence);
 const inputs=state.pendingInputs.splice(0,10);
 for(const input of inputs)processInput(state,input.command);
 // Player turns are deliberately ordered by stable player id. A hit is queued
 // onto the defender and resolves when that defender reaches their turn, which
 // preserves the PvP ordering asymmetry documented for OSRS.
 const players=Object.values(state.players).sort((a,b)=>a.pid-b.pid);
 for(const p of players){
   resolveQueuedHitForPlayer(state,p);
   prayerStageForPlayer(state,p);
   movementStageForPlayer(state,p);
   resolveAttack(state,p);
 }
 state.pendingHits=state.pendingHits.filter(hit=>hit.resolveTick>state.tick);
}
