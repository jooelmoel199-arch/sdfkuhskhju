export type Team = "blue" | "red";
export interface Player { id:string; team:Team; x:number; hp:number; maxHp:number; attack:number; strength:number; defence:number; weapon:string; cooldown:number; nextAttackTick:number; prayer:string|null; }
export interface GameState { tick:number; players:Record<string,Player>; events:string[]; }
export function createGame():GameState {
  return { tick:0, events:[], players:{
    "player":{id:"player",team:"blue",x:10,hp:99,maxHp:99,attack:75,strength:75,defence:70,weapon:"rune_scimitar",cooldown:4,nextAttackTick:0,prayer:null},
    "opponent":{id:"opponent",team:"red",x:11,hp:99,maxHp:99,attack:75,strength:75,defence:70,weapon:"rune_scimitar",cooldown:4,nextAttackTick:0,prayer:null}
  }};
}
export function step(state:GameState, attackerId="player", defenderId="opponent"):void {
  state.tick++;
  const a=state.players[attackerId], d=state.players[defenderId];
  if(!a || !d || d.hp<=0) return;
  if(state.tick<a.nextAttackTick || Math.abs(a.x-d.x)>1) return;
  const attackRoll=a.attack+1;
  const defenceRoll=d.defence+1;
  const hit=attackRoll>defenceRoll;
  const damage=hit?Math.max(1,Math.floor((a.strength+1)/8)):0;
  if(hit)d.hp=Math.max(0,d.hp-damage);
  a.nextAttackTick=state.tick+a.cooldown;
  state.events.push(JSON.stringify({tick:state.tick,type:hit?"hit":"miss",attacker:a.id,defender:d.id,damage}));
}
