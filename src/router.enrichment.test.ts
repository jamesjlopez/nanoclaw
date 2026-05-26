import { afterEach, describe, expect, it } from 'vitest';

import { _clearInboundEnrichersForTest, applyInboundEnrichers, registerInboundEnricher } from './router.js';
import type { InboundEvent } from './channels/adapter.js';

afterEach(() => {
  _clearInboundEnrichersForTest();
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

describe('inbound enrichers', () => {
  it('applies registered enrichers in order', async () => {
    registerInboundEnricher((event) => {
      const content = JSON.parse(event.message.content) as Record<string, unknown>;
      content.first = true;
      return { ...event, message: { ...event.message, content: JSON.stringify(content) } };
    });
    registerInboundEnricher((event) => {
      const content = JSON.parse(event.message.content) as Record<string, unknown>;
      content.second = content.first === true;
      return { ...event, message: { ...event.message, content: JSON.stringify(content) } };
    });

    const enriched = await applyInboundEnrichers(eventWithContent({ text: 'hello' }));
    expect(JSON.parse(enriched.message.content)).toEqual({
      text: 'hello',
      first: true,
      second: true,
    });
  });

  it('continues with the previous content when an enricher throws', async () => {
    registerInboundEnricher((event) => {
      const content = JSON.parse(event.message.content) as Record<string, unknown>;
      content.before = true;
      return { ...event, message: { ...event.message, content: JSON.stringify(content) } };
    });
    registerInboundEnricher(() => {
      throw new Error('boom');
    });
    registerInboundEnricher((event) => {
      const content = JSON.parse(event.message.content) as Record<string, unknown>;
      content.after = true;
      return { ...event, message: { ...event.message, content: JSON.stringify(content) } };
    });

    const enriched = await applyInboundEnrichers(eventWithContent({ text: 'hello' }));
    expect(JSON.parse(enriched.message.content)).toEqual({
      text: 'hello',
      before: true,
      after: true,
    });
  });
});
