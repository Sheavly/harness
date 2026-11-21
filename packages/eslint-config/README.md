# @sheavly/eslint-config

The shared ESLint config every workspace uses, and the `harness/*` rules that hold the code to
the harness's conventions: file kinds, the import graph, public APIs, one definition per type,
failing loudly. Plain JavaScript that only ESLint loads, so it isn't built; tooling, so a
workspace depends on it as a dev dependency.

```js
// <workspace>/eslint.config.js
import { baseConfig } from '@sheavly/eslint-config';

export default baseConfig({ tsconfigRootDir: import.meta.dirname });
```

| File                            | What it holds                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `base.js`                       | `baseConfig`: every rule, with an app's front-end rules read from its folder                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `rules/`                        | The `harness/*` rules, registered in `plugin.js`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `extension-contract.utils.js`   | `readExtensionContract`: the names `@sheavly/extension` exposes as the contract (service keys, scope types, scope errors), read from its files for `harness/extension-public-contract`                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `run-service-grants.utils.js`   | `readRunServiceGrants`: which grant each method of each scoped run service needs, parsed from the extension package's `RUN_SERVICE_GRANTS` for `harness/extension-declares-grants`                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `file-kinds.js`                 | Each `<name>.<kind>.ts` kind and its policy (exports, constants, max lines)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `layout.js`                     | `NOT_SOURCE` and `LAUNCHER_ENTRIES`, the hand-written parts of the layout                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `layout.utils.js`               | `readLayout`: the workspaces, their graph and domains, read from disk                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `service-grants-tests.utils.js` | `serviceGrantTestProblems`: an extension with service grants needs a test with a call expression to `assertServiceEnforcesGrants` (textual; named, aliased or namespace import; one problem when two workspaces hold the helper). It does not prove the call runs (skip, todo, dead code), hits the real provider, covers every method, is per provider (it is per workspace) or that the provider ignores the probe consumer: review-only. A same-file object method with the helper's name and a `typeof` instantiation with no call count as calls, and a call through a bracketed member name is not matched |
| `test-paths.utils.js`           | `isTestOrFake`: the one "is this a test or fake" matcher, shared with the hooks                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `rule-hints.js`                 | `RULE_HINTS`: what to do, added to lint messages that only say what's wrong                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `skills.js`                     | The one reader of `.agents/skills/*/harness.json`, shared by the hooks                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `skill-pointers.js`             | `pointRulesToSkills`: appends a skill's guide to the messages of its rules                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

`harness/imports` also keeps modules marked by `sheavly.appOnlyModules` app-selected, while
allowing packages to depend on the workspace's generic API. `harness/layout` validates those
module declarations against actual source folders. See [The workspace layout](docs/layout.md).

A new convention is a rule here, derived from the code rather than a hand-kept list, with a
message that says what to do instead, and RuleTester tests in `src/__tests__/`.

Authored model instructions, templates, tool descriptions and parameter guidance live in
first-class `*.prompt.ts` files: named text/table exports and pure typed rendering functions,
300 lines of code maximum. `harness/prompt-location` traces recognized model-facing sinks through
local bindings, workspace imports, properties and return builders; `harness/kind-contents` and
`harness/pure-imports` enforce the prompt file's shape and mechanical purity. Runtime/user data,
human UI text/errors/status, tests/fakes and stored Markdown prompts are not extraction targets.
See [Prompt extraction](docs/rules.md#prompt-extraction) for supported flows and limitations.

`harness/system-prompt-review` requires an explained review decision when production prompt/tool
sources, their sibling constants, or the generic base prompt change. The dedicated `npm run lint:prompt`
command runs uncached across affected-workspace boundaries. This catches unreviewed source drift,
not semantic prompt correctness; see [System prompt review](docs/rules.md#system-prompt-review).

Typed source checks include `.tsx` components and their tests. React hook rules also check
ordinary source helpers; plain `.ts` tests and fakes are excluded because their lifecycle
helpers use `use*` names too. JSX tests retain the hook rules. See [Rules](docs/rules.md).

## Docs

- [Rules](docs/rules.md): the file kinds and every `harness/*` rule.
- [The workspace layout](docs/layout.md): how the workspaces are read, what the layout check holds
  each one to, public APIs, and the docs it keeps honest.
