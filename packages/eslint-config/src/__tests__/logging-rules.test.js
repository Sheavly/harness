import { harnessPlugin } from '../plugin.js';
import { typescriptRuleTester } from '../testing/rule-tester.fake.js';

// The logging conventions: an error is logged where it ends, once, as the value, under an event
// of the module's catalogue, never from a pure file, and never as stderr output in an app.
const ruleTester = typescriptRuleTester();

ruleTester.run('no-log-and-throw', harnessPlugin.rules['no-log-and-throw'], {
  valid: [
    // Logged where it ends: nothing above rethrows.
    'try { run(); } catch (caughtError) { logger.error(LOG_EVENT.RUN_FAILED, { error: caughtError }); }',
    // Rethrown with its cause, and not logged here.
    "try { run(); } catch (caughtError) { throw new StoreError({ message: 'x', cause: caughtError }); }",
    // Logged and handled with a default: no throw.
    'try { run(); } catch (caughtError) { logger.warn(LOG_EVENT.RETRIED, { error: caughtError }); return undefined; }',
    // A callback that throws later is its own scope, not the catch.
    'try { run(); } catch (caughtError) { logger.error(LOG_EVENT.RUN_FAILED, { error: caughtError }); schedule(() => { throw failure; }); }',
    // A throw in the try, a log in the catch.
    'try { throw failure; } catch (caughtError) { logs.server.error(LOG_EVENT.RUN_FAILED, { error: caughtError }); }',
    // Not a logger: another object's `error` method.
    'try { run(); } catch (caughtError) { reporter.error(caughtError); throw caughtError; }',
    'p.catch((caughtError) => { logger.error(LOG_EVENT.RUN_FAILED, { error: caughtError }); });',
    // Logged and returned in one branch, rethrown in the other: never both.
    'try { run(); } catch (caughtError) { if (caughtError instanceof Known) { logger.warn(LOG_EVENT.KNOWN, { error: caughtError }); return fallback; } throw caughtError; }',
    // The unexpected is rethrown, the expected is logged: the two never happen together.
    'try { run(); } catch (caughtError) { if (!(caughtError instanceof Known)) throw caughtError; logger.warn(LOG_EVENT.KNOWN, { error: caughtError }); }',
    "try { run(); } catch (caughtError) { if (caughtError.code !== 'ENOENT') { throw caughtError; } logger.info(LOG_EVENT.MISSING); }",
  ],
  invalid: [
    'try { run(); } catch (caughtError) { logger.error(LOG_EVENT.RUN_FAILED, { error: caughtError }); throw caughtError; }',
    "try { run(); } catch (caughtError) { logger.warn(LOG_EVENT.RUN_FAILED, { error: caughtError }); throw new StoreError({ message: 'x', cause: caughtError }); }",
    // A log first, then a throw that only sometimes happens: both can happen.
    'try { run(); } catch (caughtError) { logger.error(LOG_EVENT.RUN_FAILED, { error: caughtError }); if (fatal) throw caughtError; }',
    'try { run(); } catch (caughtError) { this.#logger.error(LOG_EVENT.RUN_FAILED, { error: caughtError }); throw caughtError; }',
    // A log in a nested block of the catch still belongs to it.
    'try { run(); } catch (caughtError) { if (loud) { logger.error(LOG_EVENT.RUN_FAILED, { error: caughtError }); } throw caughtError; }',
    // The inline handler of a promise's catch is a catch too.
    'p.catch((caughtError) => { logger.error(LOG_EVENT.RUN_FAILED, { error: caughtError }); throw caughtError; });',
  ].map((code) => ({ code, errors: [{ messageId: 'logAndThrow' }] })),
});

ruleTester.run('log-error-as-value', harnessPlugin.rules['log-error-as-value'], {
  valid: [
    'logger.error(LOG_EVENT.RUN_FAILED, { error: caughtError });',
    'logger.error(LOG_EVENT.RUN_FAILED, { error: caughtError, conversationId: id });',
    // Other fields hold text freely; only `error` is the caught value.
    "logger.info(LOG_EVENT.STARTED, { code: 'x', route: `${method} ${path}` });",
    'logger.error(LOG_EVENT.RUN_FAILED);',
    // Not a logger.
    'reporter.error(LOG_EVENT.RUN_FAILED, { error: caughtError.message });',
  ],
  invalid: [
    'logger.error(LOG_EVENT.RUN_FAILED, { error: caughtError.message });',
    'logger.error(LOG_EVENT.RUN_FAILED, { error: caughtError.stack });',
    'logger.warn(LOG_EVENT.RUN_FAILED, { error: `failed: ${caughtError}` });',
    'logger.error(LOG_EVENT.RUN_FAILED, { error: String(caughtError) });',
    'logger.error(LOG_EVENT.RUN_FAILED, { error: errorMessage(caughtError) });',
    'logger.error(LOG_EVENT.RUN_FAILED, { error: caughtError instanceof Error ? caughtError.message : String(caughtError) });',
    "logger.error(LOG_EVENT.RUN_FAILED, { error: caughtError.message ?? 'unknown' });",
    'logger.error(LOG_EVENT.RUN_FAILED, { error: redactDiagnosticText(errorMessage(caughtError)) });',
    'logger.error(LOG_EVENT.RUN_FAILED, { error: printable({ text: caughtError.message, max: 500 }) });',
    'logger.error(LOG_EVENT.RUN_FAILED, { error: text.errorMessage(caughtError) });',
    "logger.error(LOG_EVENT.RUN_FAILED, { error: 'failed: ' + caughtError });",
    "logs.conversation(id).error(LOG_EVENT.RUN_FAILED, { 'error': caughtError.message });",
  ].map((code) => ({ code, errors: [{ messageId: 'asText' }] })),
});

