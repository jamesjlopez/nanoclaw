# Backlog

## Queued Low-Cost Ingest Worker

Default source ingestion should be cheapest-mode and asynchronous unless the user explicitly asks for immediate ingest.

Planned shape:

- Store queued ingest requests from any channel/source: YouTube, podcasts, repos, Instagram, articles, docs, and other links.
- Run deterministic preprocessing first: metadata fetch, transcript/content retrieval, chapter extraction, sponsor/ad skipping, deduplication, and compact file-diff planning.
- Use cheap direct models such as Gemini/OpenAI for bulk extraction and chapter summaries.
- Give Claude only compact structured extraction results and proposed wiki edits; Claude acts as final editor/file writer instead of reading entire transcripts.
- Patch or append wiki pages rather than rewriting large existing pages.
- Keep items pending when transcripts/content are not available yet, and retry later instead of doing expensive search-heavy recovery.
- Report status back to the user when queued, completed, delayed, or failed.

Target modes:

- `queued-standard`: default, later today or overnight, target roughly 80%+ lower cost than immediate Sonnet ingest.
- `immediate`: only when explicitly requested with phrases like "immediately ingest" or "ingest immediately".
