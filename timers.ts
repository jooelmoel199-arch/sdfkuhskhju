export interface AttackTimerState {
  readonly lastAttackTick: number;
  readonly weaponCooldownTicks: number;
  readonly additiveAttackDelayTicks: number;
}

export interface AttackDelayStatus {
  readonly delayed: boolean;
  readonly remainingTicks: number;
}

export interface ConsumedAttackDelayStatus extends AttackDelayStatus {
  readonly state: AttackTimerState;
}

export function createAttackTimerState(lastAttackTick = 0): AttackTimerState {
  return {
    lastAttackTick,
    weaponCooldownTicks: 0,
    additiveAttackDelayTicks: 0
  };
}

export function updateLastAttack(
  state: AttackTimerState,
  currentTick: number,
  weaponCooldownTicks: number
): AttackTimerState {
  return {
    ...state,
    lastAttackTick: currentTick,
    weaponCooldownTicks: Math.max(0, Math.trunc(weaponCooldownTicks))
  };
}

export function delayAttack(state: AttackTimerState, ticks: number): AttackTimerState {
  return {
    ...state,
    additiveAttackDelayTicks: state.additiveAttackDelayTicks + Math.max(0, Math.trunc(ticks))
  };
}

export function shouldDelayFirstReadyAttackTick(state: AttackTimerState, currentTick: number): boolean {
  return state.lastAttackTick + state.weaponCooldownTicks + state.additiveAttackDelayTicks === currentTick;
}

export function getAttackDelayStatus(state: AttackTimerState, currentTick: number): AttackDelayStatus {
  const totalDelayTicks = state.weaponCooldownTicks + state.additiveAttackDelayTicks;
  const remainingTicks = Math.max(0, state.lastAttackTick + totalDelayTicks - currentTick);

  return {
    delayed: remainingTicks > 0,
    remainingTicks
  };
}

export function consumeExpiredAttackDelay(state: AttackTimerState, currentTick: number): ConsumedAttackDelayStatus {
  const status = getAttackDelayStatus(state, currentTick);

  if (status.delayed || state.additiveAttackDelayTicks === 0) {
    return {
      ...status,
      state
    };
  }

  // Nh clears food/pot attack delay only after the combined weapon + additive window is no longer active.
  return {
    ...status,
    state: {
      ...state,
      additiveAttackDelayTicks: 0
    }
  };
}

export function canAttack(state: AttackTimerState, currentTick: number): boolean {
  return !getAttackDelayStatus(state, currentTick).delayed;
}

export function applyFoodAttackDelay(state: AttackTimerState): AttackTimerState {
  return delayAttack(state, 3);
}

export function applyKarambwanAttackDelay(state: AttackTimerState, eatDelayActive: boolean): AttackTimerState {
  return delayAttack(state, eatDelayActive ? 1 : 2);
}

export function applyPotionAttackDelay(state: AttackTimerState): AttackTimerState {
  return state;
}
