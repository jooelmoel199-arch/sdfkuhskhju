import { createPlayer, equipItem } from "../moba/entities.ts";
import { createAttackTimerState } from "../combat/timers.ts";
import { shopCatalog } from "../moba/economy.ts";
import { advanceTick } from "../moba/simulation.ts";
import { BLUE_TOWER_X, RED_TOWER_X, BLUE_BASE_X, RED_BASE_X, zoneAt } from "../moba/lane.ts";

function item(id){const found=shopCatalog.find(x=>x.id===id);if(!found)throw new Error("Unknown item "+id);return found}
function player(id,team,role){let p=createPlayer(id,team,{x:team==="blue"?BLUE_BASE_X+4:RED_BASE_X-4,y:0});p={...p,zone:zoneAt(p.tile),gp:300};const sets={melee:["rune_scimitar","rune_defender","fighter_torso","berserker_helm"],ranged:["magic_shortbow","black_dhide_body","archer_helm"],mage:["ancient_staff","mystic_robe_top"]};for(const id of sets[role]){const i=item(id);if(p.gp>=i.cost)p=equipItem(p,i)}return p}
function tower(id,team,x){return{id,kind:"tower",team,tile:{x,y:0},currentHp:250,maxHp:250,attackBonus:40,maxHit:18,attackRange:3,attackTimer:createAttackTimerState(),alive:true}}
export const state={tick:0,blue:player("blue-1","blue","melee"),red:player("red-1","red","ranged"),minions:[],towers:[tower("blue-tower","blue",BLUE_TOWER_X),tower("red-tower","red",RED_TOWER_X)],log:[],rng:Math.random};
export function stepSimulation(){advanceTick(state)}
