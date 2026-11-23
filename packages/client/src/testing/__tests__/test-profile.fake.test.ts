import { describe, expect, it } from 'vitest';
import { fakeServer } from '../fake-server.fake.js';
import { setUpTestProfile } from '../test-profile.fake.js';

describe('setUpTestProfile', () => {
  it('makes a profile with one openai model and its key through the API, then the default', async () => {
    const server = fakeServer({
      putProfile: () => undefined,
      putModel: () => undefined,
      putCredential: () => undefined,
      setDefaultProfile: () => undefined,
    });

    await setUpTestProfile({
      backend: { url: 'http://backend.test', token: 't', fetch: server.fetch },
      definition: { model: 'fake', baseUrl: 'http://model.test/v1' },
    });

    const [profile, model, credential, chosen] = server.calls;

    expect(server.calls.map(({ name }) => name)).toEqual([
      'putProfile',
      'putModel',
      'putCredential',
      'setDefaultProfile',
    ]);
    expect(profile?.call.body).toEqual({ name: 'Test' });
    expect(model?.call.body).toEqual({
      name: 'Fake',
      adapter: 'openai',
      definition: { model: 'fake', baseUrl: 'http://model.test/v1' },
    });
    expect(credential?.call.params).toEqual(model?.call.params);
    expect(credential?.call.body).toEqual({ secrets: { apiKey: 'fake-test-key' } });
    expect(chosen?.call.body).toEqual({ profile: profile?.call.params.profile });
  });
});
