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
};

function load(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function save(key, value) {
  try { localStorage.setItem(key, value); } catch { /* storage unavailable */ }
}

class LiveGameError extends Error {}

async function api(path, body) {
  const response = await fetch(path, body === undefined ? {} : {
    method: "POST",
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

// ---------- arrows ----------

/**
 * Lichess-style drawing on a board: right-drag draws an arrow, right-click
 * circles a square, drawing the same shape again removes it and a left click
 * clears everything. Shapes are kept by square, so they survive re-renders.
 */
function enableDrawing(board, svg) {
  const shapes = [];
  let start = null;
  let preview = null;
  const squareAt = (event) => {
    const square = document.elementFromPoint(event.clientX, event.clientY)?.closest(".square");
    return square && board.contains(square) ? square.dataset.square : undefined;
  };

  function draw() {
    const orientation = board.dataset.orientation ?? "w";
    const center = (square) => {
      const file = "abcdefgh".indexOf(square[0]);
      const rank = Number(square[1]);
      return orientation === "w" ? [file + 0.5, 8 - rank + 0.5] : [7 - file + 0.5, rank - 1 + 0.5];
    };
    const ns = "http://www.w3.org/2000/svg";
    const nodes = [...shapes, ...(preview ? [preview] : [])].map(({ from, to }) => {
      const [x1, y1] = center(from);
      if (from === to) {
        const circle = document.createElementNS(ns, "circle");
        Object.entries({ cx: x1, cy: y1, r: 0.45, fill: "none", "stroke-width": 0.07 }).forEach(([k, v]) => circle.setAttribute(k, v));
        circle.classList.add("shape");
        return circle;
      }
      const [x2, y2] = center(to);
      const length = Math.hypot(x2 - x1, y2 - y1);
      const [ux, uy] = [(x2 - x1) / length, (y2 - y1) / length];
      const head = 0.45;
      const [bx, by] = [x2 - ux * head, y2 - uy * head];
      const g = document.createElementNS(ns, "g");
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
    if (event.button === 2) start = squareAt(event) ?? null;
    else if (event.button === 0 && shapes.length) { shapes.length = 0; draw(); }
  });
  document.addEventListener("pointermove", (event) => {
    if (!start) return;
    const to = squareAt(event);
    preview = to && to !== start ? { from: start, to } : null;
    draw();
  });
  document.addEventListener("pointerup", (event) => {
    if (event.button !== 2 || !start) return;
    const to = squareAt(event);
    if (to) {
      const existing = shapes.findIndex((shape) => shape.from === start && shape.to === to);
      if (existing >= 0) shapes.splice(existing, 1);
      else shapes.push({ from: start, to });
    }
    start = null;
    preview = null;
    draw();
  });
  return {
    clear() { shapes.length = 0; start = null; preview = null; draw(); },
    redraw: draw,
  };
}

const exerciseDrawing = enableDrawing($("#exercise-board"), $("#exercise-arrows"));

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
    else if (!state.follow) $("#live-banner").hidden = true;
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
    if (games.length === 0) list.innerHTML = "<li>Nenhuma partida terminada encontrada.</li>";
  } catch (error) {
    list.innerHTML = `<li class="bad">${escapeHtml(error.message)}</li>`;
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
  try {
    openReview(await api("/api/analyze", body));
  } catch (error) {
    $("#review-title").textContent = error instanceof LiveGameError ? "Revisão pausada" : error.message;
  }
}

// ---------- review ----------

function moveLabel(ply) {
  return `${ply.moveNumber}${ply.color === "w" ? "." : "…"} ${ply.san}`;
}

function openReview(analysis) {
  state.analysis = analysis;
  const { game } = analysis;
  $("#review-title").textContent = `${game.white} x ${game.black} · ${game.result}`;
  const list = $("#moments");
  list.replaceChildren(...analysis.moments.map((index) => {
    const ply = analysis.plies[index];
    return momentItem(index, "error", `<strong>${escapeHtml(moveLabel(ply))}</strong>
      <span class="tag ${ply.classification}">${LABELS[ply.classification]}</span>
      <small>Melhor: ${escapeHtml(ply.bestMoveSan ?? "?")}</small>`);
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
        : `<span class="bad">deixou passar</span> · Melhor: ${escapeHtml(reply.bestMoveSan ?? "?")}`}</small>`);
  }));
  if (analysis.moments.length === 0) list.innerHTML = "<li>Nenhum erro relevante seu nesta partida. Boa!</li>";
  if (analysis.moments.length > 0) selectMoment(analysis.moments[0], "error");
  else if (opportunities.length > 0) selectMoment(opportunities[0], "opportunity");
  else reviewBoard(analysis.plies.at(-1).fenAfter, analysis.plies.at(-1).evalAfter);
}

/** Draws the review board from the user's side, with coordinates, and sets the bar to `cp`. */
function reviewBoard(fen, cp, options = {}) {
  const orientation = state.analysis.game.playerColor ?? "w";
  renderBoard($("#review-board"), fen, { orientation, coords: true, ...options });
  setEval($("#review-eval"), cp, orientation);
}

function momentItem(index, kind, html) {
  const li = document.createElement("li");
  li.dataset.index = index;
  li.dataset.kind = kind;
  li.innerHTML = html;
  li.addEventListener("click", () => selectMoment(index, kind));
  return li;
}

function showPly(which) {
  if (state.kind === "opportunity") {
    // Shown from the user's side: the position the opponent's error left, and the user's reply.
    const error = state.analysis.plies[state.plyIndex];
    const reply = state.analysis.plies[state.plyIndex + 1];
    if (which === "before") {
      reviewBoard(reply.fenBefore, reply.evalBefore, { marks: squaresOf(error.uci) });
      $("#review-caption").textContent = `O adversário jogou ${moveLabel(error)}. Como punir? O Stockfish jogaria ${reply.bestMoveSan ?? "?"}.`;
    } else {
      reviewBoard(reply.fenAfter, reply.evalAfter, { marks: squaresOf(reply.uci), animate: slidesOf(reply.fenBefore, reply.uci) });
      $("#review-caption").textContent = `Você respondeu ${moveLabel(reply)}.`;
    }
    return;
  }
  const ply = state.analysis.plies[state.plyIndex];
  if (which === "before") {
    reviewBoard(ply.fenBefore, ply.evalBefore, { marks: squaresOf(ply.bestMoveUci) });
    $("#review-caption").textContent = `Posição antes de ${ply.san}. Em destaque, o lance do Stockfish: ${ply.bestMoveSan ?? "?"}.`;
  } else {
    reviewBoard(ply.fenAfter, ply.evalAfter, { marks: squaresOf(ply.uci), animate: slidesOf(ply.fenBefore, ply.uci) });
    $("#review-caption").textContent = `Depois de ${ply.san}. Resposta mais forte: ${ply.refutationSan.slice(0, 3).join(" ") || "—"}.`;
  }
}

$("#show-before").addEventListener("click", () => showPly("before"));
$("#show-after").addEventListener("click", () => showPly("after"));

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
  askCoach();
}

async function askCoach() {
  const pending = addMessage("assistant", "Pensando…");
  $("#chat-form button").disabled = true;
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
  } catch (error) {
    pending.textContent = error.message;
    pending.classList.add("error");
    // Drop the unanswered question so the conversation stays well formed.
    if (state.chat.at(-1)?.role === "user") state.chat.pop();
  } finally {
    $("#chat-form button").disabled = false;
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
