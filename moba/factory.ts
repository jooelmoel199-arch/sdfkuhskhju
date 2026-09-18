import { createPlayer, equipItem, addInventoryItem, type TowerEntity, type NeutralCampEntity } from "./entities";
import { createAttackTimerState } from "../combat/timers";
import { shopCatalog } from "./economy";
import { LANE_Y, LANES, BLUE_TOWER_X, RED_TOWER_X, BLUE_BASE_X, RED_BASE_X, zoneAt, type LaneId } from "./lane";
import { zeroBonuses } from "../combat/formulas";
import type { SimulationState } from "./simulation";

export type StartingRole = "melee" | "ranged" | "mage";

function itemById(id: string) {
  const item = shopCatalog.find(candidate => candidate.id === id);
  if (!item) throw new Error(`Unknown starting item ${id}`);
  return item;
}

export function buildStartingLoadout(
  playerId: string,
  team: "blue" | "red",
  role: StartingRole,
  laneId: LaneId
) {
  const tile = {
    x: team === "blue" ? BLUE_BASE_X + 2 : RED_BASE_X - 2,
    y: LANE_Y[laneId]
  };

  let player = createPlayer(playerId, team, tile, laneId);
  player = { ...player, zone: zoneAt(tile), gp: 0 };

  const loadouts: Record<StartingRole, string[]> = {
    melee: ["rune_scimitar", "rune_defender", "fighter_torso", "berserker_helm"],
    ranged: ["magic_shortbow", "black_dhide_body", "archer_helm"],
    mage: ["ancient_staff", "mystic_robe_top"]
  };

  for (const id of loadouts[role]) {
    const item = itemById(id);
    if (player.gp >= item.cost) player = equipItem(player, item);
  }

  const defaultAttackType = player.equipment.weapon?.defaultAttackType;
  if (defaultAttackType) player = { ...player, attackType: defaultAttackType };
  player = { ...player, gp: 300 };

  player = addInventoryItem(player, "shark", 3);
  player = addInventoryItem(player, "prayer_potion", 2);
  return player;
}

export function makeTower(
  id: string,
  team: "blue" | "red",
  laneId: LaneId,
  x: number
): TowerEntity {
  return {
    id,
    kind: "tower",
    team,
    laneId,
    tile: { x, y: LANE_Y[laneId] },
    currentHp: 250,
    maxHp: 250,
    attackBonus: 40,
    maxHit: 18,
    attackRange: 3,
    attackTimer: createAttackTimerState(),
    alive: true
  };
}


export function makeJungleCamp(id: string, name: string, x: number, y: number, rewardGp: number, rewardXp: number): NeutralCampEntity {
  return {
    id,
    kind: "neutral_camp",
    name,
    tile: { x, y },
    currentHp: 120,
    maxHp: 120,
    maxHit: 8,
    attackRange: 4,
    attackTimer: createAttackTimerState(),
    combatLevels: { attack: 35, strength: 35, defence: 35, ranged: 35, magic: 35 },
    bonuses: { ...zeroBonuses },
    style: "crush",
    rewardGp,
    rewardXp,
    respawnTicks: 50,
    alive: true
  };
}
export function createPrototypeState(): SimulationState {
  const blueTop = buildStartingLoadout("blue-top", "blue", "melee", "top");
  const blueMid = buildStartingLoadout("blue-1", "blue", "melee", "middle");
  const blueBottom = buildStartingLoadout("blue-bottom", "blue", "ranged", "bottom");
  const redTop = buildStartingLoadout("red-top", "red", "melee", "top");
  const redMid = buildStartingLoadout("red-1", "red", "ranged", "middle");
  const redBottom = buildStartingLoadout("red-bottom", "red", "ranged", "bottom");
  const players = [blueTop, blueMid, blueBottom, redTop, redMid, redBottom];

  return {
    tick: 0,
    blue: blueMid,
    red: redMid,
    players,
    minions: [],
    towers: [
      ...LANES.map(lane => makeTower(`blue-${lane}-tower`, "blue", lane, BLUE_TOWER_X)),
      ...LANES.map(lane => makeTower(`red-${lane}-tower`, "red", lane, RED_TOWER_X))
    ],
    projectiles: [],
    jungleCamps: [
      makeJungleCamp("camp-top-west", "Hill giant camp", 12, 5, 120, 220),
      makeJungleCamp("camp-top-east", "Hill giant camp", 28, 5, 120, 220),
      makeJungleCamp("camp-bottom-west", "Demonic gorilla camp", 12, 35, 160, 280),
      makeJungleCamp("camp-bottom-east", "Demonic gorilla camp", 28, 35, 160, 280)
    ],
    engagedAttackerTeamByLane: {},
    log: [],
    rng: Math.random
  };
}
