import { mkdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createClient } from '@sheavly/client/client/client.helper';
import { setUpTestProfile } from '@sheavly/client/testing/test-profile.fake';
import { useFinderScenarios } from '../../testing/finder-scenarios.fake.js';

// A launcher (the tmux client) creates each conversation through the API, so it holds the id
// before any chat exists, and starts `sheavly chat --resume <id>` in the pane. `--resume` on a
// conversation that is already live joins it as it is. No input: a chat with no terminal reads its
// end at once, so one prompt runs and the chat ends, and closes the conversation.
const scenarios = useFinderScenarios();
const { cli } = scenarios;

/** What `sheavly chat` ended with: its exit, and what it printed on each stream. */
async function chat(args: readonly string[], env: Record<string, string> = {}) {
  const made = await cli.startAndWaitForExit(env, ['chat', ...args]);

  return { exit: await made.exited, out: made.stdout(), err: made.stderr() };
}

/** A running server with one fake model, and the client a launcher would use for it. */
async function serverWithModel() {
  const server = await cli.start({}, ['serve']);
  const model = await scenarios.fakeModel();
  const backend = { url: server.url, token: cli.folders().token };

  await setUpTestProfile({ backend, definition: { model: 'fake', baseUrl: model.baseUrl } });

  return { client: createClient(backend), model };
}

/** A folder next to the project, which exists. */
async function otherFolder(): Promise<string> {
  const other = path.join(cli.folders().base, 'other');

  await mkdir(other);

  return realpath(other);
}

/** Gives the project a `.sheavly/` folder with hooks, so its trust means something. */
async function withHooks(folder: string): Promise<void> {
  await mkdir(path.join(folder, '.sheavly', 'hooks'), { recursive: true });
  await writeFile(path.join(folder, '.sheavly', 'hooks.json'), '{"version":1,"hooks":[]}');
}

