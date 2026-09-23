import { Chess } from "chess.js";
import { fetchPlayingStatus, ONGOING_STATUSES } from "./lichess.ts";
import type { GameRecord } from "./types.ts";

/**
 * Fair-play guardrail: ChessBuddy may follow a game while it is being played,
 * but the engine and the coach stay off until it ends. Anything that would
 * compute or explain moves goes through `assertCoachAllowed` first.
 */
export class GuardrailError extends Error {
  constructor(message: string, readonly liveGameId?: string) {
    super(message);
  }
}

const FINISHED_RESULTS = new Set(["1-0", "0-1", "1/2-1/2"]);

export const MSG_LIVE =
  "Você tem uma partida em andamento. Enquanto ela durar eu só acompanho: análise e treinador voltam quando ela terminar.";
export const MSG_UNFINISHED = "Esta partida ainda não terminou. Eu só analiso partidas encerradas, para não virar ajuda externa.";

/** Accepts only games that clearly ended. */
export function assertGameFinished(game: GameRecord): void {
  if (ONGOING_STATUSES.has(game.status) || !FINISHED_RESULTS.has(game.result)) {
    // Only a Lichess game can be followed live.
    throw new GuardrailError(MSG_UNFINISHED, game.source === "lichess" ? game.id : undefined);
  }
}

/** Result tag of a pasted PGN, or "*" when missing. */
export function pgnResult(pgn: string): string {
  const board = new Chess();
  board.loadPgn(pgn);
  return board.getHeaders().Result ?? "*";
}

export class Guard {
  /** Games being followed right now. */
  private live = new Set<string>();
  private statusCache = new Map<string, { at: number; playing: boolean; gameId?: string }>();

  constructor(private checkStatus = fetchPlayingStatus, private cacheMs = 10_000) {}

  markLive(gameId: string): void {
    this.live.add(gameId);
  }

  markFinished(gameId: string): void {
    this.live.delete(gameId);
  }

  liveGames(): string[] {
    return [...this.live.keys()];
  }

  /**
   * Throws when the user is in a game. Checks games followed in this app and,
   * given a Lichess username, the user's live status. If that status can't be
   * read, it fails closed: no coaching without knowing the user isn't playing.
   */
  async assertCoachAllowed(username?: string): Promise<void> {
    const [liveId] = this.live.keys();
    if (liveId) throw new GuardrailError(MSG_LIVE, liveId);
    if (!username) return;
    const key = username.toLowerCase();
    let status = this.statusCache.get(key);
    if (!status || Date.now() - status.at > this.cacheMs) {
      try {
        status = { at: Date.now(), ...(await this.checkStatus(username)) };
      } catch {
        throw new GuardrailError("Não consegui confirmar no Lichess que você não está jogando agora, então o treinador fica pausado.");
      }
      this.statusCache.set(key, status);
    }
    if (status.playing) throw new GuardrailError(MSG_LIVE, status.gameId);
  }
}
