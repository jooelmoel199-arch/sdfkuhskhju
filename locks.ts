export type NhLockType =
  | "none"
  | "movement"
  | "full"
  | "full_nullify_damage"
  | "full_delay_damage"
  | "full_allow_logout"
  | "full_regular_damage"
  | "full_cant_attack";

export interface EntityLockState {
  readonly lockType: NhLockType;
  readonly teleporting: boolean;
  readonly freezeUntilTick: number;
  readonly freezeSourceId?: string;
  readonly stunUntilTick: number;
  readonly rootUntilTick: number;
}

export interface MovementGateStatus {
  readonly blocked: boolean;
  readonly reason: "none" | "lock" | "teleport" | "freeze" | "stun" | "root";
}

export function createEntityLockState(): EntityLockState {
  return {
    lockType: "none",
    teleporting: false,
    freezeUntilTick: -1,
    stunUntilTick: -1,
    rootUntilTick: -1
  };
}

export function isLocked(state: EntityLockState): boolean {
  return state.lockType !== "none" || state.teleporting;
}

export function isFrozen(state: EntityLockState, tick: number): boolean {
  return state.freezeUntilTick >= tick;
}

export function hasFreezeImmunity(state: EntityLockState, tick: number): boolean {
  return state.freezeUntilTick >= 0 && state.freezeUntilTick + 5 >= tick;
}

export function isStunned(state: EntityLockState, tick: number): boolean {
  return state.stunUntilTick >= tick;
}

export function isRooted(state: EntityLockState, tick: number): boolean {
  return state.rootUntilTick >= tick;
}

export function movementGate(
  state: EntityLockState,
  tick: number,
  options: { readonly ignoreFreeze?: boolean } = {}
): MovementGateStatus {
  if (state.teleporting) {
    return { blocked: true, reason: "teleport" };
  }
  if (state.lockType !== "none") {
    return { blocked: true, reason: "lock" };
  }
  if (!options.ignoreFreeze && isFrozen(state, tick)) {
    return { blocked: true, reason: "freeze" };
  }
  if (isStunned(state, tick)) {
    return { blocked: true, reason: "stun" };
  }
  if (isRooted(state, tick)) {
    return { blocked: true, reason: "root" };
  }
  return { blocked: false, reason: "none" };
}

export function canMove(
  state: EntityLockState,
  tick: number,
  options: { readonly ignoreFreeze?: boolean } = {}
): boolean {
  return !movementGate(state, tick, options).blocked;
}

export function canAct(state: EntityLockState, tick: number): boolean {
  return !isLocked(state) && !isStunned(state, tick);
}

export function canAttackThroughLock(state: EntityLockState, tick: number): boolean {
  if (isStunned(state, tick) || state.teleporting) {
    return false;
  }
  return state.lockType !== "full" && state.lockType !== "full_cant_attack";
}

export function setLock(state: EntityLockState, lockType: NhLockType, teleporting = state.teleporting): EntityLockState {
  return {
    ...state,
    lockType,
    teleporting
  };
}

export function applyFreeze(
  state: EntityLockState,
  tick: number,
  durationTicks: number,
  sourceId?: string
): EntityLockState {
  if (hasFreezeImmunity(state, tick)) {
    return state;
  }
  return {
    ...state,
    freezeUntilTick: tick + Math.max(0, Math.trunc(durationTicks)),
    freezeSourceId: sourceId
  };
}

export function resetFreeze(state: EntityLockState): EntityLockState {
  const { freezeSourceId: _freezeSourceId, ...rest } = state;
  return {
    ...rest,
    freezeUntilTick: -1
  };
}

export function applyStun(state: EntityLockState, tick: number, durationTicks: number): EntityLockState {
  return {
    ...state,
    stunUntilTick: tick + Math.max(0, Math.trunc(durationTicks))
  };
}

export function applyRoot(state: EntityLockState, tick: number, durationTicks: number): EntityLockState {
  return {
    ...state,
    rootUntilTick: tick + Math.max(0, Math.trunc(durationTicks))
  };
}

export function tickLocks(state: EntityLockState, tick: number): EntityLockState {
  const freezeActive = isFrozen(state, tick);
  const freezeImmune = hasFreezeImmunity(state, tick);

  return {
    lockType: state.lockType,
    teleporting: state.teleporting,
    freezeUntilTick: freezeImmune ? state.freezeUntilTick : -1,
    freezeSourceId: freezeImmune ? state.freezeSourceId : undefined,
    stunUntilTick: isStunned(state, tick) ? state.stunUntilTick : -1,
    rootUntilTick: isRooted(state, tick) ? state.rootUntilTick : -1
  };
}