describe.skipIf(process.platform === 'win32')(
  'sheavly chat --resume on a conversation another program created',
  () => {
    it('joins it, answers a prompt in it, and starts no other conversation', async () => {
      const { client, model } = await serverWithModel();
      const { id } = await client.call('startConversation', {
        body: { workspace: cli.folders().project },
      });
      const result = await chat(['--resume', id, 'say hello']);

      expect(result.exit.code).toBe(0);
      expect(result.out).toContain(`→ conversation ${id}`);
      expect(result.out).toContain(model.reply);
      expect(model.listener.everything()).toContain('say hello');

      const { conversations } = await client.call('queryStoredConversations', { body: {} });

      expect(conversations.map((conversation) => conversation.id)).toEqual([id]);
    }, 90_000);

    it('keeps two chats started at once in one folder on their own conversations', async () => {
      const { client } = await serverWithModel();
      const { project } = cli.folders();
      const first = await client.call('startConversation', { body: { workspace: project } });
      const second = await client.call('startConversation', { body: { workspace: project } });
      const [one, two] = await Promise.all([
        chat(['--resume', first.id, 'first pane']),
        chat(['--resume', second.id, 'second pane']),
      ]);

      expect([one.exit.code, two.exit.code]).toEqual([0, 0]);

      // The banner echoes the id it was given, so what shows each chat ran in its own conversation
      // is the history: each holds its own prompt and not the other's. Ending a chat closed them.
      const history = async (id: typeof first.id) => {
        await client.call('reopenConversation', { id });

        return JSON.stringify(await client.call('getMessages', { id }));
      };
      const firstHistory = await history(first.id);
      const secondHistory = await history(second.id);

      expect(firstHistory).toContain('first pane');
      expect(firstHistory).not.toContain('second pane');
      expect(secondHistory).toContain('second pane');
      expect(secondHistory).not.toContain('first pane');
    }, 90_000);

    it('fails for an id no conversation has, saying so in one line without the token, and starts none', async () => {
      const { client } = await serverWithModel();
      const missing = '00000000-0000-4000-8000-0000000000aa';
      const result = await chat(['--resume', missing, 'hello']);
      const lines = result.err.trimEnd().split('\n');

      expect(result.exit.code).toBe(1);
      expect(result.out).not.toContain('→ conversation');
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain(missing);
      // The host's own not-found text, so another failure that echoed the id would not pass.
      expect(lines[0]).toContain('No stored conversation');
      expect(`${result.out}${result.err}`).not.toContain(cli.folders().token);

      const stored = await client.call('queryStoredConversations', { body: {} });
      const live = await client.call('listConversations', {});

      expect([stored.conversations, live.conversations]).toEqual([[], []]);
    }, 90_000);

    describe('and --trust', () => {
      it('trusts the conversation’s own folder when the chat runs in it', async () => {
        const { client } = await serverWithModel();
        const { project } = cli.folders();
        const { id } = await client.call('startConversation', { body: { workspace: project } });
        const result = await chat(['--trust', '--resume', id, 'hello']);
        const { workspaces } = await client.call('queryTrustedWorkspaces', { body: {} });

        expect(result.exit.code).toBe(0);
        expect(workspaces.map(({ root }) => root)).toEqual([await realpath(project)]);
      }, 90_000);

      it('trusts the chat’s folder, not the conversation’s, when they differ', async () => {
        const { client } = await serverWithModel();
        const { project } = cli.folders();
        const other = await otherFolder();
        const { id } = await client.call('startConversation', { body: { workspace: project } });
        const result = await chat(['--trust', '--resume', id, 'hello'], {
          WORKSPACE_ROOT: other,
        });
        const { workspaces } = await client.call('queryTrustedWorkspaces', { body: {} });
        const { conversations } = await client.call('queryStoredConversations', { body: {} });

        expect(result.exit.code).toBe(0);
        // Read after the chat: the conversation kept the folder it was created in, and --trust
        // went to the chat's.
        expect(conversations.find((conversation) => conversation.id === id)?.workspace).toBe(
          await realpath(project),
        );
        expect(workspaces.map(({ root }) => root)).toEqual([other]);
      }, 90_000);

      it('trusts nothing without it, and leaves a folder the launcher trusted trusted', async () => {
        const { client } = await serverWithModel();
        const { project } = cli.folders();
        const { id } = await client.call('startConversation', { body: { workspace: project } });

        await chat(['--resume', id, 'hello']);
        expect((await client.call('queryTrustedWorkspaces', { body: {} })).workspaces).toEqual([]);

        await client.send('trustWorkspace', { body: { workspace: project } });

        const second = await client.call('startConversation', { body: { workspace: project } });

        await chat(['--resume', second.id, 'hello']);

        const { workspaces } = await client.call('queryTrustedWorkspaces', { body: {} });

        expect(workspaces.map(({ root }) => root)).toEqual([await realpath(project)]);
      }, 90_000);

      it('has trusted the folder already when the id turns out to be missing', async () => {
        const { client } = await serverWithModel();
        const { project } = cli.folders();
        const result = await chat([
          '--trust',
          '--resume',
          '00000000-0000-4000-8000-0000000000aa',
          'hello',
        ]);
        const { workspaces } = await client.call('queryTrustedWorkspaces', { body: {} });

        expect(result.exit.code).toBe(1);
        expect(`${result.out}${result.err}`).not.toContain(cli.folders().token);
        // Trust is sent before the conversation opens, so a refused open does not undo it.
        expect(workspaces.map(({ root }) => root)).toEqual([await realpath(project)]);
      }, 90_000);
    });

    // No chat runs here: this pins the backend rule the docs' advice rests on (hooks load when a
    // conversation is created, so a launcher trusts the folder first and joins afterwards), next
    // to the chat's own trust cases above.
    it('does not change a live conversation’s project trust when the folder is trusted after it was created', async () => {
      const { client } = await serverWithModel();
      const { project } = cli.folders();

      await withHooks(project);

      const { id } = await client.call('startConversation', { body: { workspace: project } });

      expect((await client.call('getConversation', { id })).projectTrust).toBe('untrusted');

      await client.send('trustWorkspace', { body: { workspace: project } });

      // The conversation keeps what it was built with: trust first, then create it.
      expect((await client.call('getConversation', { id })).projectTrust).toBe('untrusted');

      const later = await client.call('startConversation', { body: { workspace: project } });

      expect((await client.call('getConversation', { id: later.id })).projectTrust).toBe('trusted');
    }, 90_000);
  },
);
