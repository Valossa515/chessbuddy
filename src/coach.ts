import Anthropic from "@anthropic-ai/sdk";
import { Chess } from "chess.js";
import { uciLineToSan } from "./analysis.ts";
import { scoreToCp, type Engine } from "./engine.ts";
import type { GameAnalysis, PlyAnalysis } from "./types.ts";

const MODEL = process.env.CHESSBUDDY_MODEL ?? "claude-opus-5";
const MAX_TOOL_ROUNDS = 5;

const SYSTEM = `Você é o ChessBuddy, um treinador de xadrez paciente e direto que revisa partidas já terminadas com o aluno.

Como trabalhar:
- Os números e lances vêm do Stockfish. Nunca invente avaliações, lances ou variantes. Se precisar de uma variante que não está nos dados, use a ferramenta consultar_stockfish.
- Explique em linguagem de gente: a ideia, o plano, a peça esquecida, a ameaça que passou despercebida. Use a avaliação em peões só como apoio.
- Na primeira mensagem sobre um momento, diga em poucas frases o que aconteceu e termine com uma pergunta que faça o aluno pensar (por exemplo, o que ele estava planejando ou o que o adversário ameaçava).
- Quando o aluno propuser um lance, verifique com a ferramenta antes de responder.
- Seja breve: no máximo dois parágrafos curtos por resposta. Responda em português do Brasil.`;

const TOOLS: Anthropic.Beta.BetaTool[] = [
  {
    name: "consultar_stockfish",
    description:
      "Analisa uma posição com o Stockfish. Sem 'lance', devolve a avaliação e a melhor continuação. Com 'lance' (SAN, ex. Nf3), joga esse lance e devolve a avaliação resultante e a melhor resposta do adversário. Avaliações em peões, do ponto de vista das brancas.",
    input_schema: {
      type: "object",
      properties: {
        fen: { type: "string", description: "Posição em FEN." },
        lance: { type: "string", description: "Lance opcional em SAN a testar nessa posição." },
      },
      required: ["fen"],
      additionalProperties: false,
    },
  },
];

export type ChatTurn = { role: "user" | "assistant"; content: string };

const LABELS: Record<PlyAnalysis["classification"], string> = {
  best: "melhor lance",
  good: "bom lance",
  inaccuracy: "imprecisão",
  mistake: "erro",
  blunder: "erro grave",
};

function pawns(cp: number): string {
  if (Math.abs(cp) >= 9000) return cp > 0 ? "mate para as brancas" : "mate para as pretas";
  return (cp / 100).toFixed(2);
}

