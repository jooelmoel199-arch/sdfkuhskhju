import { createPrototypeState, createPvpTestState } from "../moba/factory.ts";
import { advanceTick, TICK_MS } from "../moba/simulation.ts";
import { maxHitpoints } from "../moba/stats.ts";
import { LANE_Y, zoneAt } from "../moba/lane.ts";
import { shopCatalog } from "../moba/economy.ts";

let state = {
  ...createPvpTestState(),
  humanControl: { attackEnabled: true, laneId: "middle", attackTargetId: "red-dummy" }
};

export { state, TICK_MS, maxHitpoints };

function syncHumanPlayer(player) {
  state.blue = player;
  state.players = state.players.map(current => current.id === player.id ? player : current);
}

export function stepSimulation() {
  advanceTick(state);
}

export function setMoveTarget(x, y = state.blue.tile.y) {
  state.humanControl.moveTargetX = Math.max(1, Math.min(39, x));
  state.humanControl.moveTargetY = y;
  delete state.humanControl.attackTargetId;
}

export function stopMovement() {
  delete state.humanControl.moveTargetX;
  delete state.humanControl.moveTargetY;
  delete state.humanControl.attackTargetId;
}

export function setAttackTarget(targetId) {
  state.humanControl.attackTargetId = targetId;
  const tower = state.towers.find(candidate => candidate.id === targetId && candidate.alive);
  if (tower) {
    state.humanControl.laneId = tower.laneId;
  }
}

export function clearAttackTarget() {
  delete state.humanControl.attackTargetId;
}

export function setLane(laneId) {
  state.humanControl.laneId = laneId;
  const moved = {
    ...state.blue,
    laneId,
    tile: { x: state.blue.tile.x, y: LANE_Y[laneId] },
    zone: zoneAt({ x: state.blue.tile.x, y: LANE_Y[laneId] })
  };
  state.blue = moved;
  state.players = state.players.map(player => player.id === moved.id ? moved : player);
  delete state.humanControl.moveTargetX;
  delete state.humanControl.moveTargetY;
}

export function cycleAttackType() {
  const modes = state.blue.equipment.weapon?.attackTypes ?? ["accurate"];
  const current = modes.indexOf(state.blue.attackType);
  syncHumanPlayer({ ...state.blue, attackType: modes[(current + 1) % modes.length] });
}

export function setAttackEnabled(enabled) {
  state.humanControl.attackEnabled = enabled;
}

export function toggleMeleePrayer() {
  state.humanControl.activatePrayer =
    state.humanControl.activatePrayer === "protect_from_melee" ? undefined : "protect_from_melee";
}

export function equipItem(itemId) {
  state.humanControl.equipItemId = itemId;
}

export function togglePrayer(prayerId) {
  state.humanControl.activatePrayer = prayerId;
}

export function useConsumable(itemId) {
  state.humanControl.consumeItemId = itemId;
}

export function investAll(stat) {
  state.humanControl.investStat = stat;
}

export function useSpecial() {
  state.humanControl.useSpecial = true;
}

export function buyBestAffordableUpgrade() {
  const affordable = state.blue.zone === "base"
    ? shopCatalog
        .filter(item => {
          if (item.cost > state.blue.gp) return false;
          const current = state.blue.equipment[item.slot];
          return !current || item.cost > current.cost;
        })
        .sort((a, b) => b.cost - a.cost)
    : [];
  const item = affordable[0];
  if (item) state.humanControl.buyItemId = item.id;
  else buyConsumables("shark", 3);
}

export function buyConsumables(itemId, quantity = 1) {
  if (state.blue.zone === "base") {
    state.humanControl.buyConsumableId = itemId;
    state.humanControl.buyConsumableQuantity = quantity;
  }
}

export function resetSimulation() {
  state = { ...createPvpTestState(), humanControl: { attackEnabled: true, laneId: "middle" } };
}
