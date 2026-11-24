import { describe, expect, it, vi } from 'vitest';
import type { EntryEvent } from '@sheavly/protocol/event/event.types';
import { createChatLook } from '../chat-look.utils.js';
import { logLook } from '../log-look.utils.js';
import { Renderer } from '../render.service.js';

const offline: EntryEvent = {
  seq: 0,
  type: 'model_connection',
  connection: { state: 'offline', error: 'The Responses API request failed: ENOTFOUND' },
};
const unreachable: EntryEvent = {
  seq: 1,
  type: 'model_connection',
  connection: { state: 'provider_unreachable', error: 'HTTP 503', attempt: 2, retries: 3 },
};
const restored: EntryEvent = {
  seq: 2,
  type: 'model_connection',
  connection: { state: 'restored' },
};

function written(look: ConstructorParameters<typeof Renderer>[1], event: EntryEvent): string {
  const lines: string[] = [];
  const renderer = new Renderer((text) => lines.push(text), look);

  renderer.event(event);

  return lines.join('');
}

describe('Renderer: the model connection', () => {
  const chat = createChatLook();

  it('tells a person in the chat that it is reconnecting, and when it has', () => {
    expect(written(chat, offline)).toContain('Reconnecting…');
    expect(written(chat, offline)).toContain('no internet connection');
    expect(written(chat, restored)).toContain('Reconnected');
  });

  it('says the provider is not responding, with the retry, and not that the network is gone', () => {
    const line = written(chat, unreachable);

    expect(line).toContain('not responding');
    expect(line).toContain('2/3');
    expect(line).not.toContain('internet');
  });

  it('keeps the provider’s error text in the log and out of the chat', () => {
    expect(written(logLook, offline)).toContain('ENOTFOUND');
    expect(written(logLook, unreachable)).toContain('HTTP 503');
    expect(written(chat, offline)).not.toContain('ENOTFOUND');
  });

  it('prints an error as one plain line, whatever the provider wrote', () => {
    const hostile: EntryEvent = {
      seq: 3,
      type: 'model_connection',
      connection: { state: 'offline', error: 'down\n\u001b[2Jcleared\nsecond' },
    };
    const line = written(logLook, hostile);

    expect(line).not.toContain('\u001b');
    expect(line).not.toContain('second');
  });

  it('does not touch the reply, the running tools or the reasoning indicator', () => {
    const write = vi.fn();
    const reply = { write: vi.fn(), end: vi.fn() };
    const renderer = new Renderer(write, chat, reply);

    renderer.event({ seq: 0, type: 'reasoning_activity', active: true });
    renderer.event(offline);

    expect(reply.write).not.toHaveBeenCalled();
    expect(reply.end).not.toHaveBeenCalled();
    expect(renderer.thinking).toBe(true);
    expect(renderer.running).toHaveLength(0);
  });
});
