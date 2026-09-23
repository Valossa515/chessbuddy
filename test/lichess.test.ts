import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mapLichessGame, parseNdjson, type LichessGame } from "../src/lichess.ts";

const games = parseNdjson<LichessGame>(readFileSync(new URL("./fixtures/lichess-games.ndjson", import.meta.url), "utf8"));

test("maps a finished Lichess game and detects the user's color", () => {
  const game = mapLichessGame(games[0], "Felipe");
  assert.equal(game.result, "0-1");
  assert.equal(game.playerColor, "w");
  assert.equal(game.opening, "C41 Philidor Defense");
  assert.match(game.pgn, /Nf3 d6/);
});

test("an ongoing game maps to an unresolved result", () => {
  const game = mapLichessGame(games[1], "felipe");
  assert.equal(game.status, "started");
  assert.equal(game.result, "*");
  assert.equal(game.playerColor, "b");
});
