# PROTOCOL — Contrato GPTProxy ↔ Harness

Ver [ESTRUTURA.md](ESTRUTURA.md) para onde cada peça deste contrato vive no código.

## Transporte

GPTProxy expõe um endpoint OpenAI-compatible:

```text
POST /v1/chat/completions
```

Aceita o corpo padrão OpenAI (`model`, `messages`, `tools`, `stream`, `temperature`, `max_tokens`, `stop`).

## Identidade de sessão

O Harness envia a identidade da sua sessão através do header:

```text
x-dsh-session-id: <harness session id>
```

Alternativamente (fallback, quando o header não estiver disponível no transporte), o corpo pode carregar:

```json
{
  "metadata": { "dsh_session_id": "<harness session id>" }
}
```

Sem esse identificador, GPTProxy opera em modo stateless: cada chamada abre uma nova conversa ChatGPT. Com ele, GPTProxy mantém uma conversa ChatGPT por sessão Harness. Esse id é o Harness Chat/Session id (`Session.id`, `packages/core/agent-loop/src/agent.ts`), não um id por request HTTP, por tool call, ou por execução; ver [SESSION.md](SESSION.md) para o ciclo de vida completo.

## Modo sem tools

Requisição sem `tools` (ou `tools: []`): GPTProxy envia o prompt ao ChatGPT e retorna a resposta como texto, no formato `chat.completion` ou `chat.completion.chunk` (streaming).

## Modo com tools

Quando `tools` está presente e não vazio:

1. Se a sessão ainda não foi hidratada para o catálogo de tools atual, GPTProxy injeta uma vez o prompt de hidratação (ver `buildHydrationPrompt` em `utils/prompt.ts`), que estabelece:
   - que o ChatGPT está operando através do DeepSeek Harness;
   - que ele não tem acesso direto ao computador;
   - o protocolo de resposta JSON obrigatório;
   - o catálogo de tools disponíveis.
2. GPTProxy envia o prompt incremental (apenas mensagens desde o último turno do assistente).
3. ChatGPT deve responder com exatamente um objeto JSON:
   - `{"tool_calls":[{"name": "...", "arguments": {...}}]}` para solicitar ações;
   - `{"final_answer": "..."}` para responder diretamente.
4. GPTProxy converte a resposta para o formato OpenAI `tool_calls` (`finish_reason: "tool_calls"`) ou texto (`finish_reason: "stop"`).
5. Se o ChatGPT responder com texto livre em vez do protocolo, GPTProxy reenvia uma mensagem de reforço de protocolo (`PROTOCOL_REINFORCE`) e tenta novamente uma vez.

## Tool result

O Harness executa a tool localmente e envia o resultado como uma nova chamada `POST /v1/chat/completions`, com o mesmo `x-dsh-session-id`, incluindo uma mensagem `role: "tool"` com `tool_call_id` correspondente. GPTProxy renderiza isso como `Tool result for <name>: <content>` dentro do prompt incremental da mesma conversa.

## Streaming

Quando `stream: true`, a resposta segue Server-Sent Events (`data: {...}\n\n`, terminando em `data: [DONE]\n\n`), compatível com o formato `chat.completion.chunk` da OpenAI, incluindo `delta.tool_calls[].function.arguments` fragmentado.

## Erros

| Situação | HTTP | Corpo |
|---|---|---|
| `messages` ausente ou vazio | 400 | `{"error":{"message":"\"messages\" must be a non-empty array"}}` |
| Sessão ChatGPT não autenticada | 401 | `{"error":{"message":"Login required. Run \"bun run login\"."}}` |
| Sessão nova resolveria para uma conversa já vinculada a outra sessão viva | 409 | `{"error":{"code":"SESSION_CONVERSATION_COLLISION","message":"...","sessionKey":"...","conversationUrl":"...","ownedBy":"..."}}` |
| Falha inesperada (inclui timeout de composer interceptado por overlay/modal) | 500 | `{"error":{"message": "<detalhe>"}}` |

## Problemas conhecidos corrigidos

- Uma versão anterior do endpoint de streaming chamava `sw.end()`, método inexistente na `StreamingApi` do Hono (`TypeError: sw.end is not a function`). A chamada foi removida: `hono/streaming`'s `stream()` já fecha o stream automaticamente ao final do callback. Ver `routes/chat.ts`.
- Uma versão anterior podia vincular duas sessões diferentes à mesma `conversationUrl` (ver [SESSION.md](SESSION.md#isolamento-entre-sessões)). Corrigido; validado com 20 sessões simultâneas e 0 colisões.

## Limitação conhecida não corrigida

Um modal de rate-limit da conta ChatGPT (`#modal-conversation-history-rate-limit`) pode interceptar cliques no composer. `sendPrompt()` falha explicitamente com `TimeoutError` (não trava indefinidamente), mas o corpo do erro 500 resultante não nomeia a causa real — a introspecção `/debug/dom` também não relata esse modal hoje.
