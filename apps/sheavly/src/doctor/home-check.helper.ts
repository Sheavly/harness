import { access, constants, lstat, stat } from 'node:fs/promises';
import { errorCode } from '@sheavly/runtime/errors/errors.utils';
import { GROUP_AND_OTHERS_BITS } from './doctor.constants.js';
import type { Finding } from './doctor.types.js';

/** Whether `home` is a link whose target is gone: it exists, but `stat` cannot follow it. */
async function isDanglingLink(home: string): Promise<boolean> {
  try {
    await lstat(home);

    return true;
  } catch (caughtError) {
    if (errorCode(caughtError) === 'ENOENT') return false;

    throw caughtError;
  }
}

/** What is wrong with the folder `home` is, or nothing: it only looks, never makes or changes. */
async function homeProblems(params: {
  home: string;
  uid: number;
  platform: NodeJS.Platform;
}): Promise<string[]> {
  const { home, uid, platform } = params;
  // `stat`, not `lstat`: a home that is a link is the user's choice, as the server treats it.
  const found = await stat(home);

  if (!found.isDirectory()) return ['it is not a folder'];

  const problems: string[] = [];

  // Windows has no owners or modes to look at.
  if (platform !== 'win32' && found.uid !== uid) problems.push('it belongs to another user');

  if (platform !== 'win32' && (found.mode & GROUP_AND_OTHERS_BITS) !== 0) {
    problems.push('others can open it: make it private (`chmod 700`)');
  }

  try {
    await access(home, constants.W_OK);
  } catch (caughtError) {
    // Only a refusal is an answer; anything else (a broken disk) is not ours to hide.
    if (errorCode(caughtError) !== 'EACCES' && errorCode(caughtError) !== 'EPERM') {
      throw caughtError;
    }

    problems.push('you cannot write to it');
  }

  return problems;
}

/**
 * Whether the Sheavly home exists, is a folder owned by `uid` that nobody else can open (where the
 * system has modes) and can be written to. A home that does not exist yet is reported but is not a
 * problem: nothing makes it until a profile is set up. Never creates or changes anything.
 */
export async function checkHome(params: {
  home: string;
  uid: number;
  platform: NodeJS.Platform;
}): Promise<Finding> {
  const { home } = params;

  try {
    const problems = await homeProblems(params);

    if (problems.length === 0) {
      return { label: 'Home', ok: true, lines: [`${home} (private, writable)`] };
    }

    return { label: 'Home', ok: false, lines: [home, ...problems.map((text) => `  ${text}`)] };
  } catch (caughtError) {
    // A part of the path that is a file (ENOTDIR) means no setup can ever make the home.
    if (errorCode(caughtError) === 'ENOTDIR') {
      return { label: 'Home', ok: false, lines: [home, '  a folder in its path is a file'] };
    }

    if (errorCode(caughtError) !== 'ENOENT') throw caughtError;

    if (await isDanglingLink(home)) {
      return { label: 'Home', ok: false, lines: [home, '  it is a link to a folder that is gone'] };
    }

    // Not a problem by itself: a server runs without a home until a profile is stored in it, and
    // the profile check is what says nothing is set up.
    return {
      label: 'Home',
      ok: true,
      lines: [`${home} does not exist yet (the first setup makes it)`],
    };
  }
}
