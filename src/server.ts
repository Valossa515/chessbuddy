import Anthropic from "@anthropic-ai/sdk";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Chess } from "chess.js";
import { analyzeGame } from "./analysis.ts";
import { Coach, parseHistory } from "./coach.ts";
import { Engine } from "./engine.ts";
import { answerExercise, createExercises, isDue } from "./exercises.ts";
import { assertGameFinished, Guard, GuardrailError, pgnResult } from "./guardrail.ts";
import { fetchGame, fetchPlayingStatus, fetchRecentGames, streamGame } from "./lichess.ts";
import { Store } from "./store.ts";
import type { Color, GameRecord } from "./types.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PORT = Number(process.env.PORT ?? 3000);
const DEPTH = Number(process.env.CHESSBUDDY_DEPTH ?? 14);

const engine = await Engine.start();
const coach = new Coach(engine, DEPTH);
const guard = new Guard();
const store = new Store(process.env.CHESSBUDDY_DB ?? join(ROOT, "data", "db.json"));

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 1_000_000) throw new HttpError(413, "Requisição grande demais");
  }
  try {
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  } catch {
    throw new HttpError(400, "JSON inválido");
  }
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

const STATIC: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };

async function serveStatic(res: ServerResponse, path: string): Promise<void> {
  const file = path === "/" ? "index.html" : path.slice(1);
  if (!/^[\w.-]+$/.test(file) || !STATIC[extname(file)]) throw new HttpError(404, "Não encontrado");
  const content = await readFile(join(ROOT, "web", file)).catch(() => {
    throw new HttpError(404, "Não encontrado");
  });
  res.writeHead(200, { "Content-Type": `${STATIC[extname(file)]}; charset=utf-8` });
  res.end(content);
}

/** Builds the game to analyse from a Lichess id or a pasted PGN, refusing unfinished games. */
async function resolveGame(body: Record<string, unknown>): Promise<GameRecord> {
  const username = optionalString(body.username);
  const gameId = optionalString(body.gameId);
  if (gameId) return fetchGame(gameId, username);
  const pgn = optionalString(body.pgn);
  if (!pgn) throw new HttpError(400, "Envie gameId (Lichess) ou pgn");
  let headers: Record<string, string | null>;
  try {
    const board = new Chess();
    board.loadPgn(pgn);
    headers = board.getHeaders();
  } catch {
    throw new HttpError(400, "PGN inválido");
  }
  const playerColor = body.playerColor === "w" || body.playerColor === "b" ? (body.playerColor as Color) : undefined;
  return {
    id: `pgn-${Date.now()}`,
    source: "pgn",
    white: headers.White ?? "Brancas",
    black: headers.Black ?? "Pretas",
    result: pgnResult(pgn),
    status: "unknown",
    pgn,
    playerColor,
    opening: headers.Opening ?? undefined,
  };
}

