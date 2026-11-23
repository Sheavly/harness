# Rules

The file kinds and every `harness/*` rule the shared config (`baseConfig`) applies to every workspace.

## File kinds and conventions

Everything below lives in `packages/eslint-config/src/`: kinds and their policies in `file-kinds.js`,
the rules in `rules/` (registered in `plugin.js`, tested in `__tests__/`), and the config every
workspace uses in `base.js`. Each workspace's `eslint.config.js` is
`baseConfig({ tsconfigRootDir: import.meta.dirname })` plus its own boundaries; `npm run lint` at the
root lints every workspace with its own config. Each convention is its own rule ID, so an override
switches off exactly one, on the files it is for, with a reason.

| Kind        | Holds                                                    | May export                                     | Max lines |
| ----------- | -------------------------------------------------------- | ---------------------------------------------- | --------- |
| `types`     | shared shapes                                            | only types (imports `type`s)                   | 300       |
| `constants` | literal values, `as const`                               | only literals                                  | 300       |
| `prompt`    | authored model text, tables and pure typed renderers     | text/data, functions; no types/classes/schemas | 300       |
| `utils`     | pure helpers: no I/O, no services                        | code                                           | none      |
| `validator` | zod schemas for external input, `parse*` functions; pure | code, schemas                                  | 300       |
| `helper`    | stateless functions; may do I/O, call services           | code, no classes                               | none      |
| `service`   | code that owns state                                     | code, at least one class                       | 300       |
| `tool`      | one agent tool (`defineTool`)                            | code                                           | 150       |
| `adapter`   | one model backend (`defineAdapter`)                      | code                                           | 150       |
| `routes`    | one group of HTTP routes (a function building a `Hono`)  | code, no classes                               | 150       |
| `errors`    | error classes                                            | code                                           | 150       |
| `component` | one React view (`.tsx`), a function component            | code, no classes                               | 150       |
| `fake`      | test-only fakes in a `testing/` folder                   | code                                           | 300       |
| `test`      | Vitest files in `__tests__/` (`.test.tsx` for a view)    | code                                           | 500       |

Max lines counts lines of code (blank and comment lines aside), enforced by `max-lines`. `utils` and
`helper` files have no cap: they are stateless functions that grow with their subject, so a long one
is split by responsibility only when it does several jobs, not to fit a number. A file with no kind
(an entry point, the demo) is capped at 300. The limits live in `file-kinds.js`.

- `harness/file-kind`: every module file is named `<name>.<kind>.ts` (kebab-case, known kind);
  tests only in `__tests__/`, and only tests there. Only a `component` (a React view) is
  `<name>.component.tsx`, and a test of one may be `.test.tsx`: a kind's extensions are in
  `file-kinds.js`, and a package never exports a `.tsx` kind (views belong to an app).
- **React** (`react-hooks/rules-of-hooks`, `react-hooks/exhaustive-deps`, every workspace's
  source): a hook is called only from a component or another hook, with its dependencies listed.
  Plain `.ts` tests and fakes are excluded because their lifecycle helpers also use `use*` names;
  `.tsx` tests remain checked.
- `harness/kind-contents`: code files export no types and no literal constants; those go in the
  module's `*.types.ts` / `*.constants.ts`. A code file also keeps no top-level literal `const`,
  exported or not (the kind's `constantsElsewhere` policy; fakes and tests are exempt): a number,
  string, regex or literal table moves to `*.constants.ts`. A `*.service.ts` exports a class, a
  `*.helper.ts` none, and only a `*.validator.ts` exports zod schemas. Unexported local types and
  schemas are fine.
- `harness/pure-imports`: `*.utils.ts`, `*.validator.ts` and `*.prompt.ts` import no I/O modules and no services, helpers, tools or adapters. Prompt files additionally reject mechanically recognizable direct I/O, model calls and state/side effects; pure rendering, local helpers and pure dependencies are allowed.
- `harness/layout` and `harness/imports`: every workspace holds together as the layout reads it
  from the workspaces (a domain, one of `generic`, `coding` or `tooling`; `tooling` is a workspace
  source never imports, such as this one, so a dependency on it must be a dev dependency; named
  after its folder, no app or coding-from-generic edge, and
  a transport such as `@sheavly/client`, `sheavly.transport`, only from an app; the one
  exception to "no app edge" is the launcher, `sheavly.launcher: true`, set with
  `npm pkg set sheavly.launcher=true -w apps/sheavly`: exactly one workspace, `apps/sheavly`
  named `sheavly`, may depend on the apps `LAUNCHER_ENTRIES` (`src/layout.js`) lists, and it
  keeps every other edge rule and is itself imported by nothing; the flag on any other
  workspace, a second launcher, or the name `sheavly` without the flag fails; such an app may
  `exports` only its entry files that list names, one by one (`./run-server/run-server.helper`),
  no app sets `main`, `module` or `browser`, and `harness/imports` then fails an import of any
  other subpath of it or of its bare name), and
  imports follow the graph: another workspace only if `package.json` depends on it (dev
  dependencies for tests), test-only workspaces only from tests and fakes, no relative import
  across workspace roots. A dynamic `import()` is checked when its specifier is a string or a
  template literal with no `${}`; a computed one is not. Modules marked by `sheavly.appOnlyModules` accept value imports only
  from apps, tests, fakes and their own module internals; package tools cannot select them either.
  Type-only imports are allowed. The check includes package subpaths (including self-imports),
  relative imports, re-exports and literal dynamic imports; layout validates the metadata against
  actual direct `src/` module folders.
- `harness/extension-definition` (source files of `extensions/*` workspaces, not tests): every
  `defineExtension({ … })` is built from its workspace's `sheavly.json`: the argument is an object
  literal (no spread) that passes `manifest` and does not pass `name`, `dependsOn` or `settings`,
  which come from the manifest and would drift if repeated. `manifest` is
  `readManifest(new URL('<path>', import.meta.url))`, where `readManifest` is the import from
  `@sheavly/extension/manifest/manifest.helper` (under any local name; a local function of that
  name, or an import from elsewhere, is reported), with a string-literal path, written in the
  call or in the module-level `const` it names, and the path, resolved from the file's own
  location, is exactly the workspace's `sheavly.json` (`'../../sheavly.json'` from
  `src/<folder>/`). A wrong depth, another extension's file, an object literal (allowed in tests
  and for third parties, never in an extension's own source), a non-literal path, a parameter,
  `let` or import standing for the manifest, and a missing `manifest` are each reported with the
  path to write.
  It reads the layout from disk (`readLayout`), so a new extension is covered with no edit, and
  takes the `root`/`layout` options of the other layout rules. Review covers an extension built by
  a helper rather than a direct `defineExtension` object literal, a manifest read through another
  function that returns it, and what the manifest declares against what the code does (the
  host's activation check throws for that). The file itself is the layout check's, below.
- **An extension's `sheavly.json`** (`harness/layout` and the layout check, one implementation in
  `extension-manifest.utils.js`, read with `JSON.parse` only): every `extensions/*` workspace has
  one; it can be read (a directory named `sheavly.json`, or no permission, is reported, not
  thrown), is valid JSON and an object; its `name` is the folder name; its `dependsOn` equals, as a
  set, the other extension workspaces in the package's `dependencies` (dev dependencies don't
  count); and the package's `files` lists `sheavly.json`, so it ships. A workspace outside
  `extensions/` has none. The rest of the schema (types, settings, wildcards) is validated by
  `readManifest` when the extension loads, not here: this package depends on neither
  `@sheavly/extension` nor zod. Each message says what to change.
