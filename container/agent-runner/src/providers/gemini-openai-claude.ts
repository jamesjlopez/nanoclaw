import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';

import { ClaudeProvider } from './claude.js';
import { registerProvider } from './provider-registry.js';
import type { AgentProvider, AgentQuery, ProviderEvent, ProviderOptions, QueryInput } from './types.js';

const HISTORY_DIR = '/workspace/provider-history';
const HISTORY_LIMIT = 24;
const GEMINI_MODEL = 'gemini-flash-latest';
const OPENAI_MODEL = 'chat-latest';
const ANTHROPIC_MODEL = 'sonnet';
const MAX_CONTEXT_FILE_CHARS = 12000;
const MAX_SYSTEM_CONTEXT_CHARS = 60000;

interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

interface ChatResult {
  continuation: string;
  text: string;
}

interface RestProvider {
  readonly name: string;
  readonly noticeName: string;
  complete(input: QueryInput, signal: AbortSignal): Promise<ChatResult>;
}

function log(msg: string): void {
  console.error(`[fallback-provider] ${msg}`);
}

function readFirstSecret(env: Record<string, string | undefined>, envNames: string[], files: string[]): string | undefined {
  for (const name of envNames) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  for (const file of files) {
    try {
      const value = fs.readFileSync(file, 'utf8').trim();
      if (value) return value;
    } catch {
      // Try the next well-known location.
    }
  }
  return undefined;
}

function historyPath(providerName: string, continuation: string): string {
  return path.join(HISTORY_DIR, providerName, `${continuation}.json`);
}

function providerContinuation(providerName: string, continuation?: string): string | undefined {
  const prefix = `${providerName}:`;
  return continuation?.startsWith(prefix) ? continuation.slice(prefix.length) : undefined;
}

function prefixedContinuation(providerName: string, continuation: string): string {
  return `${providerName}:${continuation}`;
}

function loadHistory(providerName: string, continuation?: string): { id: string; turns: ChatTurn[] } {
  const providerId = providerContinuation(providerName, continuation);
  const id = providerId || randomUUID();
  if (!providerId) return { id, turns: [] };

  try {
    const raw = JSON.parse(fs.readFileSync(historyPath(providerName, providerId), 'utf8')) as { turns?: ChatTurn[] };
    const turns = Array.isArray(raw.turns) ? raw.turns.filter(isChatTurn) : [];
    return { id, turns };
  } catch {
    return { id, turns: [] };
  }
}

function saveHistory(providerName: string, continuation: string, turns: ChatTurn[]): void {
  const file = historyPath(providerName, continuation);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ turns: turns.slice(-HISTORY_LIMIT) }, null, 2) + '\n');
}

function isChatTurn(value: unknown): value is ChatTurn {
  if (!value || typeof value !== 'object') return false;
  const turn = value as { role?: unknown; content?: unknown };
  return (turn.role === 'user' || turn.role === 'assistant') && typeof turn.content === 'string';
}

function systemPrompt(input: QueryInput): string {
  const localContext = loadLocalInstructionContext(input.cwd);
  const parts = [
    input.systemContext?.instructions || '',
    localContext,
    [
      'You are running as a NanoClaw chat agent.',
      'Reply only with final text wrapped in <message to="name">...</message> blocks unless you need private scratchpad text inside <internal>...</internal>.',
      'Use the destination names listed above. If the incoming message has a from="name" attribute, reply to that destination by default.',
      'You have been given the local agent instructions above as context. You do not have local tool access in this provider mode, so do not claim to have read or modified files unless the user provided that content in chat.',
    ].join('\n'),
  ].filter(Boolean);
  return parts.join('\n\n').slice(0, MAX_SYSTEM_CONTEXT_CHARS);
}

function loadLocalInstructionContext(cwd: string): string {
  const files = [
    path.join(cwd, 'CLAUDE.md'),
    path.join(cwd, 'CLAUDE.local.md'),
    path.join(cwd, 'repo-awareness.md'),
    '/workspace/extra/second-brain/SCHEMA.md',
    '/workspace/extra/second-brain/wiki/Home.md',
    '/workspace/extra/second-brain/wiki/Wiki Ingest Log.md',
  ];
  const seen = new Set<string>();
  const sections: string[] = [];
  for (const file of files) {
    const content = readMarkdownWithImports(file, seen);
    if (content) sections.push(content);
  }
  const secondBrainTree = listSecondBrainWiki();
  if (secondBrainTree) {
    sections.push(['# Mounted Wiki Snapshot', '', secondBrainTree].join('\n'));
  }
  return sections.length > 0 ? ['# Local Agent Instructions', '', ...sections].join('\n\n') : '';
}

