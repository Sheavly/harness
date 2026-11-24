import { describe, expect, it } from 'vitest';
import { taskInfoSchema } from '../task.validator.js';

describe('taskInfoSchema', () => {
  const TASK = {
    id: 'task-1',
    kind: 'task',
    command: 'npm test',
    description: 'running the tests',
    status: 'completed',
    startedAt: 1,
    endedAt: 2,
    output: 'ok',
  };

  it('accepts a finished task, with a null exit code when a signal stopped it', () => {
    expect(taskInfoSchema.parse({ ...TASK, exitCode: 0 })).toEqual({ ...TASK, exitCode: 0 });
    expect(taskInfoSchema.parse({ ...TASK, exitCode: null }).exitCode).toBeNull();
  });

  it('keeps an explicit wait reason without adding one to an ungrouped task', () => {
    expect(taskInfoSchema.parse(TASK)).not.toHaveProperty('reason');
    expect(taskInfoSchema.parse({ ...TASK, reason: 'Compare the test results' }).reason).toBe(
      'Compare the test results',
    );
    expect(taskInfoSchema.parse({ ...TASK, reason: '' }).reason).toBe('');
  });

  it.each([undefined, null, 123])('rejects a present invalid reason: %j', (reason) => {
    expect(taskInfoSchema.safeParse({ ...TASK, reason }).success).toBe(false);
  });

  it('keeps a task, agent or service kind, and rejects a missing or unknown one', () => {
    expect(taskInfoSchema.parse({ ...TASK, kind: 'service' }).kind).toBe('service');
    expect(taskInfoSchema.parse({ ...TASK, kind: 'task' }).kind).toBe('task');
    expect(taskInfoSchema.parse({ ...TASK, kind: 'agent' }).kind).toBe('agent');
    const { kind: _kind, ...withoutKind } = TASK;

    expect(taskInfoSchema.safeParse(withoutKind).success).toBe(false);
    expect(taskInfoSchema.safeParse({ ...TASK, kind: 'daemon' }).success).toBe(false);
    expect(taskInfoSchema.safeParse({ ...TASK, kind: undefined }).success).toBe(false);
  });

  it('keeps the session a sub-agent task runs, and has none for a task that runs no session', () => {
    expect(taskInfoSchema.parse(TASK)).not.toHaveProperty('agentSessionId');
    expect(
      taskInfoSchema.parse({ ...TASK, kind: 'agent', agentSessionId: 'session-1' }).agentSessionId,
    ).toBe('session-1');
  });

  it.each([undefined, null, 7, {}])('rejects a present agent session that is %j', (value) => {
    expect(taskInfoSchema.safeParse({ ...TASK, agentSessionId: value }).success).toBe(false);
  });

  it('rejects an unknown status', () => {
    expect(taskInfoSchema.safeParse({ ...TASK, status: 'paused' }).success).toBe(false);
  });
});
