import {
  state, stepSimulation, setMoveTarget, stopMovement, setLane, setAttackTarget, clearAttackTarget,
  setAttackEnabled, resetSimulation, maxHitpoints, TICK_MS, togglePrayer,
  useConsumable, equipItem, investAll, useSpecial, buyBestAffordableUpgrade, buyConsumables, cycleAttackType
} from "./simState.js";
import { levelOf } from "../moba/stats.ts";
import { accountLevelFromXp } from "../moba/xp.ts";
import { LANE_Y, LANES } from "../moba/lane.ts";

const canvas = document.querySelector("#game");
const ctx = canvas.getContext("2d");
const minimapCanvas = document.querySelector("#minimapCanvas");
const mini = minimapCanvas.getContext("2d");
const tickEl = document.querySelector("#tick");
const timeEl = document.querySelector("#time");
const playersEl = document.querySelector("#players");
const feedEl = document.querySelector("#feed");

const WORLD = { w: 3600, h: 2400 };
const CAMERA_LANE_Y = { top: 350, middle: 1200, bottom: 2050 };
const SIM_Y_PER_WORLD_PX = 20 / 850;
const camera = { x: 1800, y: 1200, zoom: 0.56 };
const keys = new Set();
let last = performance.now();
let accumulator = 0;
let dragging = false;
let movedDuringDrag = false;
let suppressNextClick = false;
let lastMouse = { x: 0, y: 0 };
let lastRenderedLogTick = -1;

function simToWorldX(x) { return 150 + x * 82.5; }
function worldToSimX(x) { return (x - 150) / 82.5; }
function worldToSimY(y) { return (y - 350) / (1 / SIM_Y_PER_WORLD_PX); }
function simToWorldY(y) { return 350 + y * (1 / SIM_Y_PER_WORLD_PX); }
function laneToWorldY(laneId) { return CAMERA_LANE_Y[laneId]; }
function worldToLane(y) {
  return LANES.reduce((best, lane) =>
    Math.abs(y - CAMERA_LANE_Y[lane]) < Math.abs(y - CAMERA_LANE_Y[best]) ? lane : best,
    "middle"
  );
}
function screenToWorld(x, y) {
  return { x: (x - innerWidth / 2) / camera.zoom + camera.x, y: (y - innerHeight / 2) / camera.zoom + camera.y };
}
function worldToScreen(x, y) {
  return { x: (x - camera.x) * camera.zoom + innerWidth / 2, y: (y - camera.y) * camera.zoom + innerHeight / 2 };
}

function resize() {
  const d = Math.min(2, devicePixelRatio || 1);
  canvas.width = innerWidth * d;
  canvas.height = innerHeight * d;
  ctx.setTransform(d, 0, 0, d, 0, 0);
  minimapCanvas.width = 186;
  minimapCanvas.height = 122;
}
addEventListener("resize", resize);
resize();

function tick() {
  stepSimulation();
  updateHud();
}

