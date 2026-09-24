# GPTProxy Login UI

Este GPTProxy roda localmente na VPS em `127.0.0.1:3333` e expõe uma interface HTTPS tokenizada pelo Nginx do Harness para controlar o navegador Playwright usado no login do ChatGPT.

## URLs

- Health local: `http://127.0.0.1:3333/health`
- Modelos local: `http://127.0.0.1:3333/v1/models`
- UI de login HTTPS: `https://dsh.killsis.com/login-ui?token=$(cat /root/killsis/gptproxy/.login-ui-token)`

A UI usa o token salvo em `.login-ui-token`. Não compartilhe esse token.

## Fluxo de login

1. Abra a URL da UI de login HTTPS.
2. Clique em **Abrir ChatGPT**.
3. Use a imagem da página para clicar nos campos do ChatGPT.
4. Digite texto pelo campo da UI e use **Digitar**, **Enter**, **Tab** etc.
5. Quando o status virar `logado`, clique em **Salvar sessão**.
6. Teste o proxy com:

```bash
curl -sS http://127.0.0.1:3333/health
curl -sS http://127.0.0.1:3333/v1/models
```

## Teste de chat

```bash
cat > /tmp/gptproxy-chat-test.json <<'JSON'
{"model":"chatgpt-latest","messages":[{"role":"user","content":"responda apenas ok"}],"stream":false}
JSON
curl -sS -X POST http://127.0.0.1:3333/v1/chat/completions \
  -H 'Content-Type: application/json' \
  --data-binary @/tmp/gptproxy-chat-test.json
```

Se retornar `Login required`, a sessão do ChatGPT ainda não está autenticada ou expirou.

## Rotas de controle

Todas exigem `?token=<token>` ou header `x-login-token`.

- `GET /login-ui`
- `GET /debug/login/status`
- `POST /debug/login/start`
- `GET /debug/login/screenshot`
- `POST /debug/login/click` com `{ "x": 10, "y": 10 }`
- `POST /debug/login/type` com `{ "text": "..." }`
- `POST /debug/login/press` com `{ "key": "Enter" }`
- `POST /debug/login/save`
- `POST /debug/login/restart`

## PM2

```bash
pm2 status gptproxy
pm2 restart gptproxy --update-env
pm2 logs gptproxy --lines 100 --nostream
pm2 save
```

## Nginx

As rotas HTTPS ficam no arquivo ativo `/etc/nginx/sites-enabled/dsh.killsis.com`:

- `/login-ui` -> `http://127.0.0.1:3333/login-ui`
- `/debug/login/` -> `http://127.0.0.1:3333/debug/login/`

Backups criados durante a configuração:

- `/root/backups_nginx/nginx_before_gptproxy_login_ui_*.tar.gz`
- `/root/backups_nginx/nginx_enabled_dsh_before_gptproxy_login_ui_*.conf`
