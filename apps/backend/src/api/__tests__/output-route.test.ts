import { describe, expect, it } from 'vitest';
import { serverErrorSchema } from '@sheavly/protocol/server/server.validator';
import { reply, testApi } from '../../testing/api.fake.js';
import { useOpenedServers } from '../../testing/opened-servers.fake.js';
import { servedCommand } from '../../testing/served-command.fake.js';
import { servedConversation } from '../../testing/served-conversation.fake.js';
import { framesOf } from '../../testing/subscription-frames.fake.js';

// A command's output over HTTP: followed through the subscribe route as server-sent entries, from
// a position, and what it refuses.

const servers = useOpenedServers();

type Served = Awaited<ReturnType<typeof servedConversation>>;

/** The body of a subscription to `channel` from `from`, through the generated client. */
const subscribe = (world: Served, channel: string, from: string) =>
  world.client.open('streamChannels', {
    id: world.id,
    body: { subscriptions: [{ channel, from }] },
  });

describe('a command’s output, over HTTP', () => {
  it('is followed through the subscribe route as server-sent entries, from its start to its end', async () => {
    const world = await servedConversation({ servers });
    const command = await servedCommand(world);

    command.print('building\n');

    const next = framesOf(await subscribe(world, command.node, 'start'));
    const opened = await next();
    const stored = await next();

    command.print('done\n');

    const live = await next();

    await command.finish();

    const closed = await next();
    const end = await next();

    expect(opened).toMatchObject({
      event: 'entry',
      frame: { type: 'opened', cursor: 'b0', node: { kind: 'command' } },
    });
    expect(stored).toMatchObject({
      event: 'entry',
      frame: { type: 'output', offset: 0, text: 'building\n', cursor: 'b9' },
    });
    expect(live).toMatchObject({
      event: 'entry',
      frame: { type: 'output', offset: 9, text: 'done\n', cursor: 'b14' },
    });
    expect(closed).toMatchObject({
      event: 'entry',
      frame: {
        type: 'closed',
        state: 'completed',
        exitCode: 0,
        cursor: 'b14',
        output: { status: 'complete' },
      },
    });
    expect(end).toMatchObject({ event: 'end', frame: { reason: 'completed', cursor: 'b14' } });
  });

  it('keeps every byte as the command wrote it: an escape sequence and a wide character are sent whole', async () => {
    const world = await servedConversation({ servers });
    const command = await servedCommand(world);
    const written = '\u001b[31mred\u001b[0m €\n';

    command.print(written);
    await command.finish();

    const next = framesOf(await subscribe(world, command.node, 'start'));

    await next();

    // 17 bytes: the euro sign is three. The client shows it as untrusted terminal text.
    expect(await next()).toMatchObject({
      frame: { type: 'output', offset: 0, text: written, cursor: 'b17' },
    });
  });

  it('starts from a cursor or the last bytes, and says where it stands at now', async () => {
    const world = await servedConversation({ servers });
    const command = await servedCommand(world);

    command.print('abcdefghij');

    const fromCursor = framesOf(await subscribe(world, command.node, 'b4'));
    const lastBytes = framesOf(await subscribe(world, command.node, 'tail:3'));
    const fromNow = framesOf(await subscribe(world, command.node, 'now'));

    expect(await fromCursor()).toMatchObject({
      frame: { type: 'output', offset: 4, text: 'efghij', cursor: 'b10' },
    });
    expect(await lastBytes()).toMatchObject({
      frame: { type: 'output', offset: 7, text: 'hij', cursor: 'b10' },
    });
    expect(await fromNow()).toMatchObject({ event: 'head', frame: { cursor: 'b10' } });

    await command.finish();
  });

  it('goes on for the next client when one leaves, and what the command prints after is not a problem', async () => {
    const world = await servedConversation({ servers });
    const command = await servedCommand(world);
    const leaving = await subscribe(world, command.node, 'now');

    await leaving.cancel();
    command.print('nobody reads this');

    const next = framesOf(await subscribe(world, command.node, 'now'));

    await next();
    command.print('and this is read');

    expect(await next()).toMatchObject({
      frame: { type: 'output', text: 'and this is read' },
    });

    await command.finish();
  });

  it('is served after a restart, for a command the stopped process left: its output, then closed as lost where it ends', async () => {
    const world = await servedConversation({ servers });
    const command = await servedCommand(world);

    command.print('printed before the stop');

    // A new process over the same store: the command never closed its channel, so the reopen does.
    const reopened = testApi({ go: [reply('done')] }, world.store);
    const reopen = await reopened.request(`/stored-conversations/${world.id}/reopen`, {
      method: 'POST',
    });
    const response = await reopened.request(`/conversations/${world.id}/subscribe`, {
      method: 'QUERY',
      body: { subscriptions: [{ channel: command.node, from: 'start' }] },
    });
    const next = framesOf(response.body ?? new ReadableStream());

    expect(reopen.status).toBe(200);
    expect(await next()).toMatchObject({ frame: { type: 'opened', cursor: 'b0' } });
    expect(await next()).toMatchObject({ frame: { type: 'output', cursor: 'b23' } });
    expect(await next()).toMatchObject({
      frame: { type: 'closed', state: 'lost', cursor: 'b23' },
    });
    expect(await next()).toMatchObject({ frame: { type: 'end', reason: 'completed' } });
  });
});

describe('what a request for a command’s output is refused', () => {
  it('is refused a cursor past the end, as out of range, and a cursor of the wrong kind, as a bad request', async () => {
    const world = await servedConversation({ servers });
    const command = await servedCommand(world);

    command.print('abc');

    const ask = (from: string) =>
      world.api.request(`/conversations/${world.id}/subscribe`, {
        method: 'QUERY',
        body: { subscriptions: [{ channel: command.node, from }] },
      });
    const past = await ask('b99');
    const wrongKind = await ask('s1');

    expect(serverErrorSchema.parse(await past.json()).error.code).toBe('cursor_out_of_range');
    expect(wrongKind.status).toBe(400);
    expect(serverErrorSchema.parse(await wrongKind.json()).error.code).toBe('bad_request');

    await command.finish();
  });

  it('is refused a start on an output too large for one request to read, and the next request is served', async () => {
    const world = await servedConversation({ servers });
    const command = await servedCommand(world);

    // Over the 8 MiB one request may read of stored history.
    command.print('x'.repeat(9 * 1024 * 1024));

    const refused = await world.api.request(`/conversations/${world.id}/subscribe`, {
      method: 'QUERY',
      body: { subscriptions: [{ channel: command.node, from: 'start' }] },
    });

    expect(refused.status).toBe(400);
    expect(serverErrorSchema.parse(await refused.json()).error.code).toBe('bad_request');

    // Nothing was left held by the refusal: the last bytes are served at once.
    const next = framesOf(await subscribe(world, command.node, 'tail:10'));

    expect(await next()).toMatchObject({ frame: { type: 'output', text: 'xxxxxxxxxx' } });

    await command.finish();
  });

  it('wants the token, as every route does', async () => {
    const world = await servedConversation({ servers });
    const command = await servedCommand(world);
    const response = await world.api.app.request(`/conversations/${world.id}/subscribe`, {
      method: 'QUERY',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ subscriptions: [{ channel: command.node, from: 'start' }] }),
    });

    expect(response.status).toBe(401);

    await command.finish();
  });
});
