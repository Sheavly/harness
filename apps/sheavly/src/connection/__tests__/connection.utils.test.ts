import { describe, expect, it } from 'vitest';
import { ConnectionError } from '../../errors/cli.errors.js';
import { environmentConnection, renderConnection } from '../connection.utils.js';

const TOKEN = 'an-explicit-token-0123456789abcdef';
const URL_GIVEN = 'http://127.0.0.1:4310';

/** The message `attempt` throws, or an empty text when it does not throw. */
function messageOf(attempt: () => unknown): string {
  try {
    attempt();
  } catch (caughtError) {
    return caughtError instanceof Error ? caughtError.message : '';
  }

  return '';
}

describe('renderConnection', () => {
  it('prints a discovery connection as one line of JSON with its fields in a fixed order', () => {
    expect(
      renderConnection({
        source: 'discovery',
        url: URL_GIVEN,
        token: TOKEN,
        protocolVersion: '1.2.0',
        serverVersion: '0.4.0',
      }),
    ).toBe(
      `{"source":"discovery","url":"${URL_GIVEN}","token":"${TOKEN}","protocolVersion":"1.2.0","serverVersion":"0.4.0"}\n`,
    );
  });

  it('prints an environment connection with no versions, since none was asked for', () => {
    expect(renderConnection({ source: 'environment', url: URL_GIVEN, token: TOKEN })).toBe(
      `{"source":"environment","url":"${URL_GIVEN}","token":"${TOKEN}"}\n`,
    );
  });

  it('prints only the fields of its type, whatever else the connection object carries', () => {
    const wider = {
      source: 'environment' as const,
      url: URL_GIVEN,
      token: TOKEN,
      instanceId: 'must-not-appear',
    };

    expect(renderConnection(wider)).not.toContain('must-not-appear');
  });

  it('keeps a value with a quote, a backslash or a line break one parseable line', () => {
    const token = 'a"b\\c\nd';
    const line = renderConnection({ source: 'environment', url: URL_GIVEN, token });

    expect(line.split('\n')).toHaveLength(2);
    expect((JSON.parse(line) as { token: string }).token).toBe(token);
  });
});

describe('environmentConnection', () => {
  it('names the server BACKEND_URL and BACKEND_TOKEN give, as given', () => {
    expect(environmentConnection({ BACKEND_URL: URL_GIVEN, BACKEND_TOKEN: TOKEN })).toEqual({
      url: URL_GIVEN,
      token: TOKEN,
    });
    expect(
      environmentConnection({ BACKEND_URL: 'https://sheavly.example/api', BACKEND_TOKEN: TOKEN }),
    ).toEqual({ url: 'https://sheavly.example/api', token: TOKEN });
  });

  it.each([
    ['not set', {}],
    ['empty', { BACKEND_URL: '' }],
    ['not set, with a BACKEND_TOKEN alone, which is ignored', { BACKEND_TOKEN: TOKEN }],
  ])('names nothing when BACKEND_URL is %s', (_name, env) => {
    expect(environmentConnection(env)).toBeUndefined();
  });

  it.each([
    ['not set', {}],
    ['empty', { BACKEND_TOKEN: '' }],
  ])('refuses a BACKEND_URL with a BACKEND_TOKEN that is %s, naming the variable', (_name, env) => {
    expect(() => environmentConnection({ BACKEND_URL: URL_GIVEN, ...env })).toThrow(
      ConnectionError,
    );
    expect(() => environmentConnection({ BACKEND_URL: URL_GIVEN, ...env })).toThrow(
      'BACKEND_TOKEN',
    );
  });

  it.each([
    'not a url',
    'ftp://example.com',
    'ftp://someone:hunter2@example.com',
    'javascript:alert(1)',
    'file:///etc/passwd',
    '//x',
    // Forms the URL parser reads as a host and other parsers do not, or the other way round.
    'http:evil.example',
    'http:/evil.example',
    'http://127.0.0.1\\@evil.example',
    // A login: a person reads the first host, a client connects to the second.
    'http://me:pw@127.0.0.1:4310',
    'http://127.0.0.1@evil.example',
    'https://someone@evil.example/path',
    'http://@evil.example',
    // Space, control and invisible format characters.
    ' http://127.0.0.1:4310',
    'http://127.0.0.1:4310\n',
    'http://127.0.0.1\t:4310',
    'http://127.0.0.1:4310\u0000',
    'http://127.0.0.1\u200B:4310',
    'http://127.0.0.1\u202E:4310',
  ])('refuses %j as a BACKEND_URL, without repeating any part of it or the token', (value) => {
    const attempt = () => environmentConnection({ BACKEND_URL: value, BACKEND_TOKEN: TOKEN });
    const message = messageOf(attempt);

    expect(attempt).toThrow(ConnectionError);
    expect(message).toContain('BACKEND_URL');
    expect(message).not.toContain(value.trim());

    for (const secret of ['someone', 'hunter2', 'evil.example', TOKEN]) {
      expect(message).not.toContain(secret);
    }
  });

  it.each([
    'HTTP://127.0.0.1:4310',
    'https://sheavly.example',
    'http://[::1]:4310/api',
    // An `@` after the host is only text of the path, the query or the fragment.
    'http://127.0.0.1:4310/a@b',
    'http://127.0.0.1:4310?next=me@here',
    'http://127.0.0.1:4310#me@here',
  ])('accepts %j', (value) => {
    expect(environmentConnection({ BACKEND_URL: value, BACKEND_TOKEN: TOKEN })).toEqual({
      url: value,
      token: TOKEN,
    });
  });

  it('says the URL is wrong before it says the token is missing', () => {
    expect(() => environmentConnection({ BACKEND_URL: 'not a url' })).toThrow('BACKEND_URL is not');
  });
});
