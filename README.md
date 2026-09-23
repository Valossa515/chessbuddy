# ♞ ChessBuddy

Um parceiro de xadrez que revisa suas partidas com você. O Stockfish calcula, o Claude explica e conversa, e cada erro seu vira um exercício que volta nos dias seguintes.

Este é o MVP: revisão pós-partida.

## O que ele faz

- Busca suas partidas terminadas no Lichess (ou recebe um PGN colado).
- Analisa com o Stockfish cada posição e encontra os 3 a 5 momentos decisivos, usando a mesma curva de "chance de vitória" e os mesmos limites do Lichess (imprecisão, erro, erro grave).
- Conversa sobre cada momento: o treinador explica o que aconteceu, faz uma pergunta para você pensar e testa no Stockfish qualquer lance que você propuser ("e se Nd7?"). O LLM nunca inventa lances nem avaliações; quando precisa de uma variante nova, ele consulta o motor por uma ferramenta.
- Gera exercícios "ache o lance melhor" a partir dos seus erros, com repetição espaçada (caixas de Leitner: 1, 3, 7, 14 e 30 dias).

## Guardrail de fair play

O ChessBuddy pode acompanhar uma partida ao vivo, mas nunca interfere nela:

- O modo acompanhamento só retransmite a posição e o relógio. Ele não chama o Stockfish nem o treinador.
- Enquanto você estiver jogando, análise e treinador ficam bloqueados (HTTP 423). Isso vale tanto para partidas acompanhadas no app quanto para qualquer partida sua em andamento no Lichess, detectada pelo status público do usuário.
- Se não der para confirmar no Lichess que você não está jogando, o treinador fica pausado (falha fechada).
- Só partidas encerradas são analisadas: status do Lichess em andamento ou PGN sem resultado (`*`) são recusados.

Limite conhecido: um PGN colado com resultado falso não tem como ser detectado sem informar o usuário do Lichess. Por isso a interface sempre envia o usuário, quando ele foi informado.

## Como rodar

Precisa de Node 22 ou mais novo e de uma chave da API do Claude.

```bash
npm install
cp .env.example .env   # preencha ANTHROPIC_API_KEY
npm start              # ou npm run dev, que reinicia ao salvar
```

Abra `http://localhost:3000`, digite seu usuário do Lichess e escolha uma partida.

### Configurações (`.env`)

| Variável | Padrão | Para quê |
| --- | --- | --- |
| ANTHROPIC_API_KEY |  | Chave do Claude, usada pelo treinador |
| CHESSBUDDY_MODEL | claude-opus-5 | Modelo do treinador |
| CHESSBUDDY_DEPTH | 14 | Profundidade do Stockfish |
| STOCKFISH_PATH |  | Stockfish nativo, mais forte e mais rápido que o WASM incluso |
| PORT | 3000 | Porta do servidor |

## Testes

```bash
npm test        # testes unitários + análise real da "Partida da Ópera" com o Stockfish
npm run typecheck
```

## Estrutura

```text
src/
  engine.ts      wrapper UCI do Stockfish (WASM ou binário nativo)
  analysis.ts    avaliação lance a lance e escolha dos momentos decisivos
  coach.ts       treinador com Claude + ferramenta consultar_stockfish
  exercises.ts   exercícios e repetição espaçada
  guardrail.ts   regras de fair play
  lichess.ts     API pública do Lichess (partidas, status, acompanhamento)
  store.ts       armazenamento em JSON (data/db.json)
  server.ts      API HTTP + arquivos da interface
web/             interface: tabuleiro, momentos, chat e exercícios
```

## Próximos passos possíveis

- Voz (fala e escuta no navegador) na revisão.
- Chess.com como segunda fonte de partidas.
- Padrões recorrentes entre partidas ("você perde peças em cravadas").
- Teoria de abertura a partir do explorer do Lichess, só para as aberturas que você joga.
- Jogar contra o ChessBuddy com conversa ao vivo (fora de partidas ranqueadas).
