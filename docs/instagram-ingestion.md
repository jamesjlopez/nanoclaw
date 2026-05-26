# Instagram Ingestion

Goal: when a user sends an Instagram post/Reel URL, NanoClaw should derive a
compact text artifact from that content and feed it into the normal agent
message path. The user should not need to download or resend the media.

## Shape

Treat Instagram ingestion as inbound enrichment:

```
incoming chat -> router/access/session decision -> enrich content -> inbound.db -> formatter -> agent
```

The router should not know Instagram-specific details. It exposes a generic
inbound enricher hook; the Instagram module plugs into that hook, detects
Instagram URLs, resolves media/metadata, and appends text artifacts to the
message content.

## Content Contract

Add a `linkIngestions` array to the parsed message content:

```json
{
  "text": "look at this https://www.instagram.com/reel/...",
  "linkIngestions": [
    {
      "source": "instagram",
      "url": "https://www.instagram.com/reel/...",
      "canonicalUrl": "https://www.instagram.com/reel/SHORTCODE/",
      "status": "ready",
      "kind": "video",
      "caption": "...",
      "transcript": "...",
      "ocr": "...",
      "toolMentions": [
        { "name": "Raycast", "evidence": "I use Raycast to...", "confidence": 0.86 }
      ],
      "cachedAt": "2026-05-26T19:00:00.000Z"
    }
  ]
}
```

On failure, keep the message useful:

```json
{
  "source": "instagram",
  "url": "...",
  "canonicalUrl": "...",
  "status": "failed",
  "error": "media_resolve_failed"
}
```

The formatter should render ready artifacts as text under the original message
so the agent sees them without opening the link.

## Resolver Ladder

Use the cheapest available source first:

1. Cache lookup by canonical URL or media hash.
2. Official/oEmbed-style metadata for caption, author, thumbnail, and embed
   availability.
3. Authenticated media resolution from a local browser/cookie-backed session.
4. Download the smallest usable media variant to a temp file.
5. For video/Reels, extract mono low-bitrate audio with `ffmpeg`.
6. Transcribe audio with a cheap speech-to-text model.
7. For image/carousel frames, OCR locally first, then use a vision model only
   when OCR is low-signal.
8. Extract tool mentions from the resulting text with a cheap structured pass.

## Cost Controls

- Cache all successful and failed URL resolutions.
- Deduplicate by shortcode and by media hash when available.
- Avoid vision calls unless OCR/transcript is missing or too short.
- Cap max video duration, downloaded bytes, frame samples, and model retries.
- Store transcripts and extracted tool mentions; discard raw media after
  processing unless debugging is explicitly enabled.

## Privacy And Reliability

Instagram URL-only ingestion requires a media resolver. Official metadata
endpoints are useful but do not generally provide a transcript or stable raw
media URL for arbitrary public Reels.

Recommended default for a personal NanoClaw fork:

- Use a local authenticated browser session owned by the operator.
- Keep session state under `data/instagram-ingestion/`.
- Do not commit cookies, downloaded media, transcripts, or cache data.
- Make third-party extractor APIs pluggable but optional.

## Implementation Phases

1. Generic router enricher hook.
2. Formatter rendering for `linkIngestions`.
3. Instagram URL detection and canonicalization.
4. File-backed cache.
5. Metadata resolver.
6. Authenticated browser/media resolver.
7. Audio extraction + transcription.
8. OCR/image fallback.
9. Tool-mention extraction.

## Current Runtime Dependencies

The host-side Instagram module uses external binaries and the OpenAI audio
transcription API:

- `yt-dlp` on PATH, or `INSTAGRAM_YTDLP_BIN=/path/to/yt-dlp`
- `ffmpeg` on PATH, or `INSTAGRAM_FFMPEG_BIN=/path/to/ffmpeg`
- `OPENAI_API_KEY` for `gpt-4o-mini-transcribe`

Optional resolver settings:

- `OPENAI_TRANSCRIBE_MODEL`, default `gpt-4o-mini-transcribe`
- `INSTAGRAM_YTDLP_COOKIES_FROM_BROWSER`, e.g. `chrome` or `safari`
- `INSTAGRAM_COOKIES_FILE`, passed to `yt-dlp --cookies`
- `INSTAGRAM_INGESTION_MAX_SECONDS`, default `180`
- `INSTAGRAM_INGESTION_MAX_BYTES`, default `78643200`
- `INSTAGRAM_INGESTION_TIMEOUT_MS`, default `90000`
- `INSTAGRAM_INGESTION_FAILURE_CACHE_MS`, default `3600000`

Missing dependencies do not break routing. The enricher appends a failed
`linkIngestions` entry with an error string. Successful results are cached
indefinitely; failed results are cached briefly so installing a missing
dependency later allows retry after the failure cache expires.
