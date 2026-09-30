import { test } from "node:test";
import assert from "node:assert/strict";
import { NoteError, parseNote } from "../src/notes.ts";

const now = new Date("2026-09-30T12:00:00Z");

test("a note keeps its text, arrows, circles and strokes", () => {
  const note = parseNote({
    text: "O cavalo vai para f5",
    shapes: [
      { from: "g3", to: "f5", color: "green" },
      { from: "e4", to: "e4", color: "red" },
      { points: [[1.234, 2.345], [3, 4]], color: "blue" },
    ],
  }, now);
  assert.deepEqual(note, {
    text: "O cavalo vai para f5",
    shapes: [
      { from: "g3", to: "f5", color: "green" },
      { from: "e4", to: "e4", color: "red" },
      { points: [[1.23, 2.35], [3, 4]], color: "blue" },
    ],
    updatedAt: "2026-09-30T12:00:00.000Z",
  });
});

test("an empty note means no note", () => {
  assert.equal(parseNote({}), null);
  assert.equal(parseNote({ text: "   ", shapes: [] }), null);
});

test("stroke points are clamped to the board", () => {
  const note = parseNote({ shapes: [{ points: [[-1, 9]], color: "yellow" }] });
  assert.deepEqual(note?.shapes, [{ points: [[0, 8]], color: "yellow" }]);
});

test("invalid notes are refused", () => {
  assert.throws(() => parseNote({ text: 42 }), NoteError);
  assert.throws(() => parseNote({ text: "x".repeat(5001) }), NoteError);
  assert.throws(() => parseNote({ shapes: [{ from: "e4", to: "e9", color: "green" }] }), NoteError);
  assert.throws(() => parseNote({ shapes: [{ from: "e2", to: "e4", color: "pink" }] }), NoteError);
  assert.throws(() => parseNote({ shapes: [{ points: [], color: "green" }] }), NoteError);
  assert.throws(() => parseNote({ shapes: [{ points: [[1, "2"]], color: "green" }] }), NoteError);
  assert.throws(() => parseNote({ shapes: [{ points: Array(10_001).fill([1, 1]), color: "green" }] }), NoteError);
});
