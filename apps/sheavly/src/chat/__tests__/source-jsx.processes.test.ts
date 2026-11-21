import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..', '..', '..');
const run = promisify(execFile);
let scratch: string | undefined;

afterEach(async () => {
  if (scratch) await rm(scratch, { recursive: true, force: true });
  scratch = undefined;
});

/** The `--tsconfig` the root `npm run sheavly` script hands tsx, as a path from the root. */
async function sheavlyTsconfig(): Promise<string> {
  const manifest = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  };
  const tsconfig = /--tsconfig (\S+)/.exec(manifest.scripts.sheavly ?? '')?.[1];

  if (tsconfig === undefined) throw new Error('the sheavly script names no --tsconfig');

  return tsconfig;
}

/** Every `.tsx` in a workspace's `src`: what the command may load from the checkout. */
async function workspaceTsx(): Promise<string[]> {
  const folders = ['apps', 'packages', 'extensions'];
  const workspaces = (
    await Promise.all(
      folders.map(async (folder) =>
        (await readdir(path.join(ROOT, folder))).map((name) =>
          path.join(ROOT, folder, name, 'src'),
        ),
      ),
    )
  )
    .flat()
    .filter((src) => existsSync(src));
  const files = await Promise.all(
    workspaces.map(async (src) =>
      (await readdir(src, { recursive: true }))
        .filter((file) => file.endsWith('.tsx'))
        .map((file) => path.join(src, file)),
    ),
  );

  return files.flat();
}

describe.skipIf(process.platform === 'win32')('npm run sheavly, from source', () => {
  it('compiles every workspace component with the automatic JSX runtime, as each workspace does', async () => {
    const components = await workspaceTsx();

    scratch = await mkdtemp(path.join(tmpdir(), 'sheavly-jsx-'));

    const probe = path.join(scratch, 'probe.mts');

    // Prints each component module's compiled functions: the classic runtime calls
    // `React.createElement`, which fails at render time unless React is in scope.
    await writeFile(
      probe,
      `for (const file of ${JSON.stringify(components)}) {
  const module = await import(file);
  console.log(file, Object.values(module).map(String).join(' ').includes('React.createElement') ? 'classic' : 'automatic');
}`,
    );

    const { stdout } = await run(
      process.execPath,
      ['--conditions=@sheavly/source', '--import', 'tsx', probe],
      {
        cwd: ROOT,
        env: {
          PATH: process.env.PATH,
          TSX_TSCONFIG_PATH: path.join(ROOT, await sheavlyTsconfig()),
        },
      },
    );

    expect(components.length).toBeGreaterThan(0);
    expect(stdout.split('\n').filter((line) => line.endsWith(' classic'))).toEqual([]);
    expect(stdout.split('\n').filter((line) => line.endsWith(' automatic'))).toHaveLength(
      components.length,
    );
  }, 60_000);
});
