import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { filesHolding as holding } from '@sheavly/testing/files/files-holding.fake';
import { fakeFetch } from '@sheavly/testing/fetch/fake-fetch.fake';
import { modelCatalogResponseSchema } from '@sheavly/protocol/setup/setup.validator';
import { testApi, testSetup } from '../../testing/api.fake.js';
import { testBackend } from '../../testing/backend.fake.js';

const WORK = '4b1f9a52-3c5e-4a77-9d64-0e2b7f1c8a30';
const HOME = '9d2c7e10-6a4b-4f38-b1e5-5c0a8d3f2b71';
const ASTRA = '4b1f9a52-3c5e-4a77-9d64-0e2b7f1c8a31';
const BORA = '9d2c7e10-6a4b-4f38-b1e5-5c0a8d3f2b72';
/** A key recognisable anywhere it might leak to. */
const KEY = 'sk-live-LEAKCHECK-7f3a9c';

let base = '';
let home = '';

beforeEach(async () => {
  base = await mkdtemp(path.join(tmpdir(), 'setup-routes-'));
  home = path.join(base, 'sheavly');
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

/** The API over the temp home, with the network a key check makes stood in by `fetch`. */
function api(extra: { remoteSetupAllowed?: boolean; fetch?: typeof globalThis.fetch } = {}) {
  const setup = testSetup({ home, ...extra });

  return testApi({}, undefined, setup);
}

type Api = ReturnType<typeof api>;

const put = (a: Api, path: string, body?: unknown) =>
  a.request(path, { method: 'PUT', ...(body !== undefined && { body }) });
const json = async (response: Response) => (await response.json()) as Record<string, unknown>;
const astra = { name: 'Astra', adapter: 'openai', definition: { model: 'gpt-astra' } };

/** A profile with one model, made through the routes as a UI would. */
async function withModel(a: Api, model = astra, id = ASTRA) {
  await put(a, `/profiles/${WORK}`, { name: 'Work' });
  await put(a, `/profiles/${WORK}/models/${id}`, model);
}

describe('GET /setup and GET /adapters', () => {
  it('writes global terminal preferences without a profile and keeps them through profile deletion', async () => {
    const a = api();

    expect((await put(a, '/terminal-settings', { reducedMotion: true, bell: true })).status).toBe(
      204,
    );
    await put(a, `/profiles/${WORK}`, { name: 'Work' });
    await put(a, `/profiles/${WORK}`, { name: 'Day job' });

    expect(await json(await a.request(`/profiles/${WORK}`))).not.toHaveProperty('terminal');
    expect(await json(await a.request('/setup'))).toMatchObject({
      terminal: { reducedMotion: true, bell: true },
    });
    expect((await put(a, '/terminal-settings', { reducedMotion: 'yes' })).status).toBe(400);
    expect((await put(a, '/terminal-settings', { bell: 'yes' })).status).toBe(400);
    await put(a, '/terminal-settings', { reducedMotion: false, bell: false });
    await a.request(`/profiles/${WORK}`, { method: 'DELETE' });
    expect(await json(await a.request('/setup'))).toMatchObject({
      terminal: { reducedMotion: false, bell: false },
    });
  });

  it('reports a first run: where the data is, and no profile, no default', async () => {
    const a = api();
    const response = await a.request('/setup');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ home, profiles: [], problems: [] });
  });

  it('describes the adapters, with which fields are secrets', async () => {
    const response = await api().request('/adapters');
    const { adapters } = (await response.json()) as {
      adapters: { kind: string; secrets: string[]; remoteField?: string }[];
    };

    expect(adapters.map((adapter) => adapter.kind)).toEqual(
      expect.arrayContaining(['openai', 'azure-openai', 'azure-anthropic']),
    );
    expect(adapters.find((adapter) => adapter.kind === 'openai')).toMatchObject({
      secrets: ['apiKey'],
      remoteField: 'model',
    });
  });

  it('serves model-first choices independently of profiles and credentials', async () => {
    const response = await api().request('/setup/models');
    const catalog = modelCatalogResponseSchema.parse(await response.json());

    expect(response.status).toBe(200);
    expect(catalog.models).toContainEqual({
      name: 'DeepSeek V4 Flash',
      identity: { model: 'deepseek-v4-flash', family: 'deepseek' },
      hosts: [
        {
          name: 'Azure',
          adapter: 'azure-chat',
          defaults: { deployment: 'deepseek-v4-flash', replayReasoning: true },
          fixed: {},
        },
      ],
    });
  });

  it('shows a profile, its models, whether keys are set, and whether it is ready', async () => {
    const a = api();

    await withModel(a);
    await put(a, '/default-profile', { profile: WORK });

    // A model without its key is not usable, and the profile is not ready.
    expect(await json(await a.request('/setup'))).toMatchObject({
      defaultProfile: WORK,
      profiles: [
        {
          id: WORK,
          name: 'Work',
          ready: false,
          models: [{ id: ASTRA, credential: 'missing', usable: false }],
        },
      ],
    });

    await put(a, `/profiles/${WORK}/credentials/${ASTRA}`, { secrets: { apiKey: KEY } });

    expect(await json(await a.request('/setup'))).toMatchObject({
      profiles: [{ ready: true, models: [{ credential: 'set', usable: true }] }],
    });
  });
});

