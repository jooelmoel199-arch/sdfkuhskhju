import { createCombatRules, type CombatRules } from "./combat-rules";

export type Team = "blue" | "red";
export type Prayer = "protect_melee" | "protect_mage" | "protect_range" | null;

export type InputCommand =
  | { type: "attack"; targetId: string }
  | { type: "move"; x: number }
  | { type: "prayer"; prayer: Prayer }
  | { type: "eat" }
  | { type: "special" }
  | { type: "stop_attack" };

export interface Inventory {
  food: number;
  specialEnergy: number;
}

export interface Equipment {
  weapon: string;
  attackSpeed: number;
  attackBonus: number;
  strengthBonus: number;
  specialCost: number;
  specialMultiplier: number;
}

export interface Player {
  id: string;
  team: Team;
  x: number;
  destinationX: number;
  hp: number;
  maxHp: number;
  attack: number;
  strength: number;
  defence: number;
  equipment: Equipment;
  inventory: Inventory;
  prayer: Prayer;
  targetId: string | null;
  nextAttackTick: number;
  attackQueuedTick: number | null;
  specialQueued: boolean;
}

export interface CombatEvent {
  tick: number;
  type:
    | "attack_queued"
    | "attack_cancelled"
    | "attack"
    | "hit"
    | "miss"
    | "eat"
    | "special_queued"
    | "special"
    | "move"
    | "prayer";
  attacker?: string;
  defender?: string;
  damage?: number;
  attackRoll?: number;
  defenceRoll?: number;
  special?: boolean;
  x?: number;
  prayer?: Prayer;
  reason?: string;
}

export interface QueuedInput {
  sequence: number;
  receivedTick: number;
  command: InputCommand;
}

export interface GameState {
  tick: number;
  nextInputSequence: number;
  players: Record<string, Player>;
  pendingInputs: QueuedInput[];
  events: CombatEvent[];
}

export function createGame(): GameState {
  const make = (id: string, team: Team, x: number): Player => ({
    id,
    team,
    x,
    destinationX: x,
    hp: 99,
    maxHp: 99,
    attack: 75,
    strength: 75,
    defence: 70,
    equipment: {
      weapon: "rune_scimitar",
      attackSpeed: 4,
      attackBonus: 45,
      strengthBonus: 44,
      specialCost: 50,
      specialMultiplier: 1.25
    },
    inventory: { food: 10, specialEnergy: 100 },
    prayer: null,
    targetId: null,
    nextAttackTick: 0,
    attackQueuedTick: null,
    specialQueued: false
  });

  return {
    tick: 0,
    nextInputSequence: 1,
    pendingInputs: [],
    events: [],
    players: {
      player: make("player", "blue", 10),
      opponent: make("opponent", "red", 11)
    }
  };
}

export function enqueueInput(state: GameState, command: InputCommand): void {
  state.pendingInputs.push({
    sequence: state.nextInputSequence++,
    receivedTick: state.tick,
    command
  });
}

function event(state: GameState, e: CombatEvent): void {
  state.events.push(e);
  if (state.events.length > 200) state.events.splice(0, state.events.length - 200);
}

function processInput(state: GameState, command: InputCommand): void {
  // The prototype has one controllable player. NPC/other-player actions remain
  // server-owned and can be added later without changing the tick pipeline.
  const p = state.players.player;
  if (!p || p.hp <= 0) return;

  switch (command.type) {
    case "attack": {
      const target = state.players[command.targetId];
      if (!target || target.hp <= 0 || target.team === p.team) return;

      p.targetId = target.id;
      p.destinationX = target.x;
      p.attackQueuedTick = state.tick;
      p.specialQueued = false;
      event(state, {
        tick: state.tick,
        type: "attack_queued",
        attacker: p.id,
        defender: target.id
      });
      return;
    }

    case "stop_attack":
      p.targetId = null;
      p.attackQueuedTick = null;
      p.specialQueued = false;
      event(state, { tick: state.tick, type: "attack_cancelled", attacker: p.id });
      return;

    case "move":
      p.destinationX = Math.max(0, Math.min(30, Math.round(command.x)));
      event(state, { tick: state.tick, type: "move", attacker: p.id, x: p.destinationX });
      return;

    case "prayer":
      p.prayer = command.prayer;
      event(state, { tick: state.tick, type: "prayer", attacker: p.id, prayer: p.prayer });
      return;

    case "eat":
      if (p.inventory.food > 0 && p.hp < p.maxHp) {
        p.inventory.food--;
        p.hp = Math.min(p.maxHp, p.hp + 12);
        event(state, { tick: state.tick, type: "eat", attacker: p.id, damage: -12 });
      }
      return;

    case "special":
      if (
        p.targetId &&
        p.inventory.specialEnergy >= p.equipment.specialCost &&
        p.attackQueuedTick !== null
      ) {
        p.specialQueued = true;
        event(state, {
          tick: state.tick,
          type: "special_queued",
          attacker: p.id,
          defender: p.targetId,
          special: true
        });
      }
      return;
  }
}

