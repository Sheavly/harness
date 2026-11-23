import { describe, expect, it, vi } from 'vitest';
import { useFixedClock } from '@sheavly/testing/clock/fixed-clock.fake';
import { createLogger } from '../logger.helper.js';
import type { LogEntry } from '../logger.types.js';

const clock = useFixedClock();

function collecting(level?: 'debug' | 'info' | 'warn' | 'error') {
  const entries: LogEntry[] = [];
  const logger = createLogger({
    service: 'test',
    level,
    sinks: [(entry) => void entries.push(entry)],
  });

  return { entries, logger };
}

describe('levels', () => {
  it('writes an entry at or above the minimum level and drops the rest', () => {
    const { entries, logger } = collecting('warn');

    logger.debug('test.debug');
    logger.info('test.info');
    logger.warn('test.warn');
    logger.error('test.error');
    expect(entries.map((entry) => entry.level)).toEqual(['warn', 'error']);
  });

  it('defaults to info', () => {
    const { entries, logger } = collecting();

    logger.debug('test.debug');
    logger.info('test.info');
    expect(entries.map((entry) => entry.event)).toEqual(['test.info']);
  });

  it('stamps the service and the time on every entry', () => {
    const { entries, logger } = collecting();

    logger.info('test.info');
    expect(entries[0]).toMatchObject({ service: 'test', time: clock.at });
  });
});

describe('child loggers', () => {
  it('adds its fields to every entry, and a call may add more', () => {
    const { entries, logger } = collecting();
    const child = logger.child({ conversationId: 'c-1' });

    child.info('test.one', { code: 'a' });
    logger.info('test.two');
    expect(entries[0]).toMatchObject({ conversationId: 'c-1', code: 'a' });
    expect(entries[1]).not.toHaveProperty('conversationId');
  });
});

describe('the closed field list', () => {
  it('refuses a key that is not allowed at compile time and drops it at runtime', () => {
    const { entries, logger } = collecting();

    // @ts-expect-error `body` is not in the allow-list of fields.
    logger.info('test.info', { body: 'private text' });
    expect(entries[0]).not.toHaveProperty('body');
    expect(entries[0]?.droppedFields).toEqual(['body']);
  });
});

describe('sinks', () => {
  it('lets a sink that throws neither break the caller nor starve the others', () => {
    const entries: LogEntry[] = [];
    const failures: number[] = [];
    const logger = createLogger({
      service: 'test',
      sinks: [
        () => {
          throw new Error('disk full');
        },
        (entry) => void entries.push(entry),
      ],
      onSinkFailure: ({ position }) => failures.push(position),
    });

    expect(() => logger.info('test.info')).not.toThrow();
    expect(entries).toHaveLength(1);
    expect(failures).toEqual([0]);
  });

  it('reports a sink that rejects, without an unhandled rejection', async () => {
    const onSinkFailure = vi.fn();
    const logger = createLogger({
      service: 'test',
      sinks: [() => Promise.reject(new Error('disk full'))],
      onSinkFailure,
    });

    logger.info('test.info');
    await vi.waitFor(() => expect(onSinkFailure).toHaveBeenCalledTimes(1));
    expect(onSinkFailure.mock.calls[0]?.[0]).toMatchObject({ position: 0 });
  });

  it('reports an entry it cannot make, with no sink position, and never throws', () => {
    const failures: { position: number; error: unknown }[] = [];
    const entries: LogEntry[] = [];
    const logger = createLogger({
      service: 'test',
      sinks: [(entry) => void entries.push(entry)],
      onSinkFailure: (failure) => failures.push(failure),
    });
    // Details no redaction expects: a cause whose message is not text.
    const odd = new Error('outer', { cause: Object.assign(new Error('inner'), { message: 5 }) });

    expect(() => logger.error('test.failed', { error: odd })).not.toThrow();
    expect(entries).toEqual([]);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.position).toBe(-1);
  });

  it('gives every sink the same frozen entry', () => {
    const seen: LogEntry[] = [];
    const logger = createLogger({
      service: 'test',
      sinks: [(entry) => void seen.push(entry), (entry) => void seen.push(entry)],
    });

    logger.info('test.info');
    expect(seen[0]).toBe(seen[1]);
    expect(Object.isFrozen(seen[0])).toBe(true);
  });
});
