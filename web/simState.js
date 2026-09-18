import { createPrototypeState, createPvpTestState } from "../moba/factory.ts";
import { advanceTick, queueClientCommand, TICK_MS } from "../moba/simulation.ts";
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
  queueClientCommand(state, {
    kind: "move",
    x: Math.max(1, Math.min(39, x)),
    y
  });
}

export function stopMovement() {
  queueClientCommand(state, { kind: "stop-movement" });
}

export function setAttackTarget(targetId) {
  queueClientCommand(state, { kind: "attack-target", targetId });
}

export function clearAttackTarget() {
  queueClientCommand(state, { kind: "clear-attack-target" });
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
  queueClientCommand(state, { kind: "prayer", prayerId: "protect_from_melee" });
}

export function equipItem(itemId) {
  queueClientCommand(state, { kind: "equip", itemId });
}

export function togglePrayer(prayerId) {
  queueClientCommand(state, { kind: "prayer", prayerId });
}

export function useConsumable(itemId) {
  queueClientCommand(state, { kind: "eat", itemId });
}
export function useComboFood(itemId) {
  queueClientCommand(state, { kind: "eat", itemId, combo: true });
}

export function investAll(stat) {
  state.humanControl.investStat = stat;
}

export function useSpecial() {
  // Resolve the current interaction when the command executes. This matters
  // when a target click and a special click are issued during the same client tick.
  queueClientCommand(state, { kind: "special" });
}

export function castVengeance() {
  queueClientCommand(state, { kind: "vengeance" });
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

export function setSpell(spellId) {
  state.humanControl.spellId = spellId;
}
