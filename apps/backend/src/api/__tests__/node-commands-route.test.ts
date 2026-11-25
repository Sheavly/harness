import { describe, expect, it } from 'vitest';
import { MAX_QUEUED_MESSAGES } from '@sheavly/runtime/sessions/sessions.constants';
import { toolCall } from '@sheavly/testing/provider/routed-provider.fake';
import { conversationIdSchema, serverErrorSchema } from '@sheavly/protocol/server/server.validator';
import { testApi } from '../../testing/api.fake.js';
import { useOpenedServers } from '../../testing/opened-servers.fake.js';
import { servedCommand } from '../../testing/served-command.fake.js';
import { servedConversation } from '../../testing/served-conversation.fake.js';

// A command to a node over HTTP: cancel and message, by the node in the path, for each kind of
// node, and what each refuses.

const servers = useOpenedServers();

/** A model turn that calls the `block` tool, which waits until the prompt is stopped. */
const blocks = () => [
  toolCall({ id: 'c1', name: 'block', input: {} }),
  { type: 'done' as const, stopReason: 'tool_use' as const },
];

/** What a command to a node is refused with: it has ended, it is not there, its kind cannot. */
const ENDED = { status: 409, code: 'node_ended' };
const NOT_FOUND = { status: 404, code: 'not_found' };
const BAD_REQUEST = { status: 400, code: 'bad_request' };

type Served = Awaited<ReturnType<typeof servedConversation>>;

/** The main agent's node of the conversation. */
function mainNodeOf(world: Served): string {
  const node = world.harness.sessions.nodeIdOf(world.harness.mainSession.id);

  if (!node) throw new Error('the main agent has no node');

  return node;
}

/** `POST …/nodes/{node}/{command}` in-process, as a client sends it, with the token. */
function post(params: {
  world: Served;
  node: string;
  command: 'cancel' | 'messages';
  body?: unknown;
}) {
  const { world, node, command, body } = params;

  return world.api.request(`/conversations/${world.id}/nodes/${node}/${command}`, {
    method: 'POST',
    ...(body !== undefined && { body }),
  });
}

/** The status and error code a refused call answered. */
async function refusalOf(response: Response) {
  return {
    status: response.status,
    code: serverErrorSchema.parse(await response.json()).error.code,
  };
}

/** A function that sends `command` to a node and answers what it was refused for. */
function refusedFor(params: {
  world: Served;
  command: 'cancel' | 'messages';
  body?: unknown;
}): (node: string) => Promise<{ status: number; code: string }> {
  return async (node) => refusalOf(await post({ ...params, node }));
}

describe('cancelling a node over HTTP', () => {
  it('kills a command and a service, which the generated client does by name', async () => {
    const world = await servedConversation({ servers });
    const command = await servedCommand(world);
    const service = await servedCommand(world, 'service');

    await world.client.send('cancelNode', { id: world.id, node: command.node });

    const answer = await post({ world, node: service.node, command: 'cancel' });

    expect(answer.status).toBe(204);
    expect(world.harness.tasks.get(command.taskId)?.status).toBe('cancelled');
    expect(world.harness.tasks.get(service.taskId)?.status).toBe('cancelled');
  });

  it('stops the main agent while it runs, as stop does, keeping history valid', async () => {
    const { request, start, runOf, conversations } = testApi({ wait: [blocks] });
    const id = await start();
    const harness = conversations.get(conversationIdSchema.parse(id)).harness;
    const node = harness.sessions.nodeIdOf(harness.mainSession.id);
    const kinds: string[] = [];

    for await (const { entry } of runOf({ id, text: 'wait' })) {
      if (entry.kind !== 'event') continue;

      kinds.push(entry.event.type);

      if (entry.event.type === 'tool_call_started') {
        const answer = await request(`/conversations/${id}/nodes/${node}/cancel`, {
          method: 'POST',
        });

        expect(answer.status).toBe(204);
      }
    }

    // The run ended `done` because it was stopped, and its blocked tool call was answered.
    expect(kinds.at(-1)).toBe('done');

    const history = (await (await request(`/conversations/${id}/messages`)).json()) as {
      messages: { role: string }[];
    };

    expect(history.messages.map((message) => message.role)).toEqual(['user', 'assistant', 'tool']);
  });

  it('tells a node that has ended from one that is not there, and one of another conversation', async () => {
    const world = await servedConversation({ servers });
    const command = await servedCommand(world);
    const other = await world.api.start();
    const answered = refusedFor({ world, command: 'cancel' });

    await command.finish();

    // Ended, never made, and not an id's shape at all.
    expect(await Promise.all([command.node, 'no-such-node', 'Not A Node!'].map(answered))).toEqual([
      ENDED,
      NOT_FOUND,
      NOT_FOUND,
    ]);

    // The command is this conversation's: addressed through another's path it is as unknown.
    const foreign = await world.api.request(
      `/conversations/${other}/nodes/${command.node}/cancel`,
      {
        method: 'POST',
      },
    );

    expect(await refusalOf(foreign)).toEqual(NOT_FOUND);
  });
});

