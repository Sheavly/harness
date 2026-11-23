import { describe, expect, it } from 'vitest';
import { LOG_FIELD } from '../logger.constants.js';
import type { LogFields } from '../logger.types.js';
import { createLogEntry, errorRecord, redactText } from '../logger.utils.js';

function entryWith(fields: LogFields) {
  return createLogEntry({ service: 'test', level: 'error', event: 'test.failed', time: 1, fields });
}

describe('errors', () => {
  it('keeps the name, message, stack and the whole cause chain', () => {
    const root = Object.assign(new Error('socket closed'), { code: 'ECONNRESET' });
    const entry = entryWith({ error: new TypeError('request failed', { cause: root }) });
    const record = entry.error as ReturnType<typeof errorRecord>;

    expect(record).toMatchObject({ name: 'TypeError', message: 'request failed' });
    expect(record.stack).toContain('request failed');
    expect(record.causes[0]).toMatchObject({ message: 'socket closed', code: 'ECONNRESET' });
  });

  it('writes a thrown string as the message', () => {
    expect(errorRecord('boom')).toMatchObject({ name: 'UnknownError', message: 'boom' });
  });
});

describe('redaction', () => {
  it('redacts a secret and identity-shaped text in a message and in its cause', () => {
    const cause = new Error('rejected for anna@example.com, id 19900101-1234');
    const entry = entryWith({
      error: new Error('call failed apiKey=sk-private-1234567890abcdef', { cause }),
    });
    const text = JSON.stringify(entry);

    expect(text).not.toContain('sk-private');
    expect(text).not.toContain('anna@example.com');
    expect(text).not.toContain('19900101-1234');
    expect(text).toContain('[REDACTED]');
  });

  it('redacts the stack and a stored error details', () => {
    const error = new Error('Bearer abcdefghijklmnop');
    const entry = entryWith({
      error,
      details: { name: 'E', stack: 'at x password=hunter2', causes: [] },
    });

    expect(JSON.stringify(entry)).not.toMatch(/abcdefghijklmnop|hunter2/);
  });

  it('redacts a secret in a text field, and leaves an id of digits alone', () => {
    const entry = entryWith({
      code: 'token=abc12345',
      conversationId: '00000000-0000-4000-8000-000000000001',
    });

    expect(entry.code).toBe('token=[REDACTED]');
    expect(entry.conversationId).toBe('00000000-0000-4000-8000-000000000001');
  });

  it('leaves ordinary text, ids and short numbers alone', () => {
    expect(redactText('line 12 of 4000, id 1234-abcd')).toBe('line 12 of 4000, id 1234-abcd');
  });

  it('redacts a JWT and a long digit run', () => {
    expect(redactText('jwt eyJhbGciOi.eyJzdWIiOiIx.c2ln and 0701234567')).toBe(
      'jwt [REDACTED] and [REDACTED]',
    );
  });
});

describe('the entry', () => {
  it('skips an undefined field and keeps a number a number', () => {
    const entry = entryWith({ code: undefined, status: 500 });

    expect(entry).not.toHaveProperty('code');
    expect(entry.status).toBe(500);
  });
});

/** A caller the compiler did not see: values the field types refuse. */
function untyped(fields: Record<string, unknown>) {
  return entryWith(fields);
}

describe('values that are not what their field holds', () => {
  it('drops an object in a text field and names the field, never writing it as it came', () => {
    const entry = untyped({ toolName: { secret: 'password=hunter2' }, code: 'ok' });

    expect(entry).not.toHaveProperty('toolName');
    expect(entry.droppedFields).toEqual(['toolName']);
    expect(JSON.stringify(entry)).not.toContain('hunter2');
  });

  it('drops a count that is not a finite number', () => {
    const entry = untyped({ status: Number.NaN, count: '3', durationMs: 12 });

    expect(entry.droppedFields).toEqual(['status', 'count']);
    expect(entry.durationMs).toBe(12);
  });

  it('redacts an e-mail address and a JWT in a text field, and cuts a long one', () => {
    const entry = entryWith({
      toolName: 'anna@example.com',
      hook: 'jwt eyJhbGciOi.eyJzdWIiOiIx.c2ln',
      handler: 'x'.repeat(5000),
    });

    expect(entry.toolName).toBe('[REDACTED]');
    expect(entry.hook).toBe('jwt [REDACTED]');
    expect(String(entry.handler).length).toBeLessThan(600);
  });
});

describe('bounds', () => {
  it('cuts a long error message before any pattern runs on it', () => {
    const record = errorRecord(new Error('a'.repeat(200_000)));

    expect(record.message.length).toBeLessThan(9000);
  });

  it('matches a long run of address characters without an @ quickly', () => {
    const started = performance.now();

    redactText('a'.repeat(200_000));
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it('ends details that refer to themselves instead of looping', () => {
    const loop: Record<string, unknown> = { name: 'E', causes: [] };

    loop.again = loop;

    const entry = untyped({ details: loop });

    expect(JSON.stringify(entry)).toContain('[truncated]');
  });

  it('writes the text of a value with no toString without throwing', () => {
    expect(errorRecord(Object.create(null)).message).toBe('[object Object]');
  });
});

describe('what the cut and the dropped keys leave', () => {
  it('drops a word the cut went through, so half a key never stays', () => {
    const text = `${'x '.repeat(8190)}sk-${'a'.repeat(40)}`;
    const record = errorRecord(new Error(text));

    expect(record.message).not.toContain('sk-');
    expect(record.message.endsWith('…')).toBe(true);
  });

  it('redacts an e-mail address with letters beyond ASCII', () => {
    expect(redactText('write to josé@exämple.com now')).toBe('write to [REDACTED] now');
  });

  it('redacts and caps the names of fields it drops', () => {
    const many = Object.fromEntries(
      Array.from({ length: 20 }, (_unused, n) => [`anna${String(n)}@example.com`, 1]),
    );
    const entry = untyped(many);

    expect(JSON.stringify(entry)).not.toContain('@example.com');
    expect(entry.droppedFields).toHaveLength(8);
  });
});

describe('the closed list of fields', () => {
  it('is exactly this: adding or removing one is a reviewed decision, visible here', () => {
    expect(Object.keys(LOG_FIELD).sort()).toEqual([
      'code',
      'conversationId',
      'count',
      'details',
      'durationMs',
      'error',
      'extension',
      'handler',
      'hook',
      'messageId',
      'modelId',
      'route',
      'seq',
      'sessionId',
      'status',
      'toolCallId',
      'toolName',
    ]);
  });
});