describe('the models of a profile', () => {
  const bora = { name: 'Bora', adapter: 'openai', definition: { model: 'gpt-bora-mini' } };
  const query = (a: Api, body: unknown = {}) =>
    a.request(`/profiles/${WORK}/models`, { method: 'QUERY', body });
  const namesOf = async (response: Response) =>
    ((await json(response)).models as { name: string }[]).map((model) => model.name);

  it('persists chosen model identity outside adapter fields and rejects incompatible hosts', async () => {
    const a = api();
    const identity = { model: 'claude-opus-5-5', family: 'claude' };

    await put(a, `/profiles/${WORK}`, { name: 'Work' });
    const body = {
      name: 'Opus',
      identity,
      adapter: 'azure-anthropic',
      definition: {
        deployment: 'production-opus',
        baseUrl: 'https://resource.test/anthropic',
        thinkingMode: 'adaptive',
      },
    };

    expect((await put(a, `/profiles/${WORK}/models/${ASTRA}`, body)).status).toBe(204);
    expect(await json(await api().request(`/profiles/${WORK}/models/${ASTRA}`))).toMatchObject(
      body,
    );
    const wrong = await put(a, `/profiles/${WORK}/models/${BORA}`, {
      name: 'Wrong',
      identity,
      adapter: 'openai',
      definition: { model: 'claude-opus-5-5' },
    });

    expect(wrong.status).toBe(422);
    expect((await a.request(`/profiles/${WORK}/models/${BORA}`)).status).toBe(404);
  });

  it('lists them all, and one by id', async () => {
    const a = api();

    await withModel(a);
    await put(a, `/profiles/${WORK}/models/${BORA}`, bora);

    expect(await namesOf(await query(a))).toEqual(['Astra', 'Bora']);
    expect(await json(await a.request(`/profiles/${WORK}/models/${BORA}`))).toMatchObject({
      id: BORA,
      name: 'Bora',
      credential: 'missing',
    });
  });

  it('searches by name, adapter or what the provider calls it, ignoring case', async () => {
    const a = api();

    await withModel(a);
    await put(a, `/profiles/${WORK}/models/${BORA}`, bora);

    expect(await namesOf(await query(a, { search: 'ASTRA' }))).toEqual(['Astra']);
    // The provider-side model: "gpt-bora-mini" is in no name.
    expect(await namesOf(await query(a, { search: 'bora-MINI' }))).toEqual(['Bora']);
    expect(await namesOf(await query(a, { search: 'openai' }))).toEqual(['Astra', 'Bora']);
    expect(await namesOf(await query(a, { search: 'nothing like it' }))).toEqual([]);
  });

  it('refuses an empty search, and answers an unknown profile or model as not_found', async () => {
    const a = api();

    await withModel(a);

    expect((await query(a, { search: '' })).status).toBe(400);
    expect(
      (await a.request(`/profiles/${HOME}/models`, { method: 'QUERY', body: {} })).status,
    ).toBe(404);
    expect((await a.request(`/profiles/${WORK}/models/${BORA}`)).status).toBe(404);

    for (const bad of ['nope', '..', 'ABC']) {
      const response = await a.request(`/profiles/${bad}/models/${ASTRA}`);

      expect(response.status, bad).toBe(404);
      expect(await response.json(), bad).toMatchObject({ error: { code: 'not_found' } });
    }
  });

  it('refuses a model its adapter would reject, saying which field, and stores nothing', async () => {
    const a = api();

    await withModel(a);

    const wrongField = await put(a, `/profiles/${WORK}/models/${BORA}`, {
      ...bora,
      definition: {},
    });
    const unknownAdapter = await put(a, `/profiles/${WORK}/models/${BORA}`, {
      ...bora,
      adapter: 'nope',
    });
    const withKey = await put(a, `/profiles/${WORK}/models/${BORA}`, {
      ...bora,
      definition: { model: 'x', apiKey: KEY },
    });

    expect(wrongField.status).toBe(422);
    expect(JSON.stringify(await wrongField.json())).toContain('model');
    expect(unknownAdapter.status).toBe(422);
    // A key in the definition is refused, and its value never comes back.
    expect(withKey.status).toBe(422);
    expect(JSON.stringify(await withKey.json())).not.toContain(KEY);
    expect(await namesOf(await query(a))).toEqual(['Astra']);
  });

  it('replaces a model by its id and keeps its key; removing it removes the key too', async () => {
    const a = api();

    await withModel(a);
    await put(a, `/profiles/${WORK}/credentials/${ASTRA}`, { secrets: { apiKey: KEY } });
    await put(a, `/profiles/${WORK}/models/${ASTRA}`, {
      ...astra,
      name: 'Astra 2',
      definition: { model: 'gpt-astra-2' },
    });

    expect(await json(await a.request(`/profiles/${WORK}/models/${ASTRA}`))).toMatchObject({
      name: 'Astra 2',
      credential: 'set',
    });

    expect(
      (await a.request(`/profiles/${WORK}/models/${ASTRA}`, { method: 'DELETE' })).status,
    ).toBe(204);
    expect(await namesOf(await query(a))).toEqual([]);
    expect(await filesHolding(KEY)).toEqual([]);
  });
});

