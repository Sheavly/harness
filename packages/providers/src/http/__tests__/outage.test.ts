import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

  // Only the timers are fake: every wait while offline is at least a second, and the clock a
  // call reads is the fixed one, so a test decides how much time "passed".
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Lets every wait of `running` pass, and returns how it ended. */
  async function settled(running: Promise<unknown>): Promise<unknown> {
    const outcome = running.then(
      (value) => value,
      (caughtError: unknown) => caughtError,
    );

    await vi.runAllTimersAsync();

    return outcome;
  }

  it('waits for the connection and resumes, saying `offline` once and then `restored`', async () => {
    const { fetch, calls } = network({
      model: (call) => (call <= 3 ? 'unreachable' : 'ok'),
      probe: () => undefined,
    });
    const { response, reports } = (await settled(send({ fetch }))) as Awaited<
      ReturnType<typeof send>
    >;

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
    const outcome = await settled(send({ fetch, request: { retries: 1 } }));

    expect(outcome).toHaveProperty('response');
  });

  it('gives up once the time it was awake without a connection passes `offlineTimeoutMs`', async () => {
    const { fetch, calls } = network({
      model: () => 'unreachable',
      probe: () => undefined,
      onModelCall: () => {
        clock.advance(20 * MINUTE_MS);
      },
    });
    const failure = await settled(send({ fetch }));

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
    const { reports } = (await settled(send({ fetch }))) as Awaited<ReturnType<typeof send>>;

    expect(calls.model).toBe(6);
    expect(states(reports)).toEqual(['offline', 'restored']);
  });

  it('starts the budget over once the connection answered: an outage after a provider failure is a new one', async () => {
    // 40 minutes offline, then the provider answers (503) while the probe is up, then 30 more
    // offline: within an hour each, over an hour together.
    const { fetch, calls } = network({
      model: (call) => {
        if (call === 3) return 'busy';

        return call <= 4 ? 'unreachable' : 'ok';
      },
      probe: () => undefined,
      onModelCall: (call) => {
        clock.advance((call <= 2 ? 20 : 30) * MINUTE_MS);
      },
    });
    const outcome = await settled(send({ fetch }));

    expect(outcome).toHaveProperty('response');
    expect(calls.model).toBe(5);
  });

  it('never spins, whatever `retryDelayMs` is: each wait while offline is a second at least', async () => {
    const controller = new AbortController();
    const { fetch, calls } = network({ model: () => 'unreachable', probe: () => undefined });
    const running = send({
      fetch,
      request: { retryDelayMs: 0 },
      signal: controller.signal,
    }).catch((caughtError: unknown) => caughtError);

    await vi.advanceTimersByTimeAsync(3500);
    controller.abort(new Error('stop'));
    await running;

    // The first attempt, then one a second for three seconds and a half.
    expect(calls.model).toBeLessThanOrEqual(5);
    expect(calls.model).toBeGreaterThanOrEqual(3);
  });

  it('stops waiting when the run is interrupted, without renaming the interrupt', async () => {
    const controller = new AbortController();
    const { fetch } = network({ model: () => 'unreachable', probe: () => undefined });
    const running = send({
      fetch,
      request: { retryDelayMs: 20_000 },
      signal: controller.signal,
    }).catch((caughtError: unknown) => caughtError);

    await vi.advanceTimersByTimeAsync(10);
    controller.abort(new Error('stop'));

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
    ['a model on a private network', { url: new URL('http://192.168.1.20:8000/v1/chat') }],
    ['a model on a .local name', { url: new URL('http://gpu-box.local/v1/chat') }],
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
