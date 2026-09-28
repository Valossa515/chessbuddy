export type Color = "w" | "b";

/** Engine score from the side-to-move's point of view, as UCI reports it. */
export interface Score {
  cp?: number;
  mate?: number;
}

export interface EngineLine {
  score: Score;
  /** Principal variation in UCI notation (e.g. "e2e4"). */
  pv: string[];
  depth: number;
}

export type Classification = "best" | "good" | "inaccuracy" | "mistake" | "blunder";

export interface PlyAnalysis {
  ply: number;
  moveNumber: number;
  color: Color;
  san: string;
  uci: string;
  fenBefore: string;
  fenAfter: string;
  /** Centipawns from White's point of view (mates clamped to ±10000). */
  evalBefore: number;
  evalAfter: number;
  bestMoveUci: string | null;
  bestMoveSan: string | null;
  /** Engine's best continuation from fenBefore, in SAN. */
  bestLineSan: string[];
  /** Engine's best continuation after the played move (the refutation), in SAN. */
  refutationSan: string[];
  /** Loss of winning chances for the mover, from 0 to 2 (Lichess scale). */
  winDrop: number;
  classification: Classification;
  tags: string[];
}

export interface GameRecord {
  id: string;
  source: "lichess" | "pgn";
  white: string;
  black: string;
  result: string;
  /** Lichess status ("mate", "resign", "started"...). "unknown" for pasted PGNs. */
  status: string;
  pgn: string;
  playerColor?: Color;
  url?: string;
  playedAt?: string;
  opening?: string;
  speed?: string;
  rated?: boolean;
}

export interface GameAnalysis {
  id: string;
  game: GameRecord;
  depth: number;
  plies: PlyAnalysis[];
  /** Indexes into `plies` of the decisive moments, in game order. */
  moments: number[];
  /**
   * Indexes into `plies` of the opponent's errors that the user could punish on
   * the next move, in game order. Empty when the user's color is unknown, since
   * `moments` then covers both sides. Missing on analyses saved before it existed.
   */
  opportunities?: number[];
  createdAt: string;
}

export interface Exercise {
  id: string;
  analysisId: string;
  ply: number;
  fen: string;
  sideToMove: Color;
  /** The move that was played in the game (the mistake), in SAN. */
  playedSan: string;
  /** Accepted answers in UCI: the best move and any move within a small margin of it. */
  solutionsUci: string[];
  bestLineSan: string[];
  box: number;
  dueAt: string;
  attempts: { at: string; correct: boolean; uci: string }[];
}
