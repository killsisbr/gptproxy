import { Context } from 'hono';
import { stream as honoStream } from 'hono/streaming';
import { getLoginStatus, askChatGPT, LOGIN_REQUIRED, Attachment, SessionConversationCollisionError } from '../services/chatgpt.ts';
import { buildHydrationPrompt, buildPrompt, buildSessionToolPrompt, buildToolPrompt, toolSignature } from '../utils/prompt.ts';
import { extractToolCalls, parseResponse, ParsedToolCall } from '../utils/tools.ts';

const PROTOCOL_REINFORCE =
  'REPROMPT: your previous reply violated the protocol - it was free text, not the mandatory JSON object. '
  + 'If you refused because you thought an action was unavailable, correct that. Reply NOW with ONLY one JSON '
  + 'object: either {"tool_calls":[...]} or {"final_answer":"..."}. Nothing else.';


function unwrapFinalAnswer(text: string): string {
  const parsed = parseResponse(text);
  return parsed.calls.length === 0 && parsed.answer ? parsed.answer : text;
}

const MIME_EXT: Record<string, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/gif': 'gif',
  'image/webp': 'webp', 'image/svg+xml': 'svg', 'image/bmp': 'bmp',
  'application/pdf': 'pdf', 'text/plain': 'txt', 'application/octet-stream': 'bin',
};

function extForMime(mime: string): string {
  const ext = MIME_EXT[mime.split(';')[0]];
  return ext ?? 'bin';
}

async function sanitizeMessages(messages: any[]): Promise<{ clean: any[]; attachments: Attachment[] }> {
  const clean: any[] = [];
  const attachments: Attachment[] = [];
  for (const msg of messages || []) {
    const content = msg?.content;
    if (Array.isArray(content)) {
      const textParts: string[] = [];
      const m = { ...msg, content: '' };
      for (const part of content) {
        if (!part || typeof part !== 'object') {
          textParts.push(String(part));
          continue;
        }
        if (part.type === 'image_url' || part.type === 'image') {
          const url = part.image_url?.url ?? part.imageUrl?.url ?? part.image ?? part.url;
          if (typeof url === 'string' && url.startsWith('data:')) {
            const md = /^data:([^,]+)?,(.*)$/s.exec(url);
            if (md) {
              const mime = (md[1] || 'application/octet-stream').split(';')[0];
              attachments.push({
                filename: `attach-${attachments.length + 1}.${extForMime(mime)}`,
                mime,
                data: Buffer.from(md[2], 'base64'),
              });
              textParts.push(`[anexo: ${attachments[attachments.length - 1].filename}]`);
              continue;
            }
          } else if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
            try {
              const resp = await fetch(url);
              if (resp.ok) {
                const buf = Buffer.from(await resp.arrayBuffer());
                const mime = resp.headers.get('content-type')?.split(';')[0] || 'application/octet-stream';
                attachments.push({ filename: `attach-${attachments.length + 1}.${extForMime(mime)}`, mime, data: buf });
                textParts.push(`[anexo: ${attachments[attachments.length - 1].filename}]`);
                continue;
              }
            } catch { /* fallthrough */ }
            textParts.push(`[imagem: ${url}]`);
            continue;
          }
          textParts.push('[imagem]');
          continue;
        }
        if (typeof part.text === 'string') {
          textParts.push(part.text);
        } else {
          textParts.push(JSON.stringify(part));
        }
      }
      m.content = textParts.join('\n');
      clean.push(m);
    } else {
      clean.push(msg);
    }
  }
  return { clean, attachments };
}

const completionsId = () => 'chatcmpl-' + (crypto as any).randomUUID();

interface SseChunkParams {
  id: string;
  model: string;
  delta: any;
  finish?: string | null;
}

function makeChoice(delta: any, finish: string | null = null) {
  return {
    index: 0,
    delta,
    logprobs: null,
    finish_reason: finish,
  };
}

