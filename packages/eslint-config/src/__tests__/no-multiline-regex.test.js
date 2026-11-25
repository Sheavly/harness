import path from 'node:path';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';
import { baseConfig } from '../base.js';
import { harnessPlugin } from '../plugin.js';
import { typescriptRuleTester } from '../testing/rule-tester.fake.js';

// A multiline regex breaks lines at U+2028 and U+2029 too, which JSON leaves unescaped inside a
// string: `.` and `$` stop there and `^` matches after it. A line starts where nothing but `\r` or
// `\n` comes before, and ends before one.
const ruleTester = typescriptRuleTester({ sourceType: 'module', ecmaVersion: 'latest' });

const reports = (code) => ({ code, errors: [{ messageId: 'm0' }] });

ruleTester.run('no-multiline-regex', harnessPlugin.rules['no-multiline-regex'], {
  valid: [
    // A line found without the flag: its start after a break, its end before the next.
    'const url = /(?:^|[\\r\\n])URL: (\\S+)/.exec(body)?.[1];',
    'const line = /(?:^|[\\r\\n])(Full output: [^\\r\\n]*)/.exec(content)?.[1];',
    'const zero = /(?<![^\\r\\n])label: ([^\\r\\n]*)(?![^\\r\\n])/.exec(body)?.[1];',
    // A modifier that turns `m` off, or sets another flag, is not the hazard.
    'const off = /(?-m:^a)/;',
    'const other = /(?i:^a)/;',
    // Every other flag is fine, `s` and `y` and `u` included.
    'const all = text.replaceAll(/x/gi, "y");',
    'const dot = /a.b/s;',
    'const sticky = /a/uy;',
    // The letter in the pattern, a string or a name is not the flag.
    'const word = /multiline/g;',
    "const flag = 'm';",
    "const re = new RegExp('m', 'g');",
    // `RegExp` with a pattern only, or flags without `m`.
    "const plain = new RegExp('^a');",
    "const dynamic = RegExp(`^${name}`, 'gi');",
    'const ticks = new RegExp(pattern, `gi`);',
    "const member = globalThis.RegExp('^a', 'g');",
    // Another function named like the flag argument is not a regex.
    "const other = make('^a', 'm');",
    // Known limit, stated in the rule: flags held in a variable are not seen.
    "const flags = 'm'; const held = new RegExp('^a', flags);",
  ],
  invalid: [
    reports('const found = /^a$/m.test(text);'),
    reports('const url = /^URL: (\\S+)/m.exec(body)?.[1];'),
    reports('const all = text.replaceAll(/^#/gm, "x");'),
    reports('const mixed = text.split(/^## /im);'),
    reports("const made = new RegExp('^a', 'm');"),
    reports("const called = RegExp('^a', 'gm');"),
    reports("const spread = new RegExp(`^${name}`, 'my');"),
    // Flags written as a template literal, and the constructor reached as a member.
    reports('const ticks = new RegExp(pattern, `gm`);'),
    reports("const member = globalThis.RegExp('^a', 'm');"),
    reports("const window = new window.RegExp('^a', 'gm');"),
    // The modifier that turns the flag on for part of a pattern.
    reports('const scoped = /(?m:^a)/;'),
    reports('const mixed = /(?im-s:^a$)/;'),
    // Two in one expression are two findings.
    {
      code: 'const both = [/^a/m, /b$/m];',
      errors: [{ messageId: 'm0' }, { messageId: 'm0' }],
    },
  ],
});

// The rule as ESLint applies it: a later block in base.js could otherwise switch it off for
// source, or on for tests, and the RuleTester above would not notice.
const configOf = (workspace) =>
  new ESLint({
    cwd: import.meta.dirname,
    overrideConfigFile: true,
    overrideConfig: baseConfig({
      tsconfigRootDir: path.resolve(import.meta.dirname, '../../../..', workspace),
    }),
  });
const eslintFor = {
  package: configOf('packages/eslint-config'),
  app: configOf('apps/terminal'),
};

/** Whether `file`, a path under this test's folder as the config sees it, is linted by the rule. */
async function isOn(params) {
  const { eslint, file } = params;
  const config = await eslint.calculateConfigForFile(path.resolve(import.meta.dirname, file));
  const [severity] = config.rules['harness/no-multiline-regex'] ?? [0];

  return severity !== 0;
}

describe('no-multiline-regex: where it applies', () => {
  it('is on for the source of a package, a component too', async () => {
    expect(await isOn({ eslint: eslintFor.package, file: 'src/x/x.utils.ts' })).toBe(true);
    expect(await isOn({ eslint: eslintFor.package, file: 'src/x/x.component.tsx' })).toBe(true);
  });

  it('is on for the source of an app', async () => {
    expect(await isOn({ eslint: eslintFor.app, file: 'src/x/x.helper.ts' })).toBe(true);
  });

  it('is off for tests and fakes, which read their own output', async () => {
    expect(await isOn({ eslint: eslintFor.package, file: 'src/x/__tests__/x.test.ts' })).toBe(
      false,
    );
    expect(await isOn({ eslint: eslintFor.package, file: 'src/testing/x.fake.ts' })).toBe(false);
  });
});