async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const path = url.pathname;

  if (req.method === "GET" && path === "/api/status") {
    const username = optionalString(url.searchParams.get("user"));
    const status = username ? await fetchPlayingStatus(username) : { playing: false };
    return send(res, 200, { ...status, following: guard.liveGames() });
  }

  if (req.method === "GET" && path === "/api/games") {
    const username = optionalString(url.searchParams.get("user"));
    if (!username) throw new HttpError(400, "Informe o usuário do Lichess");
    const games = await fetchRecentGames(username, Number(url.searchParams.get("max") ?? 10));
    return send(res, 200, games.map((game) => ({ ...game, analysisId: store.findAnalysisByGame(game.id)?.id })));
  }

  if (req.method === "POST" && path === "/api/analyze") {
    const body = await readJson(req);
    const username = optionalString(body.username);
    await guard.assertCoachAllowed(username);
    const game = await resolveGame(body);
    assertGameFinished(game);
    const existing = store.findAnalysisByGame(game.id);
    if (existing) return send(res, 200, existing);
    const analysis = await analyzeGame(engine, game, { depth: DEPTH });
    store.putAnalysis(analysis);
    store.putExercises(await createExercises(engine, analysis));
    return send(res, 200, analysis);
  }

  const analysisMatch = path.match(/^\/api\/analysis\/([\w-]+)$/);
  if (req.method === "GET" && analysisMatch) {
    const analysis = store.getAnalysis(analysisMatch[1]);
    if (!analysis) throw new HttpError(404, "Análise não encontrada");
    return send(res, 200, analysis);
  }

  if (req.method === "POST" && path === "/api/coach") {
    const body = await readJson(req);
    await guard.assertCoachAllowed(optionalString(body.username));
    const analysis = store.getAnalysis(String(body.analysisId ?? ""));
    if (!analysis) throw new HttpError(404, "Análise não encontrada");
    assertGameFinished(analysis.game);
    const ply = analysis.plies[Number(body.plyIndex)];
    if (!ply) throw new HttpError(400, "Lance inválido");
    let history;
    try {
      history = parseHistory(body.messages);
    } catch (error) {
      throw new HttpError(400, (error as Error).message);
    }
    return send(res, 200, { reply: await coach.reply(analysis, ply, history) });
  }

  if (req.method === "GET" && path === "/api/exercises") {
    const due = url.searchParams.get("due") !== "false";
    const exercises = store.listExercises().filter((exercise) => !due || isDue(exercise));
    // Solutions stay on the server until the user answers.
    return send(res, 200, exercises.map(({ solutionsUci, bestLineSan, ...rest }) => rest));
  }

  const answerMatch = path.match(/^\/api\/exercises\/([\w-]+)\/answer$/);
  if (req.method === "POST" && answerMatch) {
    const exercise = store.getExercise(answerMatch[1]);
    if (!exercise) throw new HttpError(404, "Exercício não encontrado");
    const uci = optionalString((await readJson(req)).uci);
    if (!uci) throw new HttpError(400, "Envie o lance em UCI (ex. e2e4)");
    const { correct, exercise: updated } = answerExercise(exercise, uci);
    store.putExercises([updated]);
    return send(res, 200, {
      correct,
      solutionSan: updated.bestLineSan[0],
      bestLineSan: updated.bestLineSan,
      nextReview: updated.dueAt,
    });
  }

  const followMatch = path.match(/^\/api\/follow\/(\w+)$/);
  if (req.method === "GET" && followMatch) return follow(req, res, followMatch[1], optionalString(url.searchParams.get("user")));

  throw new HttpError(404, "Rota não encontrada");
}

/**
 * Follow mode: relays the live position as server-sent events. It never calls
 * the engine or the coach; while it runs, the guard keeps both locked.
 */
async function follow(req: IncomingMessage, res: ServerResponse, gameId: string, username?: string): Promise<void> {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  const emit = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const abort = new AbortController();
  req.on("close", () => abort.abort());
  guard.markLive(gameId);
  try {
    await streamGame(gameId, (position) => emit("position", position), abort.signal);
    const game = await fetchGame(gameId, username);
    guard.markFinished(gameId);
    emit("finished", { gameId, result: game.result, status: game.status });
  } catch (error) {
    if (!abort.signal.aborted) emit("error", { message: (error as Error).message });
  } finally {
    // Leaving the page ends follow mode; the Lichess status check still guards a game in progress.
    guard.markFinished(gameId);
    res.end();
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  try {
    if (url.pathname.startsWith("/api/")) await handleApi(req, res, url);
    else await serveStatic(res, url.pathname);
  } catch (error) {
    if (res.headersSent) return void res.end();
    if (error instanceof GuardrailError) return send(res, 423, { error: error.message, liveGameId: error.liveGameId });
    if (error instanceof HttpError) return send(res, error.status, { error: error.message });
    if (error instanceof Anthropic.AuthenticationError) {
      return send(res, 502, { error: "O treinador não conseguiu se conectar ao Claude. Confira a ANTHROPIC_API_KEY no .env." });
    }
    if (error instanceof Anthropic.APIError) {
      return send(res, 502, { error: `O treinador está indisponível agora (Claude respondeu ${error.status}). Tente de novo em instantes.` });
    }
    console.error(error);
    send(res, 502, { error: (error as Error).message });
  }
});

server.listen(PORT, () => console.log(`ChessBuddy em http://localhost:${PORT}`));

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    engine.quit();
    server.close();
    process.exit(0);
  });
}