function updateHud() {
  tickEl.textContent = "TICK " + state.tick;
  const seconds = Math.floor(state.tick * TICK_MS / 1000);
  timeEl.textContent = String(Math.floor(seconds / 60)).padStart(2, "0") + ":" + String(seconds % 60).padStart(2, "0");

  playersEl.innerHTML = state.players.map(player => {
    const hp = maxHitpoints(player.stats);
    const weapon = player.equipment.weapon?.name ?? "Unarmed";
    const status = !player.alive ? "RESPAWNING" :
      player.activePrayers.length ? "PRAYER" :
      player.team === "blue" && state.humanControl?.moveTargetX !== undefined ? "MOVING" : "READY";
    return `<div class="playerRow ${player.team}">
      <b>${player.id}</b> <span class="muted">${player.role.toUpperCase()} · ${player.laneId.toUpperCase()} · ${status}</span><br>
      HP ${player.currentHp}/${hp} · GP ${player.gp} · K/D ${player.kills}/${player.deaths} · ${state.teamBuffs[player.team] && state.teamBuffs[player.team].expiresAtTick > state.tick ? state.teamBuffs[player.team].name : "No buff"}<br>
      <span class="muted">ACC ${accountLevelFromXp(player.stats.xp)} · XP ${Math.floor(player.stats.unallocatedXp)} · Atk ${levelOf(player.stats, "attack")} Str ${levelOf(player.stats, "strength")} Def ${levelOf(player.stats, "defence")} · ${weapon}</span>
    </div>`;
  }).join("");

  renderAccountPanel();

  // Hitsplats are driven by simulation ticks, then rendered smoothly by the client.
  for (const event of state.combatEvents ?? []) {
    const target = state.players.find(player => player.id === event.targetId);
    if (!target || !target.alive) continue;
    const age = renderTick - event.tick;
    if (age < 0 || age > 2.5) continue;
    const p = worldToScreen(simToWorldX(target.tile.x), simToWorldY(target.tile.y) - 1.2);
    const lift = age * 34 * camera.zoom;
    ctx.globalAlpha = Math.max(0, 1 - age / 2.5);
    ctx.fillStyle = event.landed ? "#fff" : "#aaa";
    ctx.font = "900 " + Math.max(14, 18 * camera.zoom) + "px ui-monospace,monospace";
    ctx.textAlign = "center";
    ctx.fillText(event.landed ? String(event.damage) : "0", p.x, p.y - lift);
    ctx.globalAlpha = 1;
  }

  if (state.matchResult) {
    document.title = state.matchResult === "blue" ? "RS MOBA Prototype · Victory" : "RS MOBA Prototype · Defeat";
  } else {
    document.title = "RS MOBA Prototype";
  }

  renderCombatHud();
  const relevant = state.log.slice(-8);
  if (relevant.length && relevant[relevant.length - 1].tick !== lastRenderedLogTick) {
    feedEl.innerHTML = relevant.map(entry => `<div><span class="muted">[${entry.tick}]</span> ${entry.message}</div>`).join("");
    lastRenderedLogTick = relevant[relevant.length - 1].tick;
  }
}


function inventoryCount(id) {
  return state.blue.inventory.find(entry => entry.id === id)?.quantity ?? 0;
}

function renderAccountPanel() {
  const player = state.blue;
  const slots = ["weapon", "shield", "head", "body", "legs", "amulet", "ring", "cape"];
  const equipment = slots.map(slot => {
    const item = player.equipment[slot];
    return '<div class="slot"><b>' + slot.toUpperCase() + '</b>' + (item ? item.name : "Empty") + '</div>';
  }).join("");
  const inventory = player.inventory
    .map(entry => {
      const item = state.blue.inventory.find(candidate => candidate.id === entry.id);
      const isGear = state.blue.equipment[entry.id] !== undefined;
      return '<button class="invItem" data-equip="' + entry.id + '">' + entry.id.replaceAll("_", " ") + ' x' + entry.quantity + '</button>';
    })
    .join("");
  document.querySelector("#account").innerHTML =
    '<div>Account level <b>' + accountLevelFromXp(player.stats.xp) + '</b> · Unallocated XP <b>' + Math.floor(player.stats.unallocatedXp) + '</b></div>' +
    '<div class="account-grid">' + equipment + '</div>' +
    '<div class="inv-row" style="margin-top:7px">' + (inventory || "Inventory empty") + '</div>';
}

document.querySelector("#account").addEventListener("click", event => {
  const button = event.target.closest("[data-equip]");
  if (button) equipItem(button.dataset.equip);
});

