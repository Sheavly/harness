import { appendFile, chmod, mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ChannelEntry, ChannelLimits, ChannelLog } from '@sheavly/core/store/store.types';
import { MAX_CHANNEL_ENTRY_CHARS } from '@sheavly/protocol/channel/channel.constants';
import { conversationIdSchema } from '@sheavly/protocol/server/server.validator';
import { MAX_TAIL } from '@sheavly/protocol/subscription/subscription.constants';
import { MAX_LINE_CHARS } from '../../jsonl-file/jsonl-file.constants.js';
import { expectPrivate, useTempFolder } from '../../testing/temp-folder.fake.js';
import { FileConversationStore } from '../conversation-store.service.js';

const temp = useTempFolder('file-channels-');
const id = conversationIdSchema.parse('00000000-0000-4000-8000-0000000000b1');

const entry = (type: string, cursor: string, channel = 'main'): ChannelEntry => ({
  channel,
  type,
  cursor,
  at: 1,
  node: { id: channel, title: 'Chat' },
});

const opened = entry('opened', 's0');
const updated = entry('updated', 's1');

/** A store over the test's folder: a new one each call, as a restarted process would be. */
const storeOf = (limits?: Partial<ChannelLimits>) =>
  new FileConversationStore({
    folder: temp.path(),
    onProblem: () => undefined,
    ...(limits && { limits }),
  });

const channelsFolder = () => path.join(temp.path(), 'conversations', id, 'channels');
const logOf = (channel = 'main') => path.join(channelsFolder(), `${channel}.jsonl`);

/**
 * The lines of a channel's file, each parsed: the file holds each entry as the JSON the store
 * checked, whose keys are in the schema's order and not the caller's, so what is compared is the
 * entry and not its bytes.
 */
async function linesOf(channel = 'main'): Promise<unknown[]> {
  const text = await readFile(logOf(channel), 'utf8');

  expect(text.endsWith('\n')).toBe(true);

  return text
    .trimEnd()
    .split('\n')
    .map((each): unknown => JSON.parse(each));
}

/** Appending `appended` to `log` is refused as `reason`. */
async function expectRefused(params: { log: ChannelLog; appended: ChannelEntry; reason: string }) {
  await expect(params.log.append(params.appended)).rejects.toMatchObject({
    name: 'StoreError',
    reason: params.reason,
  });
}

/** Channel `main` opens, and in a restarted process a second channel, `t1`, is refused for `limits`. */
async function openMainThenRefuseT1(limits: Partial<ChannelLimits>) {
  await storeOf(limits).channel({ id, channel: 'main' }).append(opened);
  await expectRefused({
    log: storeOf(limits).channel({ id, channel: 't1' }),
    appended: T1_OPENED,
    reason: 'quota',
  });
}

/** A byte channel `t1`, and room in it for a few more lines but not for the entry that is too big. */
const BYTE_OPENED = entry('opened', 'b0', 't1');
const BYTE_LIMITS = { channelBytes: Buffer.byteLength(JSON.stringify(BYTE_OPENED)) + 1 + 500 };
const BYTE_TOO_BIG = { ...entry('updated', 'b10', 't1'), pad: 'x'.repeat(2000) };
/** An offset may jump, and this entry fits the room that is left after the one that was refused. */
const BYTE_CLOSED = entry('closed', 'b20', 't1');
const T1_OPENED = entry('opened', 's0', 't1');

/** Channel `t1` as a new store, a restarted process, has it, held to `BYTE_LIMITS`. */
const byteLog = () => storeOf(BYTE_LIMITS).channel({ id, channel: 't1' });

async function cursorsOf(store: FileConversationStore, channel = 'main') {
  const cursors: string[] = [];

  for await (const each of store.channel({ id, channel }).read()) cursors.push(each.cursor);

  return cursors;
}

