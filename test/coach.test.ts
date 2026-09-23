import { test } from "node:test";
import assert from "node:assert/strict";
import type Anthropic from "@anthropic-ai/sdk";
import { Coach, parseHistory } from "../src/coach.ts";
import type { Engine } from "../src/engine.ts";
import type { GameAnalysis } from "../src/types.ts";

const pgn = '[Result "0-1"]\n\n1. f3 e5 2. g4 Qh4# 0-1';
const analysis = {
  id: "a1",
  depth: 10,
  game: { id: "g", source: "pgn", white: "Eu", black: "Rival", result: "0-1", status: "mate", pgn, playerColor: "w" },
  plies: [
    {
      ply: 3, moveNumber: 2, color: "w", san: "g4", uci: "g2g4",
      fenBefore: "rnbqkbnr/pppp1ppp/8/4p3/8/5P2/PPPPP1PP/RNBQKBNR w KQkq - 0 2",
      fenAfter: "rnbqkbnr/pppp1ppp/8/4p3/6P1/5P2/PPPPP2P/RNBQKBNR b KQkq - 0 2",
      evalBefore: -80, evalAfter: -10_000, bestMoveUci: "e2e4", bestMoveSan: "e4", bestLineSan: ["e4"],
      refutationSan: ["Qh4#"], winDrop: 1.5, classification: "blunder", tags: ["permite_mate"],
    },
  ],
  moments: [0],
  createdAt: "",
} as GameAnalysis;

test("the coach asks Stockfish before answering about a proposed move", async () => {
  const requests: Anthropic.Beta.MessageCreateParams[] = [];
  const responses = [
    { stop_reason: "tool_use", content: [{ type: "tool_use", id: "t1", name: "consultar_stockfish", input: { fen: analysis.plies[0].fenBefore, lance: "e4" } }] },
    { stop_reason: "end_turn", content: [{ type: "text", text: "Com e4 você cobre h4 com a dama." }] },
  ];
  const client = { beta: { messages: { create: async (params: Anthropic.Beta.MessageCreateParams) => (requests.push(structuredClone(params)), responses.shift()) } } };
  const engine = { analyse: async () => [{ depth: 10, score: { cp: 20 }, pv: ["d7d5"] }] } as unknown as Engine;
  const coach = new Coach(engine, 10, client as unknown as Anthropic);

  const reply = await coach.reply(analysis, analysis.plies[0], [
    { role: "assistant", content: "g4 abriu a diagonal do rei. O que a dama preta ameaçava?" },
    { role: "user", content: "E se eu jogasse e4?" },
  ]);

  assert.equal(reply, "Com e4 você cobre h4 com a dama.");
  assert.equal(requests.length, 2);
  assert.match(String(requests[0].messages[0].content), /Qh4#/);
  const toolResult = (requests[1].messages.at(-1)!.content as Anthropic.Beta.BetaToolResultBlockParam[])[0];
  assert.equal(toolResult.type, "tool_result");
  assert.match(String(toolResult.content), /"lance":"e4"/);
  assert.match(String(toolResult.content), /"melhor_continuacao":\["d5"\]/);
});

test("parseHistory enforces coach-first alternating turns ending with the user", () => {
  assert.deepEqual(parseHistory(undefined), []);
  assert.deepEqual(parseHistory([{ role: "assistant", content: "a" }, { role: "user", content: "b" }]).length, 2);
  assert.throws(() => parseHistory([{ role: "user", content: "a" }]));
  assert.throws(() => parseHistory([{ role: "assistant", content: "a" }]));
});
