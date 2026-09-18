import type { PrayerId } from "../prayer/prayers";

export type CommandPriority = "weak" | "normal" | "strong";

export type PlayerCommand =
  | {
      readonly kind: "equip";
      readonly itemId: string;
      readonly priority: CommandPriority;
      readonly id: string;
      readonly sequence: number;
      readonly issuedTick: number;
      readonly executeTick: number;
    }
  | {
      readonly kind: "eat";
      readonly itemId: string;
      readonly combo?: boolean;
      readonly priority: CommandPriority;
      readonly id: string;
      readonly sequence: number;
      readonly issuedTick: number;
      readonly executeTick: number;
    }
  | {
      readonly kind: "prayer";
      readonly prayerId: PrayerId;
      readonly priority: CommandPriority;
      readonly id: string;
      readonly sequence: number;
      readonly issuedTick: number;
      readonly executeTick: number;
    }
  | {
      readonly kind: "special";
      readonly targetId?: string;
      readonly priority: CommandPriority;
      readonly id: string;
      readonly sequence: number;
      readonly issuedTick: number;
      readonly executeTick: number;
    }
  | {
      readonly kind: "attack-target";
      readonly targetId: string;
      readonly priority: CommandPriority;
      readonly id: string;
      readonly sequence: number;
      readonly issuedTick: number;
      readonly executeTick: number;
    }
  | {
      readonly kind: "clear-attack-target";
      readonly priority: CommandPriority;
      readonly id: string;
      readonly sequence: number;
      readonly issuedTick: number;
      readonly executeTick: number;
    }
  | {
      readonly kind: "move";
      readonly x: number;
      readonly y: number;
      readonly priority: CommandPriority;
      readonly id: string;
      readonly sequence: number;
      readonly issuedTick: number;
      readonly executeTick: number;
    }
  | {
      readonly kind: "stop-movement";
      readonly priority: CommandPriority;
      readonly id: string;
      readonly sequence: number;
      readonly issuedTick: number;
      readonly executeTick: number;
    };

export type PlayerCommandInput =
  | { readonly kind: "equip"; readonly itemId: string }
  | { readonly kind: "eat"; readonly itemId: string; readonly combo?: boolean }
  | { readonly kind: "prayer"; readonly prayerId: PrayerId }
  | { readonly kind: "special"; readonly targetId?: string }
  | { readonly kind: "attack-target"; readonly targetId: string }
  | { readonly kind: "clear-attack-target" }
  | { readonly kind: "move"; readonly x: number; readonly y: number }
  | { readonly kind: "stop-movement" };

export function enqueuePlayerCommand(
  queue: readonly PlayerCommand[],
  command: PlayerCommand
): PlayerCommand[] {
  // In Henke's model, weak queued actions are cancelled by interrupting
  // actions. Inventory/equipment/prayer/special client input is represented as
  // strong input here, so a newly-arriving strong command clears stale weak
  // work while preserving FIFO order for everything else.
  const retained = command.priority === "strong"
    ? queue.filter(entry => entry.priority !== "weak")
    : [...queue];
  return [...retained, command];
}

export function drainPlayerCommands(
  queue: readonly PlayerCommand[],
  currentTick: number,
  maxCommands = 10
): { readonly commands: PlayerCommand[]; readonly queue: PlayerCommand[] } {
  const limit = Math.max(0, Math.trunc(maxCommands));
  const ready = queue
    .filter(command => command.executeTick <= currentTick)
    .sort((a, b) =>
      a.executeTick - b.executeTick ||
      a.sequence - b.sequence ||
      a.id.localeCompare(b.id)
    );
  const commands = ready.slice(0, limit);
  const consumed = new Set(commands.map(command => command.sequence));
  return {
    commands,
    queue: queue.filter(command => !consumed.has(command.sequence))
  };
}

export function makeStrongCommand(
  input: PlayerCommandInput,
  sequence: number,
  issuedTick: number,
  executeTick = issuedTick
): PlayerCommand {
  const base = {
    priority: "strong" as const,
    id: `player-command-${sequence}`,
    sequence,
    issuedTick,
    executeTick
  };
  switch (input.kind) {
    case "equip":
      return { ...base, kind: "equip", itemId: input.itemId };
    case "eat":
      return { ...base, kind: "eat", itemId: input.itemId, combo: input.combo };
    case "prayer":
      return { ...base, kind: "prayer", prayerId: input.prayerId };
    case "special":
      return { ...base, kind: "special", targetId: input.targetId };
    case "attack-target":
      return { ...base, kind: "attack-target", targetId: input.targetId };
    case "clear-attack-target":
      return { ...base, kind: "clear-attack-target" };
    case "move":
      return { ...base, kind: "move", x: input.x, y: input.y };
    case "stop-movement":
      return { ...base, kind: "stop-movement" };
  }
}
