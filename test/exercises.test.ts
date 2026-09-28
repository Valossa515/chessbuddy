import { test } from "node:test";
import assert from "node:assert/strict";
import { answerExercise, INTERVAL_DAYS, isDue, playSan, playUci } from "../src/exercises.ts";
import type { Exercise } from "../src/types.ts";

const now = new Date("2026-09-23T12:00:00Z");
const exercise: Exercise = {
  id: "e1", analysisId: "a1", ply: 7, fen: "8/8/8/8/8/8/8/8 w - - 0 1", sideToMove: "w", playedSan: "Qb3",
  solutionsUci: ["d1d3", "c4b5"], bestLineSan: ["Qd3"], box: 0, dueAt: now.toISOString(), attempts: [],
};

test("a right answer moves the puzzle up one box", () => {
  const { correct, exercise: next } = answerExercise(exercise, "c4b5", now);
  assert.equal(correct, true);
  assert.equal(next.box, 1);
  assert.equal(new Date(next.dueAt).getTime() - now.getTime(), INTERVAL_DAYS[1] * 86_400_000);
  assert.equal(isDue(next, now), false);
});

test("a wrong answer sends the puzzle back to box 1", () => {
  const { correct, exercise: next } = answerExercise({ ...exercise, box: 4 }, "e2e4", now);
  assert.equal(correct, false);
  assert.equal(next.box, 1);
  assert.equal(next.attempts.length, 1);
});

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

test("playUci returns the move with the position it leads to, or undefined when illegal", () => {
  const step = playUci(START, "e2e4");
  assert.equal(step?.san, "e4");
  assert.equal(step?.fen, "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1");
  assert.equal(playUci(START, "e2e5"), undefined);
});

test("playUci normalises promotions", () => {
  assert.equal(playUci("8/4P3/8/8/8/8/k7/4K3 w - - 0 1", "e7e8q")?.uci, "e7e8q");
});

test("playSan turns a line into steps and stops at the first illegal move", () => {
  const steps = playSan(START, ["e4", "e5", "Qxf7", "Nf3"]);
  assert.deepEqual(steps.map((step) => step.uci), ["e2e4", "e7e5"]);
});
