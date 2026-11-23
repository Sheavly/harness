import { errorCode } from '@sheavly/runtime/errors/errors.utils';
import type { Finding } from './doctor.types.js';

/** What a failure is called in the report: its error code, else its class, never its message. */
function failureKind(caughtError: unknown): string {
  return errorCode(caughtError) ?? (caughtError instanceof Error ? caughtError.name : 'unknown');
}

/**
 * Runs one check and returns its finding. A check that throws (a folder that cannot be read, a
 * home that cannot be resolved) becomes a failing finding naming the kind of failure, never its
 * message, which could hold a path or text from a file: a tool for finding what is wrong must
 * still print the other checks.
 */
export async function settleCheck(params: {
  label: string;
  run: () => Promise<Finding>;
}): Promise<Finding> {
  const { label, run } = params;

  try {
    return await run();
  } catch (caughtError) {
    // Every failure becomes a finding on purpose: nothing a check throws may hide the others.
    return {
      label,
      ok: false,
      lines: [`could not be checked (${failureKind(caughtError)})`],
    };
  }
}
