# SESSION — Lifecycle de sessão GPTProxy

Ver [PROTOCOL.md](PROTOCOL.md) para como a identidade de sessão trafega na rede, e [ESTRUTURA.md](ESTRUTURA.md) para onde o código vive.

## Identidade

```text
Harness Session ID  (gerado e possuído pelo Harness)
      ↓
GPTProxy Session     (chave de lookup em GptProxySessionStore)
      ↓
ChatGPT Conversation (URL real da conversa, ex.: https://chatgpt.com/c/<uuid>)
```

O Harness nunca vê nem manipula a URL da conversa ChatGPT; ela é estado interno do GPTProxy.

`sessionKey` corresponde ao **Harness Chat ID** (`Session.id`, imutável, atribuído uma vez na criação do chat — ver `packages/core/agent-loop/src/agent.ts`, `sessionId: this.session.id`). O mesmo valor persiste em todos os turnos, tool calls e tool results de um chat; ele muda apenas quando o Harness cria um chat diferente. Requests HTTP individuais, tool call ids e ids de execução não têm relação com `sessionKey` e não afetam qual conversa é usada.

Um subagente Copilot (ver [COPILOT.md](../../deep-seek-harness/packages/llm/llm-gptproxy/COPILOT.md)) recebe seu próprio `Session.id` independente, gerado pelo driver de subagentes do Harness (`SessionId(randomUUID())`) — não derivado do `sessionKey` do chat pai por convenção de string. Isso dá ao Copilot uma conversa ChatGPT dedicada automaticamente, sem qualquer mapeamento adicional no GPTProxy.

## Criação

Na primeira chamada com um `sessionKey` desconhecido:

1. `GptProxySessionStore.getOrCreate(key)` cria um registro vazio (`conversationUrl` ausente, `hydrationKey` ausente).
2. `askChatGPT()` não encontra `conversationUrl`, então chama `startNewChat()`, que navega diretamente para `https://chatgpt.com/` (não clica em botão — ver Isolamento entre sessões abaixo).
3. O primeiro envio real (hidratação, se houver, ou o prompt do turno) dispara `bindNewConversationUrl()`, que aguarda deterministicamente a URL real (`/c/<id>`, excluindo o placeholder transitório `/c/WEB:<uuid>`) antes de vincular.
4. `bindNewConversationUrl()` verifica colisão (`GptProxySessionStore.ownerOf()`) antes de vincular; ver Isolamento entre sessões.

## Reutilização

Em chamadas seguintes com o mesmo `sessionKey`:

1. `GptProxySessionStore.getOrCreate(key)` retorna o registro existente.
2. `askChatGPT()` navega para `conversationUrl` em vez de criar uma nova conversa.
3. Se `hydrationKey` já corresponde ao hash do catálogo de tools atual, a hidratação é pulada.
4. Apenas o prompt incremental (mensagens desde o último turno) é enviado.

## Hidratação

A hidratação é reexecutada quando o hash do catálogo de tools (`toolSignature()`) muda — por exemplo, quando o Harness habilita/desabilita uma tool ou altera seu schema. Isso evita reenviar o protocolo completo a cada turno, mas garante que o ChatGPT seja informado quando as capacidades disponíveis mudarem.

## TTL e cleanup

`GptProxySessionStore` remove sessões cujo `lastUsedAt` excede o TTL configurado (`GPT_PROXY_SESSION_TTL_MS`, padrão 6 horas) a cada operação de leitura/escrita (`cleanup()` interno, chamado por `getOrCreate()` e `list()`).

Isso é limpeza de memória do processo GPTProxy, não da conversa ChatGPT em si — a conversa continua existindo no histórico do ChatGPT; apenas o mapeamento local é esquecido.

## Recuperação

### GPTProxy reiniciado

O `GptProxySessionStore` é em memória. Um reinício do processo GPTProxy apaga todos os mapeamentos `sessionKey → conversationUrl`. Na próxima chamada de uma sessão conhecida do Harness, o GPTProxy trata como sessão nova: cria uma conversa nova e rehidrata. Isso é uma limitação conhecida, documentada, não uma falha silenciosa — a Agent Note [2026-09-24-gptproxy-session-continuity](../../deep-seek-harness/.agents/notes/implemented/feature/2026-09-24-gptproxy-session-continuity.md) registra essa decisão.

### Browser/page morre

`askChatGPT()` já tem uma tentativa de recuperação de login (`ensureLoggedIn()` + retry) para falhas de leitura de resposta. Não há hoje recuperação automática de uma `Page` fechada/crashada fora do fluxo de login; isso é trabalho futuro (ver [PLANO.md](PLANO.md)).

### Conversa ChatGPT não existe mais (excluída manualmente)

Não há hoje detecção explícita desse caso. `page.goto(conversationUrl)` para uma conversa apagada tipicamente redireciona para uma tela vazia; o comportamento resultante não foi validado e é uma lacuna conhecida.

## Isolamento entre sessões

Cada `sessionKey` mapeia para no máximo uma `conversationUrl`. **Validado com evidência real**: 20 sessões novas em sequência produziram 20 `conversationUrl` distintas e 0 colisões; memória isolada confirmada em 7 sessões com segredos exclusivos (nenhuma sessão recordou o segredo de outra).

Duas causas raiz foram corrigidas para alcançar essa garantia:

1. ChatGPT renderiza uma URL client-side transitória `/c/WEB:<uuid>` por ~1-2s antes de adotar a URL real `/c/<uuid>`; código anterior aceitava qualquer URL contendo `/c/`, incluindo a transitória. `REAL_CONVERSATION_URL` agora exclui explicitamente o prefixo `WEB:`.
2. `startNewChat()` clicava em um botão "New chat" que podia falhar em navegar sem erro visível, deixando a página presa na conversa anterior. Substituído por `page.goto('https://chatgpt.com/')` direto, que ou navega ou lança erro — sem estado intermediário ambíguo.

`GptProxySessionStore.ownerOf(url)` impede que a correção regrida silenciosamente: se uma sessão nova resolver para uma URL já pertencente a outra sessão viva, `bindNewConversationUrl()` lança `SessionConversationCollisionError` (HTTP 409) em vez de vincular. Reproduzido e confirmado antes da correção (colisão real capturada), e nunca mais observado depois.

Não há, porém, isolamento de paralelismo real: todas as sessões competem pelo mesmo `uiMutex` e pela mesma `Page` física, então chamadas concorrentes de sessões diferentes são serializadas, não executadas em paralelo.

Um modal de rate-limit da conta ChatGPT (`#modal-conversation-history-rate-limit`) pode interceptar cliques no composer sem que `/debug/dom` o reporte hoje; quando isso ocorre, `sendPrompt()` falha com `TimeoutError` explícito (não trava indefinidamente, graças aos timeouts da Fase 4), mas a causa real não é diagnosticada automaticamente. Isso não é uma falha de isolamento — nenhuma sessão vinculou a URL errada durante esse modal, os requests simplesmente falharam explicitamente — mas é uma lacuna de diagnóstico conhecida.

## Múltiplas sessões simultâneas

Hoje: suportadas logicamente (cada uma mantém sua própria conversa), mas executadas sequencialmente por causa do mutex global. Ver [BENCHMARK.md](BENCHMARK.md) para medir o custo disso antes de investir em paralelismo real (pool de pages, por exemplo).

## Introspecção

```text
GET /debug/sessions
DELETE /debug/sessions/:key
```

Listam ou removem sessões vivas para diagnóstico manual.
