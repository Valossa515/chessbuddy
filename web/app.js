const $ = (selector) => document.querySelector(selector);

const LABELS = { best: "melhor lance", good: "bom lance", inaccuracy: "imprecisão", mistake: "erro", blunder: "erro grave" };
const GLYPHS = { k: "♚", q: "♛", r: "♜", b: "♝", n: "♞", p: "♟" };

const state = {
  username: load("username") ?? "",
  analysis: null,
  plyIndex: null,
  kind: "error",
  chat: [],
  exercise: null,
  picked: null,
  answered: false,
  replay: null,
  replayToken: null,
  follow: null,
  // Lousa: the position on the review board (plies played), the user's notes by position, the drawing tool.
  pos: null,
  view: null,
  notes: {},
  tool: null,
  color: "green",
  hideEngine: load("hideEngine") === "1",
};

function load(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function save(key, value) {
  try { localStorage.setItem(key, value); } catch { /* storage unavailable */ }
}

class LiveGameError extends Error {}

async function api(path, body, method = "POST") {
  const response = await fetch(path, body === undefined ? {} : {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (response.status === 423) {
    showLive(data.error, data.liveGameId);
    throw new LiveGameError(data.error);
  }
  if (!response.ok) throw new Error(data.error ?? `Erro ${response.status}`);
  return data;
}

// ---------- board ----------

const MOVE_MS = 280;
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");

function piecesOf(fen) {
  const pieces = {};
  fen.split(" ")[0].split("/").forEach((row, r) => {
    let file = 0;
    for (const ch of row) {
      if (/\d/.test(ch)) { file += Number(ch); continue; }
      pieces["abcdefgh"[file] + (8 - r)] = ch;
      file++;
    }
  });
  return pieces;
}

/**
 * `animate` lists {from, to} slides: each piece now on `to` glides in from `from`.
 * `coords` writes the file letters and rank numbers on the edge squares.
 */
function renderBoard(el, fen, { orientation = "w", marks = [], picked = null, onSquare = null, animate = [], coords = false } = {}) {
  const pieces = piecesOf(fen);
  const files = orientation === "w" ? "abcdefgh" : "hgfedcba";
  const ranks = orientation === "w" ? [8, 7, 6, 5, 4, 3, 2, 1] : [1, 2, 3, 4, 5, 6, 7, 8];
  const squares = {};
  el.replaceChildren();
  el.dataset.orientation = orientation;
  for (const rank of ranks) {
    for (const file of files) {
      const square = file + rank;
      const div = document.createElement("div");
      squares[square] = div;
      div.dataset.square = square;
      const light = ("abcdefgh".indexOf(file) + rank) % 2 === 1;
      div.className = `square ${light ? "light" : "dark"}`;
      if (marks.includes(square)) div.classList.add("mark");
      if (picked === square) div.classList.add("picked");
      if (coords && rank === ranks.at(-1)) div.append(Object.assign(document.createElement("span"), { className: "coord file", textContent: file }));
      if (coords && file === files[0]) div.append(Object.assign(document.createElement("span"), { className: "coord rank", textContent: rank }));
      const piece = pieces[square];
      if (piece) {
        const span = document.createElement("span");
        span.className = `piece ${piece === piece.toUpperCase() ? "w" : "b"}`;
        span.textContent = GLYPHS[piece.toLowerCase()];
        div.append(span);
      }
      if (onSquare) div.addEventListener("click", () => onSquare(square, piece));
      el.append(div);
    }
  }
  if (reducedMotion.matches) return;
  for (const { from, to } of animate) {
    const span = squares[to]?.querySelector(".piece");
    if (!span || !squares[from]) continue;
    const a = squares[from].getBoundingClientRect();
    const b = squares[to].getBoundingClientRect();
    span.classList.add("moving");
    span.animate(
      [{ transform: `translate(${a.left - b.left}px, ${a.top - b.top}px)` }, { transform: "none" }],
      { duration: MOVE_MS, easing: "ease-out" },
    ).finished.then(() => span.classList.remove("moving"), () => {});
  }
}

function squaresOf(uci) {
  return uci ? [uci.slice(0, 2), uci.slice(2, 4)] : [];
}

/** The slides a UCI move makes from `fen`: the piece itself, plus the rook when castling. */
function slidesOf(fen, uci) {
  if (!uci) return [];
  const [from, to] = squaresOf(uci);
  const slides = [{ from, to }];
  const fileDiff = "abcdefgh".indexOf(to[0]) - "abcdefgh".indexOf(from[0]);
  if (piecesOf(fen)[from]?.toLowerCase() === "k" && Math.abs(fileDiff) === 2) {
    const rank = from[1];
    slides.push(fileDiff > 0 ? { from: "h" + rank, to: "f" + rank } : { from: "a" + rank, to: "d" + rank });
  }
  return slides;
}

// ---------- evaluation bar ----------

const MATE_CP = 10_000;

/** Lichess' winning-chances curve, the same one the server classifies moves with. */
function winningChances(cp) {
  const clamped = Math.max(-1000, Math.min(1000, cp));
  return 2 / (1 + Math.exp(-0.00368208 * clamped)) - 1;
}

/** `cp` is from White's point of view; undefined leaves the bar even and unlabeled. */
function setEval(bar, cp, orientation) {
  const known = typeof cp === "number";
  const whiteAhead = !known || cp >= 0;
  bar.classList.toggle("flipped", orientation === "b");
  bar.querySelector(".eval-white").style.height = `${known ? 50 + 50 * winningChances(cp) : 50}%`;
  const label = bar.querySelector(".eval-label");
  label.textContent = !known ? "" : Math.abs(cp) >= MATE_CP - 500 ? `#${Math.round((MATE_CP - Math.abs(cp)) / 10)}` : (Math.abs(cp) / 100).toFixed(1);
  // The number sits at the leading side's end of the bar, on that side's color.
  const atBottom = whiteAhead === (orientation !== "b");
  label.className = `eval-label ${atBottom ? "bottom" : "top"} ${whiteAhead ? "on-white" : "on-black"}`;
  bar.title = known ? `Avaliação do Stockfish: ${cp >= 0 ? "+" : "−"}${label.textContent}` : "";
}

// ---------- arrows and drawing ----------

const COLORS = { green: "#15781b", red: "#882020", blue: "#003088", yellow: "#e68f00" };

/**
 * Lichess-style drawing on a board: right-drag draws an arrow, right-click
 * circles a square, drawing the same shape again removes it. Shapes are kept
 * by square (strokes in White-side board units), so they survive re-renders
 * and flipped boards.
 *
 * `tool()` lets the left button draw too ("pen" for freehand, "arrow" for
 * arrows); without a tool a left click clears the drawing when `clearOnClick`.
 * `onChange` runs after each change the user makes.
 */
function enableDrawing(board, svg, { tool = () => null, color = () => "green", onChange = () => {}, clearOnClick = true } = {}) {
  let shapes = [];
  let start = null;
  let preview = null;
  let stroke = null;
  const squareAt = (event) => {
    const square = document.elementFromPoint(event.clientX, event.clientY)?.closest(".square");
    return square && board.contains(square) ? square.dataset.square : undefined;
  };
  const flipped = () => board.dataset.orientation === "b";
  const pointAt = (event) => {
    const box = board.getBoundingClientRect();
    const clamp = (n) => Math.round(Math.max(0, Math.min(8, n)) * 100) / 100;
    const x = clamp(((event.clientX - box.left) / box.width) * 8);
    const y = clamp(((event.clientY - box.top) / box.height) * 8);
    return flipped() ? [8 - x, 8 - y] : [x, y];
  };

  function draw() {
    const view = ([x, y]) => (flipped() ? [8 - x, 8 - y] : [x, y]);
    const center = (square) => view(["abcdefgh".indexOf(square[0]) + 0.5, 8 - Number(square[1]) + 0.5]);
    const ns = "http://www.w3.org/2000/svg";
    const paint = (el, hex) => { el.setAttribute("fill", hex); el.setAttribute("stroke", hex); return el; };
    const nodes = [...shapes, ...(preview ? [preview] : []), ...(stroke ? [stroke] : [])].map((shape) => {
      const hex = COLORS[shape.color] ?? COLORS.green;
      if (shape.points) {
        const line = document.createElementNS(ns, "polyline");
        line.setAttribute("points", shape.points.map((p) => view(p).join(",")).join(" "));
        Object.entries({ fill: "none", stroke: hex, "stroke-width": 0.1, "stroke-linecap": "round", "stroke-linejoin": "round" }).forEach(([k, v]) => line.setAttribute(k, v));
        line.classList.add("shape");
        return line;
      }
      const [x1, y1] = center(shape.from);
      if (shape.from === shape.to) {
        const circle = paint(document.createElementNS(ns, "circle"), hex);
        Object.entries({ cx: x1, cy: y1, r: 0.45, fill: "none", "stroke-width": 0.07 }).forEach(([k, v]) => circle.setAttribute(k, v));
        circle.classList.add("shape");
        return circle;
      }
      const [x2, y2] = center(shape.to);
      const length = Math.hypot(x2 - x1, y2 - y1);
      const [ux, uy] = [(x2 - x1) / length, (y2 - y1) / length];
      const head = 0.45;
      const [bx, by] = [x2 - ux * head, y2 - uy * head];
      const g = paint(document.createElementNS(ns, "g"), hex);
      g.classList.add("shape");
      const line = document.createElementNS(ns, "line");
      Object.entries({ x1, y1, x2: bx, y2: by, "stroke-width": 0.17 }).forEach(([k, v]) => line.setAttribute(k, v));
      const tip = document.createElementNS(ns, "polygon");
      tip.setAttribute("points", `${x2},${y2} ${bx - uy * 0.24},${by + ux * 0.24} ${bx + uy * 0.24},${by - ux * 0.24}`);
      tip.setAttribute("stroke", "none");
      g.append(line, tip);
      return g;
    });
    svg.replaceChildren(...nodes);
  }

  board.addEventListener("contextmenu", (event) => event.preventDefault());
  board.addEventListener("pointerdown", (event) => {
    const current = event.button === 0 ? tool() : event.button === 2 ? "arrow" : null;
    if (current === "arrow") start = squareAt(event) ?? null;
    else if (current === "pen") {
      event.preventDefault();
      stroke = { points: [pointAt(event)], color: color() };
      draw();
    } else if (event.button === 0 && clearOnClick && shapes.length) {
      shapes = [];
      draw();
      onChange();
    }
  });
  document.addEventListener("pointermove", (event) => {
    if (stroke) {
      const point = pointAt(event);
      const last = stroke.points.at(-1);
      if (Math.hypot(point[0] - last[0], point[1] - last[1]) < 0.04 || stroke.points.length >= 1000) return;
      stroke.points.push(point);
      draw();
      return;
    }
    if (!start) return;
    const to = squareAt(event);
    preview = to && to !== start ? { from: start, to, color: color() } : null;
    draw();
  });
  document.addEventListener("pointerup", (event) => {
    if (stroke) {
      // A tap without movement leaves a dot.
      shapes.push(stroke.points.length > 1 ? stroke : { ...stroke, points: [stroke.points[0], stroke.points[0]] });
      stroke = null;
      draw();
      onChange();
      return;
    }
    if (!start) return;
    const to = squareAt(event);
    if (to) {
      const existing = shapes.findIndex((shape) => shape.from === start && shape.to === to);
      if (existing >= 0) shapes.splice(existing, 1);
      else shapes.push({ from: start, to, color: color() });
      onChange();
    }
    start = null;
    preview = null;
    draw();
  });
  return {
    clear() { shapes = []; start = null; preview = null; stroke = null; draw(); },
    redraw: draw,
    get: () => shapes,
    set(list) { shapes = [...list]; start = null; preview = null; stroke = null; draw(); },
    undo() { if (shapes.pop()) { draw(); onChange(); } },
  };
}

const exerciseDrawing = enableDrawing($("#exercise-board"), $("#exercise-arrows"));

// ---------- buddy ----------

const SLEEP_MS = 90_000;

/** The companions the user can pick. Each one has its own look (a <template>) and its own lines. */
const CHARACTERS = {
  pawn: {
    label: "Buddy, o peão mascote do ChessBuddy. Clique para conversar.",
    hello: "Oi! Eu sou o Buddy. Coloca seu usuário do Lichess ali em cima e bora revisar.",
    helloUser: (user) => `Oi, ${user}! Bora revisar umas partidas?`,
    arrive: "Voltei! O Buddy na área.",
    tickle: "Hihi, para! Cócegas não!",
    tips: [],
  },
  capy: {
    label: "Capi, a capivara mascote do ChessBuddy. Clique para conversar.",
    hello: "Oi! Eu sou a Capi, a capivara. Coloca seu usuário do Lichess ali em cima que a gente revisa na calma.",
    helloUser: (user) => `E aí, ${user}! Bora revisar umas partidas, sem pressa?`,
    arrive: "E aí! Agora quem te acompanha sou eu, a Capi. Sem estresse.",
    tickle: "Ai, cócegas não! Sou uma capivara séria.",
    tips: [
      "Errou feio? Respira. Capivara não se estressa nem com erro grave.",
      "Dica de capivara: pensa devagar e joga com calma.",
    ],
  },
};

const TIPS = [
  "Me pergunta \"e se Nd7?\" que eu confiro o lance no Stockfish.",
  "Nos exercícios, arraste com o botão direito para desenhar setas no tabuleiro.",
  "Os exercícios voltam em alguns dias. Acertou, eles demoram mais para voltar.",
  "Em \"Chances que o adversário deu\" ficam os erros dele que você podia punir.",
  "Enquanto você joga no Lichess eu só observo. Nada de dica durante a partida!",
  "Quer revisar uma partida de fora do Lichess? Cole o PGN na aba \"Colar PGN\".",
];

/**
 * The buddy's face. A passing mood (happy, sad, talking) wins over the
 * lasting ones: thinking while a request runs, watching during a live game,
 * sleeping after a while without activity.
 */
const buddyState = { character: "pawn", mood: null, busy: 0, watching: false, sleeping: false, lastActivity: Date.now(), moodTimer: null, bubbleTimer: null, pokes: [], tip: -1 };

function renderBuddy() {
  const b = buddyState;
  $("#buddy").dataset.mood = b.mood ?? (b.busy ? "thinking" : b.watching ? "watching" : b.sleeping ? "sleeping" : "idle");
}

/** Shows `mood` for a moment and, when given, says `text` in the bubble. */
function buddy(mood, text, ms = 4500) {
  clearTimeout(buddyState.moodTimer);
  buddyState.mood = mood;
  if (mood) buddyState.moodTimer = setTimeout(() => { buddyState.mood = null; renderBuddy(); }, Math.min(ms, 2500));
  renderBuddy();
  if (mood === "happy") buddyHop();
  if (!text) return;
  const bubble = $("#buddy-bubble");
  bubble.textContent = text;
  // Re-inserting restarts the pop-in animation.
  bubble.hidden = true;
  void bubble.offsetWidth;
  bubble.hidden = false;
  placeBubble();
  clearTimeout(buddyState.bubbleTimer);
  buddyState.bubbleTimer = setTimeout(() => { bubble.hidden = true; }, ms);
}

function buddyBusy(delta) {
  buddyState.busy += delta;
  renderBuddy();
}

function buddyWatching(watching) {
  buddyState.watching = watching;
  renderBuddy();
}

function buddyHop() {
  if (reducedMotion.matches) return;
  $("#buddy .hop").animate([
    { transform: "none" },
    { transform: "scale(1.08, 0.92)", offset: 0.15 },
    { transform: "translateY(-16px) scale(0.95, 1.05)", offset: 0.45 },
    { transform: "scale(1.05, 0.95)", offset: 0.8 },
    { transform: "none" },
  ], { duration: 600, easing: "ease-out" });
}

$("#buddy-body").addEventListener("click", () => {
  const now = Date.now();
  buddyState.pokes = [...buddyState.pokes.filter((t) => now - t < 1500), now];
  buddyHop();
  const character = CHARACTERS[buddyState.character];
  if (buddyState.pokes.length >= 3) return buddy("happy", character.tickle, 2500);
  if (buddyState.watching) return buddy(null, "Shh… só observando até a partida acabar.");
  if (buddyState.busy) return buddy(null, "Calma, tô pensando…", 2500);
  const tips = [...TIPS, ...character.tips];
  buddyState.tip = (buddyState.tip + 1 + Math.floor(Math.random() * (tips.length - 1))) % tips.length;
  buddy("talking", tips[buddyState.tip], 6000);
});

/** Puts companion `id` on screen; `announce` lets it introduce itself. */
function setCharacter(id, announce = false) {
  if (!CHARACTERS[id]) id = "pawn";
  buddyState.character = id;
  $("#buddy").dataset.character = id;
  $("#buddy-body").replaceChildren($(`#buddy-${id}`).content.cloneNode(true));
  $("#buddy-body").setAttribute("aria-label", CHARACTERS[id].label);
  renderBuddy();
  if (announce) buddy("happy", CHARACTERS[id].arrive);
}

setCharacter(load("buddy") ?? "pawn");
$("#buddy-swap").addEventListener("click", () => {
  const ids = Object.keys(CHARACTERS);
  const next = ids[(ids.indexOf(buddyState.character) + 1) % ids.length];
  save("buddy", next);
  setCharacter(next, true);
});
$("#buddy-bubble").addEventListener("click", () => { $("#buddy-bubble").hidden = true; });

// The buddy and its bubble stay off the page's controls.
const CONTROLS = "header :is(input, button), nav button, main :is(button, input, textarea, select), .banner button";
// How far the buddy sinks below the screen edge: ducked leaves its eyes out, hiding leaves nothing.
const SINK = { none: 0, ducked: 0.7, hiding: 1.25 };

function visibleRects(selector) {
  return [...document.querySelectorAll(selector)].filter((el) => el.offsetParent !== null).map((el) => el.getBoundingClientRect());
}

function overlapping(box, rects) {
  return rects.filter((r) => r.left < box.right && r.right > box.left && r.top < box.bottom && r.bottom > box.top);
}

/**
 * The visible part of the buddy's body when sunk by `sink` ("none", "ducked" or "hiding"),
 * computed rather than measured so a running transition doesn't skew it.
 */
function buddyBodyRect(sink = $("#buddy").dataset.sink ?? "none") {
  const body = $("#buddy-body");
  const right = document.documentElement.clientWidth - 16;
  const bottom = innerHeight - 12 + body.offsetHeight * SINK[sink];
  return { left: right - body.offsetWidth, right, top: bottom - body.offsetHeight, bottom: Math.min(bottom, innerHeight) };
}

/** When the buddy would stand on a control it ducks below the screen edge, or hides when even its head is in the way. */
function duckBuddy() {
  const controls = visibleRects(CONTROLS);
  $("#buddy").dataset.sink = ["none", "ducked"].find((sink) => overlapping(buddyBodyRect(sink), controls).length === 0) ?? "hiding";
}

/**
 * The bubble never sits on a control. It tries its usual place above the
 * buddy, then beside it at a few heights, then risen above whatever it
 * covers; when no place is free it may cover a list item, never a control.
 */
function placeBubble() {
  const bubble = $("#buddy-bubble");
  bubble.style.translate = "";
  bubble.classList.remove("lifted", "beside");
  if (bubble.hidden) return;
  // A hidden buddy doesn't talk: a bubble with nobody next to it would just be in the way.
  if ($("#buddy").dataset.sink === "hiding") {
    bubble.hidden = true;
    return;
  }
  const controls = visibleRects(CONTROLS);
  const everything = [...controls, ...visibleRects("main .list li")];
  // Measured from the buddy rather than the bubble, which may still be popping in. The bubble's
  // own place is above the buddy's layout box, which ducking doesn't move; "beside" follows the visible body.
  const layout = buddyBodyRect("none");
  const body = buddyBodyRect();
  const right = layout.right - 16;
  const bottom = layout.top - 6;
  const home = { left: right - bubble.offsetWidth, right, top: bottom - bubble.offsetHeight, bottom };
  const at = ([dx, dy]) => ({ left: home.left + dx, right: home.right + dx, top: home.top + dy, bottom: home.bottom + dy });
  const beside = (rise) => [body.left - 10 - home.right, body.bottom - 12 - home.bottom - rise];
  const lifted = (list) => {
    let dy = 0;
    for (let i = 0; i < 8; i++) {
      const covered = overlapping(at([0, dy]), list);
      if (covered.length === 0) return [0, dy];
      dy -= at([0, dy]).bottom - Math.min(...covered.map((r) => r.top)) + 8;
    }
    return null;
  };
  const candidates = [everything, controls].flatMap((list) => [
    { offset: [0, 0], list },
    ...[0, 40, 80, 120, 160].map((rise) => ({ offset: beside(rise), list, className: "beside" })),
    { offset: lifted(list), list, className: "lifted" },
  ]);
  for (const { offset, list, className } of candidates) {
    if (!offset) continue;
    const box = at(offset);
    if (box.left < 8 || box.top < 8 || box.bottom > innerHeight - 4 || overlapping(box, list).length > 0) continue;
    bubble.style.translate = `${offset[0]}px ${offset[1]}px`;
    if (className) bubble.classList.add(className);
    return;
  }
}

let placeFrame = 0;
function placeBuddy() {
  if (placeFrame) return;
  placeFrame = requestAnimationFrame(() => {
    placeFrame = 0;
    duckBuddy();
    placeBubble();
  });
}
addEventListener("scroll", placeBuddy, { passive: true });
addEventListener("resize", placeBuddy, { passive: true });
// Content appearing or moving (a new tab, a chat message) can put a control under the buddy.
new ResizeObserver(placeBuddy).observe($("main"));

// The eyes follow the pointer.
let lookFrame = 0;
document.addEventListener("pointermove", (event) => {
  if (lookFrame) return;
  lookFrame = requestAnimationFrame(() => {
    lookFrame = 0;
    const svg = $("#buddy-body svg");
    const box = svg.getBoundingClientRect();
    // Each companion says where its eyes are and how far its pupils may travel.
    const [eyeX, eyeY] = svg.dataset.eyes.split(" ").map(Number);
    const dx = event.clientX - (box.left + box.width * eyeX);
    const dy = event.clientY - (box.top + box.height * eyeY);
    const distance = Math.hypot(dx, dy) || 1;
    const reach = Math.min(Number(svg.dataset.reach), distance / 40);
    $("#buddy .pupils").setAttribute("transform", `translate(${(dx / distance) * reach} ${(dy / distance) * reach})`);
  });
});

for (const type of ["pointermove", "pointerdown", "keydown"]) {
  document.addEventListener(type, () => {
    buddyState.lastActivity = Date.now();
    if (!buddyState.sleeping) return;
    buddyState.sleeping = false;
    buddy(null, "Opa! Tirei um cochilo.", 2500);
  }, { passive: true });
}
setInterval(() => {
  if (buddyState.sleeping || Date.now() - buddyState.lastActivity < SLEEP_MS) return;
  buddyState.sleeping = true;
  renderBuddy();
}, 5000);

// ---------- navigation ----------

function showTab(name) {
  for (const button of document.querySelectorAll("nav button")) button.classList.toggle("active", button.dataset.tab === name);
  for (const id of ["tab-games", "tab-pgn", "tab-exercises", "review", "follow"]) $("#" + id).hidden = id !== name && id !== `tab-${name}`;
  if (name === "exercises") loadExercises();
}

for (const button of document.querySelectorAll("nav button")) button.addEventListener("click", () => showTab(button.dataset.tab));

// ---------- live game guardrail ----------

function showLive(message, gameId) {
  const banner = $("#live-banner");
  banner.hidden = false;
  buddyWatching(true);
  banner.textContent = message ?? "Você está jogando agora. O treinador volta quando a partida terminar.";
  if (gameId && state.follow?.gameId !== gameId) {
    const button = document.createElement("button");
    button.textContent = "Acompanhar partida";
    button.addEventListener("click", () => startFollow(gameId));
    banner.append(button);
  }
}

async function checkStatus() {
  if (!state.username) return;
  try {
    const status = await api(`/api/status?user=${encodeURIComponent(state.username)}`);
    if (status.playing) showLive("Você está jogando agora. Eu só acompanho até a partida acabar.", status.gameId);
    else if (!state.follow) {
      $("#live-banner").hidden = true;
      buddyWatching(false);
    }
  } catch { /* status is best effort in the UI; the server enforces it */ }
}

function startFollow(gameId) {
  state.follow?.source.close();
  const source = new EventSource(`/api/follow/${encodeURIComponent(gameId)}?user=${encodeURIComponent(state.username)}`);
  state.follow = { gameId, source };
  showTab("follow");
  $("#follow-review").hidden = true;
  $("#follow-status").textContent = "Conectando à partida…";
  source.addEventListener("position", (event) => {
    const position = JSON.parse(event.data);
    renderBoard($("#follow-board"), position.fen, { marks: squaresOf(position.lastMove) });
    $("#follow-status").textContent = "Partida em andamento. Só observando.";
  });
  source.addEventListener("finished", (event) => {
    const { result } = JSON.parse(event.data);
    source.close();
    state.follow = null;
    $("#live-banner").hidden = true;
    buddyWatching(false);
    buddy("happy", "Acabou! Agora a gente pode revisar juntos.");
    $("#follow-status").textContent = `Partida encerrada (${result}). A revisão está liberada.`;
    const button = $("#follow-review");
    button.hidden = false;
    button.onclick = () => analyze({ gameId, username: state.username });
  });
  source.addEventListener("error", (event) => {
    if (event.data) $("#follow-status").textContent = JSON.parse(event.data).message;
  });
}

// ---------- games ----------

$("#username").value = state.username;
$("#user-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  state.username = $("#username").value.trim();
  save("username", state.username);
  showTab("games");
  checkStatus();
  const list = $("#games");
  list.innerHTML = "<li>Buscando partidas…</li>";
  try {
    const games = await api(`/api/games?user=${encodeURIComponent(state.username)}`);
    list.replaceChildren(...games.map(gameItem));
    if (games.length === 0) {
      list.innerHTML = "<li>Nenhuma partida terminada encontrada.</li>";
      buddy("sad", "Não achei nenhuma partida terminada.");
    } else {
      buddy("happy", `Achei ${games.length} partida${games.length > 1 ? "s" : ""}. Escolhe uma pra gente revisar!`);
    }
  } catch (error) {
    list.innerHTML = `<li class="bad">${escapeHtml(error.message)}</li>`;
    if (!(error instanceof LiveGameError)) buddy("sad");
  }
});

function gameItem(game) {
  const li = document.createElement("li");
  const when = game.playedAt ? new Date(game.playedAt).toLocaleString("pt-BR") : "";
  li.innerHTML = `<strong>${escapeHtml(game.white)} x ${escapeHtml(game.black)}</strong> · ${game.result}
    <small>${escapeHtml(game.opening ?? "")} · ${game.speed ?? ""} · ${when}${game.analysisId ? " · já revisada" : ""}</small>`;
  li.addEventListener("click", () => analyze({ gameId: game.id, username: state.username }));
  return li;
}

$("#pgn-form").addEventListener("submit", (event) => {
  event.preventDefault();
  analyze({ pgn: $("#pgn").value, playerColor: $("#pgn-color").value || undefined, username: state.username || undefined });
});

async function analyze(body) {
  showTab("review");
  $("#review-title").textContent = "Analisando com o Stockfish…";
  $("#moments").replaceChildren();
  $("#opportunities-box").hidden = true;
  $("#messages").replaceChildren();
  buddyBusy(1);
  buddy(null, "Deixa eu passar a partida no Stockfish…");
  try {
    openReview(await api("/api/analyze", body));
  } catch (error) {
    $("#review-title").textContent = error instanceof LiveGameError ? "Revisão pausada" : error.message;
    if (!(error instanceof LiveGameError)) buddy("sad", "Ih, não consegui analisar essa.");
  } finally {
    buddyBusy(-1);
  }
}

// ---------- review ----------

function moveLabel(ply) {
  return `${ply.moveNumber}${ply.color === "w" ? "." : "…"} ${ply.san}`;
}

function openReview(analysis) {
  state.analysis = analysis;
  state.plyIndex = null;
  state.pos = null;
  state.notes = {};
  renderNotes();
  loadNotes(analysis.id);
  const { game } = analysis;
  $("#review-title").textContent = `${game.white} x ${game.black} · ${game.result}`;
  const list = $("#moments");
  list.replaceChildren(...analysis.moments.map((index) => {
    const ply = analysis.plies[index];
    return momentItem(index, "error", `<strong>${escapeHtml(moveLabel(ply))}</strong>
      <span class="tag ${ply.classification}">${LABELS[ply.classification]}</span>
      <small class="engine">Melhor: ${escapeHtml(ply.bestMoveSan ?? "?")}</small>`);
  }));
  // The opponent's errors, each with whether the user's reply punished it.
  const opportunities = analysis.opportunities ?? [];
  $("#opportunities-box").hidden = opportunities.length === 0;
  $("#opportunities").replaceChildren(...opportunities.map((index) => {
    const ply = analysis.plies[index];
    const reply = analysis.plies[index + 1];
    const took = reply.classification === "best" || reply.classification === "good";
    return momentItem(index, "opportunity", `<strong>${escapeHtml(moveLabel(ply))}</strong>
      <span class="tag ${ply.classification}">${LABELS[ply.classification]}</span>
      <small>Você respondeu ${escapeHtml(moveLabel(reply))}: ${took
        ? '<span class="ok">aproveitou</span>'
        : `<span class="bad">deixou passar</span><span class="engine"> · Melhor: ${escapeHtml(reply.bestMoveSan ?? "?")}</span>`}</small>`);
  }));
  if (analysis.moments.length === 0) {
    list.innerHTML = "<li>Nenhum erro relevante seu nesta partida. Boa!</li>";
    buddy("happy", "Nenhum erro relevante seu nessa partida. Mandou bem!");
  } else {
    const n = analysis.moments.length;
    buddy(null, `Separei ${n} momento${n > 1 ? "s" : ""} pra gente olhar juntos.`);
  }
  if (analysis.moments.length > 0) selectMoment(analysis.moments[0], "error");
  else if (opportunities.length > 0) selectMoment(opportunities[0], "opportunity");
  else showPosition(analysis.plies.length);
}

function momentItem(index, kind, html) {
  const li = document.createElement("li");
  li.dataset.index = index;
  li.dataset.kind = kind;
  li.innerHTML = html;
  li.addEventListener("click", () => selectMoment(index, kind));
  return li;
}

/**
 * Shows position `pos` (the board after `pos` plies) from the user's side,
 * with its evaluation and the user's drawings and notes for it. By default
 * the last move is marked, and a step forward slides the piece. `view` names
 * the moment view ("before"/"after") the position belongs to, if any.
 */
function showPosition(pos, { marks, animate, caption, view = null } = {}) {
  const plies = state.analysis.plies;
  pos = Math.max(0, Math.min(plies.length, pos));
  const last = plies[pos - 1];
  const orientation = state.analysis.game.playerColor ?? "w";
  if (animate === undefined) animate = last && pos === state.pos + 1 ? slidesOf(last.fenBefore, last.uci) : [];
  state.pos = pos;
  state.view = view;
  renderBoard($("#review-board"), pos === 0 ? plies[0].fenBefore : last.fenAfter, { orientation, coords: true, marks: marks ?? squaresOf(last?.uci), animate });
  setEval($("#review-eval"), pos === 0 ? plies[0].evalBefore : last.evalAfter, orientation);
  $("#review-caption").textContent = caption ?? (last ? `Depois de ${moveLabel(last)}.` : "Posição inicial.");
  for (const button of document.querySelectorAll("#review-nav [data-nav]")) {
    button.disabled = ["start", "prev"].includes(button.dataset.nav) ? pos === 0 : pos === plies.length;
  }
  const note = state.notes[pos];
  reviewDrawing.set(note?.shapes ?? []);
  $("#lousa-text").value = note?.text ?? "";
  renderNotes();
}

function showPly(which) {
  const plies = state.analysis.plies;
  const hide = state.hideEngine;
  if (state.kind === "opportunity") {
    // Shown from the user's side: the position the opponent's error left, and the user's reply.
    const error = plies[state.plyIndex];
    const reply = plies[state.plyIndex + 1];
    if (which === "before") {
      showPosition(state.plyIndex + 1, {
        view: which,
        animate: [],
        caption: `O adversário jogou ${moveLabel(error)}. Como punir?${hide ? "" : ` O Stockfish jogaria ${reply.bestMoveSan ?? "?"}.`}`,
      });
    } else {
      showPosition(state.plyIndex + 2, { view: which, animate: slidesOf(reply.fenBefore, reply.uci), caption: `Você respondeu ${moveLabel(reply)}.` });
    }
    return;
  }
  const ply = plies[state.plyIndex];
  if (which === "before") {
    showPosition(state.plyIndex, {
      view: which,
      animate: [],
      marks: hide ? undefined : squaresOf(ply.bestMoveUci),
      caption: hide
        ? `Posição antes de ${moveLabel(ply)}. O que você jogaria aqui?`
        : `Posição antes de ${ply.san}. Em destaque, o lance do Stockfish: ${ply.bestMoveSan ?? "?"}.`,
    });
  } else {
    showPosition(state.plyIndex + 1, {
      view: which,
      animate: slidesOf(ply.fenBefore, ply.uci),
      caption: hide
        ? `Depois de ${moveLabel(ply)}.`
        : `Depois de ${ply.san}. Resposta mais forte: ${ply.refutationSan.slice(0, 3).join(" ") || "—"}.`,
    });
  }
}

$("#show-before").addEventListener("click", () => showPly("before"));
$("#show-after").addEventListener("click", () => showPly("after"));

function stepReview(nav) {
  if (!state.analysis || state.pos === null) return;
  const target = { start: 0, prev: state.pos - 1, next: state.pos + 1, end: state.analysis.plies.length }[nav];
  if (target >= 0 && target <= state.analysis.plies.length && target !== state.pos) showPosition(target);
}

for (const button of document.querySelectorAll("#review-nav [data-nav]")) {
  button.addEventListener("click", () => stepReview(button.dataset.nav));
}
document.addEventListener("keydown", (event) => {
  if ($("#review").hidden || event.target.closest("input, textarea, select")) return;
  const nav = { ArrowLeft: "prev", ArrowRight: "next", Home: "start", End: "end" }[event.key];
  if (!nav) return;
  event.preventDefault();
  stepReview(nav);
});

// ---------- lousa ----------

const reviewDrawing = enableDrawing($("#review-board"), $("#review-arrows"), {
  tool: () => state.tool,
  color: () => state.color,
  onChange: () => editNote({ shapes: [...reviewDrawing.get()] }),
  clearOnClick: false,
});

async function loadNotes(id) {
  try {
    const notes = await api(`/api/analysis/${encodeURIComponent(id)}/notes`);
    if (state.analysis?.id !== id) return;
    // Anything written while the notes were loading wins over the saved version.
    const edited = state.notes[state.pos];
    state.notes = { ...notes, ...state.notes };
    if (state.pos !== null && !edited) {
      const note = state.notes[state.pos];
      reviewDrawing.set(note?.shapes ?? []);
      $("#lousa-text").value = note?.text ?? "";
    }
    renderNotes();
  } catch (error) {
    $("#lousa-status").textContent = `Não consegui carregar suas anotações: ${error.message}`;
  }
}

/** Updates the note of the position on the board and saves it shortly after. */
function editNote(change) {
  const pos = state.pos;
  if (pos === null) return;
  const note = { text: state.notes[pos]?.text ?? "", shapes: state.notes[pos]?.shapes ?? [], ...change };
  if (!note.text.trim() && note.shapes.length === 0) delete state.notes[pos];
  else state.notes[pos] = note;
  scheduleSave(state.analysis.id, state.notes, pos);
  renderNotes();
}

const SAVE_MS = 700;
const pendingSaves = new Map();

/** Saves `notes[pos]` after a pause in the editing; an empty note deletes it on the server. */
function scheduleSave(id, notes, pos) {
  const key = `${id}:${pos}`;
  clearTimeout(pendingSaves.get(key)?.timer);
  const run = (keepalive = false) => {
    pendingSaves.delete(key);
    const { text = "", shapes = [] } = notes[pos] ?? {};
    return fetch(`/api/analysis/${encodeURIComponent(id)}/notes/${pos}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, shapes }),
      keepalive,
    });
  };
  const timer = setTimeout(async () => {
    try {
      const response = await run();
      if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error ?? `Erro ${response.status}`);
      if (pendingSaves.size === 0) $("#lousa-status").textContent = "Salvo";
    } catch (error) {
      $("#lousa-status").textContent = `Não salvou: ${error.message}`;
    }
  }, SAVE_MS);
  pendingSaves.set(key, { run, timer });
  $("#lousa-status").textContent = "Salvando…";
}

// Closing the page right after an edit still saves it.
addEventListener("pagehide", () => {
  for (const { run, timer } of [...pendingSaves.values()]) {
    clearTimeout(timer);
    run(true);
  }
});

/** The positions the user annotated, in game order, each one a link back to it. */
function renderNotes() {
  const plies = state.analysis?.plies ?? [];
  const positions = Object.keys(state.notes).map(Number).sort((a, b) => a - b);
  $("#notes-box").hidden = positions.length === 0;
  $("#notes").replaceChildren(...positions.map((pos) => {
    const { text, shapes } = state.notes[pos];
    const li = document.createElement("li");
    li.classList.toggle("selected", pos === state.pos);
    const title = document.createElement("strong");
    title.textContent = pos === 0 ? "Posição inicial" : `Depois de ${moveLabel(plies[pos - 1])}`;
    const summary = document.createElement("small");
    summary.textContent = text.trim().split("\n")[0] || `${shapes.length} desenho${shapes.length > 1 ? "s" : ""}`;
    li.append(title, summary);
    li.addEventListener("click", () => showPosition(pos));
    return li;
  }));
}

$("#lousa-text").addEventListener("input", (event) => editNote({ text: event.target.value }));

for (const button of document.querySelectorAll("#lousa [data-tool]")) {
  button.addEventListener("click", () => {
    state.tool = state.tool === button.dataset.tool ? null : button.dataset.tool;
    for (const other of document.querySelectorAll("#lousa [data-tool]")) other.setAttribute("aria-pressed", String(other.dataset.tool === state.tool));
    $("#review-board").classList.toggle("drawing", state.tool !== null);
  });
}
for (const button of document.querySelectorAll("#lousa [data-color]")) {
  button.addEventListener("click", () => {
    state.color = button.dataset.color;
    for (const other of document.querySelectorAll("#lousa [data-color]")) other.setAttribute("aria-pressed", String(other === button));
  });
}
$("#lousa-undo").addEventListener("click", () => reviewDrawing.undo());
$("#lousa-clear").addEventListener("click", () => {
  if (reviewDrawing.get().length === 0) return;
  reviewDrawing.set([]);
  editNote({ shapes: [] });
});

function applyHideEngine() {
  $("#hide-engine").checked = state.hideEngine;
  $("#review").classList.toggle("no-engine", state.hideEngine);
}
applyHideEngine();
$("#hide-engine").addEventListener("change", (event) => {
  state.hideEngine = event.target.checked;
  save("hideEngine", state.hideEngine ? "1" : "0");
  applyHideEngine();
  if (state.analysis && state.pos !== null) {
    if (state.view) showPly(state.view);
    else showPosition(state.pos, { animate: [] });
  }
  buddy(null, state.hideEngine
    ? "Beleza, Stockfish escondido. Agora é você e suas ideias!"
    : "Stockfish de volta. Compara com o que você anotou!");
});

function selectMoment(index, kind) {
  state.plyIndex = index;
  state.kind = kind;
  state.chat = [];
  for (const li of document.querySelectorAll("#moments li, #opportunities li")) {
    li.classList.toggle("selected", Number(li.dataset.index) === index && li.dataset.kind === kind);
  }
  $("#show-before").textContent = kind === "opportunity" ? "Depois do erro dele" : "Antes do lance";
  $("#show-after").textContent = kind === "opportunity" ? "Sua resposta" : "Depois do lance";
  showPly("before");
  $("#messages").replaceChildren();
  // Without the engine the coach only comes when asked.
  $("#ask-coach").hidden = !state.hideEngine;
  if (!state.hideEngine) askCoach();
}

$("#ask-coach").addEventListener("click", () => {
  $("#ask-coach").hidden = true;
  askCoach();
});

async function askCoach() {
  const pending = addMessage("assistant", "Pensando…");
  $("#chat-form button").disabled = true;
  buddyBusy(1);
  try {
    const { reply } = await api("/api/coach", {
      analysisId: state.analysis.id,
      plyIndex: state.plyIndex,
      kind: state.kind,
      messages: state.chat,
      username: state.username || undefined,
    });
    pending.textContent = reply;
    state.chat.push({ role: "assistant", content: reply });
    buddy("talking", undefined, 1600);
  } catch (error) {
    pending.textContent = error.message;
    pending.classList.add("error");
    if (!(error instanceof LiveGameError)) buddy("sad");
    if (state.chat.length === 0) $("#ask-coach").hidden = false;
    // Drop the unanswered question so the conversation stays well formed.
    if (state.chat.at(-1)?.role === "user") state.chat.pop();
  } finally {
    $("#chat-form button").disabled = false;
    buddyBusy(-1);
  }
}

$("#chat-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const text = $("#chat-input").value.trim();
  if (!text || state.plyIndex === null || state.chat.length === 0) return;
  $("#chat-input").value = "";
  addMessage("user", text);
  state.chat.push({ role: "user", content: text });
  askCoach();
});

function addMessage(role, text) {
  const div = document.createElement("div");
  div.className = `msg ${role}`;
  div.textContent = text;
  $("#messages").append(div);
  div.scrollIntoView({ block: "nearest" });
  return div;
}

// ---------- exercises ----------

async function loadExercises() {
  const list = $("#exercises");
  try {
    const exercises = await api("/api/exercises");
    list.replaceChildren(...exercises.map((exercise, i) => {
      const li = document.createElement("li");
      li.innerHTML = `<strong>Exercício ${i + 1}</strong><small>Jogam as ${exercise.sideToMove === "w" ? "brancas" : "pretas"}. Na partida saiu ${escapeHtml(exercise.playedSan)}.</small>`;
      li.addEventListener("click", () => selectExercise(exercise, li));
      return li;
    }));
    if (exercises.length === 0) list.innerHTML = "<li>Nada para revisar agora. Revise uma partida para gerar exercícios.</li>";
    else list.firstElementChild.click();
  } catch (error) {
    list.innerHTML = `<li class="bad">${escapeHtml(error.message)}</li>`;
  }
}

function selectExercise(exercise, li) {
  state.exercise = exercise;
  state.picked = null;
  state.answered = false;
  state.replay = null;
  state.replayToken = null;
  for (const item of $("#exercises").children) item.classList.toggle("selected", item === li);
  $("#exercise-status").textContent = `Ache um lance melhor que ${exercise.playedSan}.`;
  $("#exercise-replay").hidden = true;
  exerciseDrawing.clear();
  drawExercise();
}

function drawExercise(marks = []) {
  const exercise = state.exercise;
  renderBoard($("#exercise-board"), exercise.fen, {
    orientation: exercise.sideToMove,
    marks,
    picked: state.picked,
    onSquare: state.answered ? null : onExerciseSquare,
    coords: true,
  });
  setEval($("#exercise-eval"), exercise.eval, exercise.sideToMove);
}

async function onExerciseSquare(square, piece) {
  const exercise = state.exercise;
  if (!exercise) return;
  const own = piece && (piece === piece.toUpperCase() ? "w" : "b") === exercise.sideToMove;
  if (!state.picked || own) {
    state.picked = own ? square : null;
    return drawExercise();
  }
  const from = state.picked;
  state.picked = null;
  // Pawn reaching the last rank: promote to a queen.
  const promotion = /^[18]$/.test(square[1]) && piecesOf(exercise.fen)[from]?.toLowerCase() === "p" ? "q" : "";
  let result;
  try {
    result = await api(`/api/exercises/${exercise.id}/answer`, { uci: from + square + promotion, username: state.username || undefined });
  } catch (error) {
    $("#exercise-status").innerHTML = `<span class="bad">${escapeHtml(error.message)}</span>`;
    return drawExercise();
  }
  if (state.exercise !== exercise) return;
  state.answered = true;
  const next = new Date(result.nextReview).toLocaleDateString("pt-BR");
  $("#exercise-status").innerHTML = result.correct
    ? `<span class="ok">Isso!</span> Volta em ${next}.`
    : `<span class="bad">Não era esse.</span> O melhor era ${escapeHtml(result.solutionSan ?? "?")}. Volta em ${next}.`;
  if (result.correct) buddy("happy", "Isso! Achou o lance.");
  else buddy("sad", "Quase! Olha a solução no tabuleiro.");
  showAnswer(exercise, result);
}

// ---------- exercise replay ----------

const STEP_MS = 900;
const PAUSE_MS = 1400;

/**
 * Plays the user's move on the board, then the Stockfish line. When the user
 * found the line's first move the line just carries on from there; otherwise
 * the board goes back to the puzzle and the solution plays from the start.
 */
function showAnswer(exercise, result) {
  const start = { fen: exercise.fen, eval: exercise.eval };
  const solution = [start, ...result.line];
  if (result.line[0]?.uci === result.played.uci) {
    setReplay(solution, "Linha do Stockfish");
    stepTo(1);
    autoplay(STEP_MS);
    return;
  }
  setReplay([start, result.played], "Seu lance");
  stepTo(1);
  const token = (state.replayToken = {});
  setTimeout(() => {
    if (state.exercise !== exercise) return;
    // The solution always replaces the user's move; it only plays by itself if the user didn't take the controls.
    const untouched = state.replayToken === token;
    setReplay(solution, result.correct ? "Linha do Stockfish" : "Solução");
    stepTo(0);
    if (untouched) autoplay(STEP_MS);
  }, PAUSE_MS);
}

function setReplay(frames, label) {
  state.replay = { frames, label, index: 0 };
  $("#exercise-replay").hidden = false;
}

function stepTo(index) {
  const replay = state.replay;
  index = Math.max(0, Math.min(index, replay.frames.length - 1));
  const prev = replay.index;
  let slides = [];
  if (index === prev + 1) slides = slidesOf(replay.frames[prev].fen, replay.frames[index].uci);
  if (index === prev - 1) slides = slidesOf(replay.frames[index].fen, replay.frames[prev].uci).map(({ from, to }) => ({ from: to, to: from }));
  // Drawings belong to the position they were drawn on.
  if (index !== prev) exerciseDrawing.clear();
  replay.index = index;
  const frame = replay.frames[index];
  renderBoard($("#exercise-board"), frame.fen, {
    orientation: state.exercise.sideToMove,
    marks: squaresOf(frame.uci),
    animate: slides,
    coords: true,
  });
  setEval($("#exercise-eval"), frame.eval, state.exercise.sideToMove);
  renderLine();
}

function autoplay(delay) {
  const token = (state.replayToken = {});
  const tick = () => {
    const replay = state.replay;
    if (state.replayToken !== token || !replay || replay.index >= replay.frames.length - 1) return;
    stepTo(replay.index + 1);
    setTimeout(tick, STEP_MS);
  };
  setTimeout(tick, delay);
}

/** The line as numbered, clickable moves, with the one on the board highlighted. */
function renderLine() {
  const { frames, label, index } = state.replay;
  const [, turn, , , , fullmove] = frames[0].fen.split(" ");
  let number = Number(fullmove) || 1;
  let white = turn === "w";
  const parts = [Object.assign(document.createElement("span"), { className: "label", textContent: `${label}:` })];
  frames.slice(1).forEach((frame, i) => {
    if (white) parts.push(`${number}. `);
    else if (i === 0) parts.push(`${number}… `);
    const button = document.createElement("button");
    button.textContent = frame.san;
    button.classList.toggle("current", i + 1 === index);
    button.addEventListener("click", () => { state.replayToken = null; stepTo(i + 1); });
    parts.push(button, " ");
    if (!white) number++;
    white = !white;
  });
  $("#exercise-line").replaceChildren(...parts);
  const controls = $("#exercise-replay");
  controls.querySelector('[data-step="start"]').disabled = index === 0;
  controls.querySelector('[data-step="prev"]').disabled = index === 0;
  controls.querySelector('[data-step="next"]').disabled = index === frames.length - 1;
}

for (const button of document.querySelectorAll("#exercise-replay [data-step]")) {
  button.addEventListener("click", () => {
    if (!state.replay) return;
    state.replayToken = null;
    const { index } = state.replay;
    if (button.dataset.step === "start") stepTo(0);
    if (button.dataset.step === "prev") stepTo(index - 1);
    if (button.dataset.step === "next") stepTo(index + 1);
    if (button.dataset.step === "play") {
      stepTo(0);
      autoplay(index === 0 ? 0 : 500);
    }
  });
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
}

checkStatus();
setInterval(checkStatus, 30_000);
setTimeout(() => {
  if (buddyState.watching) return;
  const character = CHARACTERS[buddyState.character];
  buddy("happy", state.username ? character.helloUser(state.username) : character.hello, 6000);
}, 600);