- `harness/extension-no-runtime-registries` (source files of `extensions/*` workspaces, not tests
  or fakes): an extension reads run state through the scoped services the host builds for it
  (`services.get(KEY)` in `activate`, limited by its manifest's grants), so it must not take the
  full registries. A VALUE import of the runtime session, task or approval service modules, or of
  `@sheavly/host/host/host.helper` (`createHarness`), fails, in any form: `import`, a re-export,
  `export * from`, a dynamic `import('…')`, `require('…')` and `import x = require('…')` with a
  literal or expression-free template path. A relative path into a workspace's `src/` and a package
  specifier with `.`/`..` segments are resolved to the module they reach before matching. The rule
  has no exceptions: no option, list or file is exempt, and inline directives are off. Gaps:
  files under `testing/` and `__tests__` are exempt by file kind, and value imports of the loop's
  runner and of host `*Scope` classes are not flagged. Type-only uses are allowed (`import type`,
  `import { type X }`, `export type`), and so are the work factories
  (`@sheavly/runtime/tasks/work.utils`, `work.types`). The registry modules are not listed in the
  rule: they are read at lint time from the imports of the `Harness` type in
  `packages/host/src/host/host.types.ts` (each member typed by a name imported from a `*.service`
  module), so a new registry is covered with no edit; when that file cannot be read, or yields no
  registry, every extension file gets one error saying so, instead of going silent. Tests assert
  that the extension sources of this repo have no violation (the rule run over `extensions/*`
  with no options) and that a file shaped like a harness builder (a value import of `createHarness`
  from `@sheavly/host/host/host.helper` in an extension file) fails. Limits: this is not a sandbox. An
  extension is Node code and can still reach a registry at runtime through a computed or
  non-literal `import()`/`require` path, `createRequire`, `globalThis`, a prototype, or an object
  another module hands it; a registry module imported under a different specifier (a relative
  path into the package) is not matched; and what the manifest declares against what the code
  does is the host's activation check and review.
- `harness/extension-public-contract` (source files of `extensions/*` workspaces, not tests or
  fakes): `@sheavly/extension` is the contract between the app and the built-in extensions. An
  extension may use as many other libraries as its own substance needs (core, protocol, workspace,
  process, tools, the runtime's helpers, other extensions), but it does not reach the app through
  the app's own package and it takes the contract from `@sheavly/extension`. Three things fail.
  (1) Any import of `@sheavly/host` or a subpath of it: a static `import`, `import type`,
  `export … from`, `export * from`, a dynamic `import('…')`, a type query
  (`typeof import('…')`, `import('…').X`) and `import x = require('…')`, each with a literal (or
  expression-free template) specifier. (2) An import, from another `@sheavly/…` package than
  `@sheavly/extension`, of a name that package exposes as the contract, matched by the IMPORTED
  name (`import { SESSION_INFO as S }` counts): the message gives the path to use instead. A
  third-party library is not checked, since a name such as `MODEL` is generic. (3) An import of
  test code in production source: a relative or `@sheavly/…` specifier with a `testing` folder
  segment or a `.fake` file name (a `../testing/` path, an `@sheavly/workspace/testing/…`
  subpath), in any form of (1), `import type` included. A fake is exempt
  from these rules and may import the host, so production must not reach one: move what it needs
  into production code. Files that are themselves tests or fakes are exempt. The names are not listed in the rule: they are read at
  lint time (`extension-contract.utils.js`, cached by modification time) from what
  `packages/extension/src/run-services/run-services.utils.ts` (the keys),
  `packages/extension/src/run-services/run-services.types.ts` (types defined or re-exported) and
  `packages/extension/src/errors/scopes.errors.ts` export, so a new key, type or error is covered with no edit. A missing,
  non-regular or unparsable file adds no names and never crashes: check (2) then covers less, check
  (1) needs no file. Allowed: anything from `@sheavly/extension/…`, and imports of other names from
  core, protocol, runtime, workspace, process, tools or another extension; a name a file declares
  itself is no import. The registries and builders of the runtime stay
  `harness/extension-no-runtime-registries`'s. Tests assert both paths with RuleTester, a
  throwaway package that gains a name, a tree with no package files, and that the real
  `extensions/*` source has no report and the real contract list holds `SESSION_INFO`,
  `SessionInfoView` and `ScopeDeactivatedError`. Limits: a non-literal dynamic `import(name)`,
  `require(…)` and a `createRequire(…)(literal)` call are not seen; a relative specifier into
  another workspace's source is not resolved to a package (only the `testing`/`.fake` check reads
  it); an import hidden behind a type-only alias file (a local file re-exporting the name) is not
  followed; matching is by name, not structure (a differently named identical type is a miss);
  `export * from` is not followed in the package's own contract files (the host check does catch
  it); a specifier written with unusual casing (`@Sheavly/Host`) is not matched. The rule is
  enabled for `src/**/*.{ts,tsx}` of an extension workspace only: `.js`, `.cjs`, `.mts`, `.cts`
  files and files outside `src/` are not linted (`SOURCE_FILES` is shared by every rule, so it is
  not widened for this one). The `testing` folder segment and the `.fake` file name are matched
  case-sensitively, a `.fake.d.ts` file is not caught, and a `#` subpath import is not seen. The
  dependency kind of `@sheavly/host` in an extension's `package.json` is not checked here but by
  the layout check (`npm run layout`, `scripts/check-layout.mjs`, next to the provider check): an
  extension may list the host only in `devDependencies`.
