import { createGame, enqueueInput, step } from "./game";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const game = createGame();
enqueueInput(game, { type: "attack", targetId: "opponent" });
step(game);
assert(game.tick === 1, "tick should advance");
assert(game.players.player.targetId === "opponent", "attack input should acquire target");
assert(game.events.some(e => e.type === "attack_queued"), "attack should be queued");
assert(game.events.some(e => e.type === "hit" || e.type === "miss"), "queued attack should resolve");
assert(game.players.player.nextAttackTick === 5, "rune scimitar should use a 4-tick cooldown");

const hpAfterAttack = game.players.opponent.hp;
step(game); step(game); step(game);
assert(game.players.opponent.hp === hpAfterAttack, "cooldown must prevent early reattack");
step(game);
assert(game.players.opponent.hp <= hpAfterAttack, "attack should be eligible again on cooldown tick");

const beforeFood = game.players.player.hp;
enqueueInput(game, { type: "eat" });
step(game);
assert(game.players.player.inventory.food === 9, "eating should consume one food");
assert(game.players.player.hp >= beforeFood, "eating should not reduce HP");

enqueueInput(game, { type: "move", x: 14 });
step(game);
assert(game.players.player.x === 14, "movement input should be authoritative");

enqueueInput(game, { type: "prayer", prayer: "protect_melee" });
step(game);
assert(game.players.player.prayer === "protect_melee", "prayer input should update server state");

console.log("server combat queue tests passed");