describe('a channel log on disk', () => {
  it.skipIf(process.platform === 'win32')(
    'is one private file under the conversation, an entry a line',
    async () => {
      const store = storeOf();

      await store.channel({ id, channel: 'main' }).append(opened);
      await store.channel({ id, channel: 'main' }).append(updated);
      await store.channel({ id, channel: 'tree' }).append(entry('opened', 's0', 'tree'));

      expect((await readdir(channelsFolder())).toSorted()).toEqual(['main.jsonl', 'tree.jsonl']);
      expect(await linesOf()).toEqual([opened, updated]);
      await expectPrivate(logOf());
    },
  );

  it('is kept across a restart, which carries on from the last entry and refuses a repeat', async () => {
    await storeOf().channel({ id, channel: 'main' }).append(opened);

    const restarted = storeOf();

    expect(await cursorsOf(restarted)).toEqual(['s0']);
    await expect(restarted.channel({ id, channel: 'main' }).append(opened)).rejects.toMatchObject({
      reason: 'out_of_order',
    });
    await restarted.channel({ id, channel: 'main' }).append(updated);
    expect(await cursorsOf(storeOf())).toEqual(['s0', 's1']);
  });

  it('keeps a channel that was closed closed after a restart', async () => {
    await storeOf().channel({ id, channel: 'main' }).append(opened);
    await storeOf().channel({ id, channel: 'main' }).append(entry('closed', 's1'));

    await expect(
      storeOf().channel({ id, channel: 'main' }).append(entry('updated', 's2')),
    ).rejects.toMatchObject({ reason: 'out_of_order' });
  });

  it('trims an entry a crash cut off before the next one joins onto it', async () => {
    await storeOf().channel({ id, channel: 'main' }).append(opened);
    await appendFile(logOf(), '{"channel":"main","cursor":"s1","ty');

    const restarted = storeOf();

    await restarted.channel({ id, channel: 'main' }).append(updated);

    expect(await cursorsOf(restarted)).toEqual(['s0', 's1']);
    expect(await linesOf()).toEqual([opened, updated]);
  });

  it('counts its limits from what is already on disk after a restart', async () => {
    const limits = { channelBytes: Number.MAX_SAFE_INTEGER, conversationChannels: 1 };

    // The channel that was there is counted, so a second one is one too many.
    await openMainThenRefuseT1(limits);
    await storeOf(limits).channel({ id, channel: 'main' }).append(updated);
  });

  it('names a damaged line and the file, and does not show what was on it', async () => {
    await mkdir(channelsFolder(), { recursive: true });
    await writeFile(logOf(), `${JSON.stringify(opened)}\n{"secret":"hunter2"\n`);

    const reading = cursorsOf(storeOf());

    await expect(reading).rejects.toMatchObject({ name: 'StoreError', reason: 'failed' });
    await expect(reading).rejects.toThrow(/main\.jsonl/);
    await expect(reading).rejects.not.toThrow(/hunter2/);
  });

  it('refuses a line that is not an entry of a channel', async () => {
    await mkdir(channelsFolder(), { recursive: true });
    await writeFile(logOf(), `${JSON.stringify({ cursor: 's0', type: 'opened' })}\n`);

    await expect(cursorsOf(storeOf())).rejects.toMatchObject({ reason: 'failed' });
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'stores nothing while the marker of a channel that refused an entry cannot be written, and writes it when it can',
    async () => {
      await byteLog().append(BYTE_OPENED);

      const refusing = byteLog();

      try {
        // A folder nothing can be made in: the marker cannot be written, as on a disk that has
        // failed. The log itself is still there to read, and the marker's absence reads as none.
        await chmod(channelsFolder(), 0o500);
        await expectRefused({ log: refusing, appended: BYTE_TOO_BIG, reason: 'failed' });
        // The channel refused one, so this entry is not stored, even though the refusal could not
        // be made to last: a process that restarted would take it.
        await expectRefused({ log: refusing, appended: BYTE_CLOSED, reason: 'failed' });
        expect(await cursorsOf(storeOf(BYTE_LIMITS), 't1')).toEqual(['b0']);
      } finally {
        // Whatever failed above, the temporary folder can still be removed.
        await chmod(channelsFolder(), 0o700);
      }

      await expectRefused({ log: refusing, appended: BYTE_CLOSED, reason: 'quota' });
      expect(await readdir(channelsFolder())).toContain('t1.full');
      await expectRefused({ log: byteLog(), appended: BYTE_CLOSED, reason: 'quota' });
      expect(await cursorsOf(storeOf(BYTE_LIMITS), 't1')).toEqual(['b0']);
    },
  );

  it('fails an append, naming the file, when a channel’s marker cannot be read, before it reads the log', async () => {
    await byteLog().append(BYTE_OPENED);
    await writeFile(path.join(channelsFolder(), 't1.full'), '{"reason": 7}');

    const appending = byteLog().append(BYTE_CLOSED);

    await expect(appending).rejects.toMatchObject({ name: 'StoreError', reason: 'failed' });
    await expect(appending).rejects.toThrow(/t1\.full/);
    expect(await cursorsOf(storeOf(BYTE_LIMITS), 't1')).toEqual(['b0']);
  });

  it('refuses the entry of a channel that holds none without marking it, so a later one may come', async () => {
    await openMainThenRefuseT1({ conversationChannels: 1 });

    // No file was made for the name, so refused names cannot pile up files.
    expect(await readdir(channelsFolder())).toEqual(['main.jsonl']);

    // With room for it, in a later process, the same channel opens.
    await storeOf({ conversationChannels: 2 }).channel({ id, channel: 't1' }).append(T1_OPENED);
    expect(await cursorsOf(storeOf(), 't1')).toEqual(['s0']);
  });

  it('keeps a channel that refused an entry for a limit closed to later ones after a restart', async () => {
    await byteLog().append(BYTE_OPENED);
    await expectRefused({ log: byteLog(), appended: BYTE_TOO_BIG, reason: 'quota' });

    // A process that did not know the channel had refused an entry would store this one, and the
    // log would read as whole without it.
    await expectRefused({ log: byteLog(), appended: BYTE_CLOSED, reason: 'quota' });
    expect(await cursorsOf(storeOf(BYTE_LIMITS), 't1')).toEqual(['b0']);
    expect(await readdir(channelsFolder())).toContain('t1.full');
  });

  it('refuses to carry on a log edited by hand into one with a gap, naming the file', async () => {
    await mkdir(channelsFolder(), { recursive: true });
    await writeFile(
      logOf(),
      `${JSON.stringify(opened)}\n${JSON.stringify(entry('updated', 's5'))}\n`,
    );

    const appending = storeOf().channel({ id, channel: 'main' }).append(entry('updated', 's6'));

    await expect(appending).rejects.toMatchObject({ name: 'StoreError', reason: 'failed' });
    await expect(appending).rejects.toThrow(/main\.jsonl/);
  });

  it('refuses to carry on a log that holds another channel’s line', async () => {
    await mkdir(channelsFolder(), { recursive: true });
    await writeFile(logOf(), `${JSON.stringify(entry('opened', 's0', 'other'))}\n`);

    await expect(storeOf().channel({ id, channel: 'main' }).append(updated)).rejects.toMatchObject({
      reason: 'failed',
    });
  });

  it.skipIf(process.platform === 'win32')(
    'counts its limits past a link that leads nowhere, which is not a log',
    async () => {
      await mkdir(channelsFolder(), { recursive: true });
      await symlink(path.join(temp.path(), 'nowhere'), logOf('dangling'));

      await storeOf({ conversationBytes: 10_000 }).channel({ id, channel: 'main' }).append(opened);
      expect(await cursorsOf(storeOf())).toEqual(['s0']);
    },
  );

  it('never keeps an entry longer than a stored line can be read back', () => {
    // An entry over `MAX_LINE_CHARS` would make the whole channel unreadable, so the most an entry
    // may be is far under it.
    expect(MAX_CHANNEL_ENTRY_CHARS).toBeLessThan(MAX_LINE_CHARS);
  });

  it('reads the newest entries of a long log, as many as the most a subscription may ask for', async () => {
    const lines = Array.from({ length: 2500 }, (_, index) =>
      JSON.stringify(entry(index === 0 ? 'opened' : 'updated', `s${String(index)}`)),
    );

    await mkdir(channelsFolder(), { recursive: true });
    await writeFile(logOf(), `${lines.join('\n')}\n`);

    const store = storeOf();
    const tail = async (count: number) => {
      const cursors: string[] = [];

      for await (const each of store.channel({ id, channel: 'main' }).read({ tail: count })) {
        cursors.push(each.cursor);
      }

      return cursors;
    };
    const newest = await tail(MAX_TAIL);

    expect(newest).toHaveLength(MAX_TAIL);
    expect(newest[0]).toBe('s1500');
    expect(newest.at(-1)).toBe('s2499');
    expect(await tail(3)).toEqual(['s2497', 's2498', 's2499']);
    expect(await tail(0)).toEqual([]);
  });

  it('lists only the channel logs the store made: not a marker, a stray file, a folder or a bad name', async () => {
    await storeOf().channel({ id, channel: 'main' }).append(opened);
    await storeOf()
      .channel({ id, channel: 'tree' })
      .append(entry('opened', 's0', 'tree'));

    await writeFile(path.join(channelsFolder(), 't1.full'), '{"reason":"it is past its size"}');
    await writeFile(path.join(channelsFolder(), 'notes.txt'), 'hello');
    await writeFile(path.join(channelsFolder(), 'Not A Channel.jsonl'), '');
    await mkdir(path.join(channelsFolder(), 'folder.jsonl'));

    expect((await storeOf().channels(id)).toSorted()).toEqual(['main', 'tree']);
  });

  it('lists nothing for a conversation that has no folder', async () => {
    expect(await storeOf().channels(id)).toEqual([]);
  });

  it('makes no file for a name that is not a node id or the tree', async () => {
    const store = storeOf();

    for (const channel of ['../escape', 'Main', 'a/b', 'a\\b']) {
      expect(() => store.channel({ id, channel })).toThrow(/node id or is the tree/);
    }

    // Nothing was made under the store's folder, nor beside it.
    expect(await readdir(temp.path())).toEqual([]);
  });

  it('is removed with the conversation, so one made again starts from opened', async () => {
    const store = storeOf();

    await store.channel({ id, channel: 'main' }).append(opened);
    await store.delete(id);

    expect(await readdir(path.join(temp.path(), 'conversations'))).toEqual([]);
    await expect(store.channel({ id, channel: 'main' }).append(updated)).rejects.toMatchObject({
      reason: 'out_of_order',
    });
    await store.channel({ id, channel: 'main' }).append(opened);
  });
});