- `harness/extension-declares-grants` (source files of `extensions/*` workspaces, not tests or
  fakes): a scoped run service refuses a call whose grant the extension's `sheavly.json` does not
  list, but only when the call runs, so a call in a tool's `execute`, a hook handler or a rare
  branch can stay unseen. The rule reports a call to a method of a scoped service when the
  workspace's manifest `grants` lacks the grant that method needs; the message names the grant,
  the `service.method` (`approvals.request({ tool })` for an argument grant) and the manifest to
  edit (the workspace's own `sheavly.json`, as a path from the repo root). It is syntax only: no type information, so it adds
  nothing to the typed-lint cost. A call is recognised in three forms. (a) A KEY imported from
  `@sheavly/extension/run-services/run-services.utils` (under any local name) that is a key of
  that file. (b) A scope value: `services.get(KEY)` or `services.find(KEY)` on any receiver,
  chained directly (`services.get(KEY).list()`, `services.find(KEY)?.list()`) or bound with
  `const` or `let` (`s.list()`, `s?.list()`, `s!.list()`), also from a nested function or callback
  that uses the variable, which is the lazily run case. The value is followed through `as`,
  `satisfies` and `<T>` type assertions as it is through `?.` and `!`
  (`(services.get(KEY) as SessionInfoView).list()`, `const s = services.get(KEY) as T; s.list()`).
  A variable is followed when EVERY value written to it is a read of the same service, in any
  order: its initialiser if any and each `=` assignment (`let s; s = services.get(KEY)`,
  `let s: T | undefined; s = services.find(KEY); s?.list()`, a call before a later write), looking
  through the same casts. A write of `undefined` or `null` is neutral. A variable that is also
  assigned something else (another variable, a call that is not a scope read), assigned two
  different services, or changed by a destructuring, `++` or `+=` is mixed and NOT followed:
  review-only. (c) A parameter or variable annotated with
  a scope type imported from `@sheavly/extension/run-services/run-services.types` (under any local
  name; `T | undefined` counts), mapped to its service through the key that carries the type
  (`SessionInfoView` to `session-info`); a type carried by two keys is checked against both
  services. The annotation vouches for the initial value (an initialiser or a parameter default),
  but a later assignment must be a read of that service, else the variable is not followed. Which grant each method needs is read at lint time from `RUN_SERVICE_GRANTS` in
  `packages/extension/src/run-services/run-service-grants.constants.ts` and the keys from
  `run-services.utils.ts` (`run-service-grants.utils.js`, `run-service-types.utils.js`; parsed, not
  executed, cached by modification time and size), so a new scope method or a new service is
  covered with no edit. The mapping is checked first, before the manifest: when the file exists
  and parses but is not the documented plain literal (it yields no entries, or has an entry the
  reader cannot read: a spread, a call, a computed key, a new shape; one unreadable entry empties
  the whole table), the rule REPORTS once per linted extension file, naming the file and saying
  `RUN_SERVICE_GRANTS` must be a plain literal of the documented shape, even for an extension
  with no manifest (the rule has gone blind). A missing file (a throwaway tree, a checkout
  without the extension package) or a syntax error (the compiler reports it) stays silent, as
  does a missing or unreadable keys file. A method the mapping does not list is ignored (the host's tests catch a scope that gains
  one). A `{ grant, arguments }` entry also needs the argument's grant when the call's first
  argument is an object literal with a non-computed property of that name (a quoted or shorthand
  name counts; a literal `undefined` value does not); a spread, a computed key or a non-literal
  argument leaves only the base grant checked. The manifest is read with the layout's
  `sheavly.json` reader: one that is missing, not JSON or has `grants` that is not an array makes
  the rule report no call, since the layout check and the other rules report that (a broken
  mapping is still reported, as above); a manifest without
  `grants` declares none. A manifest listing grants in any order is the same. The converse, a
  declared grant that no call needs, is deliberately NOT reported: a per-file rule cannot see the
  whole workspace, and a grant can be needed by a call it cannot follow; a test pins that a
  manifest with grants no call uses reports nothing. Review-only, not reported and not claimed as
  covered: a scope passed around (as a function argument without an annotation), destructured
  methods (`const { list } = scope`), a method read without a call (`const f = scope.list`, and the
  `approvals.listening` flag), a computed key (`scope[name]()`), a scope stored on an object or a
  class field, a copy of the scope (`const t = s`), a `services` object that is not named in a call
  the rule sees, a service an extension PROVIDES (`sub-agents` with `sub-agent:share`: its keys are
  not in the mapping, so the rule ignores them; see #380), an `any`-typed value, a variable
  that is also assigned something else or another service, a namespace key import (`import * as keys …; services.get(keys.SESSION_INFO)`), a
  parameter annotated through a destructured pattern
  (`function f({ s }: { s: SessionInfoView })`), a call through `.call`, `.apply` or `.bind` or
  `Reflect.apply`, a key aliased to a local constant (`const k = KEY; services.get(k)`), a key
  imported from a local re-export file, a scope used inside a `Promise.then`-style callback whose
  parameter is not annotated, and the argument grants of a non-literal request. A
  `Map.get(KEY)` receiver is also treated as a service read (any receiver is accepted). Tests
  cover every service of the real mapping (a call per distinct grant, reported without the grant
  and accepted with it), each form, the argument grants, what is not followed, the converse,
  exempt files, a missing manifest (no call reported, a broken mapping still reported), a mapping
  that gains a method or service, a mapping that exists and parses but is not the documented
  literal (reported) or is missing or has a syntax error (silent), that the reader returns every
  service, member, grant and argument of the real file (compared with a count from its text), and
  that the real `extensions/*` source has no report (a report there is a call that would throw
  at run time).
- `harness/extension-options-use-services` (source files of `extensions/*` workspaces, not tests):
  a type alias or interface named `*ExtensionOptions` carries the embedding app's choices, never
  run state. Each member (a property, a method, an index, call or construct signature) whose declared
  type NAMES a type a run service carries (a union, an array, a generic argument such as
  `Readonly<…>` or `Promise<…>`, an optional member, an inline literal, `import('x').Type` or a
  qualified `Ns.Type` all count) is reported once, by its name, with the service key to read instead
  (`services.get(SESSION_INFO)` in `activate`). A function-typed option counts: a method signature
  `run(s: SessionRegistry): void` and a property `run: (s: SessionRegistry) => void` are both
  reported. So is an alias whose whole body is a reference or wrapper
  (`Partial<SessionRegistry>`, reported under the alias name), an `extends` entry of an interface,
  and a generic parameter's constraint or default. Otherwise a built-in extension would again get
  from the app what a third party cannot. The service types are read at lint time from the
  `defineService<Type>('name')` calls of the extension package's
  `packages/extension/src/run-services/run-services.utils.ts` (type name → exported key; keys sharing one
  type name are joined with `or`), so a new service is covered with no edit; primitives are
  ignored. Every exported `type X = A & B` of `packages/core/src/output/output.types.ts` whose
  members are all service types (`OutputStore = OutputReader & OutputCapture`) is refused too, with
  the members' keys joined by `and`, so the whole store cannot bypass the `output:read` and
  `output:capture` grants; a missing or unparsable core file adds no such type and is no error. The registry types of the host's `Harness` type (`SessionRegistry`, `TaskRegistry`,
  `ApprovalRegistry`, read from `packages/host/src/host/host.types.ts` as for
  `harness/extension-no-runtime-registries`) are refused the same way, with their own message
  pointing at the scoped services, because the run-service keys carry scope types and no longer
  name the registries; a `Harness` file that exists but yields no registry is reported like an
  unreadable run-services file. Matching is by type name only: a name the file declares itself (a local type, interface,
  enum, class or generic parameter) is not reported, and a differently named but structurally
  identical type is a miss. It takes the `root`/`layout` options of the other layout rules. When
  the file isn't under the root (or is not a regular file), or has a syntax error, it does
  nothing without crashing; when the
  file exists but yields no `defineService<Type>` key (a renamed or wrapped `defineService`) it
  reports one error on the checked file saying so, instead of going silent. Review-only: an aliased
  or re-exported type name (`import type { X as S }`), a `typeof` query of a value and
  utility or conditional types that only resolve to a registry (`ReturnType` of one), an option typed
  `unknown`, `any` or a generic parameter and then cast, a factory parameter outside the
  `*ExtensionOptions` type, an options type composed from another type that holds a service type
  (`Base & { … }` or `type S = SessionRegistry` used as `s: S`, local or imported: only the
  `*ExtensionOptions` declaration itself is read), an options `class` (only a type alias and an
  interface are visited), and an options type not named `*ExtensionOptions`. No `*ExtensionOptions`
  in this repo carries a registry type.
- `harness/single-definition`: each `*.types.ts` (in every workspace's `src/`,
  outside tests and fakes) owns the type names it exports. The same name declared anywhere else,
  exported or not (another folder, another package, a second types file of the same package), or
  re-exported from a file that isn't its owner (`export type { X } from`, `export type * from`),
  fails with where the original lives, how to import it and how to change it (its schema, for a
  protocol type). Owners are read from the workspace on disk, so a new package, folder or type is
  covered without editing the rule.
- **Params object** (`harness/params-object`): module-level functions with more than one input take one destructured
  `params` object (`f(params: { a; b }) { const { a, b } = params; }`). Class methods and inline
  callbacks are exempt, since their caller fixes the signature; so are test files.
- **Named exports only** (`harness/no-default-export`): no default exports, so imports and renames
  stay greppable.
- **No barrels** (`harness/no-barrel`): no re-exports; import from the defining file. The one
  exception is a `*.types.ts` file re-exporting, by name, types ANOTHER PACKAGE exposes
  (`export type { A, B as C } from '@pkg/…'`): a package's public contract types file can expose
  types it builds on without a second definition, and `harness/single-definition` accepts it
  because the owner is the source. A relative source (`'./a.types.js'`), a `#` subpath import
  and an absolute path are refused even there: a types file listing its siblings' types is a
  barrel by another name. Still rejected there: `export { x } from` (a value), `export *`, `export * as ns` and `export type *`
  (a wildcard hides what is re-exported), and the inline form `export { type A } from` (a value
  re-export statement). A type re-export in any other kind (`*.utils.ts`, `*.helper.ts`,
  `index.ts`) fails too.
- **Env only in apps** (`harness/no-process-env`, `src/` files of packages; tests and apps are
  exempt): no `process.env` or `process.loadEnvFile`. An app reads env and passes `process.env` in.
- **`type`, not `interface`**, and caught errors are named `caughtError`.
- **Fail loudly** (`harness/no-silent-catch`, every workspace plus `.cursor/hooks/` and `scripts/`):
  a `catch` or `.catch()` must use what it caught: rethrow it, check its `code` or class and
  handle only what it expects, or pass it on as `cause`. Turning every error into a default
  (`[]`, `undefined`, a fresh error without the cause) fails.
- **Shared permissions** (`harness/permission-store-root`, backend source): a repo's worktrees
  share one mode and allow list, so every `read`, `setMode`, `allow` or `revoke` on the permission
  store is keyed by an inline `permissionRoot(...)` call, never by a folder's own path. It matches
  stores by name, so a store under another name, `.call` and destructuring are left to review.
- **Typed errors only** (`harness/no-raw-error`): source never builds a plain `Error`; it throws
  a class from its area's errors (each workspace's `src/errors/`, `.cursor/hooks/hooks.errors.mjs`). Tests, fakes and `scripts/` are
  exempt. The classes are listed in [the overview](../../../docs/overview.md#errors).
- **Logging** (source except tests and fakes; the guide is `.agents/skills/sheavly/logging.md`).
  A log call is a call of `debug`, `info`, `warn` or `error` on a receiver named like a logger
  (`logger`, `log`, `logs`, `this.#logger`, `logs.conversation(id)`, `*Logger`); a logger held
  under another name is not seen, and where an error should have been logged is review.
  - `harness/no-log-and-throw`: a `catch` (or the inline function of a `.catch(...)`) that makes a
    log call before a throw. A log after a throw is another path (`if (!(e instanceof Known))
throw e; logger.warn(…)` is fine). A function inside the catch is its own scope.
  - `harness/log-error-as-value`: the `error` field of a log call is the caught value, not
    `error.message`/`.stack`, a template, a `+` concatenation, or `String`, `errorMessage`,
    `redactDiagnosticText` or `printable` of it (called by name or as a member).
  - `harness/log-event-name`: the event (first argument) is a `LOG_EVENT.<NAME>` member, so
    every event is in a catalogue with a meaning. The derived suite
    (`src/__tests__/log-events.test.js`, `src/log-events.utils.js`) reads each workspace's
    `LOG_EVENT` and `LOG_EVENT_MEANING` from its constants files: no duplicate value, a lowercase
    dotted `<area>.<what_happened>`, a meaning of six words or more ending in a full stop, a
    meaning for every event and an event for every meaning, and no event that nothing in its
    workspace uses as `LOG_EVENT.<NAME>`.
  - `harness/no-logger-in-pure-kind`: `*.utils.ts`, `*.validator.ts` and `*.prompt.ts` neither
    import `logger.helper` (`createLogger`) nor make a log call. Building an entry
    (`createLogEntry`) and the types are pure and allowed.
  - `harness/no-failure-output-in-catch`: in an app that depends on `@sheavly/logger` (read from
    its `package.json`), a `catch` does not write `process.stderr` or `console.*`: stderr is one of
    the logger's sinks. Output through a function passed in (`log(text)`) is not seen.
- **Branded ids** (`harness/branded-ids`, in all source except tests and fakes): a zod schema
  property named `id` or `<x>Id`, and an id schema `<x>IdSchema`, is a branded zod schema
  (`z.string().brand<'SessionId'>()`), never a bare `z.string()`, so a session's id can't go where a
  tool call's does. The brand is type-only: the wire and the JSON Schemas stay plain strings.
  The same names typed `string` in a type literal, interface or inline parameter type
  (`agentId: string`) fail too, in all source except tests, fakes and `*.prompt.ts`: type them with
  the branded type (`SessionId`) made by parsing with the schema (`sessionIdSchema`, `callIdSchema`,
  `taskIdSchema`, …). Every workspace is checked. Only type members are checked: a plain function
  parameter, a class field, `id: string[]`, a `type X = string` alias and a name such as `ids` are
  not, and a `*.prompt.ts` renderer's id parameters stay plain strings by design. It cannot tell
  which kind of id a name holds: that is review.
- **Brand casts** (`harness/no-brand-cast`, type-aware, tests included): `as` to a branded type
  fails; a value gets its brand by parsing with its schema (`sessionIdSchema.parse(id)`).
- **Background work starts through a kind factory** (`harness/no-direct-task-start`, type-aware,
  source files): any access to `TaskRegistry.start` (a call, an alias, destructuring, `.call`,
  `.apply`, a string key, `prototype.start`) fails, found by the receiver's type and not by the
  name `start`. Only the `work.utils.ts` that sits beside the `tasks.service.ts` holding
  `TaskRegistry` (the runtime's `startWork`) may; tests and `src/testing` files are exempt through
  the shared config's ignores. A registry typed `any`, cast to another shape, assigned to a
  structural type that re-declares `start` or extended through a mixin is left to review, and so
  is whether reads of the shared registry pass the caller's session.
- **A task kind is not compared by hand** (`harness/no-adhoc-task-kind`, type-aware, source files
  of packages, not apps): a comparison (`===`, `!==`, `==`, `!=`, either side) or a `switch` on a
  value whose type is a union of two or more of `'task'`, `'agent'` and `'service'` fails. It reads
  the type's shape, not its name (`TaskKind` is `z.infer` of a schema), so any such union fails,
  one of a UI's own too; a check for presence (`kind === undefined`) passes. Which kinds are finite
  (held open for, grouped, awaited, waking an idle session) is decided once, by `isFiniteKind`
  (`@sheavly/runtime/tasks/work.utils`), so a new kind joins the finite machine there. Only that
  `work.utils.ts`, beside the `tasks.service.ts` holding `TaskRegistry`, may compare; tests and
  `src/testing` files are exempt through the shared config's ignores, and an app may compare kinds
  to show them apart (counting commands, agents and services is presentation, not policy). A kind
  widened to `string` or `any` first, a lookup (`Set.has`, `includes`, a record indexed by the
  kind), a type of one literal only, a union that mixes in another literal, and a comparison in a
  test are left to review.
- **A notice entry in history** (`harness/no-adhoc-notice-entry`, source files): no
  `{ role: 'notice' }` object written by hand. Whether a notice is kept in history is its kind's
  lifetime in `NOTICE_LIFETIMES` (`@sheavly/protocol/notice/notice.constants`), applied once by
  `publishNotice` (`packages/loop/src/stream-agent/notice-publish.helper.ts`), which sends the event
  and keeps the entry for a persistent kind; a writer that sends no event (restoring a reopened
  conversation's reports) uses `noticeEntries` from the same file. That helper is the one `files:`
  exception, in packages/loop/eslint.config.js. It sees an object literal with a literal role
  (plain, quoted key, `as const` or `satisfies`), so an entry built from a variable role, a
  computed key or a spread is left to review.
- **The latest request** (`harness/no-adhoc-latest-request`, source files): no
  `findLast`/`findLastIndex` looking for the last `user` entry by hand. What a request is in stored
  history is decided once, by `latestRequest`, `latestRequestIndex` and `latestPromptIndex`
  (`@sheavly/core/history/history.utils`): a stored `user` entry, never a notice, which only becomes
  a `user`-role message in what a model is sent. Code that works on a model's input says so with a
  `files:` override and its reason. It sees only this call shape, so a lookup written another way
  (a loop, a reversed copy) is left to review.
- **The main session** (`harness/no-adhoc-main-session`, source files): no `session.depth === 1`
  (or `!==`, `==`, either side). The main session is the one without a parent, defined once by
  `isMainSession` (`@sheavly/protocol/session/session.utils`); how the main run ended is asked of
  `runEnd` (`@sheavly/protocol/status/run-end.utils`). It sees only a comparison of a `.depth`
  member with the literal 1, so a depth copied into a variable first is left to review.
- **Approvals no longer waiting** (`harness/no-adhoc-unknown-approval`, source files): no
  `'unknown_approval'` string (a plain template literal of it too). A UI's answer that finds its approval gone (answered elsewhere, or
  its call interrupted) is a normal end, forgiven once by `answerWhileWaiting`
  (`@sheavly/client/approvals/approvals.helper`), which the terminal's chat and the workbook's
  `CheckApprovals` both use. The code that defines or produces the error code is a `files:`
  override with its reason: the client helper itself, the protocol's error list and the backend's
  error mapping. It matches the literal, so the code read through a variable is left to review.
- **Instruction context** (`harness/no-direct-instruction-context`, source files): no import of
  `instruction-context.helper` (`appendInstructionContext`). An instruction source is an
  `InstructionSource` built with `createInstructionHook`, which resolves the working root each turn
  and owns the dedup; its own file
  (`packages/core/src/instruction-context/instruction-source.helper.ts`) is the one `files:`
  exception, in core's eslint.config.js. It matches the import, so a copy of the helper's text written by hand is left
  to review.
- **Instruction source reads** (`harness/no-raw-fs-in-instruction-source`, source files): a file
  that imports the instruction factory or its types (`instruction-source.helper`/`.types`) does not
  import `node:fs` or `node:fs/promises`. An instruction source's folder can be the agent's choice
  (a working root), so its reads go through `readConfinedFile`
  (`packages/workspace/src/instruction-context/confined-read.helper.ts`): real path inside the boundary, never `.env*`,
  no link swapped after the check. The skills source (`@sheavly/coding`) is the one `files:`
  exception, in the coding extension's eslint.config.js, since it reads folders fixed at build time. `instruction-source-rules.test.js` pins where the rule and
  `harness/no-direct-instruction-context` are on and off. A source that reads through a helper
  that itself uses `node:fs` is not seen: the rule looks at the source file's own imports.
- **Locked changes** (`harness/no-raw-serial-queue`, source files): no `new SerialQueue()`. A store
  that reads a file and writes it back whole changes it through `LockedChange`
  (`packages/storage/src/serial-queue/locked-change.service.ts`): a queue in the process plus a
  lock file across processes, so two processes on one `~/.sheavly` lose no update. The primitive,
  the append-only `AppendLog` and the profile registry's queue are the three `files:` exceptions in
  `packages/storage/eslint.config.js`; `no-raw-serial-queue.test.js` pins where the rule is on and
  off. It sees the construction only, so a queue passed in from elsewhere, or a lock written by
  hand, is left to review.
- **The model fetch** (`harness/no-raw-model-fetch`, source files):
  - **What it rejects:** a `fetch` written in a `createDefaultRegistry({ … })` or
    `new AdapterRegistry({ … })` call must be `createModelFetch()`
    (`packages/providers/src/http/model-fetch.helper.ts`). Passing no deps is fine, since the
    registry uses the model fetch by default.
  - **Why:** Node's global `fetch` sends a TLS ClientHello that spans two TCP segments on Node
    22.20+, 24.5+ and 26, and gateways that read only one (Azure AI Foundry) reset it.
  - **Where it's off:** tests and fakes are exempt by file role, since they pass a fake.
    `no-raw-model-fetch.test.js` pins where it is on and off.
  - **What it sees:** the names as written, called directly or as a member
    (`providers.createDefaultRegistry`), with `fetch` as a plain or quoted key.
  - **What it can't see:** deps held in a variable or spread in, a renamed import of either name,
    a subclass's `super({ fetch })`, or a registry built another way. These are left to review.
    A renamed `createModelFetch` is flagged, so import it by its name.
- **No global fetch in the providers** (`modelFetchConfinement`, the providers workspace's
  source, spread into `packages/providers/eslint.config.js`):
  - **What it rejects:**
    - Node's global `fetch`, called or passed (`fetch(…)`, `const send = fetch`), through
      `no-restricted-globals`.
    - The same through `globalThis`, `global`, `self` or `window`, including
      `globalThis['fetch']` and `const { fetch } = globalThis`, through
      `no-restricted-properties`.
    - The other ways to open a connection: an import of `undici` (its own `fetch` or `request`
      uses its default pool) or of `http`, `https`, `http2`, `tls` or `net`, through
      `no-restricted-imports`.
  - **What it allows:** a local binding named `fetch`, such as `sendRequest`'s parameter or a
    destructured dep, since it isn't the global. A model call goes through the injected
    `deps.fetch`.
  - **Where it's off:** tests and fakes. The model fetch's own file
    (`packages/providers/src/http/model-fetch.helper.ts`) is the one `files:` exception, for the
    imports only.
    `model-fetch-confinement.test.js` pins the rejections, and checks that every providers source
    file resolves the rules with these options, so an override that drops them fails.
  - **What it can't see:** a key held in a variable (`globalThis[name]`), a chained or sequence
    object (`globalThis.globalThis.fetch`, `(0, globalThis).fetch`), or `Reflect.get(globalThis,
'fetch')`.
- **Reading a model reply** (`harness/no-handrolled-reply-reader`, source files): no import of the
  SSE reader (`http/sse.utils`). A protocol gives `readReply`
  (`packages/providers/src/http/reply-reader.helper.ts`) its `parse`, `step` and `finish`, so
  unknown events, a cut-off stream, an abort and the final `done` behave the same in every
  protocol. The shared reader is the one `files:` exception, in `packages/providers/eslint.config.js`;
  `no-handrolled-reply-reader.test.js` pins where the rule is on and off. It sees the import only,
  so a reader that reads the body another way (`response.body.getReader()`) is left to review.
- **Provider policy** (`harness/no-handrolled-provider-policy`, the providers workspace's source,
  enabled in `packages/providers/eslint.config.js`): no `getReader()`, no `'retry-after'` string
  and no `item.source ===` comparison. A body is read by `readReply`, a wait is decided by
  `retry-policy.helper.ts`, and stored reasoning is checked by `ownReplay`
  (`packages/providers/src/http/replay.utils.ts`). `retry-policy.helper.ts` (reads the header) and
  `replay.utils.ts` (compares the source) are the two `files:` exceptions; `no-handrolled-provider-policy.test.js` pins where
  the rule is on and off. It matches these spellings only: a status compared as a number
  (`=== 429`), or a header name held in a variable, is left to review.
- **Command deadlines** (`harness/no-adhoc-command-deadline`, the process package's
  `packages/process/src/process/`, enabled in `packages/process/eslint.config.js`): no `AbortSignal.timeout`, no
  `setTimeout` and no `setInterval`. "Timed out" for a command or a script is `withDeadline`'s
  (`packages/process/src/process/deadline.helper.ts`): the deadline aborted and the caller did
  not. `deadline.helper.ts` is the one `files:` exception; `no-adhoc-command-deadline.test.js`
  pins where the rule is on and off, and the gaps it leaves to review: it matches the plain
  spellings only, so a renamed import (`setTimeout as sleep`), `globalThis.setTimeout`,
  `AbortSignal['timeout']` and a `timeout` option handed to a child process are not caught. It
  covers the process folder only: other command timeouts (the `timeout:` of the checkout and
  worktree helpers) are review too.
- **Ctrl+C** (`harness/no-adhoc-ctrl-c`, the terminal app's source, enabled in
  `apps/terminal/eslint.config.js`): no `.on('SIGINT', …)`, `.once`, `.addListener` or
  `.prependListener`. A press is `interruptOnCtrlC`'s
  (`apps/terminal/src/interrupt/interrupt.helper.ts`): the same-keypress window, one force-quit
  policy that runs the caller's cleanup before the process exits 130, and the `stop` that says what
  the press found. `interrupt.helper.ts` is the one `files:` exception; `no-adhoc-ctrl-c.test.js`
  pins where the rule is on and off. It matches a literal `'SIGINT'` only, so a signal name held in
  a variable, and the screen's raw `ctrl+c` key (which is not a signal), are left to review.
- **Is inside** (`harness/no-dotdot-prefix`, every file): no `relative.startsWith('..')`, which
  also matches a folder named `..x/`. Use `isInside` (`@sheavly/workspace`'s
  `workspace/workspace.utils`), or compare `relative === '..' || relative.startsWith(`..${path.sep}`)`.
- **Keys** (`harness/no-credentials-file` and `harness/no-key-holder-import`, every file,
  tests included): the credentials file holds every model's key, so only `CredentialStore`
  (`@sheavly/storage`) reads it, and only the backend app uses what hands keys out. No other code
  names `credentials.json` (in any case, with either separator, in a string or a template), and
  none imports `@sheavly/storage/credential-store/*` or `@sheavly/storage/profile-registry/*`: an
  open profile of the registry reads and sets keys, so it is the same door. The store refuses a
  file others can read, never puts a key in an error and queues writes; code that opens the file
  itself does none of that.
  The exceptions are `files:` overrides, each in the workspace's `eslint.config.js` with its
  reason: the credential store's own folder may name the file, and the backend app's one module
  that holds keys may import the store (the override goes in with the module that first needs
  it). `workspace-coverage.test.js` reads every source file's resolved config and fails an
  override that turns a rule off outside those places (the credential store's folder for the
  file name, `apps/backend` for the import), and fails one that covers a whole workspace, so
  widening an exception means editing that test, where review sees it.
- **Discovery path** (`harness/no-discovery-path`, source files; tests plant and read the file by
  name and are exempt): no string or template piece containing the runtime-directory environment
  variable's name or the discovery file's name (`process.env.<name>`, `env['<name>']`,
  `path.join(dir, '<file>')`, a template, an object value), whole or inside a longer string, so a
  derived name such as a temp file also fails. Where the server holds its lock and publishes its
  discovery file is resolved once: `serverRuntimeDirectory`
  (`@sheavly/storage/server-runtime/server-runtime.helper`) is the only reader of the variable,
  `@sheavly/storage/discovery-file/*` the only code that names the file, and `DISCOVERY_FILE_NAME`
  (`@sheavly/protocol/discovery/discovery.constants`) holds the name. A second resolver finds
  another folder and talks to no server, or the wrong one. The exceptions are `files:` overrides
  in `packages/storage/eslint.config.js` (`src/server-runtime/**`, `src/discovery-file/**`, and the
  finder's fakes, `src/server-finder/testing/**`) and
  `packages/protocol/eslint.config.js` (`src/discovery/**`); `workspace-coverage.test.js` fails an
  override that turns the rule off anywhere else, and `no-discovery-path.test.js` pins where it is
  on and off. It cannot see a name split across pieces or held in a variable.
- **Through the finder** (`harness/server-through-finder`, source files; tests and fakes plant
  and read the file on purpose and are exempt): every workspace but the server
  (`SERVER_WORKSPACES` in `src/server-modules.js`, today the backend, which writes the file and
  holds the lock) and storage itself reaches the running server only through `findRunningServer`
  (`server-finder/`) with `verifyServer`, which reads the file through the safe reader, asks the
  lock and hands on the token only after the server proved it holds it. So its source may not
  import `@sheavly/storage/discovery-file/*`, `server-lock/*` or `server-runtime/*`
  (`SERVER_INTERNAL_MODULES`, the list `connectBackendConfinement` reads too): statically, as a
  re-export, or dynamically with a specifier that starts with one of those paths (a string, a
  template whose first piece does, or a `+` chain that starts with one); a type-only import is
  allowed. And it calls `findRunningServer`, imported statically (by name, renamed, by a string
  name or through `* as`), only directly, plain or optional, with exactly one
  `verify: verifyServer` (imported from `@sheavly/client/client/verify.helper`) written in the
  call's object. Another function, a wrapper, a local `verifyServer`, a spread, a computed key, a
  second `verify` or options built elsewhere are refused, and so is the finder anywhere but
  called: stored, passed on, re-exported (`export { findRunningServer } from`, `export *`),
  called through `.call`, `.apply` or `.bind`, reached through a computed key of its namespace,
  or imported with `import()`. A type of it (`typeof findRunningServer`) is allowed.
  `server-through-finder.test.js` covers each form, a front end with storage only, the server,
  storage, and tests; `workspace-coverage.test.js` fails a `files:` override that turns it off. It cannot see `createRequire(…)(…)` or a specifier whose start is
  computed ([#456](https://github.com/Sheavly/harness/issues/456)), and the terminal's
  `connectBackend` folder is held to more, the finder included, by the block below.
- **The terminal's own backend** (`connectBackendConfinement`, a config block the terminal app
  spreads into its config, not a `harness/*` rule: it is `no-restricted-imports` and a
  `no-restricted-syntax` selector for `import('…')`, each with a message, as `replayConfinement`
  is): the files of `apps/terminal/src/client/` (tests and fakes excepted),
  which hold `connectBackend`, may not import `@sheavly/storage/discovery-file/*`,
  `@sheavly/storage/server-lock/*`, `@sheavly/storage/server-runtime/*` or
  `@sheavly/storage/server-finder/*`. A development terminal starts a backend of its own and must
  never attach to a stable server, so the code that starts it cannot read where one is published,
  take its lock or use the finder that reads and verifies it. The restriction is narrow: the
  `sheavly` command finds a server elsewhere. `connect-backend-confinement.test.js` lints the real terminal
  config and pins that the import, static or a dynamic `import('…')` of a string literal or of a
  template literal without expressions, is reported in `apps/terminal/src/client/backend.helper.ts`
  and not in other terminal files. It does not see `createRequire`, a raw `net.connect` to the
  socket path, a path held in a variable, a template literal with expressions, a relative path
  through `node_modules`, or a file outside the folder that `src/client/` code is made to call;
  those stay with review.
- **The launcher's systemd programs** (`systemdConfinement`, two config blocks the `sheavly`
  app spreads into its config, not a `harness/*` rule: `no-restricted-imports` and
  `no-restricted-syntax` selectors for `import('…')`, with a message each): `sheavly service` runs
  `systemctl`, `loginctl` and `journalctl` only through `SystemTools`, by name with an argument
  array, in `apps/sheavly/src/service/system.helper.ts`. So the files of `src/service/` (tests
  and fakes included) may not import `node:child_process`, and no file of the app but
  `apps/sheavly/src/cli.ts`
  may import `system.helper`, which makes the real tools: a command takes `SystemTools` as a
  dependency and a test passes the fake, so a test cannot get the real tools by importing them.
  It is not a guarantee that no test runs `systemctl`: a process test that starts the real command
  line still reaches the real systemd for a service action that gets as far as asking it (today
  `service.processes.test.ts` runs only refusals, before systemd is asked, and that stays with
  review), and a test outside `src/service/` may start a program of its own. The two blocks do not overlap, because a
  rule set twice for one file keeps only the later options, and the process rule stops at
  `src/service/`: other launcher code (a test that starts the command line itself) may start a
  process. `systemd-confinement.test.js` lints the real launcher config and pins both imports,
  static or a dynamic `import('…')` of a string literal or of a template literal without
  expressions, in the service folder, in the rest of the app and in `cli.ts` and the wrapper. It
  does not see `createRequire`, `process.getBuiltinModule`, a specifier in a variable or a
  template literal with expressions, `node:worker_threads`, `@sheavly/process`, `child_process`
  reached through another module, a file outside the globs (`.mts`, `.cts`, `.jsx`), or a program
  started by the shell tool of the harness itself; those stay with review.
- **The launcher's connection command** (`connectionConfinement`, one config block the `sheavly`
  app spreads after `systemdConfinement`, not a `harness/*` rule: `no-restricted-imports`,
  `no-restricted-globals` and `no-restricted-properties`, with a message each):
  `sheavly connection` prints the token of a server it did not start, so the files of
  `apps/sheavly/src/connection/` (tests and fakes excepted) may not import the backend or the
  terminal (it starts no server and no chat), the client, `undici` or a network or process
  built-in (it contacts no server itself: the finder and the handshake are in the lookup that
  `cli.ts` passes in), use the globals `fetch`, `WebSocket`, `XMLHttpRequest` or `EventSource`,
  or write with `console`, `process.stdout` or `process.stderr` (it writes only through the
  `streams` it is given), and may not import `process`, `console`, `module`, `vm`,
  `inspector` or `@sheavly/process`, nor call `process.getBuiltinModule`, which would write or
  load around those. The block repeats the real-tools restriction of `systemdConfinement`
  for its folder, because a rule set twice for one file keeps only the later options; the other
  rule that block sets, a dynamic `import('…')` of the real tools, still applies there.
  `connection-confinement.test.js` lints the real launcher config and pins each of these in that
  folder, in its tests, and in the rest of the app, where they stay allowed. It does not see
  `createRequire`, a dynamic `import('…')` of anything but the real tools, `globalThis.fetch`,
  `node:fs` writing to descriptor 1, a stream's `err` being given the token, or the token being
  put in a thrown message: that the token goes only to `streams.out` in one line, and into no
  message, is held by `connection.processes.test.ts` and review, and the lint covers only the
  slice of it that is `console`, `process` and the streams. Nor does it pin that `cli.ts` passes
  the right lookup (`findVerifiedServer`); the process tests, which run the real command, do.
- **The launcher's server start** (`serverStartConfinement`, three config blocks the `sheavly` app
  spreads after `systemdConfinement` and before `connectionConfinement`, not a `harness/*` rule:
  `no-restricted-imports` and `no-restricted-syntax` with a message): `sheavly setup` may run on a
  short-lived server of its own when none is running, started by `startEmbeddedServer` of
  `@sheavly/backend/run-server/embedded-server.helper` (an entry `LAUNCHER_ENTRIES` lists). Only
  `apps/sheavly/src/cli.ts` imports that module and hands it to `setup`: `chat`, `connection`,
  `doctor`, `service` and every other file of the app (tests and fakes excepted, which may start a
  real one on purpose) are refused an import, a re-export or a dynamic `import('…')` of it, written
  as a string literal or a template literal without expressions. `runServer`, which `serve` uses,
  stays importable as before: this confines the embedded server, not every way to start one. The
  blocks mirror the systemd ones (the service folder, the rest of the app, and the wrapper
  `apps/sheavly/src/service/system.helper.ts`, which the systemd blocks leave alone because it
  starts the real programs), and repeat what those refuse (a process in the service folder, the real systemd tools
  everywhere, and the dynamic imports of both), for both rules, because a rule set twice for one
  file keeps only the later options. `connectionConfinement` comes after them, so its own, stricter
  list wins in its folder. `server-start-confinement.test.js` lints the real launcher config and
  pins the refusal in each command, in the service folder and in the wrapper, the exceptions, and
  what the systemd blocks refused before. It does not see `createRequire` or a specifier held in a
  variable, which stay with review.
- **File writes** (`harness/no-direct-file-writes`, source files; tests and fakes write fixtures
  into temp folders and are exempt): no import of a function that creates, changes, moves or
  deletes a file or folder from `node:fs` or `node:fs/promises` (`writeFile`, `appendFile`,
  `rename`, `rm`, `mkdir`, `cp`, `createWriteStream`, `chmod`, `open`, and the rest, sync forms
  included), and no whole-module import (`import fs`, `import * as fs`, `import('node:fs')`) that
  would hide which are used: read functions are imported by name. The user's data is written
  through `@sheavly/storage` (`writeJsonFile`, `appendJsonLine`, `DocumentFile`, a store): atomic
  and private, retried on Windows, one change at a time, and the path checked. A hand-rolled copy
  of that is how the trust store ended up with a temp name two writes could share. The exceptions
  are `files:` overrides in the workspace's `eslint.config.js`, each with its reason: the storage
  primitives themselves, the agent's file helper (`file-effects.helper.ts`: `Workspace` confines
  every path it touches), the backend's model-call debug log, and the terminal's developer tooling
  (the workbook and the demo's SSE log). `workspace-coverage.test.js` lists those files and fails
  an override for any other, or for a whole workspace.

- **Guarded change paths** (`harness/guard-env-write`, every coding source file except tests and
  the resolver helper): `resolveWritable` and `resolveDeletable`
  (`@sheavly/coding/files/files.helper`) are the only way to resolve a path for a write or a
  delete, because they refuse `.env` files and `.git` on the requested path and again on the real
  one a symlink resolves to. The effects that change a file (`writeText`, `createParentFolder`,
  `removeFile`) take the path their own resolver returned: `resolveWritable` for a write,
  `resolveDeletable` for a delete, since `resolveWritable` follows a symlink and would remove its
  target. The rule has accept and reject cases in
  `packages/eslint-config/src/__tests__/guard-env-write.test.js`.

- **No terminal I/O** (`harness/no-terminal-io`, `src/` files of packages; tests and apps are
  exempt, an app being read from where the workspace is): no `node:readline` or `node:tty` import
  (static or dynamic) and no `process.stdin`, `stdout` or `stderr`, as a member
  (`process.stdout`), a named import (`import { stdout } from 'node:process'`) or a destructuring
  (`const { stdout } = process`). It cannot see `globalThis.process.stdout`, `process['stdout']` or
  `const p = process; p.stdout`; review carries those. The harness emits typed events and a UI
  renders them; a package that formats output takes a write function from its app. A child
  process's own `stdout` is data and passes.
- **One clock** (`harness/no-direct-clock`, every file, tests included): no `Date.now()`,
  `new Date()`, `Date.UTC`/`Date.parse`, `toISOString`-style calls or `z.iso.*`. The current time is
  `now()` (`@sheavly/core/clock/clock.helper`), dates are Luxon's, and a time is epoch
  milliseconds (`timestampSchema`) everywhere it is stored or sent. To time a duration use
  `performance.now()`.
- **No handwritten notice** (`harness/no-handwritten-notice`, every file except tests, which
  assert on the envelope text): a string or template
  piece holding `harness-notice`, `<harness` or `</harness` fails, because the envelope is written
  only by `formatHarnessNotice` (`@sheavly/core/notice/notice.utils`), which frames the text as
  harness data and escapes what is inserted. It cannot see a tag split inside a word or built from
  a variable, so the formatter's escaping and its tests carry the rest.
- **Chat state** (`harness/no-adhoc-chat-state`, `.cursor/hooks` except `chat-state.utils.mjs` and
  the tests, enabled in the root `eslint.config.js`): a string or template piece holding
  `SHEAVLY_HOOK_STATE_DIR` or `sheavly-harness`, whole or inside a longer path, or the first name as
  an identifier, fails, because the hooks' per-chat state is located, validated, locked and
  expired in `chat-state.utils.mjs` alone. It cannot see a name split across pieces or a variable,
  and it does not check that a hook uses `changeChatState` for a read-modify-write of one field or
  that it asks `isTestOrFake` rather than writing its own test-path regex: those are review.
- **File-tool guards** (coding source; each is checked structurally, and what it cannot see is
  left to review and the tests named in its file header):
  - `harness/guard-env-read`: a `resolveRead(requested)` call has `assertNotEnvFile` on the
    requested path before it and on the path it returns after it, as statements of their own in the
    same function, since a symlink can point at a `.env` file.
  - `harness/guard-file-tool-resolve` (coding `*.tool.ts` files): a tool never touches the
    workspace's `resolveRead`, `resolveWrite` or `resolveDelete` (a call, an alias, `.call`, a
    destructured property, an import or a re-export of one); it asks the guard in
    `extensions/coding/src/files/files.helper.ts` (`resolveReadable`, `resolveWritable`, `resolveDeletable`) or
    `resolveSearchRoot`. A tool file that calls one of those guards must also call `runFileTool`
    (`extensions/coding/src/files/file-tool.helper.ts`), the shared abort and error mapping; it
    cannot see that the call wraps the right body. It cannot see a computed key that is not a literal or a resolver reached
    through a helper that is not the guard; `harness/guard-working-root` and review carry those.
  - `harness/guard-search-root`: a `runRipgrep` call has `resolveSearchRoot` earlier in the same
    function, as a statement of its own, because ripgrep applies its `.env` and `.git` excludes to
    what it walks and never to a root path it is given.
  - `harness/guard-working-root`: a `resolveRead`, `resolveWrite` or `resolveDelete` call takes a
    path that went through `anchorToRoot`, so a relative path starts from the working root; it also
    rejects `cwd: workspace.root` and a literal `root: undefined`. It cannot see
    `this.workspace.root`, a `cwd` copied into a variable first, a spread or `root: void 0`; the
    list of what review and tests carry is in the rule's file header, and the design is in
    `extensions/coding/docs/file-tools.md`.

