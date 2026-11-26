import type { Model } from '@sheavly/protocol/model/model.types';
import { modelIdSchema } from '@sheavly/protocol/model/model.validator';
import { profileIdSchema } from '@sheavly/protocol/profile/profile.validator';
import type { testBackend } from './backend.fake.js';

/**
 * Test-only: gives `backend` one profile with one fake OpenAI model and its key, as the default,
 * so a conversation can start and its model calls reach the backend's `fetch`. With `pricing`
 * (USD per million tokens) the model has a price, and a call it makes is priced from what it
 * reports.
 */
export async function seedModel(params: {
  backend: ReturnType<typeof testBackend>;
  pricing?: NonNullable<Model['pricing']>;
}): Promise<void> {
  const { backend, pricing } = params;
  const profile = profileIdSchema.parse('00000000-0000-4000-8000-000000000001');
  const model = modelIdSchema.parse('00000000-0000-4000-8000-000000000002');

  await backend.setup.putProfile({ id: profile, name: 'Test' });
  await backend.setup.putModel({
    profile,
    id: model,
    model: {
      name: 'Fake',
      adapter: 'openai',
      definition: { model: 'test' },
      ...(pricing && { pricing }),
    },
  });
  await backend.setup.putCredential({ profile, model, secrets: { apiKey: 'fake-test-key' } });
  await backend.setup.setDefaultProfile(profile);
}

/** `seedModel` with no price: the model every other test of the backend runs on. */
export function seedFakeModel(backend: ReturnType<typeof testBackend>): Promise<void> {
  return seedModel({ backend });
}
