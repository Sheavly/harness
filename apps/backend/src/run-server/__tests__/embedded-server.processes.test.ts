import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { discoveryFileSchema } from '@sheavly/protocol/discovery/discovery.validator';
import { serverNameHash } from '@sheavly/storage/server-runtime/server-runtime.helper';
import { useServeProcesses } from '../../testing/serve-process.fake.js';

const EMBEDDED = pathToFileURL(
  path.join(import.meta.dirname, '..', 'embedded-server.helper.ts'),
).href;
// What a command does: start one, say so on a line the fake waits for, and then either wait for a
// signal or close it and let the process end by itself. Its own output is only that one line.
const processes = useServeProcesses({
  entry: [
    '--input-type=module',
    '--eval',
    `const { startEmbeddedServer } = await import(${JSON.stringify(EMBEDDED)});
const started = await startEmbeddedServer({ log: (text) => process.stderr.write(text) });
if (started.status !== 'started') throw new Error(started.message);
console.log('→ listening on embedded');
if (process.argv.includes('close')) await started.close();`,
  ],
});

async function runtimeFolder(): Promise<string> {
  const { xdg, home } = processes.folders();

  return path.join(xdg, 'sheavly', await serverNameHash({ home }));
}

describe.skipIf(process.platform === 'win32')('an embedded server in a process', () => {
  it('closes on SIGTERM, leaves no file, no socket and no lock, exits 143 and says nothing of it', async () => {
    const server = await processes.start();
    const folder = await runtimeFolder();
    const file = discoveryFileSchema.parse(
      JSON.parse(await readFile(path.join(folder, 'server.json'), 'utf8')),
    );
    const exit = await server.stop('SIGTERM');

    expect(file.pid).toBe(server.pid);
    expect(exit).toEqual({ code: 143, signal: null });
    expect(await readdir(folder)).toEqual([]);
    expect(server.stdout()).toBe('→ listening on embedded\n');
    expect(server.stderr()).toBe('');
  }, 60_000);

  it.each([
    ['SIGINT', 130],
    ['SIGHUP', 129],
  ] as const)(
    'closes on %s too and exits %i',
    async (signal, code) => {
      const server = await processes.start();
      const exit = await server.stop(signal);

      expect(exit).toEqual({ code, signal: null });
      expect(await readdir(await runtimeFolder())).toEqual([]);
    },
    60_000,
  );

  it('lets the process end by itself, with exit 0, once it is closed: nothing keeps it alive', async () => {
    const server = await processes.start({}, ['close']);
    const exit = await server.exited;

    expect(exit).toEqual({ code: 0, signal: null });
    expect(await readdir(await runtimeFolder())).toEqual([]);
    expect(server.stdout()).toBe('→ listening on embedded\n');
  }, 60_000);
});
