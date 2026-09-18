import {
  state,
  stepSimulation,
  setMoveTarget,
  stopMovement,
  setAttackEnabled,
  toggleMeleePrayer,
  resetSimulation,
  maxHitpoints,
  TICK_MS
} from "./simState.js";
import { levelOf } from "../moba/stats.ts";

const canvas = document.querySelector("#game");
const ctx = canvas.getContext("2d");
const minimapCanvas = document.querySelector("#minimapCanvas");
const mini = minimapCanvas.getContext("2d");
const tickEl = document.querySelector("#tick");
const timeEl = document.querySelector("#time");
const playersEl = document.querySelector("#players");
const feedEl = document.querySelector("#feed");

const WORLD = { w: 3600, h: 2400 };
const SIM_X_OFFSET = 100;
const SIM_X_SCALE = 85;
const camera = { x: 1800, y: 1200, zoom: 0.56 };
const keys = new Set();
let last = performance.now();
let accumulator = 0;
let dragging = false;
let movedDuringDrag = false;
let suppressNextClick = false;
let lastMouse = { x: 0, y: 0 };
let lastRenderedLogTick = -1;

function simToWorldX(x) {
  return SIM_X_OFFSET + x * SIM_X_SCALE;
}

function worldToSimX(x) {
  return (x - SIM_X_OFFSET) / SIM_X_SCALE;
}

function screenToWorld(x, y) {
  return {
    x: (x - innerWidth / 2) / camera.zoom + camera.x,
    y: (y - innerHeight / 2) / camera.zoom + camera.y
  };
}

function worldToScreen(x, y) {
  return {
    x: (x - camera.x) * camera.zoom + innerWidth / 2,
    y: (y - camera.y) * camera.zoom + innerHeight / 2
  };
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
    const status = !player.alive
      ? "RESPAWNING"
      : player.activePrayers.length
        ? "PRAYER " + player.activePrayers.join(", ")
        : state.blue === player && state.humanControl?.moveTargetX !== undefined
          ? "MOVING"
          : "READY";
    return `<div class="playerRow ${player.team}">
      <b>${player.id}</b> <span class="muted">${status}</span><br>
      HP ${player.currentHp}/${hp} · GP ${player.gp} · K/D ${player.kills}/${player.deaths}<br>
      <span class="muted">Atk ${levelOf(player.stats, "attack")} Str ${levelOf(player.stats, "strength")} Def ${levelOf(player.stats, "defence")} · Spec ${Math.floor(player.specEnergy)}%</span>
    </div>`;
  }).join("");

  const relevant = state.log.slice(-8);
  if (relevant.length && relevant[relevant.length - 1].tick !== lastRenderedLogTick) {
    feedEl.innerHTML = relevant.map(entry => `<div><span class="muted">[${entry.tick}]</span> ${entry.message}</div>`).join("");
    lastRenderedLogTick = relevant[relevant.length - 1].tick;
  }
}

function drawHpBar(x, y, width, hp, maxHp, fill) {
  ctx.fillStyle = "rgba(0,0,0,.75)";
  ctx.fillRect(x - width / 2, y, width, 6);
  ctx.fillStyle = fill;
  ctx.fillRect(x - width / 2 + 1, y + 1, Math.max(0, (width - 2) * hp / Math.max(1, maxHp)), 4);
}

