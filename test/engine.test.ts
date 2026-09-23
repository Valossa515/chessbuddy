import { test } from "node:test";
import assert from "node:assert/strict";
import { MATE_CP, parseInfo, scoreToCp } from "../src/engine.ts";

test("parseInfo reads depth, multipv, score and pv", () => {
  const info = parseInfo("info depth 12 seldepth 14 multipv 2 score cp -31 nodes 12743 pv e7e5 g1f3 b8c6");
  assert.deepEqual(info, { multipv: 2, line: { depth: 12, score: { cp: -31 }, pv: ["e7e5", "g1f3", "b8c6"] } });
});

test("parseInfo ignores lines without a score", () => {
  assert.equal(parseInfo("info string NNUE evaluation enabled"), null);
  assert.equal(parseInfo("bestmove e2e4 ponder c7c5"), null);
});

test("scoreToCp turns mates into large scores for the side to move", () => {
  assert.equal(scoreToCp({ cp: 45 }), 45);
  assert.equal(scoreToCp({ mate: 2 }), MATE_CP - 20);
  assert.equal(scoreToCp({ mate: -3 }), -(MATE_CP - 30));
  assert.equal(scoreToCp({ mate: 0 }), -MATE_CP);
});
