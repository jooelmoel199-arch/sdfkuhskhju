import {
  state, stepSimulation, setMoveTarget, stopMovement, setLane, setAttackTarget, clearAttackTarget,
  setAttackEnabled, toggleMeleePrayer, resetSimulation, maxHitpoints, TICK_MS,
  useConsumable, investAll, useSpecial, buyBestAffordableUpgrade, buyConsumables
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
const actionbarEl = document.querySelector("#actionbar");

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

  playersEl.innerHTML = [state.blue, state.red].map(player => {
    const hp = maxHitpoints(player.stats);
    const weapon = player.equipment.weapon?.name ?? "Unarmed";
    const status = !player.alive ? "RESPAWNING" :
      player.activePrayers.length ? "PRAYER" :
      player.team === "blue" && state.humanControl?.moveTargetX !== undefined ? "MOVING" : "READY";
    return `<div class="playerRow ${player.team}">
      <b>${player.id}</b> <span class="muted">${player.laneId.toUpperCase()} · ${status}</span><br>
      HP ${player.currentHp}/${hp} · GP ${player.gp} · K/D ${player.kills}/${player.deaths}<br>
      <span class="muted">ACC ${accountLevelFromXp(player.stats.xp)} · XP ${Math.floor(player.stats.unallocatedXp)} · Atk ${levelOf(player.stats, "attack")} Str ${levelOf(player.stats, "strength")} Def ${levelOf(player.stats, "defence")} · ${weapon}</span>
    </div>`;
  }).join("");

  const relevant = state.log.slice(-8);
  if (relevant.length && relevant[relevant.length - 1].tick !== lastRenderedLogTick) {
    feedEl.innerHTML = relevant.map(entry => `<div><span class="muted">[${entry.tick}]</span> ${entry.message}</div>`).join("");
    lastRenderedLogTick = relevant[relevant.length - 1].tick;
  }
}


function inventoryCount(id) {
  return state.blue.inventory.find(entry => entry.id === id)?.quantity ?? 0;
}

function renderActionbar() {
  actionbarEl.innerHTML = 
    '<div class="actionGroup">' +
    '<button class="actionButton" data-action="food"><span class="key">F</span>SHARK<span class="count">' + inventoryCount("shark") + '</span></button>' +
    '<button class="actionButton" data-action="prayer"><span class="key">C</span>PRAYER POT<span class="count">' + inventoryCount("prayer_potion") + '</span></button>' +
    '<button class="actionButton" data-action="spec"><span class="key">X</span>SPEC<span class="count">' + Math.floor(state.blue.specEnergy) + '%</span></button>' +
    '</div><div class="divider"></div>' +
    '<div class="actionGroup">' +
    '<button class="actionButton" data-action="attack"><span class="key">Q</span>ATTACK ' + (state.humanControl.attackEnabled ? 'ON' : 'OFF') + '</button>' +
    '<button class="actionButton" data-action="prayer-toggle"><span class="key">P</span>PROTECT</button>' +
    '<button class="actionButton" data-action="upgrade"><span class="key">J</span>+ATTACK</button>' +
    '<button class="actionButton" data-action="upgrade-str"><span class="key">K</span>+STRENGTH</button>' +
    '<button class="actionButton" data-action="upgrade-def"><span class="key">L</span>+DEFENCE</button>' +
    '<button class="actionButton" data-action="buy"><span class="key">B</span>BUY AT BASE</button><button class="actionButton" data-action="restock"><span class="key">V</span>RESTOCK</button>' +
    '</div>';
}
\n\nfunction drawHpBar(x, y, width, hp, maxHp, fill) {
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

  const river = worldToScreen(0, 925);
  ctx.fillStyle = "#315d7a";
  ctx.fillRect(river.x, river.y, WORLD.w * camera.zoom, 550 * camera.zoom);
  ctx.strokeStyle = "rgba(165,205,218,.18)";
  for (let y = 970; y < 1450; y += 42) {
    const p = worldToScreen(0, y);
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    ctx.lineTo(bottomRight.x, p.y);
    ctx.stroke();
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
    const p = worldToScreen(simToWorldX(state.humanControl.moveTargetX), laneToWorldY(state.blue.laneId));
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

  if (state.humanControl?.attackTargetId === state.red.id && state.red.alive) {
    const target = worldToScreen(simToWorldX(state.red.tile.x), laneToWorldY(state.red.laneId));
    ctx.strokeStyle = "rgba(255,232,130,.95)";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(target.x, target.y, 36 * camera.zoom, 0, Math.PI * 2);
    ctx.stroke();
    ctx.lineWidth = 1;
  }

  for (const player of [state.blue, state.red]) {
    if (!player.alive) continue;
    const p = worldToScreen(simToWorldX(player.tile.x), laneToWorldY(player.laneId));
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
  }

  drawMinimap();
  renderActionbar();
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

  for (const player of [state.blue, state.red]) {
    if (!player.alive) continue;
    mini.fillStyle = player.team === "blue" ? "#4da2ff" : "#ff5d5d";
    mini.beginPath();
    mini.arc((player.tile.x / 40) * 180 + 3, miniLaneY[player.laneId], 4, 0, Math.PI * 2);
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
    const enemy = state.red;
    const enemyPos = worldToScreen(simToWorldX(enemy.tile.x), simToWorldY(enemy.tile.y));
    if (enemy.alive && Math.hypot(event.clientX - enemyPos.x, event.clientY - enemyPos.y) <= 34) {
      setAttackTarget(enemy.id);
      state.humanControl.moveTargetX = enemy.tile.x;
      state.humanControl.moveTargetY = enemy.tile.y;
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

actionbarEl.addEventListener("click", event => {
  const button = event.target.closest("[data-action]");
  if (!button) return;
  const action = button.dataset.action;
  if (action === "food") useConsumable("shark");
  if (action === "prayer") useConsumable("prayer_potion");
  if (action === "spec") useSpecial();
  if (action === "attack") setAttackEnabled(!state.humanControl.attackEnabled);
  if (action === "prayer-toggle") toggleMeleePrayer();
  if (action === "upgrade") investAll("attack");
  if (action === "upgrade-str") investAll("strength");
  if (action === "upgrade-def") investAll("defence");
  if (action === "buy") buyBestAffordableUpgrade();
  if (action === "restock") buyConsumables("shark", 3);
});

addEventListener("keydown", event => {
  const key = event.key.toLowerCase();
  keys.add(key);

  if (key === " ") {
    event.preventDefault();
    setAttackEnabled(!state.humanControl.attackEnabled);
  }
  if (key === "p") toggleMeleePrayer();
  if (key === "f") useConsumable("shark");
  if (key === "c") useConsumable("prayer_potion");
  if (key === "x") useSpecial();
  if (key === "q") setAttackEnabled(!state.humanControl.attackEnabled);
  if (key === "j") investAll("attack");
  if (key === "k") investAll("strength");
  if (key === "l") investAll("defence");
  if (key === "b") buyBestAffordableUpgrade();
  if (key === "escape") clearAttackTarget();
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
