import { describe, expect, it } from 'vitest';
import type { OutputWriter } from '@sheavly/core/output/output.types';
import { outputRefSchema } from '@sheavly/protocol/output/output.validator';
import { until } from '@sheavly/testing/wait/until.fake';
import { TaskRegistry } from '../tasks.service.js';

const ref = outputRefSchema.parse('66666666-6666-4666-8666-666666666666');

/** A capture whose close rejects, as a store that fails at the very end would. */
function brokenCapture(): OutputWriter {
  return {
    log: { ref, bytes: 3, status: 'capturing' },
    append: () => undefined,
    follow: () => () => undefined,
    close: () =>
      Promise.reject(Object.assign(new Error('disk gone at /home/me/secret'), { code: 'EIO' })),
  };
}

describe('a task with a capture', () => {
  it('still settles when the log cannot be closed, and reports the log incomplete', async () => {
    const tasks = new TaskRegistry();
    const started = tasks.start({
      command: 'echo hi',
      description: 'hi',
      capture: brokenCapture(),
      run: async () => ({ exitCode: 0 }),
    });

    await until(() => tasks.get(started.id)?.status === 'completed');

    const log = tasks.get(started.id)?.outputLog;

    expect(log).toMatchObject({ ref, status: 'incomplete' });
    expect(log?.reason).toContain('EIO');
    expect(log?.reason).not.toContain('/home/me');
  });

  it('also settles a task whose run fails', async () => {
    const tasks = new TaskRegistry();
    const started = tasks.start({
      command: 'false',
      description: 'fails',
      capture: brokenCapture(),
      run: () => Promise.reject(new Error('could not start')),
    });

    await until(() => tasks.get(started.id)?.status === 'failed');

    expect(tasks.get(started.id)?.outputLog?.status).toBe('incomplete');
  });
});