## Prompt extraction

Authored model instructions/templates, tool descriptions and parameter guidance belong in an
adjacent `*.prompt.ts`, not a constants file or an execution/schema file. A prompt file is
TypeScript-only and capped at 300 lines of code. It exports named related strings, fragments,
structured prompt data (for example description/parameter-guidance tables or model sections),
and pure typed rendering functions. Keep local rendering helpers there too. Import types with
`import type`; pure utilities, other prompts and configuration constants are allowed. Numeric
limits may be interpolated into text from constants imports; unrelated numeric/business values,
exported types, classes and schemas do not belong in prompt files. Execution, validation, state,
environment access, I/O and model calls remain outside.

Existing public constants may use a direct `const` alias of a named adjacent prompt import when
TypeScript proves the imported value is a single string literal. `harness/kind-contents` rejects
renderer/function aliases, general strings, non-text data, nonadjacent imports and aliases without
type information; `src/__tests__/prompt-alias.test.js` covers these paths. The authored text stays
in the internal prompt module, and the compatibility export can preserve its literal type.

`harness/prompt-location` checks text at recognized model-facing boundaries, not English keywords
or variables named “prompt”:

- the imported `defineTool` binding's description and reachable input-schema `.describe` guidance,
  including the shared tool-schema `withDescription` producer;
