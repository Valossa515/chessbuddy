import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Exercise, GameAnalysis } from "./types.ts";

interface Data {
  analyses: Record<string, GameAnalysis>;
  exercises: Record<string, Exercise>;
}

/** Single-user JSON file store; enough for the MVP. */
export class Store {
  private data: Data;

  constructor(private path: string) {
    try {
      this.data = JSON.parse(readFileSync(path, "utf8")) as Data;
    } catch {
      this.data = { analyses: {}, exercises: {} };
    }
  }

  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data));
    renameSync(tmp, this.path);
  }

  getAnalysis(id: string): GameAnalysis | undefined {
    return this.data.analyses[id];
  }

  findAnalysisByGame(gameId: string): GameAnalysis | undefined {
    return Object.values(this.data.analyses).find((analysis) => analysis.game.id === gameId);
  }

  putAnalysis(analysis: GameAnalysis): void {
    this.data.analyses[analysis.id] = analysis;
    this.save();
  }

  getExercise(id: string): Exercise | undefined {
    return this.data.exercises[id];
  }

  listExercises(): Exercise[] {
    return Object.values(this.data.exercises);
  }

  putExercises(exercises: Exercise[]): void {
    for (const exercise of exercises) this.data.exercises[exercise.id] = exercise;
    this.save();
  }
}
