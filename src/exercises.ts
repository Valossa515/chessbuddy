import { randomUUID } from "node:crypto";
import { scoreToCp, type Engine } from "./engine.ts";
import type { Exercise, GameAnalysis } from "./types.ts";

/** Days until the next review for each Leitner box. Box 0 is due right away. */
export const INTERVAL_DAYS = [0, 1, 3, 7, 14, 30];
/** Moves within this many centipawns of the engine's best also count as correct. */
const ACCEPT_MARGIN_CP = 40;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Turns the user's mistakes and blunders into "find the better move" puzzles
 * starting from the position before the mistake.
 */
export async function createExercises(engine: Engine, analysis: GameAnalysis, now = new Date()): Promise<Exercise[]> {
  const exercises: Exercise[] = [];
  for (const index of analysis.moments) {
    const ply = analysis.plies[index];
    if (ply.classification !== "mistake" && ply.classification !== "blunder") continue;
    const lines = await engine.analyse(ply.fenBefore, analysis.depth, 3);
    if (lines.length === 0 || !lines[0].pv[0]) continue;
    const bestCp = scoreToCp(lines[0].score);
    const solutionsUci = lines
      .filter((line) => line.pv[0] && bestCp - scoreToCp(line.score) <= ACCEPT_MARGIN_CP)
      .map((line) => line.pv[0])
      .filter((uci) => uci !== ply.uci);
    if (solutionsUci.length === 0) continue;
    exercises.push({
      id: randomUUID(),
      analysisId: analysis.id,
      ply: ply.ply,
      fen: ply.fenBefore,
      sideToMove: ply.color,
      playedSan: ply.san,
      solutionsUci,
      bestLineSan: ply.bestLineSan,
      box: 0,
      dueAt: now.toISOString(),
      attempts: [],
    });
  }
  return exercises;
}

export function isDue(exercise: Exercise, now = new Date()): boolean {
  return new Date(exercise.dueAt).getTime() <= now.getTime();
}

/** Records an answer: a right answer moves the puzzle up one box, a wrong one sends it back to the start. */
export function answerExercise(exercise: Exercise, uci: string, now = new Date()): { correct: boolean; exercise: Exercise } {
  const correct = exercise.solutionsUci.includes(uci);
  const box = correct ? Math.min(exercise.box + 1, INTERVAL_DAYS.length - 1) : 1;
  const updated: Exercise = {
    ...exercise,
    box,
    dueAt: new Date(now.getTime() + INTERVAL_DAYS[box] * DAY_MS).toISOString(),
    attempts: [...exercise.attempts, { at: now.toISOString(), correct, uci }],
  };
  return { correct, exercise: updated };
}