ruleTester.run('log-event-name', harnessPlugin.rules['log-event-name'], {
  valid: [
    'logger.error(LOG_EVENT.RUN_FAILED, { error: caughtError });',
    'logs.server.warn(LOG_EVENT.SCRATCH_PRUNE_FAILED, { error: caughtError });',
    'this.logger.info(LOG_EVENT.STARTED);',
    // Not a logger.
    "reporter.error('boom');",
    "console.error('boom');",
  ],
  invalid: [
    "logger.error('run.failed', { error: caughtError });",
    'logger.error(`run.${what}`, { error: caughtError });',
    'logger.warn(eventName);',
    'logger.info(OTHER_EVENT.STARTED);',
    "logger.debug(LOG_EVENT['STARTED']);",
    "logs.conversation(id).error('prompt failed');",
  ].map((code) => ({ code, errors: [{ messageId: 'notMember' }] })),
});

const LOGGING = 'logger.error(LOG_EVENT.RUN_FAILED, { error: caughtError });';
const FACTORY = "import { createLogger } from '@sheavly/logger/logger/logger.helper';";

ruleTester.run('no-logger-in-pure-kind', harnessPlugin.rules['no-logger-in-pure-kind'], {
  valid: [
    // Helpers and services may log and build loggers.
    { code: LOGGING, filename: 'src/api/api.helper.ts' },
    {
      code: `${FACTORY} const logger = createLogger(options);`,
      filename: 'src/log/logs.helper.ts',
    },
    { code: LOGGING, filename: 'src/store/store.service.ts' },
    // A pure file may use the entry builder and the types: they return values.
    {
      code: "import { createLogEntry } from '@sheavly/logger/logger/logger.utils'; export const x = createLogEntry(params);",
      filename: 'src/log/entry.utils.ts',
    },
    {
      code: "import type { Logger } from '@sheavly/logger/logger/logger.types';",
      filename: 'src/log/entry.utils.ts',
    },
    // Not a logger call.
    { code: 'reporter.error(failure);', filename: 'src/log/entry.utils.ts' },
  ],
  invalid: [
    { code: LOGGING, filename: 'src/log/entry.utils.ts' },
    { code: LOGGING, filename: 'src/profile/profile.validator.ts' },
    { code: 'logger.info(LOG_EVENT.RENDERED);', filename: 'src/prompt/system.prompt.ts' },
    { code: `${FACTORY} export const x = 1;`, filename: 'src/log/entry.utils.ts' },
    { code: `${FACTORY} export const x = 1;`, filename: 'src/profile/profile.validator.ts' },
  ].map((test) => ({ ...test, errors: [{ messageId: 'pure' }] })),
});

ruleTester.run('no-failure-output-in-catch', harnessPlugin.rules['no-failure-output-in-catch'], {
  valid: [
    // Logged with the logger.
    'try { run(); } catch (caughtError) { logger.error(LOG_EVENT.RUN_FAILED, { error: caughtError }); }',
    // Output outside a failure is the app's own business.
    "process.stderr.write('listening\\n');",
    "console.log('started');",
    // A function inside the catch is its own scope.
    "try { run(); } catch (caughtError) { schedule(() => console.log('later')); logger.error(LOG_EVENT.RUN_FAILED, { error: caughtError }); }",
  ],
  invalid: [
    'try { run(); } catch (caughtError) { process.stderr.write(`failed: ${caughtError}\\n`); }',
    "try { run(); } catch (caughtError) { console.error('failed', caughtError); }",
    'try { run(); } catch (caughtError) { console.warn(caughtError); throw caughtError; }',
    'p.catch((caughtError) => process.stderr.write(String(caughtError)));',
    'p.catch((caughtError) => { console.error(caughtError); });',
  ].map((code) => ({ code, errors: [{ messageId: 'output' }] })),
});
