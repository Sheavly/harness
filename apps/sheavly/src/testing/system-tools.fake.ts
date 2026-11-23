import type {
  SystemCall,
  SystemResult,
  SystemTool,
  SystemTools,
} from '../service/service.types.js';

const OK: SystemResult = { status: 'ok', code: 0, stdout: '', stderr: '' };

/**
 * Test-only: systemd played by a script. Every program run is recorded and answers `OK` (exit 0,
 * no output) unless `answer` returns something for that call, which is merged over it. `follow`
 * (the journal on the terminal) is recorded too and ends with exit 0, or `options.follow`. Nothing
 * here touches the machine's systemd.
 */
export function fakeSystemTools(
  answer?: (call: SystemCall) => Partial<SystemResult> | undefined,
  options: { follow?: number | 'missing' } = {},
): {
  system: SystemTools;
  calls: SystemCall[];
  /** The calls of one program, as `args` joined by spaces, in order. */
  commands: (tool: SystemTool) => string[];
} {
  const calls: SystemCall[] = [];

  return {
    calls,
    commands: (tool) =>
      calls.filter((call) => call.tool === tool).map((call) => call.args.join(' ')),
    system: {
      run: (call) => {
        calls.push(call);

        return Promise.resolve({ ...OK, ...answer?.(call) });
      },
      follow: (call) => {
        calls.push(call);

        return Promise.resolve(options.follow ?? 0);
      },
    },
  };
}