/** The files under the temp home that hold `text`: where a key must never be after it is removed. */
const filesHolding = (text: string) => holding({ folder: base, text });

describe('a model’s key', () => {
  const keyPath = `/profiles/${WORK}/credentials/${ASTRA}`;

  it('is kept in the profile’s credentials only, private, and is never in any answer', async () => {
    const a = api();

    await withModel(a);

    const set = await put(a, keyPath, { secrets: { apiKey: KEY } });
    const everything = [
      await a.request('/setup'),
      await a.request('/adapters'),
      await a.request(`/profiles/${WORK}`),
      await a.request(`/profiles/${WORK}/models/${ASTRA}`),
      await a.request(`/profiles/${WORK}/models`, { method: 'QUERY', body: {} }),
    ];

    expect(set.status).toBe(204);
    expect(await set.text()).toBe('');

    for (const response of everything) expect(await response.text()).not.toContain(KEY);

    const holding = await filesHolding(KEY);

    // One file holds it, nothing else (no log, no model file, no temp file).
    expect(holding).toHaveLength(1);
    expect(holding[0]).toContain(path.join('profiles', WORK));
  });

  it.skipIf(process.platform === 'win32')(
    'keeps it in a file only its owner can read',
    async () => {
      const a = api();

      await withModel(a);
      await put(a, keyPath, { secrets: { apiKey: KEY } });

      const [file = ''] = await filesHolding(KEY);

      expect((await stat(file)).mode & 0o777).toBe(0o600);
    },
  );

  it('refuses a secret its adapter does not take, a model that is not there, and never echoes it', async () => {
    const a = api();

    await withModel(a);

    const extra = await put(a, keyPath, { secrets: { apiKey: KEY, password: KEY } });
    const noModel = await put(a, `/profiles/${WORK}/credentials/${BORA}`, {
      secrets: { apiKey: KEY },
    });
    const noProfile = await put(a, `/profiles/${HOME}/credentials/${ASTRA}`, {
      secrets: { apiKey: KEY },
    });
    const empty = await put(a, keyPath, { secrets: { apiKey: '' } });

    expect([extra.status, noModel.status, noProfile.status, empty.status]).toEqual([
      422, 404, 404, 400,
    ]);

    for (const response of [extra, noModel, noProfile, empty]) {
      expect(await response.text()).not.toContain(KEY);
    }

    expect(await filesHolding(KEY)).toEqual([]);
  });

  it('is forgotten on its own, leaving the model, and forgetting none is fine', async () => {
    const a = api();

    await withModel(a);
    await put(a, keyPath, { secrets: { apiKey: KEY } });

    expect((await a.request(keyPath, { method: 'DELETE' })).status).toBe(204);
    expect((await a.request(keyPath, { method: 'DELETE' })).status).toBe(204);
    expect(await json(await a.request(`/profiles/${WORK}/models/${ASTRA}`))).toMatchObject({
      credential: 'missing',
    });
    expect(await filesHolding(KEY)).toEqual([]);
  });

  it('is not served from a model file that holds one, whatever the file says', async () => {
    const a = api();

    await put(a, `/profiles/${WORK}`, { name: 'Work' });

    // A model file edited by hand, with the key where a model's own fields go.
    const models = path.join(home, 'profiles', WORK, 'models');

    await mkdir(models, { recursive: true });
    await writeFile(
      path.join(models, `${ASTRA}.json`),
      JSON.stringify({
        id: ASTRA,
        name: 'Astra',
        adapter: 'openai',
        model: 'gpt-astra',
        apiKey: KEY,
      }),
    );

    const served = [
      await a.request('/setup'),
      await a.request(`/profiles/${WORK}`),
      await a.request(`/profiles/${WORK}/models/${ASTRA}`),
      await a.request(`/profiles/${WORK}/models`, { method: 'QUERY', body: {} }),
    ];

    expect(served.map((response) => response.status)).toEqual([200, 200, 200, 200]);

    for (const response of served) expect(await response.text()).not.toContain(KEY);
  });

  it('is replaced by a new one for the same model', async () => {
    const a = api();

    await withModel(a);
    await put(a, keyPath, { secrets: { apiKey: KEY } });
    await put(a, keyPath, { secrets: { apiKey: 'sk-second-key-0001' } });

    expect(await filesHolding(KEY)).toEqual([]);
    expect(await filesHolding('sk-second-key-0001')).not.toEqual([]);
  });
});

