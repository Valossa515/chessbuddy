import { randomUUID } from "node:crypto";
import { Chess } from "chess.js";
import { scoreToCp, MATE_CP, type Engine } from "./engine.ts";
import type { Classification, Color, EngineLine, GameAnalysis, GameRecord, PlyAnalysis } from "./types.ts";

/** Lichess' winning-chances curve: maps centipawns to [-1, 1]. */
export function winningChances(cp: number): number {
  const clamped = Math.max(-1000, Math.min(1000, cp));
  return 2 / (1 + Math.exp(-0.00368208 * clamped)) - 1;
}

/** Same thresholds Lichess uses for its move annotations. */
export function classify(winDrop: number, isBest: boolean): Classification {
  if (isBest) return "best";
  if (winDrop >= 0.3) return "blunder";
  if (winDrop >= 0.2) return "mistake";
  if (winDrop >= 0.1) return "inaccuracy";
  return "good";
}

/** Converts a UCI line into SAN starting from `fen`, stopping at the first illegal move. */
export function uciLineToSan(fen: string, uciMoves: string[], limit = 8): string[] {
  const board = new Chess(fen);
  const san: string[] = [];
  for (const uci of uciMoves.slice(0, limit)) {
    try {
      san.push(board.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] }).san);
    } catch {
      break;
    }
  }
  return san;
}

function whitePov(line: EngineLine | undefined, sideToMove: Color): number {
  const cp = line ? scoreToCp(line.score) : 0;
  return sideToMove === "w" ? cp : -cp;
}

export interface AnalyzeOptions {
  depth: number;
  maxMoments?: number;
  onProgress?: (done: number, total: number) => void;
}

export async function analyzeGame(engine: Engine, game: GameRecord, options: AnalyzeOptions): Promise<GameAnalysis> {
  const board = new Chess();
  board.loadPgn(game.pgn);
  const moves = board.history({ verbose: true });
  if (moves.length === 0) throw new Error("A partida não tem lances para analisar.");

  const fens = [moves[0].before, ...moves.map((move) => move.after)];
  const lines: (EngineLine | undefined)[] = [];
  for (let i = 0; i < fens.length; i++) {
    const [best] = await engine.analyse(fens[i], options.depth);
    lines.push(best);
    options.onProgress?.(i + 1, fens.length);
  }

  const plies: PlyAnalysis[] = moves.map((move, i) => {
    const color = move.color as Color;
    const before = lines[i];
    const after = lines[i + 1];
    const evalBefore = whitePov(before, color);
    // After the move it is the opponent's turn.
    const evalAfter = whitePov(after, color === "w" ? "b" : "w");
    const uci = move.from + move.to + (move.promotion ?? "");
    const bestMoveUci = before?.pv[0] ?? null;
    const sign = color === "w" ? 1 : -1;
    const winDrop = Math.max(0, sign * (winningChances(evalBefore) - winningChances(evalAfter)));
    const classification = classify(winDrop, bestMoveUci === uci);
    const bestLineSan = before ? uciLineToSan(move.before, before.pv) : [];

    const tags: string[] = [];
    const moverBefore = sign * evalBefore;
    const moverAfter = sign * evalAfter;
    if (moverBefore >= MATE_CP - 200 && moverAfter < MATE_CP - 200) tags.push("mate_perdido");
    if (moverBefore >= 150 && moverAfter < 50) tags.push("vantagem_desperdicada");
    if (moverAfter <= -(MATE_CP - 200)) tags.push("permite_mate");

    return {
      ply: i + 1,
      moveNumber: Math.floor(i / 2) + 1,
      color,
      san: move.san,
      uci,
      fenBefore: move.before,
      fenAfter: move.after,
      evalBefore,
      evalAfter,
      bestMoveUci,
      bestMoveSan: bestLineSan[0] ?? null,
      bestLineSan,
      refutationSan: after ? uciLineToSan(move.after, after.pv) : [],
      winDrop: Math.round(winDrop * 1000) / 1000,
      classification,
      tags,
    };
  });

  return {
    id: randomUUID(),
    game,
    depth: options.depth,
    plies,
    moments: pickDecisiveMoments(plies, game.playerColor, options.maxMoments ?? 5),
    createdAt: new Date().toISOString(),
  };
}

/**
 * The few moves worth talking about: the biggest drops in winning chances,
 * restricted to the user's own moves when we know which side they played.
 */
export function pickDecisiveMoments(plies: PlyAnalysis[], playerColor: Color | undefined, max: number): number[] {
  return plies
    .map((ply, index) => ({ ply, index }))
    .filter(({ ply }) => !playerColor || ply.color === playerColor)
    .filter(({ ply }) => ply.classification === "inaccuracy" || ply.classification === "mistake" || ply.classification === "blunder")
    .sort((a, b) => b.ply.winDrop - a.ply.winDrop)
    .slice(0, max)
    .map(({ index }) => index)
    .sort((a, b) => a - b);
}
