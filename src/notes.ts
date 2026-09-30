import type { BoardNote, NoteArrow, NoteColor, NoteStroke } from "./types.ts";

const COLORS: NoteColor[] = ["green", "red", "blue", "yellow"];
const MAX_TEXT = 5000;
const MAX_SHAPES = 200;
const MAX_POINTS = 10_000;

export class NoteError extends Error {}

/**
 * Validates a note sent by the client. Returns null for an empty note, which
 * the caller stores as "no note". Stroke points are clamped to the board and
 * rounded, so a note stays small whatever the client sends.
 */
export function parseNote(body: Record<string, unknown>, now = new Date()): BoardNote | null {
  const text = body.text ?? "";
  if (typeof text !== "string") throw new NoteError("Texto inválido");
  if (text.length > MAX_TEXT) throw new NoteError(`O texto passa de ${MAX_TEXT} caracteres`);
  const raw = body.shapes ?? [];
  if (!Array.isArray(raw)) throw new NoteError("Desenhos inválidos");
  if (raw.length > MAX_SHAPES) throw new NoteError("Desenhos demais nesta posição");
  let points = 0;
  const shapes = raw.map((shape): NoteArrow | NoteStroke => {
    if (typeof shape !== "object" || shape === null || !COLORS.includes(shape.color)) throw new NoteError("Desenho inválido");
    if (Array.isArray(shape.points)) {
      if (shape.points.length === 0) throw new NoteError("Traço vazio");
      points += shape.points.length;
      if (points > MAX_POINTS) throw new NoteError("Traços longos demais nesta posição");
      return { color: shape.color, points: shape.points.map(parsePoint) };
    }
    if (!isSquare(shape.from) || !isSquare(shape.to)) throw new NoteError("Seta inválida");
    return { color: shape.color, from: shape.from, to: shape.to };
  });
  if (!text.trim() && shapes.length === 0) return null;
  return { text, shapes, updatedAt: now.toISOString() };
}

function isSquare(value: unknown): value is string {
  return typeof value === "string" && /^[a-h][1-8]$/.test(value);
}

function parsePoint(point: unknown): [number, number] {
  if (!Array.isArray(point) || point.length !== 2 || !point.every((n) => typeof n === "number" && Number.isFinite(n))) {
    throw new NoteError("Ponto inválido");
  }
  const clamp = (n: number) => Math.round(Math.max(0, Math.min(8, n)) * 100) / 100;
  return [clamp(point[0]), clamp(point[1])];
}
