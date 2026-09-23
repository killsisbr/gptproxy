export interface GptProxySession {
  key: string;
  conversationUrl?: string;
  hydrationKey?: string;
  createdAt: number;
  lastUsedAt: number;
  turns: number;
}

export interface SessionSnapshot {
  key: string;
  conversationUrl?: string;
  hydrated: boolean;
  createdAt: number;
  lastUsedAt: number;
  turns: number;
}

const DEFAULT_TTL_MS = 1000 * 60 * 60 * 6;

/**
 * Matches a settled ChatGPT conversation URL. Excludes the transient
 * client-side `/c/WEB:<uuid>` placeholder ChatGPT renders immediately after
 * the first send, before the backend-assigned real conversation id is
 * adopted; that placeholder is never a real, addressable conversation and
 * must never be recorded as a session's bound `conversationUrl`.
 */
const REAL_CONVERSATION_URL = /\/c\/(?!WEB:)[^/?#]+/u;

export class GptProxySessionStore {
  private readonly sessions = new Map<string, GptProxySession>();
  private readonly ttlMs: number;

  constructor(ttlMs = DEFAULT_TTL_MS) {
    this.ttlMs = ttlMs;
  }

  getOrCreate(key: string): GptProxySession {
    this.cleanup();
    const now = Date.now();
    const existing = this.sessions.get(key);
    if (existing) {
      existing.lastUsedAt = now;
      return existing;
    }
    const created: GptProxySession = { key, createdAt: now, lastUsedAt: now, turns: 0 };
    this.sessions.set(key, created);
    return created;
  }

  /**
   * The key of the live session currently bound to `conversationUrl`, if any.
   * @param conversationUrl - a settled (non-placeholder) ChatGPT conversation URL.
   * @returns the owning session key, or undefined if no live session owns it.
   */
  ownerOf(conversationUrl: string): string | undefined {
    for (const session of this.sessions.values()) {
      if (session.conversationUrl === conversationUrl) return session.key;
    }
    return undefined;
  }

  markTurn(session: GptProxySession, conversationUrl: string | undefined): void {
    session.lastUsedAt = Date.now();
    session.turns += 1;
    if (conversationUrl && REAL_CONVERSATION_URL.test(conversationUrl)) {
      session.conversationUrl = conversationUrl;
    }
  }

  clear(key: string): boolean {
    return this.sessions.delete(key);
  }

  list(): SessionSnapshot[] {
    this.cleanup();
    return [...this.sessions.values()].map((session) => ({
      key: session.key,
      conversationUrl: session.conversationUrl,
      hydrated: Boolean(session.hydrationKey),
      createdAt: session.createdAt,
      lastUsedAt: session.lastUsedAt,
      turns: session.turns,
    }));
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [key, session] of this.sessions) {
      if (now - session.lastUsedAt > this.ttlMs) {
        this.sessions.delete(key);
      }
    }
  }
}

export const gptProxySessions = new GptProxySessionStore(
  process.env.GPT_PROXY_SESSION_TTL_MS ? Number(process.env.GPT_PROXY_SESSION_TTL_MS) : undefined,
);