function readMarkdownWithImports(filePath: string, seen: Set<string>): string {
  let realPath: string;
  try {
    realPath = fs.realpathSync(filePath);
  } catch {
    return '';
  }
  if (seen.has(realPath)) return '';
  seen.add(realPath);

  let content: string;
  try {
    content = fs.readFileSync(realPath, 'utf8').slice(0, MAX_CONTEXT_FILE_CHARS);
  } catch {
    return '';
  }

  const dir = path.dirname(filePath);
  const expanded = content
    .split('\n')
    .map((line) => {
      const match = line.match(/^@(.+\.md)\s*$/);
      if (!match) return line;
      const importPath = match[1].startsWith('/') ? match[1] : path.resolve(dir, match[1]);
      return readMarkdownWithImports(importPath, seen);
    })
    .filter(Boolean)
    .join('\n');

  return [`## ${path.basename(filePath)}`, '', expanded].join('\n');
}

function listSecondBrainWiki(): string {
  const wikiDir = '/workspace/extra/second-brain/wiki';
  let entries: string[];
  try {
    entries = fs.readdirSync(wikiDir);
  } catch {
    return '';
  }
  const md = entries.filter((name) => name.endsWith('.md')).sort().slice(0, 80);
  return md.length > 0 ? `Available wiki pages in ${wikiDir}:\n${md.map((name) => `- ${name}`).join('\n')}` : '';
}

function needsClaudeCode(input: QueryInput): boolean {
  const text = input.prompt.toLowerCase();
  const sourceLink = /https?:\/\/\S+/.test(text);
  return (
    sourceLink ||
    /\b(ingest|youtube|podcast|instagram|repo|repository|transcript|wiki|second-brain|write|update|append|create file|edit file|read file|tool-recommendations|\/workspace|\/workspace\/extra)\b/.test(
      text,
    )
  );
}

function failMessage(provider: string, response: Response, body: string): string {
  const detail = body.trim().slice(0, 500);
  return `${provider} request failed (${response.status} ${response.statusText})${detail ? `: ${detail}` : ''}`;
}

class GeminiRestProvider implements RestProvider {
  readonly name = 'gemini';
  readonly noticeName = 'Gemini';

  constructor(
    private readonly env: Record<string, string | undefined>,
    private readonly model?: string,
  ) {}

