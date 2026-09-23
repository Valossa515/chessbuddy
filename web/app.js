const $ = (selector) => document.querySelector(selector);

const LABELS = { best: "melhor lance", good: "bom lance", inaccuracy: "imprecisão", mistake: "erro", blunder: "erro grave" };
const GLYPHS = { k: "♚", q: "♛", r: "♜", b: "♝", n: "♞", p: "♟" };

const state = {
  username: load("username") ?? "",
  analysis: null,
  plyIndex: null,
  chat: [],
  exercise: null,
  picked: null,
  answered: false,
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

function renderBoard(el, fen, { orientation = "w", marks = [], picked = null, onSquare = null } = {}) {
  const rows = fen.split(" ")[0].split("/");
  const pieces = {};
  rows.forEach((row, r) => {
    let file = 0;
    for (const ch of row) {
      if (/\d/.test(ch)) { file += Number(ch); continue; }
      pieces["abcdefgh"[file] + (8 - r)] = ch;
      file++;
    }
  });
  const files = orientation === "w" ? "abcdefgh" : "hgfedcba";
  const ranks = orientation === "w" ? [8, 7, 6, 5, 4, 3, 2, 1] : [1, 2, 3, 4, 5, 6, 7, 8];
  el.replaceChildren();
  for (const rank of ranks) {
    for (const file of files) {
      const square = file + rank;
      const div = document.createElement("div");
      const light = ("abcdefgh".indexOf(file) + rank) % 2 === 1;
      div.className = `square ${light ? "light" : "dark"}`;
      if (marks.includes(square)) div.classList.add("mark");
      if (picked === square) div.classList.add("picked");
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
}

function squaresOf(uci) {
  return uci ? [uci.slice(0, 2), uci.slice(2, 4)] : [];
}

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
  $("#messages").replaceChildren();
  try {
    openReview(await api("/api/analyze", body));
  } catch (error) {
    $("#review-title").textContent = error instanceof LiveGameError ? "Revisão pausada" : error.message;
  }
}

// ---------- review ----------

function openReview(analysis) {
  state.analysis = analysis;
  const { game } = analysis;
  $("#review-title").textContent = `${game.white} x ${game.black} · ${game.result}`;
  const list = $("#moments");
  list.replaceChildren(...analysis.moments.map((index) => {
    const ply = analysis.plies[index];
    const li = document.createElement("li");
    li.dataset.index = index;
    li.innerHTML = `<strong>${ply.moveNumber}${ply.color === "w" ? "." : "…"} ${escapeHtml(ply.san)}</strong>
      <span class="tag ${ply.classification}">${LABELS[ply.classification]}</span>
      <small>Melhor: ${escapeHtml(ply.bestMoveSan ?? "?")}</small>`;
    li.addEventListener("click", () => selectMoment(index));
    return li;
  }));
  if (analysis.moments.length === 0) {
    list.innerHTML = "<li>Nenhum erro relevante nesta partida. Boa!</li>";
    renderBoard($("#review-board"), analysis.plies.at(-1).fenAfter, { orientation: game.playerColor ?? "w" });
  } else {
    selectMoment(analysis.moments[0]);
  }
}

function showPly(which) {
  const ply = state.analysis.plies[state.plyIndex];
  const orientation = state.analysis.game.playerColor ?? "w";
  if (which === "before") {
    renderBoard($("#review-board"), ply.fenBefore, { orientation, marks: squaresOf(ply.bestMoveUci) });
    $("#review-caption").textContent = `Posição antes de ${ply.san}. Em destaque, o lance do Stockfish: ${ply.bestMoveSan ?? "?"}.`;
  } else {
    renderBoard($("#review-board"), ply.fenAfter, { orientation, marks: squaresOf(ply.uci) });
    $("#review-caption").textContent = `Depois de ${ply.san}. Resposta mais forte: ${ply.refutationSan.slice(0, 3).join(" ") || "—"}.`;
  }
}

$("#show-before").addEventListener("click", () => showPly("before"));
$("#show-after").addEventListener("click", () => showPly("after"));

function selectMoment(index) {
  state.plyIndex = index;
  state.chat = [];
  for (const li of $("#moments").children) li.classList.toggle("selected", Number(li.dataset.index) === index);
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
  for (const item of $("#exercises").children) item.classList.toggle("selected", item === li);
  $("#exercise-status").textContent = `Ache um lance melhor que ${exercise.playedSan}.`;
  drawExercise();
}

function drawExercise(marks = []) {
  const exercise = state.exercise;
  renderBoard($("#exercise-board"), exercise.fen, {
    orientation: exercise.sideToMove,
    marks,
    picked: state.picked,
    onSquare: state.answered ? null : onExerciseSquare,
  });
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
  const promotion = /^[18]$/.test(square[1]) && isPawnOn(exercise.fen, from) ? "q" : "";
  const result = await api(`/api/exercises/${exercise.id}/answer`, { uci: from + square + promotion });
  state.answered = true;
  drawExercise([from, square]);
  const next = new Date(result.nextReview).toLocaleDateString("pt-BR");
  $("#exercise-status").innerHTML = result.correct
    ? `<span class="ok">Isso!</span> Linha do Stockfish: ${escapeHtml(result.bestLineSan.slice(0, 5).join(" "))}. Volta em ${next}.`
    : `<span class="bad">Não era esse.</span> O melhor era ${escapeHtml(result.solutionSan ?? "?")} (${escapeHtml(result.bestLineSan.slice(0, 5).join(" "))}). Volta em ${next}.`;
}

function isPawnOn(fen, square) {
  const rows = fen.split(" ")[0].split("/");
  const row = rows[8 - Number(square[1])];
  let file = 0;
  for (const ch of row) {
    if (/\d/.test(ch)) { file += Number(ch); continue; }
    if ("abcdefgh"[file] === square[0]) return ch.toLowerCase() === "p";
    file++;
  }
  return false;
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
}

checkStatus();
setInterval(checkStatus, 30_000);
