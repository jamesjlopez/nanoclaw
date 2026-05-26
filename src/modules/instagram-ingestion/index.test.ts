import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { _test, enrichInstagramLinks, type LinkIngestion } from './index.js';
import type { InboundEvent } from '../../channels/adapter.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instagram-ingestion-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function eventWithContent(content: object): InboundEvent {
  return {
    channelType: 'test',
    platformId: 'platform-1',
    threadId: null,
    message: {
      id: 'msg-1',
      kind: 'chat',
      timestamp: '2026-05-26T00:00:00.000Z',
      content: JSON.stringify(content),
    },
  };
}

describe('canonicalizeInstagramUrl', () => {
  it('canonicalizes reel, post, and tv URLs', () => {
    expect(_test.canonicalizeInstagramUrl('https://instagram.com/reel/ABC_123/?igsh=abc')).toBe(
      'https://www.instagram.com/reel/ABC_123/',
    );
    expect(_test.canonicalizeInstagramUrl('https://www.instagram.com/p/xyz-9')).toBe(
      'https://www.instagram.com/p/xyz-9/',
    );
    expect(_test.canonicalizeInstagramUrl('https://www.instagram.com/tv/a_b-c/')).toBe(
      'https://www.instagram.com/tv/a_b-c/',
    );
  });

  it('rejects non-Instagram and unsupported paths', () => {
    expect(_test.canonicalizeInstagramUrl('https://example.com/reel/ABC/')).toBeNull();
    expect(_test.canonicalizeInstagramUrl('https://www.instagram.com/stories/user/123/')).toBeNull();
  });
});

describe('extractInstagramUrls', () => {
  it('extracts and deduplicates URLs from text and links', () => {
    expect(
      _test.extractInstagramUrls({
        text: 'watch https://www.instagram.com/reel/ABC/?utm_source=x',
        links: [{ url: 'https://instagram.com/reel/ABC/' }, 'https://www.instagram.com/p/DEF/'],
      }),
    ).toEqual(['https://www.instagram.com/reel/ABC/', 'https://www.instagram.com/p/DEF/']);
  });
});

describe('enrichInstagramLinks', () => {
  it('uses a ready cache entry without calling external tools', async () => {
    const canonicalUrl = 'https://www.instagram.com/reel/ABC/';
    const cached: LinkIngestion = {
      source: 'instagram',
      url: canonicalUrl,
      canonicalUrl,
      status: 'ready',
      kind: 'video',
      transcript: 'Cached transcript',
      cachedAt: '2026-05-26T00:00:00.000Z',
    };
    _test.writeCachedForTest(tmpDir, cached);

    const enriched = await enrichInstagramLinks(eventWithContent({ text: `watch ${canonicalUrl}` }), {
      cacheDir: tmpDir,
      env: { INSTAGRAM_YTDLP_BIN: path.join(tmpDir, 'missing-yt-dlp') },
    });
    const content = JSON.parse(enriched.message.content) as { linkIngestions: LinkIngestion[] };
    expect(content.linkIngestions).toEqual([cached]);
  });

  it('adds a failed ingestion when OpenAI credentials are missing', async () => {
    const canonicalUrl = 'https://www.instagram.com/reel/NO_KEY/';
    const enriched = await enrichInstagramLinks(eventWithContent({ text: `watch ${canonicalUrl}` }), {
      cacheDir: tmpDir,
      env: {},
    });
    const content = JSON.parse(enriched.message.content) as { linkIngestions: LinkIngestion[] };
    expect(content.linkIngestions).toMatchObject([
      {
        source: 'instagram',
        canonicalUrl,
        status: 'failed',
        error: 'missing_openai_api_key',
      },
    ]);
  });
});
