import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createRequire } from "node:module";
import type { EngineLine, Score } from "./types.ts";

const require = createRequire(import.meta.url);

/**
 * Thin UCI wrapper around Stockfish. Uses a native binary when STOCKFISH_PATH is
 * set, otherwise the single-threaded WASM build shipped by the `stockfish` package.
 */
export class Engine {
  private proc: ChildProcessWithoutNullStreams;
  private pending = "";
  private listeners = new Set<(line: string) => void>();
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(command: string, args: string[]) {
    this.proc = spawn(command, args, { stdio: "pipe" });
    this.proc.stdout.setEncoding("utf8");
    this.proc.stdout.on("data", (chunk: string) => {
      this.pending += chunk;
      const lines = this.pending.split("\n");
      this.pending = lines.pop() ?? "";
      for (const line of lines) for (const listener of this.listeners) listener(line.trim());
    });
  }

  static async start(): Promise<Engine> {
    const native = process.env.STOCKFISH_PATH;
    const engine = native
      ? new Engine(native, [])
      : new Engine(process.execPath, [require.resolve("stockfish/bin/stockfish-19-lite-single.js")]);
    engine.send("uci");
    await engine.waitFor((line) => line === "uciok", 30_000);
    await engine.ready();
    return engine;
  }

  send(command: string): void {
    this.proc.stdin.write(command + "\n");
  }

  private waitFor(match: (line: string) => boolean, timeoutMs: number, onLine?: (line: string) => void): Promise<string> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.listeners.delete(listener);
        reject(new Error("Stockfish não respondeu a tempo"));
      }, timeoutMs);
      const listener = (line: string) => {
        onLine?.(line);
        if (match(line)) {
          clearTimeout(timer);
          this.listeners.delete(listener);
          resolve(line);
        }
      };
      this.listeners.add(listener);
    });
  }

  private async ready(): Promise<void> {
    this.send("isready");
    await this.waitFor((line) => line === "readyok", 30_000);
  }

  /** Analyses one position. Calls are serialized, since UCI engines handle one search at a time. */
  analyse(fen: string, depth: number, multipv = 1): Promise<EngineLine[]> {
    const run = async () => {
      const lines = new Map<number, EngineLine>();
      this.send(`setoption name MultiPV value ${multipv}`);
      await this.ready();
      this.send(`position fen ${fen}`);
      this.send(`go depth ${depth}`);
      await this.waitFor(
        (line) => line.startsWith("bestmove"),
        120_000,
        (line) => {
          const info = parseInfo(line);
          if (info) lines.set(info.multipv, info.line);
        },
      );
      return [...lines.entries()].sort((a, b) => a[0] - b[0]).map(([, line]) => line);
    };
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => undefined);
    return result;
  }

  quit(): void {
    this.send("quit");
    this.proc.kill();
  }
}

export function parseInfo(line: string): { multipv: number; line: EngineLine } | null {
  if (!line.startsWith("info ") || !line.includes(" score ")) return null;
  const tokens = line.split(/\s+/);
  let depth = 0;
  let multipv = 1;
  const score: Score = {};
  let pv: string[] = [];
  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === "depth") depth = Number(tokens[++i]);
    else if (token === "multipv") multipv = Number(tokens[++i]);
    else if (token === "score") {
      const kind = tokens[++i];
      const value = Number(tokens[++i]);
      if (kind === "cp") score.cp = value;
      else if (kind === "mate") score.mate = value;
    } else if (token === "pv") {
      pv = tokens.slice(i + 1);
      break;
    }
  }
  return { multipv, line: { depth, score, pv } };
}

export const MATE_CP = 10_000;

/** Converts a UCI score (side-to-move POV) into centipawns from the side-to-move POV. */
export function scoreToCp(score: Score): number {
  if (score.mate !== undefined) {
    // "mate 0" means the side to move is already mated.
    if (score.mate === 0) return -MATE_CP;
    return Math.sign(score.mate) * (MATE_CP - Math.abs(score.mate) * 10);
  }
  return score.cp ?? 0;
}
