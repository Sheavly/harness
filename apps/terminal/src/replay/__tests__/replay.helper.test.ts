import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeFetch } from '@sheavly/testing/fetch/fake-fetch.fake';
import { Renderer } from '../../render/render.service.js';
import { useTempFolders } from '../../testing/temp-folders.fake.js';
import { replayStored } from '../replay.helper.js';
import type { ReplayOptions } from '../replay.types.js';
import {
  asJsonl,
  asSse,
  fixtureEntries,
  HELPER,
  MAIN,
  oldFormEntries,
} from '../testing/stream.fake.js';

const temp = useTempFolders();
/** The fixture as the log look prints it, written out so a change of the look is seen here. */
const GOLDEN = [
  '',
  '  ◆ sub-agent "Look around" [helper] started · depth 2 · parent main · main main',
  'Looking.',
  '',
  '⏺ list files  $ ls',
  '    ✓ 4 chars · 0.3s',
  '  ◆ sub-agent "Look around" [helper] completed',
  '[completed · 4 events · reasoning items kept: 0]',
  '',
].join('\n');

afterEach(() => vi.unstubAllGlobals());

async function replayed(params: {
  files: Record<string, string>;
  options?: Partial<ReplayOptions>;
}) {
  const folder = await temp.make('replay');
  let out = '';

  for (const [name, text] of Object.entries(params.files)) {
    await writeFile(path.join(folder, name), text);
  }

  const options = { target: folder, from: 0, json: false, summary: false, ...params.options };

  await replayStored({ options, folder, write: (text) => void (out += text) });

  return out;
}

/** What the live run prints: the demo feeds each entry of the stream to a `Renderer`. */
function live(): string {
  let out = '';
  const renderer = new Renderer((text) => void (out += text));

  for (const entry of fixtureEntries()) renderer.entry(entry, MAIN);

  return out;
}

describe('replayStored', () => {
  it('renders a stored conversation exactly as the live run printed it', async () => {
    const out = await replayed({ files: { 'stream.jsonl': asJsonl(fixtureEntries()) } });

    expect(out).toBe(live());
    expect(out).toBe(GOLDEN);
  });

  it('replays a conversation an older version stored as it replays today’s, with no finding', async () => {
    const files = { 'stream.jsonl': asJsonl([...fixtureEntries(), ...oldFormEntries()]) };
    const out = await replayed({ files });
    const summary = await replayed({ files, options: { summary: true } });

    expect(out).toContain(GOLDEN.trimEnd());
    expect(summary).toContain('Findings:\n  none');
    expect(summary).not.toContain('not an entry');
  });

  it('renders a workbook run from its sessions.sse the same way', async () => {
    const out = await replayed({ files: { 'sessions.sse': asSse(fixtureEntries()) } });

    expect(out).toBe(live());
  });

  it('starts at --from, by seq', async () => {
    const out = await replayed({
      files: { 'stream.jsonl': asJsonl(fixtureEntries()) },
      options: { from: 8 },
    });

    expect(out).toContain('completed');
    expect(out).not.toContain('Looking.');
  });

  it('keeps the stream main session when --from starts at a sub-agent entry', async () => {
    const out = await replayed({
      files: { 'stream.jsonl': asJsonl(fixtureEntries()) },
      options: { from: 7 },
    });

    expect(out).toContain('sub-agent "Look around" [helper] completed');
    expect(out).toContain('[completed · ');
  });

  it('says when nothing is left to replay, instead of printing nothing', async () => {
    const out = await replayed({
      files: { 'stream.jsonl': asJsonl(fixtureEntries()) },
      options: { from: 99 },
    });

    expect(out).toBe('No entries to replay.\n');
  });

  it('does not let stored text write terminal escapes in the summary', async () => {
    const hostile = asJsonl(fixtureEntries()).replaceAll(
      'Look around',
      '\\u001b]0;pwned\\u0007Look',
    );
    const out = await replayed({
      files: { 'stream.jsonl': hostile },
      options: { summary: true },
    });

    expect(out).toContain('Look');
    expect(out).not.toContain('\u001b');
    expect(out).not.toContain('\u0007');
  });

  it('shows only the --session entries, with that session as the main one', async () => {
    const out = await replayed({
      files: { 'stream.jsonl': asJsonl(fixtureEntries()) },
      options: { session: HELPER, json: true },
    });
    const entries = out.trim().split('\n');

    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every((line) => line.includes(`"sessionId":"${HELPER}"`))).toBe(true);
  });

  it('prints one entry per line with --json', async () => {
    const out = await replayed({
      files: { 'stream.jsonl': asJsonl(fixtureEntries()) },
      options: { json: true },
    });

    const lines: unknown[] = out
      .trim()
      .split('\n')
      .map((line): unknown => JSON.parse(line));

    expect(lines).toEqual(fixtureEntries());
  });

  it('says when the stream ends with a tool still running, instead of hiding it', async () => {
    const unfinished = fixtureEntries().slice(0, 4);
    const out = await replayed({ files: { 'stream.jsonl': asJsonl(unfinished) } });

    expect(out).toContain('the stream ends with 1 tool call(s) still running');
  });

  it('summarizes the whole stream with --summary, even from a later seq', async () => {
    const withoutDone = fixtureEntries()
      .slice(0, -1)
      .filter((entry) => entry.seq !== 4);
    const out = await replayed({
      files: { 'stream.jsonl': asJsonl(withoutDone) },
      options: { summary: true, from: 6 },
    });

    expect(out).toContain('✗ seq gap: 3 is followed by 5');
    expect(out).toContain('✗ no `done` of the main session');
  });

  it('prints the summary as JSON with --summary --json', async () => {
    const out = await replayed({
      files: { 'stream.jsonl': asJsonl(fixtureEntries()) },
      options: { summary: true, json: true },
    });

    expect(JSON.parse(out)).toMatchObject({ entries: 9, outcome: 'completed', gaps: [] });
  });

  it('makes no network call', async () => {
    const { fetch, requests } = fakeFetch([]);
    const folder = await temp.make('replay');

    vi.stubGlobal('fetch', fetch);
    await writeFile(path.join(folder, 'stream.jsonl'), asJsonl(fixtureEntries()));

    for (const mode of [{}, { summary: true }, { json: true }]) {
      await replayStored({
        folder,
        write: () => undefined,
        options: { target: folder, from: 0, json: false, summary: false, ...mode },
      });
    }

    expect(requests).toHaveLength(0);
  });
});
