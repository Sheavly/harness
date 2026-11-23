import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Conversations } from '@sheavly/host/conversations/conversations.service';
import { twoModelRun } from '@sheavly/host/testing/run.fake';
import { collect } from '@sheavly/testing/fetch/fake-fetch.fake';
import { scriptedProvider } from '@sheavly/testing/provider/scripted-provider.fake';
import { routedProvider, say } from '@sheavly/testing/provider/routed-provider.fake';
import { TrustStore } from '@sheavly/coding/trust/trust.service';
import { memoryTrust } from '@sheavly/coding/testing/trust.fake';
import { harnessConversation, workspaceSkills } from '../conversation.helper.js';
import { createBackendHarness } from '../harness.helper.js';
import { askingPermissions } from '../../testing/permissions.fake.js';
import { collectingLogs, silentLogs } from '../../testing/logs.fake.js';
import type { Provider } from '@sheavly/core/provider/provider.types';
import { until } from '@sheavly/testing/wait/until.fake';
import { conversationIdSchema } from '@sheavly/protocol/server/server.validator';

const SKILL = '---\nname: review\ndescription: Reviews a change.\n---\nREVIEW STEPS\n';

let base: string;
let root: string;

beforeEach(async () => {
  base = await mkdtemp(path.join(tmpdir(), 'harness-conversation-'));
  root = path.join(base, 'project');
  await mkdir(path.join(root, '.agents', 'skills', 'review'), { recursive: true });
  await writeFile(path.join(root, '.agents', 'skills', 'review', 'SKILL.md'), SKILL);
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe('workspaceSkills', () => {
  it('lists the workspace’s skills as a UI shows them, without their bodies', async () => {
    const skills = await workspaceSkills({ root }).list({});

    expect(skills).toContainEqual({
      name: 'review',
      description: 'Reviews a change.',
      manualOnly: false,
      scope: 'project',
    });
  });

  it('runs a picked skill, and reports one no one has instead of throwing', async () => {
    const skills = workspaceSkills({ root });

    expect(
      await skills.prepare({ prompt: { parts: [{ type: 'skill', name: 'review' }] } }),
    ).toMatchObject({ text: expect.stringContaining('REVIEW STEPS') as string });
    expect(await skills.prepare({ prompt: { parts: [{ type: 'skill', name: 'nope' }] } })).toEqual({
      unknown: ['nope'],
    });
  });
});

/** The backend's harness on `provider`, over the test's project folder. */
function harnessOn(provider: Provider) {
  return createBackendHarness({
    provider,
    title: 'Test',
    workspaceRoot: root,
    trustStore: new TrustStore({
      persistence: memoryTrust({ file: path.join(base, 'trusted.json') }),
    }),
    env: process.env,
    permissions: askingPermissions(),
  });
}

/** Starts finite work that ends at once: the conversation wakes to tell the model. */
function finishATask(harness: Awaited<ReturnType<typeof harnessOn>>): void {
  harness.tasks.start({
    command: 'lint',
    description: 'Lint',
    sessionId: harness.mainSession.id,
    run: async () => ({ exitCode: 0 }),
  });
}

describe('harnessConversation', () => {
  it('runs a prompt on the harness’s tools and the workspace’s skills, through Conversations', async () => {
    const conversations = new Conversations({
      create: async ({ messages }) =>
        harnessConversation({
          // The message the model gets holds the skill's instructions, so any first message.
          harness: await harnessOn(
            scriptedProvider([
              [
                { type: 'text_delta', text: 'reviewed' },
                { type: 'done', stopReason: 'end_turn' },
              ],
            ]),
          ),
          messages,
          logger: silentLogs().server,
          run: twoModelRun(),
        }),
    });
    const id = await conversations.start();
    const { events, parts } = await conversations.send({ id, prompt: { text: 'look /review' } });

    await collect(events);

    expect(parts).toEqual([
      { type: 'text', text: 'look ' },
      { type: 'skill', name: 'review' },
    ]);
    expect(conversations.messages(id).at(0)).toMatchObject({
      role: 'user',
      content: expect.stringContaining('REVIEW STEPS') as string,
      parts,
    });
    expect(conversations.messages(id).at(-1)).toMatchObject({ content: 'reviewed' });
    await conversations.closeAll();
  });

  it('logs the run it starts itself for finished work once, in its conversation, when that run fails', async () => {
    const { logs, entries } = collectingLogs();
    const id = conversationIdSchema.parse('00000000-0000-4000-8000-0000000000aa');
    // The prompt is answered; the run the finished task wakes finds the model down.
    const harness = await harnessOn(
      routedProvider({
        build: [
          say('ok'),
          () => {
            throw new Error('model down');
          },
        ],
      }),
    );
    const { conversation } = harnessConversation({
      harness,
      run: twoModelRun(),
      logger: logs.conversation(id),
    });

    try {
      await collect(conversation.send('build'));
      finishATask(harness);
      await until(() => entries.length === 1);
      await until(() => !conversation.running);

      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        level: 'error',
        event: 'conversation.wake_run_failed',
        conversationId: id,
        error: { message: 'model down' },
      });
    } finally {
      await conversation.close();
    }
  });
});
