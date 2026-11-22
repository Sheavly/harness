import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { modelIdSchema } from '@sheavly/protocol/model/model.validator';
import { profileIdSchema } from '@sheavly/protocol/profile/profile.validator';
import { MODEL_FETCH_HELLO } from '@sheavly/providers/testing/client-hello.constants';
import { captureClientHello, helloShape } from '@sheavly/providers/testing/client-hello.fake';
import { useTempFolders } from '@sheavly/testing/files/temp-folders.fake';
import { testBackend } from '../../testing/backend.fake.js';

const PROFILE = profileIdSchema.parse('2e4b7c19-8d3a-4f60-b5e2-9a1c7d0f4b36');
const MODEL = modelIdSchema.parse('2e4b7c19-8d3a-4f60-b5e2-9a1c7d0f4b37');

const folders = useTempFolders({ prefix: 'model-fetch-', names: ['app'] });
const closing: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(closing.splice(0).map((close) => close()));
});

describe('the backend’s model calls', () => {
  it('go out with a TLS ClientHello that fits in one TCP segment, as Azure AI Foundry needs', async () => {
    const capture = await captureClientHello();

    closing.push(capture.close);
    // No `fetch` given: the backend builds its adapters as `serve.ts` does.
    const { setup } = testBackend({
      home: path.join(folders.base, 'sheavly'),
      workspace: folders.app,
    });

    await setup.putProfile({ id: PROFILE, name: 'Azure' });
    await setup.putModel({
      profile: PROFILE,
      id: MODEL,
      model: {
        name: 'Claude on Foundry',
        adapter: 'azure-anthropic',
        identity: { model: 'claude-sonnet-5-5', family: 'claude' },
        definition: { baseUrl: `${capture.url}/anthropic`, deployment: 'claude-sonnet-5-5' },
      },
    });
    await setup.putCredential({ profile: PROFILE, model: MODEL, secrets: { apiKey: 'k' } });

    await setup.checkCredential({ profile: PROFILE, model: MODEL });

    expect(helloShape(await capture.hello)).toEqual(MODEL_FETCH_HELLO);
  });
});
