import { describe, expect, it } from 'vitest';
import { scriptedProvider } from '@sheavly/testing/provider/scripted-provider.fake';
import type { AgentEvent } from '@sheavly/protocol/event/event.types';
import type { StreamEvent } from '@sheavly/core/message/message.types';
import { streamAgent } from '../stream-agent.helper.js';

const offline: StreamEvent = {
  type: 'model_connection',
  connection: { state: 'offline', error: 'ENOTFOUND' },
};
const restored: StreamEvent = { type: 'model_connection', connection: { state: 'restored' } };

async function run(script: StreamEvent[]): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];

  for await (const event of streamAgent({
    provider: scriptedProvider([script]),
    tools: [],
    messages: [{ role: 'user', content: 'go' }],
  })) {
    events.push(event);
  }

  return events;
}

describe('a provider waiting for the network', () => {
  it('has its reports sent on in order before the reply, with a gap-free seq', async () => {
    const events = await run([
      offline,
      restored,
      { type: 'text_delta', text: 'hi' },
      { type: 'done', stopReason: 'end_turn' },
    ]);

    expect(events.map((event) => event.type)).toEqual([
      'model_connection',
      'model_connection',
      'text_delta',
      'usage',
      'turn_end',
      'done',
    ]);
    expect(events.slice(0, 2)).toMatchObject([
      { connection: { state: 'offline', error: 'ENOTFOUND' } },
      { connection: { state: 'restored' } },
    ]);
    expect(events.map((event) => event.seq)).toEqual(events.map((_, index) => index));
  });

  it('ends the run as it would have without the wait, and keeps the reports out of history', async () => {
    const events = await run([
      offline,
      restored,
      { type: 'text_delta', text: 'hi' },
      { type: 'done', stopReason: 'end_turn' },
    ]);
    const done = events.at(-1);

    if (done?.type !== 'done') throw new Error('Missing done event');
    expect(done.reason).toBe('completed');
    expect(done.messages).toHaveLength(2);
    expect(JSON.stringify(done.messages)).not.toContain('model_connection');
  });
});
