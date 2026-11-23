import { sheavlyHome } from '@sheavly/storage/home/home.helper';
import type { CliCommand, Streams } from '../command/command.types.js';
import { DoctorFailedError, UsageError } from '../errors/cli.errors.js';
import { DOCTOR_HELP, DOCTOR_NAME, DOCTOR_SUMMARY } from './doctor.constants.js';
import { checkHome } from './home-check.helper.js';
import { checkNode } from './node-check.utils.js';
import { checkProfile } from './profile-check.helper.js';
import { renderReport } from './report.utils.js';
import { checkServer } from './server-check.helper.js';
import { settleCheck } from './settle-check.helper.js';

/**
 * The `doctor` command: prints what is installed, what runs and what is wrong (Node, the home, the
 * server, the profile) to `streams.out`, and fails with a `DoctorFailedError` (exit 1) when any
 * check found a problem, so the exit code is non-zero exactly then. It reads and probes only,
 * takes no argument, and no line it prints holds the token. A check that cannot run is a failing
 * finding (`settleCheck`), so the other checks are still reported. The process facts (Node's version,
 * the user, the platform) are passed in so a test supplies its own.
 */
export function createDoctorCommand(params: {
  nodeVersion: string;
  uid: number;
  platform: NodeJS.Platform;
  streams: Streams;
}): CliCommand {
  const { nodeVersion, uid, platform, streams } = params;

  return {
    name: DOCTOR_NAME,
    summary: DOCTOR_SUMMARY,
    help: DOCTOR_HELP,
    run: async ({ args, env }) => {
      const [unexpected] = args;

      if (unexpected !== undefined) {
        throw new UsageError(
          `"sheavly doctor" takes no arguments, got "${unexpected}". Run "sheavly doctor --help".`,
        );
      }

      // Resolved inside each check: with no HOME and no passwd entry it throws, and that must be a
      // finding of its own check, not the end of the report.
      const findings = [
        checkNode(nodeVersion),
        ...(await Promise.all([
          settleCheck({
            label: 'Home',
            run: () => checkHome({ home: sheavlyHome(env), uid, platform }),
          }),
          settleCheck({
            label: 'Server',
            run: () => checkServer({ env, home: sheavlyHome(env), uid }),
          }),
          settleCheck({ label: 'Profile', run: () => checkProfile({ home: sheavlyHome(env) }) }),
        ])),
      ];

      streams.out(renderReport(findings));

      const failed = findings.filter(({ ok }) => !ok).length;

      if (failed > 0) throw new DoctorFailedError(`${String(failed)} check(s) failed`);
    },
  };
}