- instruction/base-instruction and message options passed to imported harness/agent/composition
  APIs, including `appendInstructionContext`;
- typed model request options and `Provider.stream`, typed message/history content for authored
  system/user messages, hook `addContext`/`addInstructions` and conversation `send`/`followup`;
- typed `ModelSection` titles and guidance, not arbitrary UI titles or `RuleSection` metadata;
- an extension's system-prompt sections: the `text` of each `InstructionContribution` (the
  `instructions` of a `Contributions` return, an array literal of object literals, written inline
  or built in a variable first, or any object literal typed `InstructionContribution`) and its
  `baseInstructions`. A string or template literal, a `*.constants.ts` value or a helper's literal
  result is reported; a value imported from an adjacent `*.prompt.ts` (`text: CODING_INSTRUCTIONS`)
  passes. An unrelated `{ name, text }` is not a section and is not reported
  (`src/__tests__/prompt-location-sections.test.js`, which also lints the real extensions).

Local/import aliases, workspace package/relative imports, static object properties/destructuring,
concatenation, templates, arrays/join, static map projections and ordinary return builders are
traced. Text from a `*.prompt.ts` import is extracted; caller parameters and unresolved runtime
values remain legal. Role tags, tool names, section ids and other routing metadata are not prose
sinks. Human UI/errors/status, unrelated human schema descriptions, tests/fakes (including
metadata-marked test-only workspaces) and stored Markdown prompts are exempt.

