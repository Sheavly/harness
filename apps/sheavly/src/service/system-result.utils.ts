import type { ExecFailure, SystemResult } from './service.types.js';

/**
 * What a finished program amounts to: `ok` when it exited 0, `missing` when it is not installed
 * (`ENOENT`), otherwise `failed` with its exit code (1 when there is none, as for a timeout or a
 * signal, which leave no numeric code).
 */
export function resultOf(params: {
  failure: ExecFailure | null;
  stdout: string;
  stderr: string;
}): SystemResult {
  const { failure, stdout, stderr } = params;

  if (failure === null) return { status: 'ok', code: 0, stdout, stderr };

  if (failure.code === 'ENOENT') return { status: 'missing', code: 1, stdout, stderr };

  const code = typeof failure.code === 'number' ? failure.code : 1;

  return { status: 'failed', code, stdout, stderr };
}