/** The facts the coach is allowed to talk about, as a compact text block. */
export function momentBriefing(analysis: GameAnalysis, ply: PlyAnalysis): string {
  const { game } = analysis;
  const board = new Chess();
  board.loadPgn(game.pgn);
  const history = board.history().slice(0, ply.ply - 1);
  const color = ply.color === "w" ? "brancas" : "pretas";
  const player = game.playerColor ? (game.playerColor === "w" ? "brancas" : "pretas") : "desconhecido";
  return [
    `Partida: ${game.white} (brancas) x ${game.black} (pretas), resultado ${game.result}${game.opening ? `, abertura ${game.opening}` : ""}.`,
    `O aluno jogou com: ${player}.`,
    `Lances até o momento: ${history.join(" ") || "(início)"}`,
    `Momento: lance ${ply.moveNumber}${ply.color === "w" ? "." : "..."} ${ply.san} das ${color} (${LABELS[ply.classification]}).`,
    `FEN antes do lance: ${ply.fenBefore}`,
    `Avaliação antes: ${pawns(ply.evalBefore)}; depois: ${pawns(ply.evalAfter)} (peões, ponto de vista das brancas).`,
    `Melhor lance segundo o Stockfish: ${ply.bestMoveSan ?? "?"}; linha: ${ply.bestLineSan.join(" ")}`,
    `Resposta mais forte do adversário ao lance jogado: ${ply.refutationSan.join(" ") || "(nenhuma)"}`,
    ply.tags.length ? `Marcadores: ${ply.tags.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

async function consultStockfish(engine: Engine, depth: number, input: { fen?: unknown; lance?: unknown }): Promise<string> {
  if (typeof input.fen !== "string") return JSON.stringify({ erro: "fen ausente" });
  let board: Chess;
  try {
    board = new Chess(input.fen);
  } catch {
    return JSON.stringify({ erro: "FEN inválido" });
  }
  let played: string | undefined;
  if (typeof input.lance === "string" && input.lance.trim()) {
    try {
      played = board.move(input.lance.trim()).san;
    } catch {
      return JSON.stringify({ erro: `Lance ilegal nessa posição: ${input.lance}` });
    }
  }
  const fen = board.fen();
  if (board.isGameOver()) {
    return JSON.stringify({ lance: played, fim_de_jogo: board.isCheckmate() ? "xeque-mate" : "empate" });
  }
  const [line] = await engine.analyse(fen, depth);
  const cp = line ? scoreToCp(line.score) : 0;
  const whiteCp = board.turn() === "w" ? cp : -cp;
  return JSON.stringify({
    lance: played,
    avaliacao: pawns(whiteCp),
    melhor_continuacao: line ? uciLineToSan(fen, line.pv) : [],
  });
}

export class Coach {
  constructor(private engine: Engine, private depth: number, private client: Pick<Anthropic, "beta"> = new Anthropic()) {}

  /**
   * One coach turn about a decisive moment. `history` is the visible
   * conversation so far, starting with the coach's first message.
   */
  async reply(analysis: GameAnalysis, ply: PlyAnalysis, history: ChatTurn[]): Promise<string> {
    const messages: Anthropic.Beta.BetaMessageParam[] = [
      {
        role: "user",
        content: `${momentBriefing(analysis, ply)}\n\nComece a revisão deste momento.`,
      },
      ...history.map((turn) => ({ role: turn.role, content: turn.content })),
    ];

    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      const response = await this.client.beta.messages.create({
        model: MODEL,
        max_tokens: 16000,
        system: SYSTEM,
        tools: TOOLS,
        messages,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
      });

      if (response.stop_reason === "refusal") return "Não consegui responder a isso. Vamos voltar para a partida?";
      const toolUses = response.content.filter((block): block is Anthropic.Beta.BetaToolUseBlock => block.type === "tool_use");
      if (response.stop_reason !== "tool_use" || toolUses.length === 0 || round === MAX_TOOL_ROUNDS) {
        return response.content
          .filter((block): block is Anthropic.Beta.BetaTextBlock => block.type === "text")
          .map((block) => block.text)
          .join("\n")
          .trim();
      }

      messages.push({ role: "assistant", content: response.content });
      const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
      for (const use of toolUses) {
        results.push({
          type: "tool_result",
          tool_use_id: use.id,
          content: await consultStockfish(this.engine, this.depth, use.input as { fen?: unknown; lance?: unknown }),
        });
      }
      messages.push({ role: "user", content: results });
    }
    return "";
  }
}

/** Validates the conversation a client sends back: alternating turns, coach first, user last. */
export function parseHistory(value: unknown): ChatTurn[] {
  if (!Array.isArray(value)) return [];
  const turns = value.map((turn, i) => {
    const role = i % 2 === 0 ? "assistant" : "user";
    if (typeof turn !== "object" || turn === null || turn.role !== role || typeof turn.content !== "string") {
      throw new Error("Histórico de conversa inválido");
    }
    return { role, content: turn.content.slice(0, 4000) } as ChatTurn;
  });
  if (turns.length > 0 && turns[turns.length - 1].role !== "user") throw new Error("A última mensagem deve ser do aluno");
  return turns;
}