function deterministicRoll(seed: number): number {
  // Deterministic per attack: the authoritative server can replay the same fight.
  const x = Math.sin(seed * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

function resolveAttack(state: GameState, attacker: Player): void {
  if (!attacker.targetId || attacker.attackQueuedTick === null) return;
  if (state.tick < attacker.nextAttackTick) return;

  const defender = state.players[attacker.targetId];
  if (!defender || defender.hp <= 0) {
    attacker.targetId = null;
    attacker.attackQueuedTick = null;
    attacker.specialQueued = false;
    return;
  }

  // The attack request stays queued while out of melee range. A later movement
  // tick can therefore make the already-requested attack eligible.
  if (Math.abs(attacker.x - defender.x) > 1) return;

  const special = attacker.specialQueued;
  const effectiveAttack = attacker.attack + 8;
  const attackRoll = effectiveAttack * (attacker.equipment.attackBonus + 64);
  const effectiveDefence = defender.defence + 8;
  const defenceRoll = effectiveDefence * 64;
  const hit = attackRoll > defenceRoll;

  const baseMaxHit = Math.max(
    1,
    Math.floor(
      ((attacker.strength + 8) * (attacker.equipment.strengthBonus + 64)) / 640
    )
  );
  const maxHit = special
    ? Math.max(1, Math.floor(baseMaxHit * attacker.equipment.specialMultiplier))
    : baseMaxHit;

  const roll = deterministicRoll(state.tick * 1009 + attacker.id.length * 97);
  const damage = hit ? Math.min(defender.hp, Math.floor(roll * (maxHit + 1))) : 0;

  attacker.nextAttackTick = state.tick + attacker.equipment.attackSpeed;
  attacker.attackQueuedTick = null;
  attacker.specialQueued = false;

  if (special) {
    attacker.inventory.specialEnergy -= attacker.equipment.specialCost;
    event(state, {
      tick: state.tick,
      type: "special",
      attacker: attacker.id,
      defender: defender.id,
      special: true
    });
  }

  event(state, {
    tick: state.tick,
    type: "attack",
    attacker: attacker.id,
    defender: defender.id,
    attackRoll,
    defenceRoll,
    special
  });

  event(state, {
    tick: state.tick,
    type: hit ? "hit" : "miss",
    attacker: attacker.id,
    defender: defender.id,
    damage,
    attackRoll,
    defenceRoll,
    special
  });

  if (hit) defender.hp = Math.max(0, defender.hp - damage);
  if (defender.hp <= 0) {
    defender.targetId = null;
    attacker.targetId = null;
    attacker.attackQueuedTick = null;
  }
}

export function step(state: GameState): void {
  state.tick++;

  // FIFO input processing is deliberately separate from simulation resolution.
  // This is the foundation for a real client/server protocol later.
  const inputs = state.pendingInputs.splice(0);
  inputs.sort((a, b) => a.sequence - b.sequence);
  for (const input of inputs) processInput(state, input.command);

  // Movement is discrete and server-authoritative: one tile per game tick.
  // Attack requests can supply a destination, so clicking an opponent naturally
  // produces the familiar walk-into-range-then-attack behaviour.
  for (const player of Object.values(state.players)) {
    if (player.x < player.destinationX) player.x++;
    else if (player.x > player.destinationX) player.x--;
  }

  // Every player gets the same deterministic combat resolution stage.
  for (const player of Object.values(state.players)) resolveAttack(state, player);
}
