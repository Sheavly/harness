---
name: sheavly
description: Router for working in the Sheavly harness (TypeScript, Node 24 ESM monorepo): which guide to read for layers and where code goes, file kinds, extending the harness (tools, hooks, providers, events, routes), tests, the quality gate, debugging a run or a stored conversation, and the state machines of each system. Use when editing any code, docs or tooling in this repo, adding a tool, hook, provider, route or loop event, writing tests, debugging, or when a hook or lint message points at a guide.
---

# Sheavly

The harness is a small generic core with coding as a preset on top, and every front end an app.
Read the guide for what you are touching; each one holds the ownership, the canonical API, the
invariants, the extension steps and what lint enforces. Branches, commits and PRs are the `git`
skill; which workspace holds what is the `sheavly-packages` skill.

## Always keep #102 in mind

The harness must be extendable the way VS Code is: contributions add to the loop and never own
it; names are namespaced and a collision fails; content without code needs no trust, code from a
repo stays behind workspace trust; the framework imposes no category on an extension. `coding`
is one extension among others: it reads the run through the same scoped services and grants as a
third party, and no extension may take a registry. So:

- **Extend, don't modify.** A new behaviour is a new tool, hook, adapter, work kind or
  contribution through the system's canonical path. Editing a core module (the loop's turn, the
  hook runner, the registries) to special-case one caller is the mistake, not the shortcut.
- **One system per concept.** Before adding a mechanism, find the existing one for that concept
  (background work, status, notices, hooks, instruction context) and use it. Two parallel
  versions of one concept is how a sub-agent and a background command diverged.
- **Behaviour stays.** A change that restructures code changes no behaviour. A change to behaviour
  is its own change, says so, and updates the guide and the tests that state it.

## Which guide

| You are…                                                                           | Read                                                               |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| deciding where code goes, adding an import, or touching what a UI may do           | [layers.md](layers.md)                                             |
| creating or naming files, a prompt, a schema, a type or a constant                 | [file-kinds.md](file-kinds.md)                                     |
| adding a tool, sub-agent, provider, loop event, route, hook or project hook        | [extending.md](extending.md)                                       |
| writing an extension, its dependencies or contributions, or touching `extensions/` | [extensions.md](extensions.md)                                     |
| writing style, errors, time, validation, naming, or deciding what a rule should do | [principles.md](principles.md)                                     |
| adding a workspace, or changing a package's README, docs or `exports`              | [packages.md](packages.md)                                         |
| writing or fixing tests and fakes                                                  | [tests.md](tests.md)                                               |
| a lint, hook, format, knip or jscpd failure; the stop gate; a hook or script       | [quality-gate.md](quality-gate.md)                                 |
| a run, a stored conversation, a backend or a workbook run that misbehaves          | [debugging.md](debugging.md)                                       |
| logging a failure, an event name or field, a sink, or reading a conversation's log | [logging.md](logging.md)                                           |
| a lifecycle, a status, a queue, an approval, or anything that "ends"               | [state-machines.md](state-machines.md)                             |
| starting, owning, reading or ending background work (a command, a sub-agent)       | [sessions-and-background-work.md](sessions-and-background-work.md) |

A lint message that names a guide is routed here by this skill's `harness.json`: `lintRules` lists
the rules a skill explains, `ruleFiles` the guide for each, `guides` the files a guide covers. The
hook names the skill and then each guide once per chat. A new guide is one file beside this one
plus its entries in `harness.json`; the layout check fails a guide nothing leads to.

## Always

- Finish a change only when `npm run check` passes ([quality-gate.md](quality-gate.md)).
- No `eslint-disable`, no `jscpd:ignore`, no hand-edited `package.json`, no mock data in code.
- Say in the PR what each check enforces and what stays review-only (`git` skill, harness impact).
- If the code and a guide disagree, fix the guide in the same change; never leave both.
