import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { promptEntries } from '@sheavly/client/prompt/prompt.helper';
import { fakeFetch } from '@sheavly/testing/fetch/fake-fetch.fake';
import { filesHolding } from '@sheavly/testing/files/files-holding.fake';
import { modelIdSchema } from '@sheavly/protocol/model/model.validator';
import { profileIdSchema } from '@sheavly/protocol/profile/profile.validator';
import type { StreamEntry } from '@sheavly/protocol/stream/stream.types';
import { testBackend } from '../../testing/backend.fake.js';

let base = '';

afterEach(async () => {
  if (base) await rm(base, { recursive: true, force: true });
});

describe('credential-reading commands', () => {
  it('refuses a credential read without an explicit command grant and never emits the key', async () => {
    base = await mkdtemp(path.join(tmpdir(), 'credential-command-'));
    const workspace = path.join(base, 'workspace');
    const home = path.join(base, 'home');
    const profile = profileIdSchema.parse('00000000-0000-4000-8000-000000000001');
    const model = modelIdSchema.parse('00000000-0000-4000-8000-000000000002');
    const key = 'fake-key-MUST-NOT-REACH-TOOL-OUTPUT';
    let command = '';

    await mkdir(workspace);
    const fetch: typeof globalThis.fetch = (input, init) =>
      fakeFetch([
        {
          type: 'response.output_item.done',
          item: {
            type: 'function_call',
            call_id: 'read-credentials',
            name: 'run_command',
            arguments: JSON.stringify({ description: 'Attempt credential read', command }),
          },
        },
      ]).fetch(input, init);
    const backend = testBackend({ home, workspace, fetch, env: { MAX_TURNS: '1' } });
    const { client } = backend;

    try {
      await client.send('putProfile', { profile, body: { name: 'Work' } });
      await client.send('putModel', {
        profile,
        model,
        body: { name: 'Fake', adapter: 'openai', definition: { model: 'test' } },
      });
      await client.send('putCredential', { profile, model, body: { secrets: { apiKey: key } } });
      const files = await filesHolding({ folder: home, text: key });

      expect(files).toHaveLength(1);
      command = `cat ${JSON.stringify(files[0])}`;
      await client.send('setDefaultProfile', { body: { profile } });
      const { id } = await client.call('startConversation', { body: {} });
      const entries: StreamEntry[] = [];

      for await (const entry of promptEntries({
        client,
        id,
        prompt: { text: 'Try the command once.' },
      })) {
        entries.push(entry);
      }

      const result = entries.find(
        (entry) => entry.kind === 'event' && entry.event.type === 'tool_result',
      );

      expect(result).toMatchObject({ event: { type: 'tool_result', message: { isError: true } } });
      expect(JSON.stringify(entries)).toContain("needs the user's approval");
      expect(JSON.stringify(entries)).not.toContain(key);
    } finally {
      await backend.conversations.closeAll();
    }
  });
});
