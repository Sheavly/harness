/**
 * The harness backend: conversations served to UIs in other processes, over HTTP on this machine.
 *
 *   npm run serve -w @sheavly/backend                  from source
 *
 * Each conversation runs on its workspace's profile: the models and keys in `~/.sheavly`
 * (`SHEAVLY_HOME` moves it), set up through the API, never `.env`. With none, a conversation is
 * refused with `not_set_up` and a UI onboards the user. Other settings: WORKSPACE_ROOT,
 * --trust, MAX_TURNS, WEB_FETCH, SUMMARY, CONTEXT_WINDOW, MODEL_CALLS_FILE,
 * SHOW_MODEL_CALLS, MODEL_RESPONSE_TIMEOUT_MS, MODEL_RETRIES, MODEL_RETRY_DELAY_MS. It listens on
 * SERVER_HOST:SERVER_PORT (127.0.0.1:4310 by default, moving to a free port when taken; port 0
 * picks a free one, from 20000-32000 when the OS has none; an explicit port that is taken fails)
 * and needs SERVER_TOKEN on every request but `GET /health` and `QUERY /handshake`, as
 * `Authorization: Bearer <token>`; without one it makes one and prints it once. Once it listens it
 * prints `→ listening on <url>`, the line a UI that started it waits for. A server that is not
 * SERVER_EXIT_WITH_PARENT and has not SERVER_DISCOVERY=false first takes its home's one-server
 * lock (exit 1 when another holds it) and publishes its address and token in the discovery file
 * once it listens; the others take no lock and write no file. Ctrl+C, SIGTERM, closing
 * the terminal or, with SERVER_EXIT_WITH_PARENT=true, its stdin closing (the UI that started it
 * is gone) stops it, and every conversation's prompts, tasks and processes with it. Calls the real
 * API, so it costs money. The routes: apps/backend/docs/api.md.
 *
 * This file only starts the server: the sequence is `runServer`
 * (`run-server/run-server.helper.ts`), which the `sheavly serve` command runs too.
 */
import { runServer } from './run-server/run-server.helper.js';

await runServer();