Import tracing reads only supported JavaScript/TypeScript sources inside the discovered lint root,
with metadata and source ancestry checked before reads. Symlinked source files/ancestors and escaped
source paths fail closed; unknown data-file imports stay opaque rather than being read or parsed.
Discovery does not scan unrelated type-file contents. `src/__tests__/prompt-source-confinement.test.js`
checks allowed relative/workspace imports and rejection paths with filesystem read spies. These are
lint-analysis boundaries, not changes to agent command grants or workspace/worktree access.

**Limits:** this is bounded static tracing, not a whole-program or natural-language analyzer. It
follows initializers and ordinary return expressions, not later mutation, arbitrary computed
property names, object-rest/nested parameter bindings, callback scheduling, runtime registries,
reflection, external package bodies or all branch/loop execution. Unsupported parameter bindings
remain opaque rather than crashing lint. Typed boundaries need TypeScript services and recognizable defining
contracts; untyped lookalike `send`/`stream`/hook methods are intentionally not matched. A renderer
whose output never reaches a supported sink cannot be identified just by its name. Fully dynamic
user/caller data cannot be classified as authored instructions. For instruction sections that
leaves review-only: sections produced by `.map`, spread elements (`...more`) in the array, `text`
built at runtime and a dynamically imported module. The rule also does not flag these, which are
review-only too: `Object.assign({ name }, { text: '...' })`, a section array held in a class field,
`c.baseInstructions = '...'` assigned onto a `Contributions` variable and
`{ name, get text() { return '...' } }`. Review must cover those paths;
do not suppress violations with inline disables or a baseline.

