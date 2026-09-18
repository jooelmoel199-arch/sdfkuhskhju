import { createPrototypeState } from "../moba/factory.ts";
import { advanceTick, TICK_MS } from "../moba/simulation.ts";
import { maxHitpoints } from "../moba/stats.ts";
import { LANE_Y, zoneAt } from "../moba/lane.ts";
import { shopCatalog } from "../moba/economy.ts";

let state = {
  ...createPrototypeState(),
  humanControl: { attackEnabled: true, laneId: "middle" }
};

export { state, TICK_MS, maxHitpoints };

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
}

export function clearAttackTarget() {
  delete state.humanControl.attackTargetId;
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
  delete state.humanControl.moveTargetY;
}

export function cycleAttackType() {
  const style = state.blue.equipment.weapon?.style;
  const modes = style === "ranged"
    ? ["accurate", "rapid_ranged", "long_ranged"]
    : style === "magic"
      ? ["accurate"]
      : ["accurate", "aggressive", "controlled"];
  const current = modes.indexOf(state.blue.attackType);
  state.blue = { ...state.blue, attackType: modes[(current + 1) % modes.length] };
}

export function setAttackEnabled(enabled) {
  state.humanControl.attackEnabled = enabled;
}

export function toggleMeleePrayer() {
  state.humanControl.activatePrayer =
    state.humanControl.activatePrayer === "protect_from_melee" ? undefined : "protect_from_melee";
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
  state = { ...createPrototypeState(), humanControl: { attackEnabled: true, laneId: "middle" } };
}
