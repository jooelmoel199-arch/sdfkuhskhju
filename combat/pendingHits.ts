export interface PendingHit {
  readonly id: string;
  readonly dueTick: number;
  readonly attackerId: string;
  readonly targetId: string;
  readonly attackerPid: number;
  readonly targetPid: number;
  readonly style: "stab" | "slash" | "crush" | "ranged" | "magic";
  readonly attackType: string;
  readonly landed: boolean;
  readonly hitChance: number;
  readonly rawDamage: number;
  readonly special?: boolean;
  readonly freezeTicks?: number;
  readonly createdTick: number;
  /** Monotonic insertion sequence preserves FIFO when several queue entries share a tick. */
  readonly sequence?: number;
}

export function processingOrderDelay(attackerPriority: number, defenderPriority: number): number {
  return defenderPriority < attackerPriority ? 1 : 0;
}

export function meleeHitTick(currentTick: number, attackerPriority: number, defenderPriority: number): number {
  return currentTick + processingOrderDelay(attackerPriority, defenderPriority);
}

export function distanceHitDelay(style: "ranged" | "magic", distance: number): number {
  const d = Math.max(1, Math.trunc(distance));
  if (style === "ranged") return 2 + Math.floor((d + 3) / 6);
  return 2 + Math.floor((d + 1) / 3);
}

export function projectileHitTick(
  currentTick: number,
  style: "ranged" | "magic",
  distance: number,
  attackerPriority: number,
  defenderPriority: number
): number {
  return currentTick + distanceHitDelay(style, distance) +
    processingOrderDelay(attackerPriority, defenderPriority);
}
