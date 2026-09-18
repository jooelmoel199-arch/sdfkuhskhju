export function effectiveCombatLevel(baseLevel:number, prayerMultiplier:number, styleBonus:number):number {
  return Math.floor(baseLevel * prayerMultiplier) + styleBonus + 8;
}

export function hitChanceFromRolls(attackRoll:number, defenceRoll:number):number {
  if (attackRoll > defenceRoll) return 1 - (defenceRoll + 2) / (2 * (attackRoll + 1));
  return attackRoll / (2 * (defenceRoll + 1));
}

export function standardMaxHit(effectiveStrength:number, strengthBonus:number):number {
  return Math.floor(0.5 + effectiveStrength * (strengthBonus + 64) / 640);
}

export function magicMaxHit(spellMaxHit:number, magicDamageBonus:number):number {
  return Math.floor(spellMaxHit * (1 + magicDamageBonus));
}

export function playerMagicDefenceLevel(
  magicLevel:number,
  defenceLevel:number,
  magicPrayerMultiplier:number,
  defencePrayerMultiplier:number,
):number {
  return Math.floor(magicLevel * 0.7 * magicPrayerMultiplier + defenceLevel * 0.3 * defencePrayerMultiplier) + 8;
}

export function prayerDrainResistance(prayerBonus:number):number {
  return 60 + prayerBonus * 2;
}

export function projectileHitDelay(attackType:"melee"|"ranged"|"magic", distance:number):number {
  const d=Math.max(1,distance);
  if(attackType==="melee") return 0;
  if(attackType==="ranged") return 1 + Math.floor((d+3)/6);
  return 1 + Math.floor((d+1)/3);
}
