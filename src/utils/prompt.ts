import { formatTools } from './tools.ts';

export function contentToString(content: any): string {
  if (Array.isArray(content)) {
    return content.map((c: any) => c?.text || (c?.type === 'image_url' || c?.type === 'image' ? '[imagem]' : JSON.stringify(c))).join('\n');
  }
  if (typeof content === 'object' && content !== null) {
    return JSON.stringify(content);
  }
  return content || '';
}

export function buildPrompt(messages: any[]): string {
  let system = '';
  let flow = '';

  for (const msg of messages || []) {
    const content = contentToString(msg.content);
    switch (msg.role) {
      case 'system':
        system += content + '\n\n';
        break;
      case 'user':
        flow += `User: ${content}\n\n`;
        break;
      case 'assistant':
        flow += `Assistant: ${content}\n\n`;
        break;
      case 'tool':
      case 'function':
        flow += `Tool response (${msg.name || 'tool'}): ${content}\n\n`;
        break;
      default:
        flow += `${msg.role}: ${content}\n\n`;
    }
  }

  const parts: string[] = [];
  if (system.trim()) {
    parts.push(
      `<SYSTEM_INSTRUCTIONS>\n${system.trim()}\n</SYSTEM_INSTRUCTIONS>\n\n`
      + 'These are system instructions for the whole conversation. Follow them silently. '
      + 'Never restate, quote, or repeat them in your reply.'
    );
  }
  const userBlock = flow.trim();
  if (userBlock) {
    parts.push(userBlock);
  }
  if (system.trim()) {
    parts.push(
      'Respond directly and concisely to the last "User:" message above. Do not restate the system instructions.'
    );
  }

  return parts.join('\n\n');
}

function collectSystem(messages: any[]): string {
  return (messages || [])
    .filter((m) => m.role === 'system')
    .map((m) => contentToString(m.content))
    .join('\n\n')
    .trim();
}

function responseProtocol(toolList: string): string {
  return [
    '',
    '## Response protocol (MANDATORY - you must reply in this exact JSON format every time)',
    'Return ONLY one JSON object, with no markdown, code fences, explanation or extra text.',
    '',
    'To request actions:',
    '{"tool_calls":[{"name":"<action_name>","arguments":{...}}]}',
    '',
    'To give a final answer:',
    '{"final_answer":"<answer>"}',
    '',
    '## Actions the operator can execute for you',
    toolList,
    '',
    '## Rules',
    '- "arguments" must be a JSON object matching the documented parameters.',
    '- When you need data you do not have, request an action instead of guessing or answering from memory.',
    '- Values returned by previous actions arrive as new operator messages; use them before requesting more.',
    '- Never output anything besides the JSON object.',
  ].join('\n');
}

export function buildHydrationPrompt(messages: any[], tools: any[]): string {
  const toolList = formatTools(tools);
  const sys = collectSystem(messages) || 'You are a helpful assistant.';
  return [
    `<SYSTEM_INSTRUCTIONS>\n${sys}\n</SYSTEM_INSTRUCTIONS>`,
    '',
    'You are operating through DeepSeek Harness.',
    'The user is conversing with you normally, but you also have indirect access to local tools through the Harness.',
    'You do NOT have direct access to the computer, filesystem, shell, network, browser, or project.',
    'When an action is needed, request it with the tool_call JSON protocol below.',
    'The Harness validates and executes the action, then returns the result as a later operator message in this same conversation.',
    'When no tool is needed, answer conversationally by returning final_answer JSON.',
    responseProtocol(toolList),
    '',
    'Acknowledge this session setup with exactly {"final_answer":"hydrated"}.',
  ].join('\n\n');
}

export function toolSignature(tools: any[]): string {
  try {
    return JSON.stringify(tools ?? []);
  } catch {
    return String(Date.now());
  }
}

export function buildSessionToolPrompt(messages: any[]): string {
  const rendered = lastRelevantMessages(messages)
    .map((msg) => renderMessage(msg))
    .filter(Boolean)
    .join('\n\n');
  return [
    rendered || 'Continue from the previous tool result or user request.',
    '',
    'Reply with exactly one JSON object using the established response protocol.',
  ].join('\n\n');
}

export function buildToolPrompt(messages: any[], tools: any[]): string {
  const toolList = formatTools(tools);

  const sys = [
    collectSystem(messages) || 'You are a helpful assistant.',
    '',
    'You are the agent inside an automated pipeline. Every reply to the operator MUST be the JSON object',
    'described in "## Response protocol" below - nothing else. The operator reads the JSON and executes the',
    'actions you request; the results arrive in the next operator message.',
    'Never claim you lack access to an action: requesting it IS how you access it.',
  ].join('\n');

  const flow = (messages || [])
    .map((msg) => renderMessage(msg))
    .filter(Boolean)
    .join('\n\n');

  const parts: string[] = [
    `<SYSTEM_INSTRUCTIONS>\n${sys}\n</SYSTEM_INSTRUCTIONS>\n\n`
    + 'These are the system instructions. Follow them silently; never restate them.',
    flow.trim(),
    responseProtocol(toolList),
    '',
    'Now respond with your single JSON object to the last operator request above.',
  ];

  return parts.join('\n\n');
}

function lastRelevantMessages(messages: any[]): any[] {
  const relevant = (messages || []).filter((msg) => msg.role !== 'system');
  if (!relevant.length) return [];
  const tail: any[] = [];
  for (let i = relevant.length - 1; i >= 0; i--) {
    const msg = relevant[i];
    if (!tail.length) {
      tail.unshift(msg);
      continue;
    }
    if ((msg.role === 'tool' || msg.role === 'function') && (tail[0].role === 'tool' || tail[0].role === 'function')) {
      tail.unshift(msg);
      continue;
    }
    break;
  }
  return tail;
}

function renderMessage(msg: any): string {
  const content = contentToString(msg.content);
  switch (msg.role) {
    case 'system':
      return '';
    case 'user':
      return `User: ${content}`;
    case 'assistant':
      if (Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
        const calls = msg.tool_calls
          .map((tc: any) => {
            const fn = tc?.function ?? tc;
            const args = typeof fn?.arguments === 'string'
              ? fn.arguments
              : (() => { try { return JSON.stringify(fn?.arguments ?? {}); } catch { return '{}'; } })();
            return `Assistant tool call: ${fn?.name}(${args})`;
          })
          .join('\n');
        if (content) return calls + '\n\nAssistant: ' + content;
        return calls;
      }
      return `Assistant: ${content}`;
    case 'tool':
    case 'function':
      return `Tool result for ${msg.name || 'tool'}: ${content}`;
    default:
      return `${msg.role}: ${content}`;
  }
}