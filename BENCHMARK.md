# BENCHMARK — Metodologia GPTProxy + Harness

Ver [IDEIA.md](IDEIA.md) para por que sessão persistente importa, e [SESSION.md](SESSION.md) para o mecanismo medido aqui.

## Princípio

Medir antes de otimizar. Nenhuma mudança de arquitetura de sessão, concorrência ou hidratação deve ser justificada por impressão; deve ser justificada por números coletados com esta metodologia.

## Métricas

| Métrica | Definição |
|---|---|
| cold session total | tempo da primeira mensagem de uma sessão nova até a resposta final |
| warm session total | tempo de uma mensagem em sessão já hidratada até a resposta final |
| TTFT | tempo até o primeiro chunk de texto/tool-call no streaming |
| tool-call latency | tempo entre o envio do prompt e a emissão do `tool_calls` pelo ChatGPT |
| tool execution latency | tempo real de execução da tool no Harness (fora do GPTProxy) |
| tool-result round trip | tempo entre o Harness enviar o tool result e o ChatGPT responder |
| round trips | número de chamadas `/v1/chat/completions` por tarefa completa |
| proxy overhead | tempo gasto em HTTP/parsing/streaming no próprio GPTProxy |
| playwright overhead | tempo gasto em navegação, envio e leitura de UI do ChatGPT |
| failure rate | falhas por N execuções do mesmo cenário |
| recovery time | tempo para uma sessão se recuperar de uma falha de leitura/login |

## Cenários mínimos

1. Conversa simples, sem tools.
2. Uma tool (`read_file`).
3. Duas tools em sequência (`write_file` + `read_file`) — igual ao E2E já validado.
4. Tarefa multi-step (`list_files` + `read_file` + `edit_file` + rodar testes).
5. Sessão nova (cold) vs. sessão reutilizada (warm) para o mesmo cenário.
6. Restart do GPTProxy no meio de uma sessão (mede o custo de recovery documentado em SESSION.md).
7. Duas sessões concorrentes (A e B), para observar o efeito do mutex global.

## Comparação principal

```text
nova conversa (cold, sem sessão)
vs
conversa reutilizada (warm, com x-dsh-session-id)
```

Esta é a comparação que justifica ou invalida a decisão de sessão persistente registrada em [2026-09-24-gptproxy-session-continuity](../../deep-seek-harness/.agents/notes/implemented/feature/2026-09-24-gptproxy-session-continuity.md).

## Formato de registro

Cada execução de benchmark deve gravar um evento estruturado (JSON Lines) com pelo menos:

```json
{
  "scenario": "two-tools-warm",
  "sessionKey": "bench-001",
  "cold": false,
  "ttftMs": 812,
  "totalMs": 4310,
  "roundTrips": 2,
  "toolCallLatencyMs": [740, 690],
  "toolResultRoundTripMs": [1200],
  "error": null
}
```

Correlacionar pelo `sessionKey`, que é o mesmo valor enviado como `x-dsh-session-id`.

## Estado atual

Nenhum benchmark automatizado existe ainda. Este documento define a metodologia; a implementação de um runner de benchmark é trabalho futuro (ver [PLANO.md](PLANO.md), Fase 6). Até lá, qualquer alegação de performance deve ser tratada como não verificada.
