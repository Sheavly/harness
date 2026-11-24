# @sheavly/core

The code contracts tools, hooks and providers are written against: `defineTool` / `runTool`,
`defineHook`, `defineAdapter`, the `Provider` and its `ProviderRequest`, and the `Environment` an
app passes in. No services, no tools of its own: everything else builds on this.

`ProviderRequest.effort` optionally carries `low`, `medium`, `high` or `extreme` reasoning effort
for one call. The caller chooses it; the provider translates it to its API's native settings.
The provider's `done` event may carry `usage`, with reported token counts. Input includes cache
reads and writes, and output includes reasoning when the provider reports it that way. Missing
usage is unknown, not zero; an app may attach a configured cost estimate and model id.

```ts
import { defineTool } from '@sheavly/core/tool/tool.utils';
import { defineHook } from '@sheavly/core/hook/hook.utils';
import type { Provider } from '@sheavly/core/provider/provider.types';
```

| Module                 | What it holds                                                                                                                                |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `tool/`                | `Tool` types, `defineTool`, `runTool`, the call's `description` field                                                                        |
| `hook/`                | `Hook` and its handlers' contexts, `defineHook`                                                                                              |
| `provider/`            | `Provider`, `ProviderRequest`, `ToolDefinition`                                                                                              |
| `notice/`              | `formatHarnessNotice`: model-facing formatting of shared protocol notices, transient and persistent                                          |
| `history/`             | `latestRequest`, `latestRequestIndex`, `latestPromptIndex`: what counts as a request in stored history                                       |
| `summary/`             | `Summarizer`, `SummaryOptions` and `SummaryPolicy` (what writes a checkpoint, and when), and `formatCheckpoint`                              |
| `text/`                | `neutralize`, `escapeTags`, `oneLine`, `escapedLine`: keep model-written text from opening or closing an envelope                            |
| `instruction-context/` | `createInstructionHook`, `registerInstructionHooks`: the one factory for instruction sources; `appendInstructionContext` dedups from history |
| `adapter/`             | `Adapter` types and `defineAdapter`, for model backends                                                                                      |
| `output/`              | `OutputStore` (`OutputReader` + `OutputCapture`): a conversation's complete command output, and the lines that tell the model where it is    |
| `store/`               | `ConversationStore`, `EntryStore` and `ChannelLog` (where past conversations are kept), `channelAppendEntry`, `toStoreError`                 |
| `clock/`               | `now()`: the one place a package reads the time, as epoch milliseconds                                                                       |
| `message/`             | `StreamEvent` and what a provider streams                                                                                                    |
| `environment/`         | `Environment`: settings an app passes in, since packages never read env                                                                      |
| `validation/`          | `parseOrThrow` / `validate`, which turn zod failures into an area's error                                                                    |
| `errors/`              | `DefinitionError`, `ToolCallError`, `StoreError`, `InstructionSourceError`                                                                   |

Completion notices render timing, intervening user-message counts and an optional starting tool
call ID alongside a fenced agent-authored reason; grouped completions keep one wrapper wait-reason
block and per-member context.
Transient `running-tasks` snapshots render total/omitted counts, escaped one-line task IDs, titles
and scalar group IDs, epoch start times and individually fenced agent-authored reasons as DATA.
The formatter supplies the no-polling/wait handling policy, never commands or task output.
Authored notice and checkpoint handling policies and the shared tool call-description guidance
live in adjacent internal `*.prompt.ts` files, alongside pure typed renderers for the complete
notice and checkpoint templates. Public utils formatters prepare and sanitize runtime data before
calling those renderers; protocol validators retain validation. Renderer exports stay internal to
core, with no public prompt subpaths.

## Docs

- [Model-facing notices](docs/notices.md): completion context and safe data fences.
- [Writing a tool](docs/tools.md): the `Tool` contract, and the artifacts a tool hands a UI.
- [Hooks](docs/hooks.md): every hook point, and adding one.
- [The provider contract](docs/providers.md): what a model backend implements.
