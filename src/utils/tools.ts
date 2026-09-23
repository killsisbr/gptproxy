export function parseResponse(text: string): { calls: ParsedToolCall[]; answer?: string; json?: boolean } {
  const markerCalls = extractMarkerCalls(text);
  if (markerCalls.length) return { calls: markerCalls, json: true };

  const stripped = text.replace(/```(?:json)?/g, '').trim();
  for (const block of scanJsonBlocks(stripped)) {
    if (!block || typeof block !== 'object' || Array.isArray(block)) continue;
    if (Array.isArray(block.tool_calls)) {
      const calls = (block.tool_calls as any[])
        .map((item) => normalizeCall(item))
        .filter((c): c is ParsedToolCall => c !== null);
      if (calls.length) return { calls, json: true };
    }
    if (typeof block.final_answer === 'string' && block.final_answer.trim()) {
      return { calls: [], answer: block.final_answer.trim(), json: true };
    }
    if (typeof block.tool_call === 'object' && block.tool_call !== null) {
      const call = normalizeCall(block.tool_call);
      if (call) return { calls: [call], json: true };
    }
    if (typeof block.arguments !== 'undefined' || typeof block.name === 'string') {
      const call = normalizeCall(block);
      if (call) return { calls: [call], answer: typeof block.text === 'string' ? block.text : undefined, json: true };
    }
  }
  return { calls: [] };
}

export interface ParsedToolCall {
  id: string;
  name: string;
  arguments: string;
}

function randomId(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return 'call_' + Math.random().toString(36).slice(2, 12);
}

function normalizeCall(raw: any): ParsedToolCall | null {
  if (!raw || typeof raw !== 'object') return null;
  let name = typeof raw.name === 'string' ? raw.name : undefined;
  if (!name && raw.function && typeof raw.function.name === 'string') name = raw.function.name;
  if (!name) return null;

  let argsObj = raw.arguments;
  if (argsObj == null && raw.function) argsObj = raw.function.arguments;
  let argsStr: string;
  if (typeof argsObj === 'string') argsStr = argsObj;
  else if (argsObj && typeof argsObj === 'object') {
    try {
      argsStr = JSON.stringify(argsObj);
    } catch {
      argsStr = '{}';
    }
  } else {
    argsStr = '{}';
  }
  if (!argsStr.trim()) argsStr = '{}';

  const id = typeof raw.id === 'string' ? raw.id : typeof raw.tool_call_id === 'string' ? raw.tool_call_id : randomId();
  return { id, name, arguments: argsStr };
}

function extractMarkerCalls(text: string): ParsedToolCall[] {
  const calls: ParsedToolCall[] = [];
  const markerRe = /<tool_call>([\s\S]*?)<\/tool_call>/g;
  let m: RegExpExecArray | null;
  while ((m = markerRe.exec(text))) {
    const inner = m[1].trim();
    const parsed = scanJsonBlocks(inner);
    for (const p of parsed) {
      const items = Array.isArray(p) ? p : [p];
      for (const item of items) {
        const norm = normalizeCall(item);
        if (norm) calls.push(norm);
      }
    }
  }
  return calls;
}

export function extractToolCalls(text: string): ParsedToolCall[] | null {
  const markerCalls = extractMarkerCalls(text);
  if (markerCalls.length) return markerCalls;
  const res = parseResponse(text);
  return res.calls.length ? res.calls : null;
}

function scanJsonBlocks(text: string): any[] {
  const blocks: any[] = [];
  let depth = 0;
  let start = -1;
  let inStr = false;
  const seen = new Set<string>();
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (ch === '\\') {
        i++;
        continue;
      }
      if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') {
      inStr = true;
      continue;
    }
    if (ch === '{' || ch === '[') {
      if (depth === 0) start = i;
      depth++;
      continue;
    }
    if (ch === '}' || ch === ']') {
      depth--;
      if (depth === 0 && start >= 0) {
        const candidate = text.slice(start, i + 1);
        start = -1;
        let parsed: any;
        try {
          parsed = JSON.parse(candidate);
        } catch {
          continue;
        }
        let key: string;
        try {
          key = JSON.stringify(parsed);
        } catch {
          key = String(parsed);
        }
        if (!seen.has(key)) {
          seen.add(key);
          blocks.push(parsed);
        }
      }
    }
  }
  return blocks;
}

export function formatTools(tools: any[]): string {
  if (!tools || !tools.length) return '';
  const lines: string[] = [];
  for (const t of tools) {
    const fn = t?.function ?? t;
    if (!fn || typeof fn !== 'object') continue;
    const name = fn.name;
    if (!name) continue;
    const desc = fn.description ?? '';
    let params = fn.parameters;
    if (params && typeof params === 'object') {
      try {
        params = JSON.stringify(params);
      } catch {
        params = String(params);
      }
    }
    lines.push(`- name: ${name}`);
    if (desc) lines.push(`  description: ${desc}`);
    lines.push(`  parameters(JSON Schema): ${params ?? '{}'}`);
  }
  return lines.join('\n');
}