## System prompt review

`harness/system-prompt-review` checks an explained review record beside the generic
`BASE_AGENT_INSTRUCTIONS` declaration in `packages/host/src/instructions/instructions.prompt.ts`.
It compares two SHA-256 hashes: the current base prompt source inside its backticks and a
deterministic inventory of production `*.prompt.ts`, `*.tool.ts` and their sibling `*.constants.ts`
files. The base is excluded from that inventory so its review comment cannot create a circular
hash. Workspaces come from npm metadata, not a package-name list; test-only and tooling workspaces,
tests and fakes are excluded. Workspace patterns and metadata ancestry are checked before reads;
unsafe paths and symlinked manifests fail with path-only diagnostics, not JSON contents. Each lint
root is independent. These inventory checks do not change agent command grants or workspace/worktree
access permissions.
The full watched source is a conservative signal: implementation and formatting edits can require
review even when they do not change model-facing behaviour.

The record is one JSON block comment marked `@system-prompt-review`, with `version: 1`, `sourcesHash`,
`promptHash`, `decision` (`prompt-updated` or `prompt-unchanged`) and a nonempty `reason`. The rule
rejects missing, malformed, duplicate and stale records. It reads the prompt from ESLint's current
source, so an unsaved prompt edit also invalidates the record. It has no autofix: matching hashes
without an explicit decision and explanation are not an accepted review record.

