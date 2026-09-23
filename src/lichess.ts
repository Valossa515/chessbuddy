import type { Color, GameRecord } from "./types.ts";

const LICHESS = process.env.LICHESS_URL ?? "https://lichess.org";

/** Statuses of a game that has not ended yet. */
export const ONGOING_STATUSES = new Set(["created", "started"]);

export function parseNdjson<T = unknown>(text: string): T[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

interface LichessPlayer {
  user?: { name: string; id: string };
  aiLevel?: number;
}

export interface LichessGame {
  id: string;
  rated: boolean;
  variant: string;
  speed: string;
  status: string;
  createdAt: number;
  winner?: "white" | "black";
  players: { white: LichessPlayer; black: LichessPlayer };
  opening?: { eco: string; name: string };
  pgn?: string;
}

function playerName(player: LichessPlayer): string {
  if (player.user) return player.user.name;
  if (player.aiLevel) return `Stockfish nível ${player.aiLevel}`;
  return "Anônimo";
}

export function mapLichessGame(game: LichessGame, username?: string): GameRecord {
  const result = ONGOING_STATUSES.has(game.status)
    ? "*"
    : game.winner === "white"
      ? "1-0"
      : game.winner === "black"
        ? "0-1"
        : "1/2-1/2";
  let playerColor: Color | undefined;
  const me = username?.toLowerCase();
  if (me && game.players.white.user?.id === me) playerColor = "w";
  if (me && game.players.black.user?.id === me) playerColor = "b";
  return {
    id: game.id,
    source: "lichess",
    white: playerName(game.players.white),
    black: playerName(game.players.black),
    result,
    status: game.status,
    pgn: game.pgn ?? "",
    playerColor,
    url: `${LICHESS}/${game.id}`,
    playedAt: new Date(game.createdAt).toISOString(),
    opening: game.opening ? `${game.opening.eco} ${game.opening.name}` : undefined,
    speed: game.speed,
    rated: game.rated,
  };
}

async function get(path: string, accept: string): Promise<Response> {
  const response = await fetch(LICHESS + path, { headers: { Accept: accept } });
  if (!response.ok) throw new Error(`Lichess respondeu ${response.status} em ${path}`);
  return response;
}

/** Recent finished standard games of a user. Ongoing games are never requested. */
export async function fetchRecentGames(username: string, max = 10): Promise<GameRecord[]> {
  const params = new URLSearchParams({
    max: String(max),
    ongoing: "false",
    finished: "true",
    pgnInJson: "true",
    opening: "true",
    clocks: "false",
    evals: "false",
    perfType: "ultraBullet,bullet,blitz,rapid,classical,correspondence",
  });
  const response = await get(`/api/games/user/${encodeURIComponent(username)}?${params}`, "application/x-ndjson");
  return parseNdjson<LichessGame>(await response.text())
    .filter((game) => game.variant === "standard" && !ONGOING_STATUSES.has(game.status))
    .map((game) => mapLichessGame(game, username));
}

export async function fetchGame(gameId: string, username?: string): Promise<GameRecord> {
  const response = await get(`/game/export/${encodeURIComponent(gameId)}?pgnInJson=true&opening=true&clocks=false`, "application/json");
  return mapLichessGame((await response.json()) as LichessGame, username);
}

export interface PlayingStatus {
  playing: boolean;
  gameId?: string;
}

/** Whether a user is in a game right now, from Lichess' public status endpoint. */
export async function fetchPlayingStatus(username: string): Promise<PlayingStatus> {
  const response = await get(`/api/users/status?ids=${encodeURIComponent(username)}&withGameIds=true`, "application/json");
  const [status] = (await response.json()) as { playing?: boolean; playingId?: string }[];
  return { playing: Boolean(status?.playing), gameId: status?.playingId };
}

export interface LivePosition {
  fen: string;
  lastMove?: string;
  whiteClock?: number;
  blackClock?: number;
}

/**
 * Streams the positions of a game while it is being played. Only positions and
 * clocks are forwarded: nothing here touches the engine or the coach.
 */
export async function streamGame(gameId: string, onPosition: (position: LivePosition) => void, signal: AbortSignal): Promise<void> {
  const response = await fetch(`${LICHESS}/api/stream/game/${encodeURIComponent(gameId)}`, {
    headers: { Accept: "application/x-ndjson" },
    signal,
  });
  if (!response.ok || !response.body) throw new Error(`Lichess respondeu ${response.status} ao acompanhar a partida`);
  const decoder = new TextDecoder();
  let pending = "";
  for await (const chunk of response.body) {
    pending += decoder.decode(chunk, { stream: true });
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const event of parseNdjson<{ fen?: string; lm?: string; wc?: number; bc?: number }>(lines.join("\n"))) {
      if (event.fen) onPosition({ fen: event.fen, lastMove: event.lm, whiteClock: event.wc, blackClock: event.bc });
    }
  }
}
