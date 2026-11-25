import { describe, expect, it } from 'vitest';
import { REFUSED_HOST_MESSAGE, REFUSED_ORIGIN_MESSAGE } from '../api.constants.js';
import {
  allowedRequests,
  canonicalHostName,
  hostNameOfHeader,
  isHostName,
  refusalOf,
} from '../request-origin.utils.js';

const LOCAL = allowedRequests();
const URL_OF = (host: string) => `http://${host}/conversations`;

describe('hostNameOfHeader', () => {
  it('takes the name out of a Host value, with or without a port, in one spelling', () => {
    expect(hostNameOfHeader('localhost')).toBe('localhost');
    expect(hostNameOfHeader('LocalHost:4310')).toBe('localhost');
    expect(hostNameOfHeader('localhost.:80')).toBe('localhost');
    expect(hostNameOfHeader('127.0.0.1:1')).toBe('127.0.0.1');
    expect(hostNameOfHeader('[::1]:4310')).toBe('[::1]');
    expect(hostNameOfHeader('[::1]')).toBe('[::1]');
  });

  it('refuses a value that is not a host name', () => {
    for (const value of ['', 'user@localhost', 'localhost/path', 'a b', 'localhost:', 'a:b:c']) {
      expect(hostNameOfHeader(value), value).toBeUndefined();
    }

    // A label with no letter or digit: these are no name, and `.` would otherwise be the empty one.
    for (const value of ['.', '..', '...', '-', 'a..b', '.a', '-a', 'a-']) {
      expect(hostNameOfHeader(value), value).toBeUndefined();
    }
  });
});

describe('canonicalHostName and isHostName', () => {
  it('write a name one way: lower case, no trailing dot, an IPv6 address in brackets', () => {
    expect(canonicalHostName('MyHost.Example.')).toBe('myhost.example');
    expect(canonicalHostName('::1')).toBe('[::1]');
    expect(canonicalHostName('[::1]')).toBe('[::1]');
  });

  it('accept a name or an address alone, and nothing that carries more', () => {
    for (const value of ['myhost.example', '10.0.0.5', '[::1]', 'localhost']) {
      expect(isHostName(value), value).toBe(true);
    }

    for (const value of ['http://myhost', 'myhost:80', 'my host', 'myhost/', '']) {
      expect(isHostName(value), value).toBe(false);
    }
  });

  it('refuse a name a client would never send: the URL writes it another way, or it is empty', () => {
    // `10.1` is `10.0.0.1` in a URL, `0x7f.1` is `127.0.0.1`, and a long IPv6 form is shortened.
    for (const value of ['10.1', '0x7f.1', '1', '[fe80:0:0:0:0:0:0:1]', '.', '...', '-', 'a..b']) {
      expect(isHostName(value), value).toBe(false);
    }

    for (const value of ['10.0.0.1', '[fe80::1]', 'my-host.example', 'MyHost.', 'a_b.example']) {
      expect(isHostName(value), value).toBe(true);
    }
  });
});

describe('allowedRequests', () => {
  it('always allows this machine, and no origin', () => {
    expect([...LOCAL.hosts].toSorted()).toEqual(['127.0.0.1', '[::1]', 'localhost']);
    expect(LOCAL.origins.size).toBe(0);
  });

  it('adds the name the server is bound to, and the names a remote server lists', () => {
    const allowed = allowedRequests({
      bound: 'My-Box.example',
      hosts: ['Other.Example', '10.0.0.5'],
      origins: ['https://app.example'],
    });

    expect([...allowed.hosts]).toEqual(
      expect.arrayContaining(['my-box.example', 'other.example', '10.0.0.5', 'localhost']),
    );
    expect(allowed.origins.has('https://app.example')).toBe(true);
  });

  it('adds nothing for a wildcard bind, which names no host', () => {
    for (const bound of ['0.0.0.0', '::', '0', '::0', '[::]']) {
      expect(allowedRequests({ bound }).hosts.size, bound).toBe(3);
    }
  });

  it('adds a bind address of this machine as the name a client may use', () => {
    expect(allowedRequests({ bound: '127.0.0.2' }).hosts.has('127.0.0.2')).toBe(true);
    expect(allowedRequests({ bound: '::1' }).hosts.has('[::1]')).toBe(true);
  });
});

describe('refusalOf', () => {
  const check = (params: { host?: string; url?: string; origin?: string }) =>
    refusalOf({
      host: params.host,
      url: params.url ?? URL_OF('localhost:4310'),
      origin: params.origin,
      allowed: LOCAL,
    });

  it('lets a request through that names this machine, whatever port it carries', () => {
    expect(check({})).toBeUndefined();
    expect(check({ host: 'localhost:4310' })).toBeUndefined();
    expect(check({ host: '127.0.0.1:55555', url: URL_OF('127.0.0.1:55555') })).toBeUndefined();
    expect(check({ host: '[::1]:4310', url: URL_OF('[::1]:4310') })).toBeUndefined();
    expect(check({ host: 'LOCALHOST.', url: URL_OF('localhost') })).toBeUndefined();
  });

  it('refuses a request for any other name: the Host, the URL, or one that is no host', () => {
    expect(check({ host: 'evil.example' })).toBe(REFUSED_HOST_MESSAGE);
    expect(check({ host: 'evil.example:4310', url: URL_OF('evil.example:4310') })).toBe(
      REFUSED_HOST_MESSAGE,
    );
    // A page whose name resolves to the loopback address: its Host is its own name.
    expect(check({ host: 'localhost.evil.example' })).toBe(REFUSED_HOST_MESSAGE);
    expect(check({ host: '127.0.0.1.evil.example' })).toBe(REFUSED_HOST_MESSAGE);
    // The URL names another host than the header (an absolute request line): refused too.
    expect(check({ host: 'localhost', url: URL_OF('evil.example') })).toBe(REFUSED_HOST_MESSAGE);
    expect(check({ host: 'user@localhost' })).toBe(REFUSED_HOST_MESSAGE);
    expect(check({ host: '' })).toBe(REFUSED_HOST_MESSAGE);
    expect(check({ url: URL_OF('evil.example') })).toBe(REFUSED_HOST_MESSAGE);
  });

  it('refuses any Origin that is not listed, null included, and lets a listed one through', () => {
    for (const origin of ['https://evil.example', 'null', 'http://localhost:4310', '']) {
      expect(check({ origin }), origin).toBe(REFUSED_ORIGIN_MESSAGE);
    }

    const allowed = allowedRequests({ origins: ['https://app.example'] });

    expect(
      refusalOf({
        host: 'localhost',
        url: URL_OF('localhost'),
        origin: 'https://app.example',
        allowed,
      }),
    ).toBeUndefined();
    expect(
      refusalOf({
        host: 'localhost',
        url: URL_OF('localhost'),
        origin: 'https://app.example:8443',
        allowed,
      }),
    ).toBe(REFUSED_ORIGIN_MESSAGE);
  });

  it('says only fixed text, never what the request sent', () => {
    expect(REFUSED_HOST_MESSAGE).not.toMatch(/evil|localhost/i);
    expect(check({ host: 'evil.example' })).toBe(REFUSED_HOST_MESSAGE);
    expect(check({ origin: 'https://evil.example' })).toBe(REFUSED_ORIGIN_MESSAGE);
  });
});