async function streamToolCalls(
  sw: any,
  c: Context,
  calls: ParsedToolCall[],
  completionId: string,
  model: string
) {
  const writeEvent = async (data: any) => {
    await sw.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  await writeEvent({
    id: completionId,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [makeChoice({ role: 'assistant', content: null })],
  });

  for (let i = 0; i < calls.length; i++) {
    const call = calls[i];
    await writeEvent({
      id: completionId,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [makeChoice({
        tool_calls: [{ index: i, id: call.id, type: 'function', function: { name: call.name, arguments: '' } }],
      })],
    });
  }
  for (let i = 0; i < calls.length; i++) {
    const call = calls[i];
    await writeEvent({
      id: completionId,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [makeChoice({
        tool_calls: [{ index: i, function: { arguments: call.arguments } }],
      })],
    });
  }
  for (let i = 0; i < calls.length; i++) {
    await writeEvent({
      id: completionId,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [makeChoice({
        tool_calls: [{ index: i, function: { arguments: '' } }],
      })],
    });
  }

  await writeEvent({
    id: completionId,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [makeChoice({ content: null }, 'tool_calls')],
  });
  await sw.write('data: [DONE]\n\n');
}

async function streamText(
  sw: any,
  c: Context,
  text: string,
  completionId: string,
  model: string
) {
  const writeEvent = async (data: any) => {
    await sw.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  await writeEvent({
    id: completionId,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [makeChoice({ role: 'assistant', content: '' })],
  });

  const chunks = text.match(/[\s\S]{1,64}/g) ?? [];
  for (const chunk of chunks) {
    await writeEvent({
      id: completionId,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [makeChoice({ content: chunk })],
    });
  }

  await writeEvent({
    id: completionId,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [makeChoice({}, 'stop')],
  });
  await sw.write('data: [DONE]\n\n');
}

export async function chatCompletions(c: Context) {
  const login = await getLoginStatus();
  if (!login.loggedIn) {
    return c.json({ error: { message: 'Login required. Open /login-ui and save the ChatGPT session.' } }, 401);
  }
  try {
    const body: any = await c.req.json();
    if (!Array.isArray(body.messages) || body.messages.length === 0) {
      return c.json({ error: { message: '"messages" must be a non-empty array' } }, 400);
    }
    const isStream = body.stream ?? false;
    const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
    const sessionKey = c.req.header('x-dsh-session-id') || body.metadata?.dsh_session_id || body.metadata?.session_id;
    const requestId = c.req.header('x-dsh-request-id') || body.metadata?.request_id;
    const scenario = c.req.header('x-dsh-scenario') || body.metadata?.scenario;
    const askOpts = {
      ...sessionKey === undefined ? {} : { sessionKey },
      ...requestId === undefined ? {} : { requestId },
      ...scenario === undefined ? {} : { scenario },
    };
    const { clean: messages, attachments } = await sanitizeMessages(body.messages);
    const completionId = completionsId();
    const model = body.model || 'chatgpt';

    const usage = (promptLen: number, textLen: number) => ({
      prompt_tokens: Math.ceil(promptLen / 3.5),
      completion_tokens: Math.ceil(textLen / 3.5),
      total_tokens: Math.ceil((promptLen + textLen) / 3.5),
    });

    // Ask the web model. With tools we buffer the answer and retry once if the
    // model replies with prose instead of the mandated JSON protocol.
    let text = '';
    let parsed: ReturnType<typeof parseResponse> = { calls: [] };
    let calls: ParsedToolCall[] = [];
    let prompt = '';

    if (!hasTools) {
      // No tools: prompt used for direct answer (streaming keeps caller-visible deltas).
      prompt = buildPrompt(messages);
      if (!isStream) {
        const result = await askChatGPT(prompt, undefined, 300000, attachments, { ...askOpts });
        const finalText = unwrapFinalAnswer(result.text ?? '');
        return c.json({
          id: completionId,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [{
            index: 0,
            message: { role: 'assistant', content: finalText },
            logprobs: null,
            finish_reason: 'stop',
          }],
          usage: usage(prompt.length, finalText.length),
        });
      }

      c.header('Content-Type', 'text/event-stream');
      c.header('Cache-Control', 'no-cache');
      c.header('Connection', 'keep-alive');

      return honoStream(c, async (sw: any) => {
        const result = await askChatGPT(prompt, undefined, 300000, attachments, { ...askOpts });
        await streamText(sw, c, unwrapFinalAnswer(result.text ?? ''), completionId, model);
      });
    }

    const hydrationKey = hasTools ? toolSignature(body.tools) : undefined;
    const hydrationPrompt = sessionKey && hasTools ? buildHydrationPrompt(messages, body.tools) : undefined;
    prompt = sessionKey ? buildSessionToolPrompt(messages) : buildToolPrompt(messages, body.tools);
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await askChatGPT(prompt, undefined, 300000, attachments, { ...askOpts, hydrationPrompt, hydrationKey });
      text = result.text ?? '';
      parsed = parseResponse(text);
      calls = parsed.calls.length ? parsed.calls : (extractToolCalls(text) ?? []);
      if (calls.length || parsed.json) break;
      if (attempt < 1) {
        console.warn(`[GPT] Tool-call protocol violated (prose answer); retrying (${attempt + 1}/2)...`);
        messages.push({ role: 'user', content: PROTOCOL_REINFORCE });
      }
    }

    let finalText = text;
    if (calls.length) {
      finalText = parsed.answer ?? '';
    } else if (parsed.answer) {
      finalText = parsed.answer;
    }

    if (!isStream) {
      if (calls.length) {
        return c.json({
          id: completionId,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: null,
              tool_calls: calls.map((call) => ({
                id: call.id,
                type: 'function',
                function: { name: call.name, arguments: call.arguments },
              })),
            },
            logprobs: null,
            finish_reason: 'tool_calls',
          }],
          usage: usage(prompt.length, text.length),
        });
      }
      return c.json({
        id: completionId,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{
          index: 0,
          message: { role: 'assistant', content: finalText },
          logprobs: null,
          finish_reason: 'stop',
        }],
        usage: usage(prompt.length, finalText.length),
      });
    }

    c.header('Content-Type', 'text/event-stream');
    c.header('Cache-Control', 'no-cache');
    c.header('Connection', 'keep-alive');

    return honoStream(c, async (sw: any) => {
      if (calls.length) {
        await streamToolCalls(sw, c, calls, completionId, model);
      } else {
        await streamText(sw, c, finalText, completionId, model);
      }
      // hono's StreamingApi exposes close(), not end(); stream() itself also
      // calls close() in its finally block once this callback resolves, so no
      // explicit call is required here at all.
    });
  } catch (err: any) {
    if (err === LOGIN_REQUIRED || err?.message?.includes('Login required')) {
      return c.json({ error: { message: 'Login required. Run "bun run login".' } }, 401);
    }
    if (err instanceof SessionConversationCollisionError) {
      console.error('Error in chatCompletions:', err);
      return c.json({
        error: {
          code: err.code,
          message: err.message,
          sessionKey: err.sessionKey,
          conversationUrl: err.conversationUrl,
          ownedBy: err.ownedBy,
        },
      }, 409);
    }
    console.error('Error in chatCompletions:', err);
    return c.json({ error: { message: err.message } }, 500);
  }
}