describe('a backend that listens beyond this machine', () => {
  it('takes no key, changes or checks none, and says why without quoting it', async () => {
    const a = api({ remoteSetupAllowed: false });

    // Everything else still works: only a key is refused.
    await withModel(a);

    const attempts = [
      await put(a, `/profiles/${WORK}/credentials/${ASTRA}`, { secrets: { apiKey: KEY } }),
      await a.request(`/profiles/${WORK}/credentials/${ASTRA}`, { method: 'DELETE' }),
      await a.request(`/profiles/${WORK}/credentials/${ASTRA}/check`, { method: 'POST' }),
    ];

    for (const response of attempts) {
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: { code: 'forbidden' } });
    }

    expect(await filesHolding(KEY)).toEqual([]);
    expect((await a.request('/setup')).status).toBe(200);
  });
});

describe('trying a key', () => {
  const check = (a: Api) =>
    a.request(`/profiles/${WORK}/credentials/${ASTRA}/check`, { method: 'POST' });

  it('says valid when the model answers, and invalid when the key is refused, in fixed words', async () => {
    const ok = api({
      fetch: fakeFetch([{ type: 'response.output_text.delta', delta: 'ok' }]).fetch,
    });
    const refused = api({ fetch: fakeFetch([], 401).fetch });

    for (const a of [ok, refused]) {
      await withModel(a);
      await put(a, `/profiles/${WORK}/credentials/${ASTRA}`, { secrets: { apiKey: KEY } });
    }

    expect(await json(await check(ok))).toEqual({ status: 'valid' });

    const invalid = await check(refused);

    expect(invalid.status).toBe(200);
    expect(await json(invalid)).toMatchObject({ status: 'invalid' });
    expect(JSON.stringify(await json(await check(refused)))).not.toContain(KEY);
  });

  it('refuses a model with no key as one that cannot be tried, and an unknown one as not found', async () => {
    const a = api();

    await withModel(a);

    expect((await check(a)).status).toBe(422);
    expect(
      (await a.request(`/profiles/${WORK}/credentials/${BORA}/check`, { method: 'POST' })).status,
    ).toBe(404);
  });
});

