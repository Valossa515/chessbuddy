import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { analyzeGame, classify, pickDecisiveMoments, uciLineToSan, winningChances } from "../src/analysis.ts";
import { Engine } from "../src/engine.ts";
import type { PlyAnalysis } from "../src/types.ts";

test("winningChances is symmetric and bounded", () => {
  assert.equal(winningChances(0), 0);
  assert.ok(Math.abs(winningChances(300) + winningChances(-300)) < 1e-12);
  assert.ok(winningChances(100_000) < 1);
});

test("classify follows the Lichess thresholds", () => {
  assert.equal(classify(0.5, true), "best");
  assert.equal(classify(0.05, false), "good");
  assert.equal(classify(0.12, false), "inaccuracy");
  assert.equal(classify(0.25, false), "mistake");
  assert.equal(classify(0.4, false), "blunder");
});

test("uciLineToSan converts until the first illegal move", () => {
  const start = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
  assert.deepEqual(uciLineToSan(start, ["e2e4", "e7e5", "g1f3", "e2e4"]), ["e4", "e5", "Nf3"]);
});

test("pickDecisiveMoments keeps the player's worst moves in game order", () => {
  const ply = (color: "w" | "b", winDrop: number, classification: PlyAnalysis["classification"]) =>
    ({ color, winDrop, classification }) as PlyAnalysis;
  const plies = [ply("w", 0.5, "blunder"), ply("b", 0.35, "blunder"), ply("w", 0, "best"), ply("b", 0.15, "inaccuracy"), ply("b", 0.22, "mistake")];
  assert.deepEqual(pickDecisiveMoments(plies, "b", 2), [1, 4]);
  assert.deepEqual(pickDecisiveMoments(plies, undefined, 5), [0, 1, 3, 4]);
});

test("analyzeGame finds Black's decisive errors in the Opera Game", { timeout: 120_000 }, async () => {
  const engine = await Engine.start();
  try {
    const pgn = readFileSync(new URL("./fixtures/opera.pgn", import.meta.url), "utf8");
    const analysis = await analyzeGame(
      engine,
      { id: "opera", source: "pgn", white: "Morphy", black: "Aliados", result: "1-0", status: "unknown", pgn, playerColor: "b" },
      { depth: 10 },
    );
    assert.equal(analysis.plies.length, 33);
    assert.ok(analysis.moments.length > 0);
    for (const index of analysis.moments) assert.equal(analysis.plies[index].color, "b");
    const last = analysis.plies.at(-1)!;
    assert.equal(last.san, "Rd8#");
    assert.ok(last.evalAfter >= 9000, "checkmate should score as a win for White");
  } finally {
    engine.quit();
  }
});
