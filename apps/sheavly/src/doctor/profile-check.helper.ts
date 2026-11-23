import { StorageFileError, UnsafePathError } from '@sheavly/storage/errors/storage.errors';
import { ConfigStore } from '@sheavly/storage/config-store/config-store.service';
import { ProfileStore } from '@sheavly/storage/profile-store/profile-store.service';
import type { ProfileListing } from '@sheavly/storage/profile-store/profile-store.types';
import { SET_UP_HINT } from './doctor.constants.js';
import type { Finding } from './doctor.types.js';

function summarize(params: {
  defaultProfile: string | undefined;
  listing: ProfileListing;
}): Finding {
  const { defaultProfile, listing } = params;
  const { profiles, problems } = listing;
  // The stores' own messages can quote what the file holds (a parse error shows a snippet, a
  // schema error shows values), so only where the problem is is printed, never what it says.
  const damaged = problems.map(({ file }) => `  ${file} cannot be used as a profile`);

  if (defaultProfile === undefined) {
    const summary =
      profiles.length === 0
        ? 'no profile is set up'
        : `${String(profiles.length)} profile(s) but none is the default`;

    return { label: 'Profile', ok: false, lines: [summary, SET_UP_HINT, ...damaged] };
  }

  if (!profiles.some(({ id }) => id === defaultProfile)) {
    return {
      label: 'Profile',
      ok: false,
      lines: [
        `the default profile ${defaultProfile} does not exist or cannot be read`,
        SET_UP_HINT,
        ...damaged,
      ],
    };
  }

  return {
    label: 'Profile',
    ok: damaged.length === 0,
    lines: [`default profile ${defaultProfile} (${String(profiles.length)} set up)`, ...damaged],
  };
}

/**
 * Whether a default profile is set up in `home`: the config names one and its `profile.json`
 * reads. A profile folder that cannot be read is listed with the problem. It reads the stores and
 * never a key; whether the profile's model and key work is the server's to say, so it is not
 * judged here. A config the stores refuse to read is a finding, not a crash.
 */
export async function checkProfile(params: { home: string }): Promise<Finding> {
  try {
    const { defaultProfile } = await new ConfigStore({ root: params.home }).read();
    const listing = await new ProfileStore({ root: params.home }).list();

    return summarize({ defaultProfile, listing });
  } catch (caughtError) {
    // Only a stored file or a home the stores refuse is a finding; anything else is not ours to
    // hide. The file is named, what it holds is not: a parse or schema error quotes it.
    if (caughtError instanceof StorageFileError) {
      return { label: 'Profile', ok: false, lines: [`${caughtError.file} cannot be read`] };
    }

    if (caughtError instanceof UnsafePathError) {
      return { label: 'Profile', ok: false, lines: ['the home is not a folder Sheavly can use'] };
    }

    throw caughtError;
  }
}
