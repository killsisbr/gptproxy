import fs from 'fs';
import path from 'path';

/**
 * Per-request phase timings, in milliseconds relative to `askChatGPT()` start.
 * Undefined fields mean that phase did not run (e.g. no hydration needed) or
 * was not technically separable from an adjacent phase with the current
 * instrumentation (Playwright UI wait time is not separable from ChatGPT
 * server-side generation time; both are folded into `uiRoundTripMs`).
 */
export interface TurnTimings {
  requestId: string;
  sessionKey?: string;
  scenario?: string;
  startedAt: number;
  loginCheckMs?: number;
  navigationMs?: number;
  hydrationMs?: number;
  sendPromptMs?: number;
  /** Time from prompt sent to the full assistant response text settling (readAssistantStream). Includes both Playwright polling overhead and ChatGPT's own generation time; not separable with DOM polling. */
  uiRoundTripMs?: number;
  totalMs?: number;
  success: boolean;
  error?: string;
}

const LOG_PATH = path.resolve('./benchmark-telemetry.jsonl');

export function recordTurn(timing: TurnTimings): void {
  try {
    fs.appendFileSync(LOG_PATH, JSON.stringify(timing) + '\n');
  } catch {
    // Telemetry is best-effort and must never fail the request it describes.
  }
}

export function telemetryLogPath(): string {
  return LOG_PATH;
}
