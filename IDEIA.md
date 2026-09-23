# IDEIA — GPTProxy como ponte de sessão persistente para o DeepSeek Harness

## O que estamos construindo

GPTProxy é uma ponte entre uma sessão real do ChatGPT (via navegador, autenticada) e o DeepSeek Harness. O objetivo não é usar o ChatGPT como uma API LLM stateless: o objetivo é transformar uma conversa contínua com o ChatGPT em uma interface para o Harness.

```text
ChatGPT   = inteligência, conversa, decisão de usar ferramenta
GPTProxy  = ponte, protocolo, sessão ChatGPT
Harness   = orquestração, execução, permissões, logs
Tools     = capacidades locais (filesystem, shell, git, ...)
```

## Experiência desejada

O usuário conversa normalmente com o ChatGPT. Quando uma tarefa exige uma ação local, o ChatGPT emite uma tool call; o Harness valida e executa; o resultado volta para a mesma conversa; o ChatGPT continua naturalmente. Nenhuma etapa reinicia a conversa nem expõe o computador diretamente ao modelo.

```text
Oi
Oi! Tudo certo?

Dá uma olhada no projeto e vê por que o servidor está dando erro.
Vou verificar. → tool_call(list_files)
[Harness executa]
Encontrei o problema em ...
```

## Princípio de segurança

O ChatGPT nunca recebe acesso direto ao computador. Ele decide e solicita; o Harness valida, autoriza e executa através do seu próprio registro de tools, política de filesystem, política de shell, aprovações e log de sessão. GPTProxy não duplica nenhuma dessas responsabilidades e não executa ações locais.

## Por que sessão persistente, não API stateless

Uma API stateless reconstrói o histórico inteiro a cada chamada e reabre uma conversa nova a cada turno. Isso funciona como MVP de prova de tool call, mas não entrega a experiência de "conversar com o ChatGPT enquanto ele opera o Harness": o modelo nunca acumula uma conversa real, e o protocolo de tools precisa ser reenviado por completo a cada turno.

A sessão persistente resolve isso mapeando:

```text
Harness Session ID → GPTProxy Session → ChatGPT Conversation
```

Ver [SESSION.md](SESSION.md) para o lifecycle completo e [PROTOCOL.md](PROTOCOL.md) para o contrato de transporte.

## Copiloto: ChatGPT como consultor do agente principal

Além de servir diretamente o usuário, uma conversa ChatGPT via GPTProxy também pode servir como segunda opinião técnica para o agente principal do Harness — um Copiloto que analisa e recomenda, nunca executa. Ver [COPILOT.md](../../deep-seek-harness/packages/llm/llm-gptproxy/COPILOT.md) para a arquitetura, que reutiliza a infraestrutura de subagentes já existente do Harness.

## O que este projeto não é

- Não é um executor local. GPTProxy nunca chama filesystem, shell ou subprocess diretamente em nome do modelo.
- Não é uma reimplementação do sistema de tools do Harness.
- Não é uma forma de dar ao ChatGPT acesso irrestrito ao computador.

## Documentos relacionados

- [ESTRUTURA.md](ESTRUTURA.md) — arquitetura, módulos, responsabilidades, limites.
- [PROTOCOL.md](PROTOCOL.md) — contrato de transporte GPTProxy ↔ Harness.
- [SESSION.md](SESSION.md) — lifecycle de sessão, hidratação, TTL, recovery.
- [COPILOT.md](../../deep-seek-harness/packages/llm/llm-gptproxy/COPILOT.md) — arquitetura do Copiloto como subagente.
- [BENCHMARK.md](BENCHMARK.md) — metodologia e métricas.
- [PLANO.md](PLANO.md) — fases concretas de implementação.
