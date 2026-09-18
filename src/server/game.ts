export type Team = "blue" | "red";
export type Prayer = "protect_melee" | "protect_mage" | "protect_range" | null;
export type InputCommand =
  | { type: "attack"; targetId: string }
  | { type: "move"; x: number }
  | { type: "prayer"; prayer: Prayer }
  | { type: "eat" }
  | { type: "special" }
  | { type: "stop_attack" };

export interface Inventory { food: number; specialEnergy: number; }
export interface Equipment { weapon: string; attackSpeed: number; attackBonus: number; strengthBonus: number; }

export interface Player {
  id: string; team: Team; x: number; hp: number; maxHp: number;
  attack: number; strength: number; defence: number;
  equipment: Equipment; inventory: Inventory; prayer: Prayer;
  targetId: string | null; nextAttackTick: number; attackQueuedTick: number | null;
}

export interface CombatEvent {
  tick: number; type: "attack_queued" | "attack" | "hit" | "miss" | "eat" | "special" | "move" | "prayer";
  attacker?: string; defender?: string; damage?: number; attackRoll?: number; defenceRoll?: number;
  special?: boolean; x?: number; prayer?: Prayer;
}
export interface GameState { tick: number; players: Record<string, Player>; pendingInputs: InputCommand[]; events: CombatEvent[]; }

export function createGame(): GameState {
  const make = (id: string, team: Team, x: number): Player => ({
    id, team, x, hp: 99, maxHp: 99, attack: 75, strength: 75, defence: 70,
    equipment: { weapon: "rune_scimitar", attackSpeed: 4, attackBonus: 45, strengthBonus: 44 },
    inventory: { food: 10, specialEnergy: 100 },
    prayer: null, targetId: null, nextAttackTick: 0, attackQueuedTick: null
  });
  return { tick: 0, pendingInputs: [], events: [], players: {
    player: make("player", "blue", 10),
    opponent: make("opponent", "red", 11)
  }};
}

export function enqueueInput(state: GameState, command: InputCommand): void {
  state.pendingInputs.push(command);
}

function event(state: GameState, e: CombatEvent): void {
  state.events.push(e);
  if (state.events.length > 100) state.events.splice(0, state.events.length - 100);
}

function processInput(state: GameState, command: InputCommand): void {
  const p = state.players.player;
  if (!p) return;
  if (command.type === "attack") {
    const target = state.players[command.targetId];
    if (!target || target.hp <= 0 || target.team === p.team) return;
    p.targetId = target.id;
    p.attackQueuedTick = state.tick;
    event(state, { tick: state.tick, type: "attack_queued", attacker: p.id, defender: target.id });
    return;
  }
  if (command.type === "stop_attack") { p.targetId = null; p.attackQueuedTick = null; return; }
  if (command.type === "move") {
    p.x = Math.max(0, Math.min(30, Math.round(command.x)));
    event(state, { tick: state.tick, type: "move", attacker: p.id, x: p.x });
    return;
  }
  if (command.type === "prayer") {
    p.prayer = command.prayer;
    event(state, { tick: state.tick, type: "prayer", attacker: p.id, prayer: p.prayer });
    return;
  }
  if (command.type === "eat") {
    if (p.inventory.food > 0 && p.hp < p.maxHp) {
      p.inventory.food--;
      p.hp = Math.min(p.maxHp, p.hp + 12);
      event(state, { tick: state.tick, type: "eat", attacker: p.id, damage: -12 });
    }
    return;
  }
  if (command.type === "special") {
    if (p.inventory.specialEnergy < 50 || !p.targetId) return;
    p.inventory.specialEnergy -= 50;
    p.attackQueuedTick = state.tick;
    event(state, { tick: state.tick, type: "special", attacker: p.id, defender: p.targetId, special: true });
  }
}

function resolveAttack(state: GameState, attacker: Player): void {
  if (!attacker.targetId || state.tick < attacker.nextAttackTick) return;
  const defender = state.players[attacker.targetId];
  if (!defender || defender.hp <= 0 || Math.abs(attacker.x - defender.x) > 1) return;

  const effectiveAttack = attacker.attack + 8;
  const attackRoll = effectiveAttack * (attacker.equipment.attackBonus + 64);
  const effectiveDefence = defender.defence + 8;
  const defenceRoll = effectiveDefence * 64;
  const hit = attackRoll > defenceRoll;
  const maxHit = Math.max(1, Math.floor((attacker.strength + 8) * (attacker.equipment.strengthBonus + 64) / 640));
  const damage = hit ? Math.floor(maxHit * (0.5 + Math.random() * 0.5)) : 0;

  attacker.nextAttackTick = state.tick + attacker.equipment.attackSpeed;
  attacker.attackQueuedTick = null;
  event(state, { tick: state.tick, type: "attack", attacker: attacker.id, defender: defender.id, attackRoll, defenceRoll });
  event(state, { tick: state.tick, type: hit ? "hit" : "miss", attacker: attacker.id, defender: defender.id, damage, attackRoll, defenceRoll });
  if (hit) defender.hp = Math.max(0, defender.hp - damage);
  if (defender.hp <= 0) defender.targetId = null;
}

export function step(state: GameState): void {
  state.tick++;
  const inputs = state.pendingInputs.splice(0);
  for (const input of inputs) processInput(state, input);
  for (const player of Object.values(state.players)) resolveAttack(state, player);
}
