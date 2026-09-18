import { createPlayer, equipItem, addInventoryItem, type TowerEntity } from "./entities";
import { createAttackTimerState } from "../combat/timers";
import { shopCatalog } from "./economy";
import { LANE_Y, LANES, BLUE_TOWER_X, RED_TOWER_X, BLUE_BASE_X, RED_BASE_X, zoneAt, type LaneId } from "./lane";
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
  player = { ...player, zone: zoneAt(tile), gp: 300 };

  const loadouts: Record<StartingRole, string[]> = {
    melee: ["rune_scimitar", "rune_defender", "fighter_torso", "berserker_helm"],
    ranged: ["magic_shortbow", "black_dhide_body", "archer_helm"],
    mage: ["ancient_staff", "mystic_robe_top"]
  };

  for (const id of loadouts[role]) {
    const item = itemById(id);
    if (player.gp >= item.cost) player = equipItem(player, item);
  }

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

export function createPrototypeState(): SimulationState {
  return {
    tick: 0,
    blue: buildStartingLoadout("blue-1", "blue", "melee", "middle"),
    red: buildStartingLoadout("red-1", "red", "ranged", "middle"),
    minions: [],
    towers: [
      ...LANES.map(lane => makeTower(`blue-${lane}-tower`, "blue", lane, BLUE_TOWER_X)),
      ...LANES.map(lane => makeTower(`red-${lane}-tower`, "red", lane, RED_TOWER_X))
    ],
    engagedAttackerTeamByLane: {},
    log: [],
    rng: Math.random
  };
}
