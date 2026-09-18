import { createPlayer, equipItem } from "../moba/entities.ts";
import { createAttackTimerState } from "../combat/timers.ts";
import { shopCatalog } from "../moba/economy.ts";
import { advanceTick, TICK_MS } from "../moba/simulation.ts";
import { BLUE_TOWER_X, RED_TOWER_X, BLUE_BASE_X, RED_BASE_X, LANE_Y, LANES, zoneAt } from "../moba/lane.ts";
import { maxHitpoints } from "../moba/stats.ts";

function itemById(id) {
  const item = shopCatalog.find(candidate => candidate.id === id);
  if (!item) throw new Error("Unknown item: " + id);
  return item;
}

function buildPlayer(id, team, role, laneId = "middle") {
  const tile = { x: team === "blue" ? BLUE_BASE_X + 2 : RED_BASE_X - 2, y: LANE_Y[laneId] };
  let player = createPlayer(id, team, tile, laneId);
  player = { ...player, zone: zoneAt(tile), gp: 300 };

  const loadouts = {
    melee: ["rune_scimitar", "rune_defender", "fighter_torso", "berserker_helm"],
    ranged: ["magic_shortbow", "black_dhide_body", "archer_helm"],
    mage: ["ancient_staff", "mystic_robe_top"]
  };
  for (const id of loadouts[role]) {
    const item = itemById(id);
    if (player.gp >= item.cost) player = equipItem(player, item);
  }
  return player;
}

function makeTower(id, team, laneId, x) {
  return {
    id, kind: "tower", team, laneId,
    tile: { x, y: LANE_Y[laneId] },
    currentHp: 250, maxHp: 250, attackBonus: 40, maxHit: 18, attackRange: 3,
    attackTimer: createAttackTimerState(), alive: true
  };
}

function initialState() {
  return {
    tick: 0,
    blue: buildPlayer("blue-1", "blue", "melee", "middle"),
    red: buildPlayer("red-1", "red", "ranged", "middle"),
    minions: [],
    towers: [
      ...LANES.map(lane => makeTower("blue-" + lane + "-tower", "blue", lane, BLUE_TOWER_X)),
      ...LANES.map(lane => makeTower("red-" + lane + "-tower", "red", lane, RED_TOWER_X))
    ],
    engagedAttackerTeamByLane: {},
    log: [],
    rng: Math.random,
    humanControl: { attackEnabled: true, laneId: "middle" }
  };
}

let state = initialState();

export { state, TICK_MS, maxHitpoints };

export function stepSimulation() {
  advanceTick(state);
}

export function setMoveTarget(x) {
  state.humanControl.moveTargetX = Math.max(2, Math.min(38, x));
}

export function stopMovement() {
  delete state.humanControl.moveTargetX;
}

export function setLane(laneId) {
  state.humanControl.laneId = laneId;
  state.blue = {
    ...state.blue,
    laneId,
    tile: { x: state.blue.tile.x, y: LANE_Y[laneId] },
    zone: zoneAt({ x: state.blue.tile.x, y: LANE_Y[laneId] })
  };
  delete state.humanControl.moveTargetX;
}

export function setAttackEnabled(enabled) {
  state.humanControl.attackEnabled = enabled;
}

export function toggleMeleePrayer() {
  state.humanControl.activatePrayer =
    state.humanControl.activatePrayer === "protect_from_melee" ? undefined : "protect_from_melee";
}

export function resetSimulation() {
  state = initialState();
}
