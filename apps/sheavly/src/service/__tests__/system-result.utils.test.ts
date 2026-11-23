import { describe, expect, it } from 'vitest';
import { resultOf } from '../system-result.utils.js';

const OUTPUT = { stdout: 'out', stderr: 'err' };

// `uninstall` and the systemd check rest on this mapping, so each way a program can end is pinned.
describe('resultOf', () => {
  it('is ok with exit 0 and the output when the program succeeded', () => {
    expect(resultOf({ failure: null, ...OUTPUT })).toEqual({ status: 'ok', code: 0, ...OUTPUT });
  });

  it('is missing, not failed, when the program is not installed', () => {
    expect(resultOf({ failure: { code: 'ENOENT' }, ...OUTPUT })).toEqual({
      status: 'missing',
      code: 1,
      ...OUTPUT,
    });
  });

  it('is failed with its own exit code when it exited non-zero', () => {
    expect(resultOf({ failure: { code: 3 }, ...OUTPUT })).toEqual({
      status: 'failed',
      code: 3,
      ...OUTPUT,
    });
  });

  it.each([
    ['a timeout or a signal, which leave no code', {}],
    ['another error code, such as a refused permission', { code: 'EACCES' }],
    ['a code that is explicitly undefined', { code: undefined }],
  ])('is failed with code 1 for %s', (_name, failure) => {
    expect(resultOf({ failure, ...OUTPUT })).toEqual({
      status: 'failed',
      code: 1,
      ...OUTPUT,
    });
  });
});
