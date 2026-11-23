# @sheavly/logger

A structured logger: closed event names and fields, redaction before any sink, sinks passed in.
Generic: it knows no file, folder or terminal. It reads no env and does no I/O of its own; where
entries go is a list of sinks an app or a store passes in.

```ts
import { createLogger } from '@sheavly/logger/logger/logger.helper';

const logger = createLogger({ service: 'backend', sinks: [fileSink, stderrSink] });
const conversation = logger.child({ conversationId });

try {
  await run();
} catch (caughtError) {
  // The caught value itself, never `error.message`: the entry keeps its stack and cause chain.
  conversation.error(LOG_EVENT.PROMPT_FAILED, { error: caughtError });
}
```

| Module    | What it holds                                                                                                                                 |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `logger/` | `createLogger` (levels, `child`, isolated sinks), `createLogEntry` (the one place an entry is redacted), `errorRecord`, and the types of both |

Internal (closed in `exports`): the constants (`LOG_FIELD`, the closed list of fields a call may
pass, and the identity patterns). Event names are the calling module's own `LOG_EVENT`.

## Docs

- [Design](docs/design.md): how it works, and how to extend it.
