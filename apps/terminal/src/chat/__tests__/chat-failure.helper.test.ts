import { afterEach, describe, expect, it, vi } from 'vitest';
import { SetupCancelledError, SetupError } from '../../errors/setup.errors.js';
import { reportChatFailure } from '../chat-failure.helper.js';

afterEach(() => {
  process.exitCode = undefined;
  vi.restoreAllMocks();
});

describe('reportChatFailure', () => {
  it('prints the message and ends with 1', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    reportChatFailure(new SetupError('no model'));

    expect(error).toHaveBeenCalledWith('no model');
    expect(process.exitCode).toBe(1);
  });

  it('ends with 130 when the user cancelled the setup', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    reportChatFailure(new SetupCancelledError());

    expect(process.exitCode).toBe(130);
  });

  it('drops the user name and password of a URL in the message, and keeps the rest', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    reportChatFailure(
      new TypeError(
        'Request cannot be constructed from a URL that includes credentials: http://user:a-secret@127.0.0.1:4310/setup and https://only-token@example.test/x',
      ),
    );

    expect(error).toHaveBeenCalledWith(
      'Request cannot be constructed from a URL that includes credentials: http://127.0.0.1:4310/setup and https://example.test/x',
    );
  });

  it('drops a password holding @, /, # or ?, and a URL right after a dash or a number', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const urls = [
      'http://user:p@SECRET@host/setup',
      'Failed to parse URL from http://user:p/SECRET@host/setup',
      'http://user:p#SECRET@host/setup',
      'http://user:p?SECRET@host/setup',
      '-http://user:SECRET@host/setup',
      'step 2.https://user:SECRET@host/setup',
    ];

    for (const url of urls) reportChatFailure(new Error(url));

    const printed = error.mock.calls.map(([text]) => String(text));

    expect(printed.filter((text) => text.includes('SECRET') || text.includes('user'))).toEqual([]);
    expect(printed[1]).toBe('Failed to parse URL from http://host/setup');
  });

  it('keeps an address without credentials and an email whole', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    reportChatFailure(new Error('fetch failed: http://127.0.0.1:4310/setup, ask a@b.example'));

    expect(error).toHaveBeenCalledWith(
      'fetch failed: http://127.0.0.1:4310/setup, ask a@b.example',
    );
  });

  it('strips a long message in one pass, not once per dot', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    // A pattern that rescanned from every `.` took about 200 s on this; one pass is milliseconds.
    const long = `${'a.'.repeat(500_000)} http://user:a-secret@host/x`;

    reportChatFailure(new Error(long));

    expect(error).toHaveBeenCalledWith(`${'a.'.repeat(500_000)} http://host/x`);
  });

  it('says what caused it, and drops the credentials of a URL in the cause too', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    reportChatFailure(
      new TypeError('fetch failed', {
        cause: new Error('connect ECONNREFUSED http://user:a-secret@127.0.0.1:4310'),
      }),
    );

    expect(error).toHaveBeenCalledWith('fetch failed (connect ECONNREFUSED http://127.0.0.1:4310)');
  });

  it('prints a thrown value that is not an error as text', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    reportChatFailure('plain');

    expect(error).toHaveBeenCalledWith('plain');
  });
});