function draw() {
  ctx.fillStyle = "#3b633c";
  ctx.fillRect(0, 0, innerWidth, innerHeight);

  const topLeft = worldToScreen(0, 0);
  const bottomRight = worldToScreen(WORLD.w, WORLD.h);
  ctx.fillStyle = "#426c3f";
  ctx.fillRect(topLeft.x, topLeft.y, bottomRight.x - topLeft.x, bottomRight.y - topLeft.y);

  // Jungle blocks.
  ctx.fillStyle = "#294b30";
  for (const r of [[420, 510, 1040, 450], [2140, 510, 1040, 450], [420, 1440, 1040, 450], [2140, 1440, 1040, 450]]) {
    const p = worldToScreen(r[0], r[1]);
    ctx.fillRect(p.x, p.y, r[2] * camera.zoom, r[3] * camera.zoom);
  }

  // River.
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

  // Three lanes.
  for (const y of [350, 1200, 2050]) {
    const p = worldToScreen(0, y);
    ctx.fillStyle = "#8d805f";
    ctx.fillRect(p.x, p.y - 56 * camera.zoom, WORLD.w * camera.zoom, 112 * camera.zoom);
    ctx.fillStyle = "#b5a57e";
    ctx.fillRect(p.x, p.y - 3 * camera.zoom, WORLD.w * camera.zoom, 6 * camera.zoom);
  }

  // Jungle decoration.
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

  // Bases.
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

  // Towers: simulation is one-dimensional, so render it on the middle lane for now.
  for (const tower of state.towers) {
    if (!tower.alive) continue;
    const p = worldToScreen(simToWorldX(tower.tile.x), 1200);
    const size = 34 * camera.zoom;
    ctx.fillStyle = tower.team === "blue" ? "#4d91d2" : "#d85a5a";
    ctx.fillRect(p.x - size / 2, p.y - size, size, size);
    drawHpBar(p.x, p.y - size - 12 * camera.zoom, size * 1.35, tower.currentHp, tower.maxHp, tower.team === "blue" ? "#6eb2ff" : "#ff7474");
  }

  // Player movement target.
  const targetX = state.humanControl?.moveTargetX;
  if (targetX !== undefined && state.blue.alive) {
    const p = worldToScreen(simToWorldX(targetX), 1200);
    ctx.strokeStyle = "rgba(255,232,130,.9)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 15 * camera.zoom, 0, Math.PI * 2);
    ctx.stroke();
    ctx.lineWidth = 1;
  }

  // Minions.
  for (const minion of state.minions.filter(m => m.alive)) {
    const p = worldToScreen(simToWorldX(minion.tile.x), 1200 + (minion.team === "blue" ? -24 : 24));
    ctx.fillStyle = minion.team === "blue" ? "#71a8df" : "#df7474";
    ctx.beginPath();
    ctx.arc(p.x, p.y, 11 * camera.zoom, 0, Math.PI * 2);
    ctx.fill();
  }

  // Players.
  for (const player of [state.blue, state.red]) {
    if (!player.alive) continue;
    const p = worldToScreen(simToWorldX(player.tile.x), 1200);
    const radius = 25 * camera.zoom;
    ctx.fillStyle = player.team === "blue" ? "#4da2ff" : "#ff5d5d";
    ctx.beginPath();
    ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#f8efca";
    ctx.lineWidth = player.team === "blue" ? 2 : 1;
    ctx.stroke();
    ctx.lineWidth = 1;
    drawHpBar(p.x, p.y - radius - 13 * camera.zoom, 62 * camera.zoom, player.currentHp, maxHitpoints(player.stats), "#72d26b");
    ctx.fillStyle = "#fff";
    ctx.font = "bold " + Math.max(10, 13 * camera.zoom) + "px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(player.id, p.x, p.y - radius - 22 * camera.zoom);
  }

  drawMinimap();
}

function drawMinimap() {
  mini.clearRect(0, 0, minimapCanvas.width, minimapCanvas.height);
  mini.fillStyle = "#29472e";
  mini.fillRect(0, 0, 186, 122);
  mini.fillStyle = "#315d7a";
  mini.fillRect(0, 47, 186, 28);
  for (const y of [18, 61, 103]) {
    mini.fillStyle = "#8d805f";
    mini.fillRect(0, y - 4, 186, 8);
  }
  mini.fillStyle = "#37638d";
  mini.fillRect(2, 54, 8, 15);
  mini.fillStyle = "#8e4848";
  mini.fillRect(176, 54, 8, 15);
  for (const tower of state.towers) {
    if (!tower.alive) continue;
    mini.fillStyle = tower.team === "blue" ? "#70adf0" : "#f07474";
    mini.fillRect((tower.tile.x / 40) * 180 + 3, 58, 5, 5);
  }
  for (const minion of state.minions.filter(m => m.alive)) {
    mini.fillStyle = minion.team === "blue" ? "#71a8df" : "#df7474";
    mini.fillRect((minion.tile.x / 40) * 180 + 3, minion.team === "blue" ? 56 : 66, 2, 2);
  }
  for (const player of [state.blue, state.red]) {
    if (!player.alive) continue;
    mini.fillStyle = player.team === "blue" ? "#4da2ff" : "#ff5d5d";
    mini.beginPath();
    mini.arc((player.tile.x / 40) * 180 + 3, 61, 4, 0, Math.PI * 2);
    mini.fill();
  }
  mini.strokeStyle = "rgba(255,255,255,.45)";
  mini.strokeRect(
    Math.max(0, ((camera.x - WORLD.w / (2 * camera.zoom)) / WORLD.w) * 186),
    Math.max(0, ((camera.y - WORLD.h / (2 * camera.zoom)) / WORLD.h) * 122),
    Math.min(186, (WORLD.w / camera.zoom / WORLD.w) * 186),
    Math.min(122, (WORLD.h / camera.zoom / WORLD.h) * 122)
  );
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
  if (suppressNextClick) { suppressNextClick = false; return; }
  const world = screenToWorld(event.clientX, event.clientY);
  const simX = worldToSimX(world.x);
  if (simX >= 2 && simX <= 38) setMoveTarget(simX);
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
  const dx = event.clientX - lastMouse.x;
  const dy = event.clientY - lastMouse.y;
  if (!dragging) return;
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
  if (key === "p") toggleMeleePrayer();
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