describe('profiles', () => {
  it('are made and renamed under the id the client chose, and read back', async () => {
    const a = api();

    expect((await put(a, `/profiles/${WORK}`, { name: 'Work' })).status).toBe(204);
    expect((await put(a, `/profiles/${WORK}`, { name: 'Office' })).status).toBe(204);
    expect(await json(await a.request(`/profiles/${WORK}`))).toMatchObject({
      id: WORK,
      name: 'Office',
      models: [],
      ready: false,
    });
  });

  it('are several, each with its own models and keys', async () => {
    const a = api();

    await withModel(a);
    await put(a, `/profiles/${HOME}`, { name: 'Home' });
    await put(a, `/profiles/${HOME}/models/${BORA}`, { ...astra, name: 'Bora' });

    const { profiles } = (await json(await a.request('/setup'))) as {
      profiles: { id: string; models: { id: string }[] }[];
    };

    expect(profiles.map((p) => [p.id, p.models.map((m) => m.id)]).sort()).toEqual(
      [
        [WORK, [ASTRA]],
        [HOME, [BORA]],
      ].sort(),
    );
    // One profile's model is not the other's.
    expect((await a.request(`/profiles/${WORK}/models/${BORA}`)).status).toBe(404);
  });

  it('refuse an empty name, an unknown default, and answer an unknown profile as not found', async () => {
    const a = api();

    expect((await put(a, `/profiles/${WORK}`, { name: '  ' })).status).toBe(400);
    expect((await put(a, '/default-profile', { profile: WORK })).status).toBe(404);
    expect((await a.request(`/profiles/${WORK}`)).status).toBe(404);
  });

  it('delete with their models and keys, and stop being the default', async () => {
    const a = api();

    await withModel(a);
    await put(a, `/profiles/${WORK}/credentials/${ASTRA}`, { secrets: { apiKey: KEY } });
    await put(a, '/default-profile', { profile: WORK });

    expect((await a.request(`/profiles/${WORK}`, { method: 'DELETE' })).status).toBe(204);
    expect((await a.request(`/profiles/${WORK}`, { method: 'DELETE' })).status).toBe(204);
    expect(await json(await a.request('/setup'))).toEqual({ home, profiles: [], problems: [] });
    expect(await filesHolding(KEY)).toEqual([]);
  });
});

describe('a first run, set up only through the API', () => {
  it('refuses a conversation, then runs one on the model and key just added, with no file edited', async () => {
    const project = path.join(base, 'project');
    const reply = fakeFetch([{ type: 'response.output_text.delta', delta: 'hello' }]);

    await mkdir(project, { recursive: true });

    const { conversations, call, logged } = testBackend({
      home,
      workspace: project,
      fetch: reply.fetch,
    });
    const start = () => call('/conversations', { method: 'POST', body: {} });

    // Nothing is set up: a UI is told so with a code it can act on.
    const before = await start();

    expect(before.status).toBe(409);
    expect(await before.json()).toMatchObject({ error: { code: 'not_set_up' } });

    // The user's journey: a profile, a model, its key, and the profile made the default.
    await call(`/profiles/${WORK}`, { method: 'PUT', body: { name: 'Work' } });
    await call(`/profiles/${WORK}/models/${ASTRA}`, { method: 'PUT', body: astra });

    // A model without its key is still not enough.
    await call('/default-profile', { method: 'PUT', body: { profile: WORK } });
    expect((await start()).status).toBe(409);

    await call(`/profiles/${WORK}/credentials/${ASTRA}`, {
      method: 'PUT',
      body: { secrets: { apiKey: KEY } },
    });

    const after = await start();

    expect(after.status).toBe(201);

    const { id } = (await after.json()) as { id: string };
    const details = await json(await call(`/conversations/${id}`));

    expect(details).toMatchObject({ model: { id: ASTRA, name: 'Astra', model: 'gpt-astra' } });

    // Prompting reaches the model with the key, from the profile: it sent it, and kept it out of the log.
    const prompt = await call(`/conversations/${id}/prompts`, {
      method: 'POST',
      body: { text: 'hi' },
    });

    expect(await prompt.json()).toEqual({ status: 'started', queued: [] });
    // Answered at once: the run goes on in the conversation, which is idle again once it ended.
    await vi.waitFor(() => {
      expect(conversations.list()).toMatchObject([{ running: false }]);
      expect(reply.requests).toHaveLength(1);
    });
    expect(JSON.stringify(reply.requests[0]?.headers)).toContain(KEY);
    expect(logged.join('')).not.toContain(KEY);
    await conversations.closeAll();
  });
});
