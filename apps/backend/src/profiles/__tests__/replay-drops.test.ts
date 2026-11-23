import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ReplayDrop } from '@sheavly/core/adapter/replay.types';
import { modelIdSchema } from '@sheavly/protocol/model/model.validator';
import { profileIdSchema } from '@sheavly/protocol/profile/profile.validator';
import { captureClientHello } from '@sheavly/providers/testing/client-hello.fake';
import { collect } from '@sheavly/testing/fetch/fake-fetch.fake';
import { parseRequestEnv } from '../../harness/settings.validator.js';
import { Profiles } from '../profiles.service.js';

const PROFILE = profileIdSchema.parse('4b1f9a52-3c5e-4a77-9d64-0e2b7f1c8a30');
const MODEL = modelIdSchema.parse('4b1f9a52-3c5e-4a77-9d64-0e2b7f1c8a31');

let root = '';
const closing: (() => Promise<void>)[] = [];

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'backend-replay-drops-'));
});

afterEach(async () => {
  await Promise.all(closing.splice(0).map((close) => close()));
  await rm(root, { recursive: true, force: true });
});

describe('Profiles and a dropped reasoning replay', () => {
  it('hands its handler to the models it builds, so a drop is heard', async () => {
    // The drop is heard while the request is built, so the call only has to stay on this machine:
    // the capture drops the connection and the call fails.
    const capture = await captureClientHello();

    closing.push(capture.close);

    const drops: ReplayDrop[] = [];
    const profiles = new Profiles({
      env: { SHEAVLY_HOME: root },
      onReplayDropped: (drop) => drops.push(drop),
    });
    const setup = profiles.setup({ request: parseRequestEnv({}), remoteSetupAllowed: true });

    await setup.putProfile({ id: PROFILE, name: 'Work' });
    await setup.putModel({
      profile: PROFILE,
      id: MODEL,
      model: {
        name: 'Fake',
        adapter: 'openai',
        definition: { model: 'test', baseUrl: `${capture.url}/v1` },
      },
    });
    await setup.putCredential({ profile: PROFILE, model: MODEL, secrets: { apiKey: 'fake-key' } });

    const models = await profiles.modelsFor({
      placement: { workspace: root, profile: PROFILE },
      request: parseRequestEnv({ MODEL_RETRIES: '0' }),
    });

    const sent = collect(
      models.models.switch.stream({
        messages: [
          { role: 'user', content: 'hi' },
          {
            role: 'assistant',
            content: 'ok',
            toolCalls: [],
            reasoning: [{ source: 'responses:https://other.test/v1#x', data: {} }],
          },
          { role: 'user', content: 'go' },
        ],
        tools: [],
        signal: new AbortController().signal,
      }),
    );

    await expect(sent).rejects.toThrow();
    expect(drops).toEqual([
      { reason: 'source_mismatch', source: 'responses:https://other.test/v1#x' },
    ]);
  });
});