function renderCombatHud() {
  const player = state.blue;
  const target = state.players.find(p => p.id === state.humanControl?.attackTargetId);
  const weapon = player.equipment.weapon;
  const cooldown = weapon ? Math.max(0, weapon.cooldownTicks ?? 4) : 0;
  const readyTick = player.attackTimer.lastAttackTick + player.attackTimer.weaponCooldownTicks + player.attackTimer.additiveAttackDelayTicks;
  const remaining = Math.max(0, readyTick - state.tick);
  const freeze = Math.max(0, player.locks.freezeUntilTick - state.tick + 1);
  const prayer = player.activePrayers.length ? player.activePrayers[0].replaceAll("_", " ").toUpperCase() : "OFF";
  const targetHp = target ? Math.max(0, target.currentHp) + "/" + maxHitpoints(target.stats) : "NO TARGET";
  const el = document.querySelector("#combatStatus");
  if (el) {
    el.innerHTML =
      '<b>' + (weapon?.name ?? "Unarmed") + '</b> · ' + player.attackType.toUpperCase() +
      ' · CD <b>' + remaining + '</b>t · SPEC <b>' + player.specEnergy + '%</b><br>' +
      'HP <b>' + player.currentHp + '/' + maxHitpoints(player.stats) + '</b> · PRAYER <b>' + player.prayerPoints + '/' + player.stats.xp.prayer + '</b> · ' +
      '<span class="prayer">' + prayer + '</span><br>' +
      'TARGET HP <b>' + targetHp + '</b>' + (freeze ? ' · FROZEN ' + freeze + 't' : '');
  }
}

function drawHpBar(x, y, width, hp, maxHp, fill) {
  ctx.fillStyle = "rgba(0,0,0,.75)";
  ctx.fillRect(x - width / 2, y, width, 6);
  ctx.fillStyle = fill;
  ctx.fillRect(x - width / 2 + 1, y + 1, Math.max(0, (width - 2) * hp / Math.max(1, maxHp)), 4);
}

function drawLaneLabel(lane) {
  const y = laneToWorldY(lane);
  const p = worldToScreen(3200, y);
  ctx.fillStyle = "rgba(244,239,214,.55)";
  ctx.font = "700 11px ui-monospace,monospace";
  ctx.textAlign = "right";
  ctx.fillText(lane.toUpperCase() + " LANE", p.x, p.y - 68 * camera.zoom);
}

