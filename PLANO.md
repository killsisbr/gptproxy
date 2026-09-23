# PLANO — Fases de implementação

Ver [IDEIA.md](IDEIA.md) para a visão, [ESTRUTURA.md](ESTRUTURA.md) para a arquitetura atual, e [COPILOT.md](COPILOT.md) para a arquitetura do Copiloto.

## Rodada 1 — Sessão persistente básica (concluída)

- Documentação inicial criada (`IDEIA.md`, `ESTRUTURA.md`, `PROTOCOL.md`, `SESSION.md`, `BENCHMARK.md`).
- `sw.end is not a function` corrigido.
- `x-dsh-session-id` transportado do adapter Harness até o GPTProxy; `GptProxySessionStore` implementado.
- Hidratação incremental por hash de catálogo de tools implementada.
- Benchmark real executado (67+ turnos medidos); resultados em `BENCHMARK.md`.

## Rodada 2 — Correção de isolamento e Copiloto (concluída)

### Isolamento de sessão

- Causa raiz real identificada e corrigida: URL transitória `/c/WEB:<uuid>` do ChatGPT aceita incorretamente como real; `startNewChat()` clicando em botão sem confirmar navegação.
- Correção: navegação direta via `page.goto()`, espera determinística da URL real (`waitForNewConversationUrl`), invariante anti-colisão (`SessionConversationCollisionError`, HTTP 409).
- **Validado com evidência real**: 20 sessões novas → 20 `conversationUrl` distintas → 0 colisões. Memória isolada confirmada em 7 sessões com segredos exclusivos.

### Continuidade

- 10 turnos em uma sessão (conversa + tools intercaladas + recall de memória no 8º turno) → `conversationUrl` estável, hidratação disparada apenas 1x.

### Robustez

- `messages` ausente/inválido retorna `400` (antes travava indefinidamente).
- Todos os timeouts implícitos do Playwright tornados explícitos (30s).

### Provider efetivo

- Achado real: `$DSH_HOME/settings.yaml` sobrepõe silenciosamente `--patch`. `verify-provider.ps1` criado para confirmar via evidência do GPTProxy (`/debug/sessions`) em vez de confiar no patch sozinho.

### Copiloto

- Implementado como segunda instância de `@deepseek-ai/dsh-tool-subagent` (`provider: spawn`, `backgroundMode: continuable`), reutilizando toda a infraestrutura de subagentes existente do Harness — nenhum sistema novo criado.
- Identidade de conversa dedicada confirmada por evidência de código (`Session.id` independente por child, não convenção de string).
- **E2E real validado**: agente principal consulta Copiloto sem perguntar ao usuário (Fase 7); reuso do mesmo child/`conversationUrl` via `send_message` provado com evidência direta (Fase 8: 1 nova sessão GPTProxy, 4 turnos acumulados); isolamento entre 2 chats pai diferentes provado (Fase 9: segredos KILO-9901/LIMA-3302 recuperados corretamente, sem cruzamento).

Detalhes completos em [COPILOT.md](COPILOT.md).

## Trabalho pendente (não iniciado nesta rodada)

### Recovery e cleanup

- Detectar e tratar `conversationUrl` inválida (conversa apagada/inacessível).
- Recuperação automática de `Page` fechada/crashada fora do fluxo de login.
- Testar explicitamente reiniciar o GPTProxy no meio de uma sessão ativa.
- Detectar o modal de rate-limit da conta (`#modal-conversation-history-rate-limit`) explicitamente em vez de deixá-lo aparecer apenas como `TimeoutError` genérico.

### Performance (não investigada nesta rodada, por instrução explícita)

- Separar tempo real de geração do ChatGPT do overhead de polling DOM do Playwright dentro de `uiRoundTripMs` (~45-47s constantes por turno).
- Investigar por que uma chamada completa ao Copiloto via Harness real leva ~474s, muito acima do custo isolado de uma chamada GPTProxy.
- Decisão de produto pendente: aumentar o timeout de idle stream do modelo principal, tornar a delegação ao Copiloto genuinamente assíncrona, ou atacar a latência do GPTProxy — nessa ordem de investigação, não simultaneamente.

### Copiloto — refinamentos

- Filtrar contexto de sistema global (ex.: `<available_skills>`) do prompt do child do Copiloto, se isso se mostrar necessário na prática.
- Decisão de produto: promover o Copiloto ao bundle base (`packages/bundle/base/cordis.patch.yml`) ou mantê-lo opt-in via patch.

## Riscos conhecidos

- Recovery de `Page` morta sem duplicar navegação ou perder mensagens em trânsito exige cuidado com o `uiMutex`.
- O mutex global pode ser um gargalo sério para múltiplas sessões/Copilotos simultâneos; medir antes de investir em pool de pages.
- O modal de rate-limit da conta pode aparecer de forma imprevisível durante bateria de testes intensa; não há hoje forma de distingui-lo de outras falhas de composer sem inspeção manual do DOM.
