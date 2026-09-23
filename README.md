# GPTProxy

Ponte OpenAI-compatível entre uma sessão real do ChatGPT (via Playwright) e o DeepSeek Harness. Ver [IDEIA.md](IDEIA.md) para o propósito do produto, [ESTRUTURA.md](ESTRUTURA.md) para a arquitetura, [PROTOCOL.md](PROTOCOL.md) para o contrato de rede, e [SESSION.md](SESSION.md) para o lifecycle de sessão.

## O que este projeto é hoje

Um servidor HTTP (Bun + Hono) que expõe:

```text
POST /v1/chat/completions   OpenAI-compatible, com suporte a tools e streaming
GET  /v1/models
GET  /v1/health
GET  /health
GET  /debug/sessions
DELETE /debug/sessions/:key
```

e usa Playwright para conversar com `https://chatgpt.com/` através de uma sessão de navegador real e autenticada.

Não é mais o script CLI interativo de versões anteriores; esse fluxo está descontinuado em favor do endpoint OpenAI-compatible consumido pelo DeepSeek Harness através do provider `chatgpt-proxy` (`@deepseek-ai/dsh-llm-gptproxy`).

## Pré-requisitos

- [Bun](https://bun.sh/)
- Google Chrome instalado (o proxy usa o canal `chrome` do Playwright)

## Instalação

```bash
bun install
```

## Primeiro login

```bash
bun run login
```

Abre um navegador visível para login manual no ChatGPT; a sessão fica salva em `./userData/` e `storageState.json` para reuso.

## Executar o servidor

```bash
set PORT=3000
bun src/index.ts --headed --browser=chrome
```

Use uma porta diferente da usada pelo DeepSeek Harness Web GUI (padrão `3080`); `3000` é o valor padrão esperado pelo adapter `llm-gptproxy`.

## Uso pelo DeepSeek Harness

Configure o provider `chatgpt-proxy` no Harness (`packages/llm/llm-gptproxy`), apontando `baseURL` para `http://localhost:3000/v1`. O Harness então trata o GPTProxy como qualquer outro provider LLM, com a diferença de que as respostas vêm de uma sessão real do ChatGPT e a mesma conversa é reutilizada por sessão do Harness (ver [SESSION.md](SESSION.md)).

## Problema conhecido corrigido

Uma versão anterior do endpoint de streaming lançava `TypeError: sw.end is not a function`. Corrigido: `hono/streaming`'s `stream()` já fecha o stream automaticamente; a chamada extra foi removida. Ver [PROTOCOL.md](PROTOCOL.md#problema-conhecido-corrigido).

## Documentos

- [IDEIA.md](IDEIA.md) — visão do produto.
- [ESTRUTURA.md](ESTRUTURA.md) — arquitetura e responsabilidades.
- [PROTOCOL.md](PROTOCOL.md) — contrato GPTProxy ↔ Harness.
- [SESSION.md](SESSION.md) — lifecycle de sessão e hidratação.
- [BENCHMARK.md](BENCHMARK.md) — metodologia de medição.
- [PLANO.md](PLANO.md) — fases e status de implementação.

## Licença

Uso educacional/interno. Use de forma responsável e de acordo com os termos de serviço do OpenAI.
