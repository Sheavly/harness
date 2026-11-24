# @sheavly/testing

Test fakes every workspace's tests share: scripted and routed providers, fake fetch, a tool
runner, and a polling wait. Test-only (`"sheavly": { "testOnly": true }`): depend on it as a dev
dependency and import it only from tests and fakes; `harness/imports` fails it anywhere else, and
lint treats all its source as test code.

```ts
import { routedProvider, say } from '@sheavly/testing/provider/routed-provider.fake';

const provider = routedProvider({ hi: [say('hello')] });
```

| Module      | What it holds                                                                           |
| ----------- | --------------------------------------------------------------------------------------- |
| `provider/` | `scriptedProvider`, `callOnceProvider`, `routedProvider`, the `Script` type             |
| `fetch/`    | `fakeFetch`, `fakeFetchSequence`, `collect`, `requestSentBy`                            |
| `tool/`     | `toolRunner`, which runs tools the way the loop does                                    |
| `wait/`     | `until`, which polls a condition                                                        |
| `files/`    | `filesHolding` (the files under a folder that hold some text), `useTempFolders`         |
| `store/`    | `MemoryConversationStore` (in memory, can be made to fail) and the store contract tests |
| `clock/`    | `useFixedClock`, which freezes the time `now()` reads for each test                     |
| `notice/`   | `NOTICE_SAMPLES`: one valid notice of every kind, for suites that run all kinds         |

It depends on `@sheavly/core` and `@sheavly/protocol`, so core's own tests can't use it; a
package's own fakes stay in its `src/testing/`.

## Docs

- [Fakes](docs/fakes.md): what each one stands in for.
