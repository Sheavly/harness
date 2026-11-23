export const DOCTOR_NAME = 'doctor';

export const DOCTOR_SUMMARY = 'Check what is installed, what runs and what is wrong';

/** The Node major version the harness needs: `engines` in the root `package.json`. */
export const MIN_NODE_MAJOR = 24;

/** The mode bits of the group and of everyone else: a private folder has none of them. */
export const GROUP_AND_OTHERS_BITS = 0o077;

/**
 * What no report line may hold: control characters (an escape sequence, a newline that would
 * start a forged `ok` line), format characters (bidi overrides) and line or paragraph separators.
 * Folder names and messages that come from files can hold them.
 */
export const UNPRINTABLE_TEXT = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

/** What follows a profile finding that is not ok: the one way to make a profile. */
export const SET_UP_HINT = '  Run `sheavly setup` to set one up.';

export const DOCTOR_HELP = `Usage: sheavly doctor

Says what is installed, what runs and what is wrong, and exits 1 when anything is:

  Node      the version, which must be 24 or later
  Home      the Sheavly home folder: that it exists, is private to you and writable
  Server    your running server, found through its discovery file and proven by its handshake;
            or why there is none (left over, refused, another protocol version, not started)
  Profile   that a default profile is set up

It only reads and probes: it never starts or stops a server and creates or changes nothing.
It never prints the token or what the discovery file holds.
`;
