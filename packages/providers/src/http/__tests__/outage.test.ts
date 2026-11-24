import { describe, expect, it } from 'vitest';
import { useFixedClock } from '@sheavly/testing/clock/fixed-clock.fake';
import { ModelApiError } from '../../errors/providers.errors.js';
import { TEST_REQUEST } from '../../testing/request.constants.js';
import { sendCollecting } from '../../testing/send.fake.js';
import type { RequestPolicy } from '../http.types.js';

const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;
const PROBE = 'https://probe.test/';
const MODEL = new URL('https://model.test/v1/messages');
/** A response timeout longer than any step a test simulates, so only a sleep looks like one. */
const policy: RequestPolicy = {
  ...TEST_REQUEST,
  responseTimeoutMs: HOUR_MS,
  retries: 2,
  offlineTimeoutMs: HOUR_MS,
  probeUrls: [PROBE],
};

/** The way a model call is answered: not at all (the network error Node gives), a 503, or well. */
type Answer = 'unreachable' | 'busy' | 'ok';

/**
 * A fetch for a model and a probe address. `model` answers the nth call to the model (from 1);
 * `probe` answers a probe with a status, or undefined for no answer at all.
 */
function network(params: {
  model: (call: number) => Answer;
  probe: () => number | undefined;
  onModelCall?: (call: number) => void;
}) {
  const calls = { model: 0, probe: 0 };
  const fetch = ((input: string | URL) => {
    if (String(input) === PROBE) {
      calls.probe++;
      const status = params.probe();

      return status === undefined
        ? Promise.reject(new TypeError('fetch failed'))
        : Promise.resolve(new Response(null, { status }));
    }

    calls.model++;
    params.onModelCall?.(calls.model);

    return answer(params.model(calls.model));
  }) as typeof globalThis.fetch;

  return { fetch, calls };
}

function answer(how: Answer): Promise<Response> {
  if (how === 'ok') return Promise.resolve(new Response('ok'));

  if (how === 'busy') return Promise.resolve(new Response('busy', { status: 503 }));

  return Promise.reject(
    new TypeError('fetch failed', {
      cause: Object.assign(new Error('getaddrinfo ENOTFOUND model.test'), { code: 'ENOTFOUND' }),
    }),
  );
}

const states = (reports: { connection: { state: string } }[]) =>
  reports.map((report) => report.connection.state);

const send = (params: {
  fetch: typeof globalThis.fetch;
  request?: Partial<RequestPolicy>;
  url?: URL;
  signal?: AbortSignal;
}) =>
  sendCollecting({
    api: 'Test API',
    fetch: params.fetch,
    url: params.url ?? MODEL,
    init: { method: 'POST', body: '{}' },
    policy: { ...policy, ...params.request },
    signal: params.signal ?? new AbortController().signal,
  });

describe('a call with no connection to its provider', () => {
  const clock = useFixedClock();

  it('waits for the connection and resumes, saying `offline` once and then `restored`', async () => {
    const { fetch, calls } = network({
      model: (call) => (call <= 3 ? 'unreachable' : 'ok'),
      probe: () => undefined,
    });
    const { response, reports } = await send({ fetch });

    expect(await response.text()).toBe('ok');
    expect(calls.model).toBe(4);
    expect(states(reports)).toEqual(['offline', 'restored']);
    expect(reports[0]?.connection).toMatchObject({
      error: expect.stringContaining('ENOTFOUND') as string,
    });
  });

  it('does not use the provider’s retries up while it waits', async () => {
    const { fetch } = network({
      model: (call) => (call <= 6 ? 'unreachable' : 'ok'),
      probe: () => undefined,
    });

    await expect(send({ fetch, request: { retries: 1 } })).resolves.toBeDefined();
  });

  it('gives up once the time it was awake without a connection passes `offlineTimeoutMs`', async () => {
    const { fetch, calls } = network({
      model: () => 'unreachable',
      probe: () => undefined,
      onModelCall: () => {
        clock.advance(20 * MINUTE_MS);
      },
    });
    const failure = await send({ fetch }).catch((caughtError: unknown) => caughtError);

    expect(failure).toBeInstanceOf(ModelApiError);
    expect(failure).toMatchObject({ reason: 'network' });
    expect((failure as Error).message).toContain('no connection for 60 min');
    expect((failure as Error).message).toContain('ENOTFOUND');
    expect(calls.model).toBe(3);
  });

  it('counts only time awake: a sleep starts the wait over instead of using it up', async () => {
    const { fetch, calls } = network({
      model: (call) => (call <= 5 ? 'unreachable' : 'ok'),
      probe: () => undefined,
      onModelCall: () => {
        clock.advance(10 * HOUR_MS);
      },
    });
    const { reports } = await send({ fetch });

    expect(calls.model).toBe(6);
    expect(states(reports)).toEqual(['offline', 'restored']);
  });

  it('stops waiting when the run is interrupted, without renaming the interrupt', async () => {
    const controller = new AbortController();
    const { fetch } = network({ model: () => 'unreachable', probe: () => undefined });
    const running = send({
      fetch,
      request: { retryDelayMs: 20_000 },
      signal: controller.signal,
    }).catch((caughtError: unknown) => caughtError);

    setTimeout(() => {
      controller.abort(new Error('stop'));
    }, 20);

    const failure = await running;

    expect(failure).not.toBeInstanceOf(ModelApiError);
    expect((failure as Error).message).toBe('stop');
  });
});

describe('a call to a provider that fails while the connection is up', () => {
  it.each([200, 404, 500])(
    'is retried as before and then reported, whatever status (%i) the probe answers with',
    async (status) => {
      const { fetch, calls } = network({ model: () => 'unreachable', probe: () => status });
      const failure = await send({ fetch }).catch((caughtError: unknown) => caughtError);

      expect(failure).toMatchObject({ reason: 'network' });
      expect((failure as Error).message).toContain('after 3 attempts');
      expect(calls.model).toBe(3);
    },
  );

  it('says `provider_unreachable` for a dropped request, then `restored` once it gets through', async () => {
    const { fetch } = network({
      model: (call) => (call <= 1 ? 'unreachable' : 'ok'),
      probe: () => 204,
    });
    const { reports } = await send({ fetch });

    expect(states(reports)).toEqual(['provider_unreachable', 'restored']);
  });

  it('reports each retry with its number, and never says `offline`', async () => {
    const { fetch } = network({
      model: (call) => (call <= 2 ? 'busy' : 'ok'),
      probe: () => 204,
    });
    const { reports } = await send({ fetch });

    expect(reports.map((report) => report.connection)).toEqual([
      expect.objectContaining({ state: 'provider_unreachable', attempt: 1, retries: 2 }),
      expect.objectContaining({ state: 'provider_unreachable', attempt: 2, retries: 2 }),
      { state: 'restored' },
    ]);
  });
});

describe('when a lost connection cannot be told from a provider that is down', () => {
  it.each([
    ['a model on this machine', { url: new URL('http://localhost:11434/v1/chat') }],
    ['no probe addresses', { request: { probeUrls: [] } }],
    ['waiting switched off', { request: { offlineTimeoutMs: 0 } }],
  ])('never waits for %s: the retries are all there is', async (_name, variant) => {
    const { fetch, calls } = network({ model: () => 'unreachable', probe: () => undefined });
    const failure = await send({ fetch, ...variant }).catch((caughtError: unknown) => caughtError);

    expect(failure).toMatchObject({ reason: 'network' });
    expect(calls.model).toBe(3);
    expect(calls.probe).toBe(0);
  });
});