  async complete(input: QueryInput, signal: AbortSignal): Promise<ChatResult> {
    const apiKey = readFirstSecret(
      this.env,
      ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY'],
      [
        '/workspace/agent/config/gemini-api-key.txt',
        '/workspace/agent/config/google-api-key.txt',
        '/workspace/agent/config/youtube-api-key.txt',
      ],
    );
    if (!apiKey) throw new Error('Gemini API key not found');

    const history = loadHistory(this.name, input.continuation);
    const turns = [...history.turns, { role: 'user' as const, content: input.prompt }];
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.model || this.env.GEMINI_MODEL || GEMINI_MODEL)}:generateContent`;
    const res = await fetch(url, {
      method: 'POST',
      signal,
      headers: {
        'content-type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt(input) }] },
        contents: turns.map((turn) => ({
          role: turn.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: turn.content }],
        })),
      }),
    });

    const body = await res.text();
    if (!res.ok) throw new Error(failMessage(this.noticeName, res, body));

    const parsed = JSON.parse(body) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> }; finishReason?: string }>;
    };
    const text = parsed.candidates?.[0]?.content?.parts?.map((part) => part.text || '').join('').trim();
    if (!text) throw new Error(`Gemini returned no text (${parsed.candidates?.[0]?.finishReason || 'unknown finish reason'})`);

    saveHistory(this.name, history.id, [...turns, { role: 'assistant', content: text }]);
    return { continuation: prefixedContinuation(this.name, history.id), text };
  }
}

class OpenAiRestProvider implements RestProvider {
  readonly name = 'openai';
  readonly noticeName = 'OpenAI';

  constructor(
    private readonly env: Record<string, string | undefined>,
    private readonly model?: string,
  ) {}

  async complete(input: QueryInput, signal: AbortSignal): Promise<ChatResult> {
    const apiKey = readFirstSecret(this.env, ['OPENAI_API_KEY'], ['/workspace/agent/config/openai-api-key.txt']);
    if (!apiKey) throw new Error('OpenAI API key not found');

    const history = loadHistory(this.name, input.continuation);
    const turns = [...history.turns, { role: 'user' as const, content: input.prompt }];
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      signal,
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model || this.env.OPENAI_MODEL || OPENAI_MODEL,
        messages: [{ role: 'system', content: systemPrompt(input) }, ...turns],
      }),
    });

    const body = await res.text();
    if (!res.ok) throw new Error(failMessage(this.noticeName, res, body));

    const parsed = JSON.parse(body) as { choices?: Array<{ message?: { content?: string } }> };
    const text = parsed.choices?.[0]?.message?.content?.trim();
    if (!text) throw new Error('OpenAI returned no message content');

    saveHistory(this.name, history.id, [...turns, { role: 'assistant', content: text }]);
    return { continuation: prefixedContinuation(this.name, history.id), text };
  }
}

export class GeminiOpenAiClaudeProvider implements AgentProvider {
  readonly supportsNativeSlashCommands = false;

  private readonly gemini: GeminiRestProvider;
  private readonly openai: OpenAiRestProvider;
  private readonly claude: ClaudeProvider;

  constructor(options: ProviderOptions = {}) {
    const env = options.env ?? {};
    this.gemini = new GeminiRestProvider(env, env.GEMINI_MODEL || env.GOOGLE_MODEL);
    this.openai = new OpenAiRestProvider(env, env.OPENAI_MODEL);
    this.claude = new ClaudeProvider({
      ...options,
      model: env.ANTHROPIC_MODEL || env.CLAUDE_MODEL || options.model || ANTHROPIC_MODEL,
    });
  }

  isSessionInvalid(err: unknown): boolean {
    return this.claude.isSessionInvalid(err);
  }

  maybeRotateContinuation(continuation: string, cwd: string): string | null {
    const claudeContinuation = providerContinuation('claude', continuation);
    void cwd;
    return claudeContinuation ? this.claude.maybeRotateContinuation?.(claudeContinuation) ?? null : null;
  }

  query(input: QueryInput): AgentQuery {
    const abortController = new AbortController();
    let activeClaudeQuery: AgentQuery | null = null;
    let aborted = false;

    async function* eventsFor(provider: RestProvider): AsyncGenerator<ProviderEvent> {
      const result = await provider.complete(input, abortController.signal);
      yield { type: 'init', continuation: result.continuation };
      yield { type: 'result', text: result.text };
    }

    const events = (async function* (self: GeminiOpenAiClaudeProvider): AsyncGenerator<ProviderEvent> {
      if (needsClaudeCode(input)) {
        log('Prompt requires local workspace/wiki access; using Claude Code directly');
        activeClaudeQuery = self.claude.query({
          ...input,
          continuation: providerContinuation('claude', input.continuation),
        });
        for await (const event of activeClaudeQuery.events) {
          if (event.type === 'init') {
            yield { ...event, continuation: prefixedContinuation('claude', event.continuation) };
          } else {
            yield event;
          }
        }
        return;
      }

      try {
        yield* eventsFor(self.gemini);
        return;
      } catch (err) {
        if (aborted) return;
        log(`Gemini failed: ${err instanceof Error ? err.message : String(err)}`);
        yield { type: 'provider_notice', message: 'Gemini is unavailable right now, so I am switching to OpenAI for this reply.' };
      }

      try {
        yield* eventsFor(self.openai);
        return;
      } catch (err) {
        if (aborted) return;
        log(`OpenAI failed: ${err instanceof Error ? err.message : String(err)}`);
        yield { type: 'provider_notice', message: 'OpenAI is unavailable too, so I am switching to Anthropic for this reply.' };
      }

      activeClaudeQuery = self.claude.query({
        ...input,
        continuation: providerContinuation('claude', input.continuation),
      });
      for await (const event of activeClaudeQuery.events) {
        if (event.type === 'init') {
          yield { ...event, continuation: prefixedContinuation('claude', event.continuation) };
        } else {
          yield event;
        }
      }
    })(this);

    return {
      push: (message) => activeClaudeQuery?.push(message),
      end: () => activeClaudeQuery?.end(),
      events,
      abort: () => {
        aborted = true;
        abortController.abort();
        activeClaudeQuery?.abort();
      },
    };
  }
}

registerProvider('gemini-openai-claude', (opts) => new GeminiOpenAiClaudeProvider(opts));
