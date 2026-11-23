import { execFile, spawn } from 'node:child_process';
import type { SystemResult, SystemTools } from './service.types.js';
import { TOOL_TIMEOUT_MS } from './system.constants.js';
import { resultOf } from './system-result.utils.js';

/**
 * The real systemd tools: each program is run by name with an argument array, so nothing is
 * parsed by a shell, with a time limit and its output captured. `follow` gives the program the
 * terminal and waits for it.
 */
export function createSystemTools(): SystemTools {
  return {
    run: ({ tool, args }) =>
      new Promise<SystemResult>((resolve) => {
        execFile(
          tool,
          [...args],
          { timeout: TOOL_TIMEOUT_MS, encoding: 'utf8' },
          (failure, stdout, stderr) => resolve(resultOf({ failure, stdout, stderr })),
        );
      }),
    follow: ({ tool, args }) =>
      new Promise<number | 'missing'>((resolve) => {
        const child = spawn(tool, [...args], { stdio: 'inherit' });

        child.once('error', (failure: NodeJS.ErrnoException) =>
          resolve(failure.code === 'ENOENT' ? 'missing' : 1),
        );
        child.once('close', (code) => resolve(code ?? 1));
      }),
  };
}