When the rule reports drift:

1. Compare the watched changes with the base policy and tool descriptions. Keep tool parameters,
   limits and mechanics in their descriptions; update the system prompt only for cross-tool policy.
2. Update the prompt if needed. Otherwise choose `prompt-unchanged` and explain why the existing
   policy still applies.
3. Run `npm run lint:prompt` to obtain the current hashes, then update the record with those hashes,
   the decision and its explanation. Run the command again to verify it matches.
4. Run the affected regression checks and relevant stored-prompt evaluation. Hashes verify source
   correspondence, not that the explanation is sound or the model follows the policy.

The dedicated anchor check runs without caching in both `npm run check` and
`npm run check:affected`, outside workspace filtering. The stop hook invokes it independently for
changed prompts, tools, constants, package metadata and review tooling; its error cannot be scoped away
just because it names the host prompt rather than the changed tool. Acceptance/rejection tests
live in `src/__tests__/system-prompt-review.test.js`; gate wiring is checked in
`../../../scripts/__tests__/gate.test.mjs` and stop behaviour in
`../../../.cursor/hooks/__tests__/prompt-review.utils.test.mjs`.

**Limits:** this does not fetch or track changes to an upstream Cursor prompt, prove semantic
freshness, or inspect the complete dependency graph. Imported helpers and schemas outside the
watched files, provider transformations and runtime configuration can change behaviour without
invalidating this inventory. Saved prompt/tool sources are read from disk; only the base prompt
uses the current lint buffer. Reviewers still assess these changes and the explanation. The record is a reviewed
source snapshot, not a violation-suppression baseline: every detected drift fails.

## Service grants need a proof test

Not an ESLint rule: a test over the repo (`src/__tests__/service-grants-tests.test.js`, logic in
`src/service-grants-tests.utils.js`), run with the package's tests. The host verifies that the
grants an extension's `sheavly.json` declares for a service it provides (`services.grants`) exist,
but only the provider's own methods check them. So every `extensions/*` workspace whose manifest
declares a non-empty `services.grants` must have a `src/**/__tests__/*.test.ts` that imports
`assertServiceEnforcesGrants` from the testing kit and calls it. A named import (an alias counts),
a namespace import (`import * as kit` and `kit.assertServiceEnforcesGrants(`) and several imports
of the specifier in one file all count; a comment, an import with no call, a type-only import, a
re-export and a function of that name from another module do not. The check reads text with
regular expressions, not syntax. The import specifier
is not listed: it is the name of the workspace that holds a `service-grants.fake.ts` under its
`src/testing/` behind a `./testing/*` export, plus that subpath. When more than one workspace holds
that file the specifier is ambiguous, so the check reports one problem naming them instead of
picking the first. Extensions without service grants are asked for nothing.
The tests accept the real tree and reject synthetic workspaces with no test, with an import never
called, a call from another module and two holders of the helper.

**Limits:** it proves only that a call expression to the helper exists in a test file of the
workspace. It does not prove:

- that the call runs: a call under `describe.skip`/`it.skip`/`it.todo`, in dead code (`if (false)`)
  or in a function nothing calls still counts, and so does text in a string or template literal,
  an object method of the same file with the helper's name (`{ assertServiceEnforcesGrants() {} }`)
  and a `typeof assertServiceEnforcesGrants<...>` instantiation with no call;
- that it targets the real provider rather than a stub;
- that `calls` cover every method of the service (the helper proves each listed call refuses
  without its grant, and fails a list that omits a declared grant);
- that it is per provider or per service: it is per workspace, so one call satisfies a workspace
  that provides several services;
- that the provider does not special-case the probe consumer the helper uses.

All of these are review-only. A helper re-exported from another module and called there is not
recognised (the check wants the import of the specifier in the file that calls it), and neither is
a call through a bracketed member name of the namespace import. It is not
wired into `npm run layout`, so it runs where the package's tests run.

## The rest of the config

`eslint.config.js` is strict and type-aware (typescript-eslint `strictTypeChecked`), with
readability rules: cognitive complexity, max depth/nesting, early returns, no nested ternaries, blank
lines between steps (auto-fixed with `npm run lint:fix`).

- **Tests live in `__tests__/`** next to the code they test (`extensions/coding/src/read-file/__tests__/read-file.tool.test.ts`).
  ESLint rejects a `*.test.ts` anywhere else, and Vitest only runs `src/**/__tests__/**/*.test.ts`.
- **No inline escape hatches.** `eslint-disable` comments are rejected
  (`noInlineConfig`). An exception goes in a `files:` override in the config, with a reason.
- **No baseline.** The codebase is lint-clean, and a new rule lands with its violations fixed.
  Never suppress new code.
