/**
 * Instagram URL ingestion.
 *
 * This module runs as a host-side inbound enricher: it detects Instagram post
 * and Reel URLs in chat content, resolves/transcribes the media when possible,
 * caches the result, and appends compact text artifacts to `linkIngestions`.
 */
import { execFile } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';

import { DATA_DIR } from '../../config.js';
import { readEnvFile } from '../../env.js';
import { log } from '../../log.js';
import { registerInboundEnricher } from '../../router.js';
import type { InboundEvent } from '../../channels/adapter.js';

const execFileAsync = promisify(execFile);

const INSTAGRAM_URL_RE = /https?:\/\/(?:www\.)?instagram\.com\/(?:reel|p|tv)\/[A-Za-z0-9_-]+\/?(?:\?[^ \n\t<>"']*)?/gi;

export interface ToolMention {
  name: string;
  evidence?: string;
  confidence?: number;
}

export interface LinkIngestion {
  source: 'instagram';
  url: string;
  canonicalUrl: string;
  status: 'ready' | 'failed';
  kind?: 'video' | 'image' | 'carousel' | 'unknown';
  caption?: string;
  transcript?: string;
  ocr?: string;
  toolMentions?: ToolMention[];
  cachedAt?: string;
  error?: string;
}

interface InstagramMetadata {
  title?: string;
  description?: string;
  duration?: number;
  ext?: string;
  webpage_url?: string;
  extractor?: string;
  availability?: string;
}

interface IngestionEnv {
  OPENAI_API_KEY?: string;
  OPENAI_TRANSCRIBE_MODEL?: string;
  INSTAGRAM_YTDLP_BIN?: string;
  INSTAGRAM_FFMPEG_BIN?: string;
  INSTAGRAM_YTDLP_COOKIES_FROM_BROWSER?: string;
  INSTAGRAM_COOKIES_FILE?: string;
  INSTAGRAM_INGESTION_MAX_SECONDS?: string;
  INSTAGRAM_INGESTION_MAX_BYTES?: string;
  INSTAGRAM_INGESTION_TIMEOUT_MS?: string;
  INSTAGRAM_INGESTION_FAILURE_CACHE_MS?: string;
}

interface IngestionOptions {
  cacheDir?: string;
  tmpDir?: string;
  env?: IngestionEnv;
}

function ingestionEnv(): IngestionEnv {
  const dotenv = readEnvFile([
    'OPENAI_API_KEY',
    'OPENAI_TRANSCRIBE_MODEL',
    'INSTAGRAM_YTDLP_BIN',
    'INSTAGRAM_FFMPEG_BIN',
    'INSTAGRAM_YTDLP_COOKIES_FROM_BROWSER',
    'INSTAGRAM_COOKIES_FILE',
    'INSTAGRAM_INGESTION_MAX_SECONDS',
    'INSTAGRAM_INGESTION_MAX_BYTES',
    'INSTAGRAM_INGESTION_TIMEOUT_MS',
    'INSTAGRAM_INGESTION_FAILURE_CACHE_MS',
  ]);
  return {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY || dotenv.OPENAI_API_KEY,
    OPENAI_TRANSCRIBE_MODEL: process.env.OPENAI_TRANSCRIBE_MODEL || dotenv.OPENAI_TRANSCRIBE_MODEL,
    INSTAGRAM_YTDLP_BIN: process.env.INSTAGRAM_YTDLP_BIN || dotenv.INSTAGRAM_YTDLP_BIN,
    INSTAGRAM_FFMPEG_BIN: process.env.INSTAGRAM_FFMPEG_BIN || dotenv.INSTAGRAM_FFMPEG_BIN,
    INSTAGRAM_YTDLP_COOKIES_FROM_BROWSER:
      process.env.INSTAGRAM_YTDLP_COOKIES_FROM_BROWSER || dotenv.INSTAGRAM_YTDLP_COOKIES_FROM_BROWSER,
    INSTAGRAM_COOKIES_FILE: process.env.INSTAGRAM_COOKIES_FILE || dotenv.INSTAGRAM_COOKIES_FILE,
    INSTAGRAM_INGESTION_MAX_SECONDS:
      process.env.INSTAGRAM_INGESTION_MAX_SECONDS || dotenv.INSTAGRAM_INGESTION_MAX_SECONDS,
    INSTAGRAM_INGESTION_MAX_BYTES: process.env.INSTAGRAM_INGESTION_MAX_BYTES || dotenv.INSTAGRAM_INGESTION_MAX_BYTES,
    INSTAGRAM_INGESTION_TIMEOUT_MS: process.env.INSTAGRAM_INGESTION_TIMEOUT_MS || dotenv.INSTAGRAM_INGESTION_TIMEOUT_MS,
    INSTAGRAM_INGESTION_FAILURE_CACHE_MS:
      process.env.INSTAGRAM_INGESTION_FAILURE_CACHE_MS || dotenv.INSTAGRAM_INGESTION_FAILURE_CACHE_MS,
  };
}

function defaultCacheDir(): string {
  return path.join(DATA_DIR, 'instagram-ingestion', 'cache');
}

function sha256(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

function numericEnv(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function canonicalizeInstagramUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, '').toLowerCase();
    if (host !== 'instagram.com') return null;
    const parts = parsed.pathname.split('/').filter(Boolean);
    if (parts.length < 2) return null;
    const kind = parts[0];
    const shortcode = parts[1];
    if (!['reel', 'p', 'tv'].includes(kind)) return null;
    if (!/^[A-Za-z0-9_-]+$/.test(shortcode)) return null;
    return `https://www.instagram.com/${kind}/${shortcode}/`;
  } catch {
    return null;
  }
}

export function extractInstagramUrls(content: unknown): string[] {
  const urls = new Set<string>();
  const addFromText = (text: unknown) => {
    if (typeof text !== 'string') return;
    for (const match of text.matchAll(INSTAGRAM_URL_RE)) {
      const canonical = canonicalizeInstagramUrl(match[0]);
      if (canonical) urls.add(canonical);
    }
  };

  if (!content || typeof content !== 'object') return [];
  const c = content as Record<string, unknown>;
  addFromText(c.text);
  addFromText(c.markdown);
  const links = c.links;
  if (Array.isArray(links)) {
    for (const link of links) {
      if (typeof link === 'string') addFromText(link);
      if (link && typeof link === 'object') {
        const l = link as Record<string, unknown>;
        addFromText(l.url);
        addFromText(l.href);
      }
    }
  }
  return [...urls];
}

function cachePath(cacheDir: string, canonicalUrl: string): string {
  return path.join(cacheDir, `${sha256(canonicalUrl)}.json`);
}

function readCached(cacheDir: string, canonicalUrl: string, env: IngestionEnv): LinkIngestion | null {
  try {
    const raw = fs.readFileSync(cachePath(cacheDir, canonicalUrl), 'utf8');
    const parsed = JSON.parse(raw) as LinkIngestion;
    if (parsed.source !== 'instagram' || parsed.canonicalUrl !== canonicalUrl) return null;
    if (parsed.status === 'failed') {
      const failureCacheMs = numericEnv(env.INSTAGRAM_INGESTION_FAILURE_CACHE_MS, 60 * 60 * 1000);
      const cachedAt = parsed.cachedAt ? Date.parse(parsed.cachedAt) : 0;
      if (!cachedAt || Date.now() - cachedAt > failureCacheMs) return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function writeCached(cacheDir: string, item: LinkIngestion): void {
  fs.mkdirSync(cacheDir, { recursive: true });
  const p = cachePath(cacheDir, item.canonicalUrl);
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(item, null, 2));
  fs.renameSync(tmp, p);
}

function makeFailed(url: string, canonicalUrl: string, error: string): LinkIngestion {
  return {
    source: 'instagram',
    url,
    canonicalUrl,
    status: 'failed',
    kind: 'unknown',
    error,
    cachedAt: new Date().toISOString(),
  };
}

function ytdlpArgs(url: string, env: IngestionEnv): string[] {
  const args = ['--no-playlist'];
  if (env.INSTAGRAM_COOKIES_FILE) {
    args.push('--cookies', env.INSTAGRAM_COOKIES_FILE);
  } else if (env.INSTAGRAM_YTDLP_COOKIES_FROM_BROWSER) {
    args.push('--cookies-from-browser', env.INSTAGRAM_YTDLP_COOKIES_FROM_BROWSER);
  }
  args.push(url);
  return args;
}

async function readMetadata(url: string, env: IngestionEnv, timeoutMs: number): Promise<InstagramMetadata> {
  const bin = env.INSTAGRAM_YTDLP_BIN || 'yt-dlp';
  const { stdout } = await execFileAsync(bin, ['--dump-json', ...ytdlpArgs(url, env)], {
    timeout: timeoutMs,
    maxBuffer: 4 * 1024 * 1024,
  });
  return JSON.parse(stdout) as InstagramMetadata;
}

function downloadedMediaFile(dir: string): string | null {
  const files = fs
    .readdirSync(dir)
    .filter((name) => name.startsWith('media.'))
    .map((name) => path.join(dir, name));
  return files[0] ?? null;
}

async function downloadMedia(url: string, dir: string, env: IngestionEnv, timeoutMs: number): Promise<string> {
  const bin = env.INSTAGRAM_YTDLP_BIN || 'yt-dlp';
  const maxBytes = numericEnv(env.INSTAGRAM_INGESTION_MAX_BYTES, 75 * 1024 * 1024);
  await execFileAsync(
    bin,
    [
      '-f',
      'bestaudio/best',
      '--max-filesize',
      String(maxBytes),
      '-o',
      path.join(dir, 'media.%(ext)s'),
      ...ytdlpArgs(url, env),
    ],
    { timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024 },
  );
  const media = downloadedMediaFile(dir);
  if (!media) throw new Error('media_download_missing_output');
  return media;
}

async function extractAudio(mediaPath: string, outPath: string, env: IngestionEnv, timeoutMs: number): Promise<void> {
  const bin = env.INSTAGRAM_FFMPEG_BIN || 'ffmpeg';
  await execFileAsync(bin, ['-y', '-i', mediaPath, '-vn', '-ac', '1', '-ar', '16000', '-b:a', '32k', outPath], {
    timeout: timeoutMs,
    maxBuffer: 2 * 1024 * 1024,
  });
}

async function transcribeAudio(audioPath: string, env: IngestionEnv): Promise<string> {
  const apiKey = env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('missing_openai_api_key');
  const bytes = fs.readFileSync(audioPath);
  const form = new FormData();
  form.set('model', env.OPENAI_TRANSCRIBE_MODEL || 'gpt-4o-mini-transcribe');
  form.set('response_format', 'text');
  form.set('file', new Blob([bytes], { type: 'audio/mpeg' }), 'instagram-audio.mp3');
  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}` },
    body: form,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`openai_transcription_failed_${res.status}${text ? `_${text.slice(0, 80)}` : ''}`);
  }
  return (await res.text()).trim();
}

function inferKind(metadata: InstagramMetadata): LinkIngestion['kind'] {
  if (metadata.duration && metadata.duration > 0) return 'video';
  if (metadata.ext && ['jpg', 'jpeg', 'png', 'webp'].includes(metadata.ext.toLowerCase())) return 'image';
  return 'unknown';
}

async function ingestInstagramUrl(url: string, opts: IngestionOptions = {}): Promise<LinkIngestion> {
  const canonicalUrl = canonicalizeInstagramUrl(url) ?? url;
  const cacheDir = opts.cacheDir ?? defaultCacheDir();
  const env = opts.env ?? ingestionEnv();
  const cached = readCached(cacheDir, canonicalUrl, env);
  if (cached) return cached;

  const timeoutMs = numericEnv(env.INSTAGRAM_INGESTION_TIMEOUT_MS, 90_000);
  const maxSeconds = numericEnv(env.INSTAGRAM_INGESTION_MAX_SECONDS, 180);
  const tmpRoot = opts.tmpDir ?? path.join(os.tmpdir(), 'nanoclaw-instagram-ingestion');
  fs.mkdirSync(tmpRoot, { recursive: true });
  const workDir = fs.mkdtempSync(path.join(tmpRoot, 'job-'));

  try {
    if (!env.OPENAI_API_KEY) {
      throw new Error('missing_openai_api_key');
    }
    const metadata = await readMetadata(canonicalUrl, env, timeoutMs);
    const duration = metadata.duration ?? 0;
    if (duration > maxSeconds) {
      throw new Error(`video_too_long_${Math.round(duration)}s`);
    }
    const mediaPath = await downloadMedia(canonicalUrl, workDir, env, timeoutMs);
    const audioPath = path.join(workDir, 'audio.mp3');
    await extractAudio(mediaPath, audioPath, env, timeoutMs);
    const transcript = await transcribeAudio(audioPath, env);
    const item: LinkIngestion = {
      source: 'instagram',
      url,
      canonicalUrl,
      status: 'ready',
      kind: inferKind(metadata),
      caption: metadata.description || metadata.title || undefined,
      transcript: transcript || undefined,
      cachedAt: new Date().toISOString(),
    };
    writeCached(cacheDir, item);
    return item;
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    const item = makeFailed(url, canonicalUrl, error);
    writeCached(cacheDir, item);
    log.warn('Instagram ingestion failed', { canonicalUrl, err });
    return item;
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

export async function enrichInstagramLinks(event: InboundEvent, opts: IngestionOptions = {}): Promise<InboundEvent> {
  if (event.message.kind !== 'chat' && event.message.kind !== 'chat-sdk') return event;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(event.message.content) as Record<string, unknown>;
  } catch {
    return event;
  }
  const urls = extractInstagramUrls(parsed);
  if (urls.length === 0) return event;

  const existing = Array.isArray(parsed.linkIngestions) ? parsed.linkIngestions : [];
  const existingUrls = new Set(
    existing
      .filter((item): item is { canonicalUrl: string } => !!item && typeof item === 'object')
      .map((item) => item.canonicalUrl),
  );
  const additions: LinkIngestion[] = [];
  for (const url of urls) {
    if (existingUrls.has(url)) continue;
    additions.push(await ingestInstagramUrl(url, opts));
  }
  if (additions.length === 0) return event;
  parsed.linkIngestions = [...existing, ...additions];
  return {
    ...event,
    message: {
      ...event.message,
      content: JSON.stringify(parsed),
    },
  };
}

registerInboundEnricher(enrichInstagramLinks);

export const _test = {
  extractInstagramUrls,
  canonicalizeInstagramUrl,
  writeCachedForTest: writeCached,
};