describe('messaging a node over HTTP', () => {
  it('reaches the main agent as the user, which the generated client does by name', async () => {
    const world = await servedConversation({ servers });

    await world.client.send('messageNode', {
      id: world.id,
      node: mainNodeOf(world),
      body: { text: 'steer left' },
    });

    expect(world.harness.sessions.takeMessages(world.harness.mainSession.id)).toMatchObject([
      { from: 'user', content: 'steer left' },
    ]);
  });

  it('refuses a command, a service and an extension’s node as no agent, and an ended one as ended', async () => {
    const world = await servedConversation({ servers });
    const command = await servedCommand(world);
    const service = await servedCommand(world, 'service');
    const extension = world.harness.nodes.open({
      kind: 'notes.sync',
      title: 'Sync',
      parent: world.harness.sessions.nodeIdOf(world.harness.mainSession.id),
    }).id;
    const answered = refusedFor({ world, command: 'messages', body: { text: 'hello' } });

    expect(await Promise.all([command.node, service.node, extension].map(answered))).toEqual([
      BAD_REQUEST,
      BAD_REQUEST,
      BAD_REQUEST,
    ]);

    await command.finish();

    expect(await Promise.all([command.node, 'no-such-node'].map(answered))).toEqual([
      ENDED,
      NOT_FOUND,
    ]);
  });

  it('wants a text: an empty one, or none, is a bad request, judged before the node is looked up', async () => {
    const world = await servedConversation({ servers });
    const node = mainNodeOf(world);

    for (const body of [{ text: '' }, {}, { text: 5 }]) {
      const answer = await post({ world, node, command: 'messages', body });

      expect(answer.status).toBe(400);
    }

    // The same bad text for a node that is not there is still 400, and a good one for it is 404.
    const missing = (body: unknown) =>
      post({ world, node: 'no-such-node', command: 'messages', body }).then(({ status }) => status);

    expect(await missing({ text: '' })).toBe(400);
    expect(await missing({ text: 'hello' })).toBe(404);
  });

  it('refuses a message past what the agent’s inbox holds, as a queue that is full, and takes none of it', async () => {
    const world = await servedConversation({ servers });
    const node = mainNodeOf(world);
    const send = (text: string) =>
      post({ world, node, command: 'messages', body: { text } }).then(({ status }) => status);

    for (let each = 0; each < MAX_QUEUED_MESSAGES; each += 1) expect(await send('x')).toBe(204);

    const refused = await post({ world, node, command: 'messages', body: { text: 'one more' } });

    expect(await refusalOf(refused)).toEqual({ status: 409, code: 'cannot_queue' });
    expect(world.harness.sessions.takeMessages(world.harness.mainSession.id)).toHaveLength(
      MAX_QUEUED_MESSAGES,
    );
  });
});

describe('what both need', () => {
  it('wants the token, as every route does', async () => {
    const world = await servedConversation({ servers });
    const node = mainNodeOf(world);

    for (const command of ['cancel', 'messages']) {
      const answer = await world.api.app.request(
        `/conversations/${world.id}/nodes/${node}/${command}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text: 'hi' }),
        },
      );

      expect(answer.status).toBe(401);
    }
  });
});
