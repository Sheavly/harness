import type { Harness } from '../host/host.types.js';

/**
 * Test-only: starts finite work for the harness's main session that runs until the returned
 * `finish` is resolved, then exits 0: its end wakes an idle conversation to deliver the notice.
 */
export function startGatedWork(harness: Pick<Harness, 'tasks' | 'mainSession'>) {
  const finish = Promise.withResolvers<undefined>();

  harness.tasks.start({
    command: 'build',
    description: 'Build the project',
    sessionId: harness.mainSession.id,
    run: async ({ onOutput }) => {
      await finish.promise;
      onOutput('Build passed');

      return { exitCode: 0 };
    },
  });

  return finish;
}
