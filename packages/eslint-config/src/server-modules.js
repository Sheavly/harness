// The modules of `@sheavly/storage` that are the server's own: where it publishes its address and
// token, holds its one-server lock, and resolves the folder for both. Only the server and the
// finder (`server-finder/`, which reads them safely) touch them; `harness/server-through-finder`
// and the terminal's `connectBackendConfinement` both refuse them, from this one list.
export const SERVER_INTERNAL_MODULES = ['discovery-file', 'server-lock', 'server-runtime'];

/** The workspaces that are the server: they write the discovery file and hold the lock. */
export const SERVER_WORKSPACES = ['@sheavly/backend'];

/** Where the finder is, and the one handshake it may be given. */
export const FINDER_MODULE = '@sheavly/storage/server-finder/server-finder.helper';
export const VERIFY_MODULE = '@sheavly/client/client/verify.helper';