function draw() {
  ctx.fillStyle = "#3b633c";
  ctx.fillRect(0, 0, innerWidth, innerHeight);

  const topLeft = worldToScreen(0, 0);
  const bottomRight = worldToScreen(WORLD.w, WORLD.h);
  ctx.fillStyle = "#426c3f";
  ctx.fillRect(topLeft.x, topLeft.y, bottomRight.x - topLeft.x, bottomRight.y - topLeft.y);

  ctx.fillStyle = "#294b30";
  for (const r of [[420, 500, 1040, 430], [2140, 500, 1040, 430], [420, 1450, 1040, 430], [2140, 1450, 1040, 430]]) {
    const p = worldToScreen(r[0], r[1]);
    ctx.fillRect(p.x, p.y, r[2] * camera.zoom, r[3] * camera.zoom);
  }

  ctx.fillStyle = "#315d7a";
  for (const [top, height] of [[690, 170], [1540, 170]]) {
    const river = worldToScreen(0, top);
    ctx.fillRect(river.x, river.y, WORLD.w * camera.zoom, height * camera.zoom);
    ctx.strokeStyle = "rgba(165,205,218,.18)";
    for (let y = top + 25; y < top + height; y += 42) {
      const p = worldToScreen(0, y);
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(bottomRight.x, p.y);
      ctx.stroke();
    }
  }

  for (const lane of LANES) {
    const y = laneToWorldY(lane);
    const p = worldToScreen(0, y);
    ctx.fillStyle = "#8d805f";
    ctx.fillRect(p.x, p.y - 56 * camera.zoom, WORLD.w * camera.zoom, 112 * camera.zoom);
    ctx.fillStyle = state.humanControl?.laneId === lane ? "#c8b37a" : "#b5a57e";
    ctx.fillRect(p.x, p.y - 3 * camera.zoom, WORLD.w * camera.zoom, 6 * camera.zoom);
    drawLaneLabel(lane);
  }

  ctx.fillStyle = "#172b1d";
  for (let x = 330; x < 3330; x += 170) {
    for (let y = 620; y < 1810; y += 160) {
      if ((x + y) % 340 < 170) {
        const p = worldToScreen(x, y);
        ctx.beginPath();
        ctx.arc(p.x, p.y, 24 * camera.zoom, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  for (const team of ["blue", "red"]) {
    const x = team === "blue" ? simToWorldX(0) + 10 : simToWorldX(40) - 10;
    const p = worldToScreen(x, 1200);
    ctx.fillStyle = team === "blue" ? "rgba(40,89,139,.82)" : "rgba(135,60,60,.82)";
    ctx.beginPath();
    ctx.arc(p.x, p.y, 155 * camera.zoom, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#eee7c9";
    ctx.font = Math.max(11, 18 * camera.zoom) + "px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(team === "blue" ? "BLUE BASE" : "RED BASE", p.x, p.y + 7);
  }

  for (const tower of state.towers) {
    if (!tower.alive) continue;
    const p = worldToScreen(simToWorldX(tower.tile.x), laneToWorldY(tower.laneId));
    const size = 34 * camera.zoom;
    ctx.fillStyle = tower.team === "blue" ? "#4d91d2" : "#d85a5a";
    ctx.fillRect(p.x - size / 2, p.y - size, size, size);
    drawHpBar(p.x, p.y - size - 12 * camera.zoom, size * 1.35, tower.currentHp, tower.maxHp,
      tower.team === "blue" ? "#6eb2ff" : "#ff7474");
  }

  if (state.humanControl?.moveTargetX !== undefined && state.blue.alive) {
    const targetY = state.humanControl.moveTargetY ?? state.blue.tile.y;
    const p = worldToScreen(simToWorldX(state.humanControl.moveTargetX), simToWorldY(targetY));
    ctx.strokeStyle = "rgba(255,232,130,.95)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 15 * camera.zoom, 0, Math.PI * 2);
    ctx.stroke();
    ctx.lineWidth = 1;
  }

  for (const minion of state.minions.filter(m => m.alive)) {
    const offset = minion.team === "blue" ? -24 : 24;
    const p = worldToScreen(simToWorldX(minion.tile.x), laneToWorldY(minion.laneId) + offset);
    ctx.fillStyle = minion.team === "blue" ? "#71a8df" : "#df7474";
    ctx.beginPath();
    ctx.arc(p.x, p.y, 11 * camera.zoom, 0, Math.PI * 2);
    ctx.fill();
    drawHpBar(p.x, p.y - 16 * camera.zoom, 25 * camera.zoom, minion.currentHp, minion.maxHp,
      minion.team === "blue" ? "#71a8df" : "#df7474");
  }


  // Neutral jungle and river objectives.
  for (const camp of state.jungleCamps) {
    const p = worldToScreen(simToWorldX(camp.tile.x), simToWorldY(camp.tile.y));
    const radius = 18 * camera.zoom;
    ctx.fillStyle = camp.alive ? "#8f7a45" : "rgba(30,30,25,.55)";
    ctx.beginPath();
    ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
    ctx.fill();
    if (camp.alive) {
      ctx.fillStyle = "#e6d49d";
      ctx.font = "700 " + Math.max(9, 10 * camera.zoom) + "px ui-monospace,monospace";
      ctx.textAlign = "center";
      ctx.fillText(camp.name, p.x, p.y - radius - 8);
      drawHpBar(p.x, p.y + radius + 4, 44 * camera.zoom, camp.currentHp, camp.maxHp, "#d9ad4f");
    } else if (camp.respawnAtTick !== undefined) {
      ctx.fillStyle = "rgba(230,212,157,.55)";
      ctx.font = "700 9px ui-monospace,monospace";
      ctx.textAlign = "center";
      ctx.fillText("RESP " + Math.max(0, camp.respawnAtTick - state.tick), p.x, p.y + 4);
    }
  }
  if (state.humanControl?.attackTargetId) {
    const targetPlayer = state.players.find(player => player.id === state.humanControl?.attackTargetId && player.alive);
    const targetCamp = state.jungleCamps.find(camp => camp.id === state.humanControl?.attackTargetId && camp.alive);
    const targetTile = targetPlayer?.tile ?? targetCamp?.tile;
    if (targetTile) {
      const target = worldToScreen(simToWorldX(targetTile.x), simToWorldY(targetTile.y));
      ctx.strokeStyle = "rgba(255,232,130,.95)";
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(target.x, target.y, (targetPlayer ? 36 : 28) * camera.zoom, 0, Math.PI * 2);
      ctx.stroke();
      ctx.lineWidth = 1;
    }
  }

  // Tick-driven projectiles. Simulation owns launch/impact; render interpolates between ticks.
  const renderTick = state.tick + accumulator / TICK_MS;
  for (const projectile of state.projectiles) {
    const span = Math.max(1, projectile.hitTick - projectile.createdTick);
    const progress = Math.max(0, Math.min(1, (renderTick - projectile.createdTick) / span));
    const x = projectile.fromTile.x + (projectile.toTile.x - projectile.fromTile.x) * progress;
    const y = projectile.fromTile.y + (projectile.toTile.y - projectile.fromTile.y) * progress;
    const p = worldToScreen(simToWorldX(x), simToWorldY(y));
    ctx.fillStyle = projectile.style === "magic" ? "#c596ff" : "#e2d1a0";
    ctx.beginPath();
    ctx.arc(p.x, p.y, 5 * camera.zoom, 0, Math.PI * 2);
    ctx.fill();
  }

  for (const player of state.players) {
    if (!player.alive) continue;
    const p = worldToScreen(simToWorldX(player.tile.x), simToWorldY(player.tile.y));
    const radius = 25 * camera.zoom;
    ctx.fillStyle = player.team === "blue" ? "#4da2ff" : "#ff5d5d";
    ctx.beginPath();
    ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#f8efca";
    ctx.lineWidth = player.team === "blue" ? 2 : 1;
    ctx.stroke();
    ctx.lineWidth = 1;
    drawHpBar(p.x, p.y - radius - 13 * camera.zoom, 62 * camera.zoom, player.currentHp, maxHitpoints(player.stats),
      player.team === "blue" ? "#72d26b" : "#d87373");
    ctx.fillStyle = "#fff";
    ctx.font = "bold " + Math.max(10, 13 * camera.zoom) + "px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(player.id, p.x, p.y - radius - 22 * camera.zoom);
    if (player.activePrayers.length) {
      ctx.fillStyle = "#f7f2c5";
      ctx.font = "700 " + Math.max(9, 11 * camera.zoom) + "px ui-monospace,monospace";
      ctx.fillText(player.activePrayers[0].replace("protect_from_", "PROT "), p.x, p.y + radius + 18 * camera.zoom);
    }
    if (player.locks.freezeUntilTick >= state.tick) {
      ctx.fillStyle = "#8fd7ff";
      ctx.font = "900 " + Math.max(9, 12 * camera.zoom) + "px ui-monospace,monospace";
      ctx.fillText("FROZEN " + (player.locks.freezeUntilTick - state.tick + 1) + "t", p.x, p.y + radius + 34 * camera.zoom);
  }

  if (state.matchResult) {
    ctx.fillStyle = "rgba(0,0,0,.62)";
    ctx.fillRect(0, 0, innerWidth, innerHeight);
    ctx.fillStyle = state.matchResult === "blue" ? "#72d26b" : "#ff7474";
    ctx.font = "900 48px system-ui,sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(state.matchResult === "blue" ? "VICTORY" : "DEFEAT", innerWidth / 2, innerHeight / 2 - 12);
    ctx.fillStyle = "#f4f1df";
    ctx.font = "600 15px ui-monospace,monospace";
    ctx.fillText("Press R to run the prototype again", innerWidth / 2, innerHeight / 2 + 24);
  }

  drawMinimap();
}

function drawMinimap() {
  mini.clearRect(0, 0, minimapCanvas.width, minimapCanvas.height);
  mini.fillStyle = "#29472e";
  mini.fillRect(0, 0, 186, 122);
  mini.fillStyle = "#315d7a";
  mini.fillRect(0, 47, 186, 28);
  const miniLaneY = { top: 18, middle: 61, bottom: 103 };

  for (const lane of LANES) {
    mini.fillStyle = state.humanControl?.laneId === lane ? "#bca772" : "#8d805f";
    mini.fillRect(0, miniLaneY[lane] - 4, 186, 8);
  }

  for (const tower of state.towers) {
    if (!tower.alive) continue;
    mini.fillStyle = tower.team === "blue" ? "#70adf0" : "#f07474";
    mini.fillRect((tower.tile.x / 40) * 180 + 3, miniLaneY[tower.laneId] - 3, 5, 5);
  }

  for (const minion of state.minions.filter(m => m.alive)) {
    mini.fillStyle = minion.team === "blue" ? "#71a8df" : "#df7474";
    mini.fillRect((minion.tile.x / 40) * 180 + 3, miniLaneY[minion.laneId] - 1, 2, 2);
  }

  for (const camp of state.jungleCamps) {
    const x = (camp.tile.x / 40) * 180 + 3;
    const y = (camp.tile.y / 40) * 85 + 18;
    mini.fillStyle = camp.alive ? "#d9ad4f" : "#6c6655";
    mini.fillRect(x - 2, y - 2, 4, 4);
  }

  for (const player of state.players) {
    if (!player.alive) continue;
    mini.fillStyle = player.team === "blue" ? "#4da2ff" : "#ff5d5d";
    mini.beginPath();
    mini.arc((player.tile.x / 40) * 180 + 3, (player.tile.y / 40) * 85 + 18, 3.5, 0, Math.PI * 2);
    mini.fill();
  }
}

function frame(now) {
  const dt = Math.min(100, now - last);
  last = now;
  accumulator += dt;
  while (accumulator >= TICK_MS) {
    accumulator -= TICK_MS;
    tick();
  }

  const cameraSpeed = 700 / camera.zoom;
  if (keys.has("w")) camera.y -= cameraSpeed * dt / 1000;
  if (keys.has("s")) camera.y += cameraSpeed * dt / 1000;
  if (keys.has("a")) camera.x -= cameraSpeed * dt / 1000;
  if (keys.has("d")) camera.x += cameraSpeed * dt / 1000;
  camera.x = Math.max(0, Math.min(WORLD.w, camera.x));
  camera.y = Math.max(0, Math.min(WORLD.h, camera.y));

  draw();
  requestAnimationFrame(frame);
}

canvas.addEventListener("click", event => {
  if (suppressNextClick) {
    suppressNextClick = false;
    return;
  }
  const world = screenToWorld(event.clientX, event.clientY);
  const simX = worldToSimX(world.x);
  const simY = worldToSimY(world.y);
  if (simX >= 1 && simX <= 39 && simY >= -2 && simY <= 42) {
    const clickedEnemy = state.players
      .filter(player => player.team !== state.blue.team && player.alive)
      .map(player => ({ player, pos: worldToScreen(simToWorldX(player.tile.x), simToWorldY(player.tile.y)) }))
      .find(entry => Math.hypot(event.clientX - entry.pos.x, event.clientY - entry.pos.y) <= 34);
    const clickedCamp = state.jungleCamps
      .filter(camp => camp.alive)
      .map(camp => ({ camp, pos: worldToScreen(simToWorldX(camp.tile.x), simToWorldY(camp.tile.y)) }))
      .find(entry => Math.hypot(event.clientX - entry.pos.x, event.clientY - entry.pos.y) <= 28);
    const clickedTower = state.towers
      .filter(tower => tower.alive && tower.team !== state.blue.team)
      .map(tower => ({ tower, pos: worldToScreen(simToWorldX(tower.tile.x), laneToWorldY(tower.laneId)) }))
      .find(entry => Math.hypot(event.clientX - entry.pos.x, event.clientY - entry.pos.y) <= 32);

    if (clickedEnemy) {
      setAttackTarget(clickedEnemy.player.id);
      state.humanControl.moveTargetX = clickedEnemy.player.tile.x;
      state.humanControl.moveTargetY = clickedEnemy.player.tile.y;
    } else if (clickedCamp) {
      setAttackTarget(clickedCamp.camp.id);
      state.humanControl.moveTargetX = clickedCamp.camp.tile.x;
      state.humanControl.moveTargetY = clickedCamp.camp.tile.y;
    } else if (clickedTower) {
      setAttackTarget(clickedTower.tower.id);
      setLane(clickedTower.tower.laneId);
      setMoveTarget(clickedTower.tower.tile.x, laneToWorldY(clickedTower.tower.laneId));
    } else {
      clearAttackTarget();
      const lane = worldToLane(world.y);
      if (Math.abs(world.y - laneToWorldY(lane)) < 70) {
        setLane(lane);
        setMoveTarget(simX, simY);
      } else {
        setMoveTarget(simX, simY);
      }
    }
  }
});

canvas.addEventListener("contextmenu", event => {
  event.preventDefault();
  stopMovement();
});

canvas.addEventListener("mousedown", event => {
  dragging = true;
  movedDuringDrag = false;
  lastMouse = { x: event.clientX, y: event.clientY };
  canvas.classList.add("dragging");
});

addEventListener("mouseup", () => {
  if (dragging && movedDuringDrag) suppressNextClick = true;
  dragging = false;
  canvas.classList.remove("dragging");
});

addEventListener("mousemove", event => {
  if (!dragging) return;
  const dx = event.clientX - lastMouse.x;
  const dy = event.clientY - lastMouse.y;
  if (Math.abs(dx) + Math.abs(dy) > 4) movedDuringDrag = true;
  if (!movedDuringDrag) return;
  camera.x -= dx / camera.zoom;
  camera.y -= dy / camera.zoom;
  lastMouse = { x: event.clientX, y: event.clientY };
});

canvas.addEventListener("wheel", event => {
  event.preventDefault();
  const before = screenToWorld(event.clientX, event.clientY);
  camera.zoom = Math.max(0.28, Math.min(1.4, camera.zoom * Math.exp(-event.deltaY * 0.001)));
  const after = screenToWorld(event.clientX, event.clientY);
  camera.x += before.x - after.x;
  camera.y += before.y - after.y;
}, { passive: false });

addEventListener("keydown", event => {
  const key = event.key.toLowerCase();
  keys.add(key);

  if (key === " ") {
    event.preventDefault();
    setAttackEnabled(!state.humanControl.attackEnabled);
  }
  if (key === "p") togglePrayer("protect_from_melee");
  if (key === "f") useConsumable("shark");
  if (key === "c") useConsumable("prayer_potion");
  if (key === "x") useSpecial();
  if (key === "q") setAttackEnabled(!state.humanControl.attackEnabled);
  if (key === "t") cycleAttackType();
  if (key === "j") investAll("attack");
  if (key === "k") investAll("strength");
  if (key === "l") investAll("defence");
  if (key === "b") buyBestAffordableUpgrade();
  if (key === "escape") clearAttackTarget();
  if (key === "m") togglePrayer("protect_from_magic");
  if (key === "n") togglePrayer("protect_from_missiles");
  if (key === "1") setLane("top");
  if (key === "2") setLane("middle");
  if (key === "3") setLane("bottom");
  if (key === "r") {
    resetSimulation();
    camera.x = 1800;
    camera.y = 1200;
    camera.zoom = 0.56;
    lastRenderedLogTick = -1;
    updateHud();
  }
});

addEventListener("keyup", event => keys.delete(event.key.toLowerCase()));

updateHud();
requestAnimationFrame(frame);
