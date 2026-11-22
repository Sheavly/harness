import { modelIdSchema } from '@sheavly/protocol/model/model.validator';
import { profileIdSchema } from '@sheavly/protocol/profile/profile.validator';
import { createClient } from '../client/client.helper.js';
import type { ClientOptions } from '../client/client.types.js';

const PROFILE = profileIdSchema.parse('00000000-0000-4000-8000-000000000001');
const MODEL = modelIdSchema.parse('00000000-0000-4000-8000-000000000002');

/**
 * Test-only: gives a running backend, through its own API, a default profile with one `openai`
 * model and a made-up key, so a conversation can open on it. `definition` is the model's
 * (`{ model: 'test' }`, or a `baseUrl` that points at a fake model endpoint). `backend` is what
 * `createClient` takes: its url and token, and a `fetch` for a test of this fake itself.
 */
export async function setUpTestProfile(params: {
  backend: ClientOptions;
  definition: { model: string; baseUrl?: string };
}): Promise<void> {
  const client = createClient(params.backend);

  await client.send('putProfile', { profile: PROFILE, body: { name: 'Test' } });
  await client.send('putModel', {
    profile: PROFILE,
    model: MODEL,
    body: { name: 'Fake', adapter: 'openai', definition: params.definition },
  });
  await client.send('putCredential', {
    profile: PROFILE,
    model: MODEL,
    body: { secrets: { apiKey: 'fake-test-key' } },
  });
  await client.send('setDefaultProfile', { body: { profile: PROFILE } });
}
