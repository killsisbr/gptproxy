# ESTRUTURA — Arquitetura do GPTProxy

Ver [IDEIA.md](IDEIA.md) para o propósito do produto.

## Componentes

```text
src/
  index.ts              servidor Hono; rotas de health, models, sessions, chat
  routes/chat.ts         endpoint OpenAI-compatible /v1/chat/completions
  services/chatgpt.ts     Playwright: browser, page, login, envio/leitura de prompt
  services/sessions.ts    GptProxySessionStore: mapeamento session → conversation
  utils/prompt.ts         construção de prompts (hidratação, protocolo, incremental)
  utils/tools.ts          parsing de tool_calls e final_answer a partir da resposta do ChatGPT
```

## Fluxo de uma chamada com tools e sessão

```text
Harness (llm-gptproxy adapter)
  → POST /v1/chat/completions
    header x-dsh-session-id: <harness session id>
    body.tools: [...]
→ GPTProxy routes/chat.ts
  → GptProxySessionStore.getOrCreate(sessionKey)
  → se não hidratada: buildHydrationPrompt() (uma vez por sessão)
  → buildSessionToolPrompt() (mensagens incrementais)
→ services/chatgpt.ts askChatGPT()
  → abre a mesma conversation (por URL) ou cria uma nova na primeira vez
  → envia prompt, lê resposta
→ utils/tools.ts parseResponse()
  → extrai tool_calls ou final_answer
→ resposta OpenAI-compatible (streaming ou não) volta ao Harness
→ Harness executa a tool localmente (fora do GPTProxy)
→ Harness envia tool result em nova chamada, mesmo x-dsh-session-id
→ GPTProxy retoma a MESMA conversation
```

## Responsabilidades e limites

| Componente | Responsável por | NÃO responsável por |
|---|---|---|
| ChatGPT | decidir, conversar, emitir tool_call | executar qualquer coisa localmente |
| GPTProxy | transporte HTTP, sessão/conversation mapping, hidratação, protocolo JSON | executar tools, política de permissão, filesystem, shell |
| `llm-gptproxy` (Harness) | adapter LLM: serializar request, traduzir StreamChunk, propagar session id | manter estado de conversa ChatGPT |
| Harness (agent loop) | executar tools, aplicar permissões, registrar session log | manter estado de browser/Playwright |

## Session Manager

Vive em `services/sessions.ts` (`GptProxySessionStore`). Mantém, em memória, por `sessionKey`:

- `conversationUrl` — URL da conversa ChatGPT associada.
- `hydrationKey` — hash do catálogo de tools já hidratado nesta sessão.
- `createdAt` / `lastUsedAt` / `turns` — para TTL e diagnóstico.

Detalhes completos de lifecycle: [SESSION.md](SESSION.md).

## O que NÃO é duplicado aqui

GPTProxy não reimplementa:

- registro de tools;
- política de filesystem/shell/sandbox;
- aprovações;
- agent loop;
- session log do Harness.

Essas responsabilidades pertencem exclusivamente ao DeepSeek Harness. GPTProxy apenas transporta a intenção (`tool_calls`) e o resultado (`tool` message) entre o ChatGPT e o Harness.

## Concorrência

Uma única `BrowserContext`, uma única `Page`, e um mutex global (`uiMutex`) serializam todo acesso à UI do ChatGPT — inclusive entre sessões diferentes. Isso é uma limitação conhecida, não uma garantia de paralelismo. Ver [PLANO.md](PLANO.md) para quando isso deve ser revisitado, e [BENCHMARK.md](BENCHMARK.md) para medir o impacto antes de otimizar.
