import { describe, expect, it } from 'vitest';
import type { Finding } from '../doctor.types.js';
import { settleCheck } from '../settle-check.helper.js';

const SECRET = 'text-from-a-file-or-a-path';

describe('doctor settles a check that cannot run', () => {
  it('returns the finding of a check that ran', async () => {
    const finding: Finding = { label: 'Home', ok: true, lines: ['fine'] };

    expect(await settleCheck({ label: 'Home', run: () => Promise.resolve(finding) })).toBe(finding);
  });

  it('turns an error with a code into a failing finding that names the code, not the message', async () => {
    const failure = Object.assign(new Error(SECRET), { code: 'EACCES' });
    const found = await settleCheck({ label: 'Home', run: () => Promise.reject(failure) });

    expect(found).toEqual({ label: 'Home', ok: false, lines: ['could not be checked (EACCES)'] });
  });

  it('names the class of an error with no code, and still not its message', async () => {
    const found = await settleCheck({
      label: 'Server',
      run: () => Promise.reject(new TypeError(SECRET)),
    });

    expect(found.lines).toEqual(['could not be checked (TypeError)']);
    expect(found.ok).toBe(false);
  });
});
