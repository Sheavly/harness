import { MIN_NODE_MAJOR } from './doctor.constants.js';
import type { Finding } from './doctor.types.js';

/** Whether `version` (`process.versions.node`, as `24.1.0`) is a Node the harness runs on. */
export function checkNode(version: string): Finding {
  const major = Number.parseInt(version.split('.')[0] ?? '', 10);
  const ok = major >= MIN_NODE_MAJOR;

  return {
    label: 'Node',
    ok,
    lines: [
      ok
        ? `${version} (${String(MIN_NODE_MAJOR)} or later is required)`
        : `${version} is too old: ${String(MIN_NODE_MAJOR)} or later is required. Install a newer Node.`,
    ],
  };
}
