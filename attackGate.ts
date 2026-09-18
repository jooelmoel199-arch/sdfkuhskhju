/**
 * Adapted from NH Trainer's src/sim/combat/player-combat.ts (MIT). The gate
 * logic (lock check -> reach/range check -> cooldown check) is generic OSRS
 * attack-cycle behaviour; only the hardcoded NH weapon table was dropped in
 * favour of shop-driven weapon profiles (see moba/economy.ts ShopItem).
 */
import type { EntityLockState } from "../entity/locks";
import { canAttackThroughLock } from "../entity/locks";
import { canMeleeReachThisTick, chebyshevDistance, type TilePosition } from "../world/movement";
import type { AttackTimerState } from "./timers";
import { canAttack, updateLastAttack } from "./timers";
import type { CombatStyle } from "./formulas";

export interface WeaponProfile {
  readonly style: CombatStyle;
  readonly cooldownTicks: number;
  readonly attackRange: number;
}

export interface AttackGateInput {
  readonly currentTick: number;
  readonly attackerTile: TilePosition;
  readonly defenderTile: TilePosition;
  readonly attackerFrozen: boolean;
  readonly locks: EntityLockState;
  readonly attackTimer: AttackTimerState;
  readonly weapon: WeaponProfile;
  readonly extraAttackDelayUntilTick?: number; // from eating food this tick cycle
}

export interface AttackGateResult {
  readonly canAttack: boolean;
  readonly reason: "ready" | "lock" | "timer" | "out-of-range" | "eating-delay";
}

export function isMeleeStyle(style: CombatStyle): boolean {
  return style === "stab" || style === "slash" || style === "crush";
}

export function attackGate(input: AttackGateInput): AttackGateResult {
  if (!canAttackThroughLock(input.locks, input.currentTick)) {
    return { canAttack: false, reason: "lock" };
  }
  if (input.extraAttackDelayUntilTick !== undefined && input.currentTick < input.extraAttackDelayUntilTick) {
    return { canAttack: false, reason: "eating-delay" };
  }

  const attackReady = canAttack(input.attackTimer, input.currentTick);

  if (isMeleeStyle(input.weapon.style)) {
    const reach = canMeleeReachThisTick({
      attacker: input.attackerTile,
      defender: input.defenderTile,
      attackerFrozen: input.attackerFrozen,
      attackRange: input.weapon.attackRange
    });
    if (!reach.canReach) {
      return { canAttack: false, reason: "out-of-range" };
    }
    return attackReady ? { canAttack: true, reason: "ready" } : { canAttack: false, reason: "timer" };
  }

  const distance = chebyshevDistance(input.attackerTile, input.defenderTile);
  const inRange = distance >= 1 && distance <= input.weapon.attackRange;
  if (!inRange) {
    return { canAttack: false, reason: "out-of-range" };
  }
  return attackReady ? { canAttack: true, reason: "ready" } : { canAttack: false, reason: "timer" };
}

export function dispatchAttack(input: AttackGateInput): { readonly gate: AttackGateResult; readonly attackTimer: AttackTimerState } {
  const gate = attackGate(input);
  if (!gate.canAttack) {
    return { gate, attackTimer: input.attackTimer };
  }
  return { gate, attackTimer: updateLastAttack(input.attackTimer, input.currentTick, input.weapon.cooldownTicks) };
}
