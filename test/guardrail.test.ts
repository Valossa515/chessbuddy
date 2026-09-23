import { test } from "node:test";
import assert from "node:assert/strict";
import { assertGameFinished, Guard, GuardrailError, pgnResult } from "../src/guardrail.ts";
import type { GameRecord } from "../src/types.ts";

const game = (overrides: Partial<GameRecord>): GameRecord => ({
  id: "g1", source: "lichess", white: "a", black: "b", result: "1-0", status: "mate", pgn: "", ...overrides,
});

test("finished games pass, ongoing or unresolved ones are refused", () => {
  assertGameFinished(game({}));
  assert.throws(() => assertGameFinished(game({ status: "started", result: "*" })), GuardrailError);
  assert.throws(() => assertGameFinished(game({ status: "unknown", result: "*" })), GuardrailError);
});

test("pgnResult reads the Result tag", () => {
  assert.equal(pgnResult('[Result "0-1"]\n\n1. f3 e5 2. g4 Qh4# 0-1'), "0-1");
  assert.equal(pgnResult("1. e4 e5 *"), "*");
});

test("coach is locked while the user is playing on Lichess", async () => {
  const guard = new Guard(async () => ({ playing: true, gameId: "abc" }));
  await assert.rejects(guard.assertCoachAllowed("felipe"), (error: GuardrailError) => error.liveGameId === "abc");
});

test("coach fails closed when the Lichess status can't be read", async () => {
  const guard = new Guard(async () => {
    throw new Error("offline");
  });
  await assert.rejects(guard.assertCoachAllowed("felipe"), GuardrailError);
});

test("coach is allowed when the user isn't playing, and locked while a game is followed", async () => {
  const guard = new Guard(async () => ({ playing: false }));
  await guard.assertCoachAllowed("felipe");
  await guard.assertCoachAllowed();
  guard.markLive("xyz");
  await assert.rejects(guard.assertCoachAllowed(), GuardrailError);
  guard.markFinished("xyz");
  await guard.assertCoachAllowed();
});
