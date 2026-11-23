import { Text, useAnimation } from 'ink';
import { now } from '@sheavly/core/clock/clock.helper';
import { backgroundText, runningToolsText, statusLabel } from '../tui/view.utils.js';
import type { ActivityProps } from './react-screen.types.js';
import { usageText } from '../usage/usage.utils.js';
import { plainTerminalText } from '../render/terminal-text.utils.js';

/** Real state takes priority over motion; cancellation is always visible while working. */
export function Activity(props: ActivityProps) {
  const {
    state,
    model,
    modelEffort,
    workingBranch,
    mode,
    tasks,
    tools = [],
    colors,
    reducedMotion = false,
  } = props;
  const secondary = colors.text.secondary;
  // Reduced motion still ticks once a second so elapsed times do not freeze.
  const { frame, time } = useAnimation({
    interval: reducedMotion ? 1000 : 100,
    isActive: state === 'working',
  });
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  const working = state === 'working';
  const label = statusLabel({
    state,
    thinking: props.thinking,
    awaitedTasks: props.awaitedTasks,
    queued: props.queued,
  });
  const icon = working && !reducedMotion ? frames[frame % frames.length] : '●';
  // Read on every tick: tool elapsed times advance even without the spinner.
  const running = working ? runningToolsText({ tools, at: now() }) : undefined;

  return (
    <Text wrap="truncate-end">
      <Text color={state === 'ready' ? colors.status.success : colors.status.warning}>
        {icon} {label}
      </Text>
      {working && <Text color={secondary}> · {Math.floor(time / 1000)}s · Ctrl+C to stop</Text>}
      {running && <Text color={secondary}> · {running}</Text>}
      <Text color={secondary}>
        {' '}
        · {plainTerminalText(model)}
        {modelEffort ? ` · ${modelEffort}` : ''}
        {workingBranch ? ` · ⎇ ${plainTerminalText(workingBranch)}` : ''} · mode:{' '}
      </Text>
      <Text {...(mode === 'allow_all' ? { color: colors.status.error } : {})}>{mode}</Text>
      <Text color={secondary}>
        {backgroundText({ tasks, agents: props.agents ?? 0, services: props.services ?? 0 })}
      </Text>
      <Text color={secondary}>
        {' '}
        · {usageText({ context: props.contextUsage, usage: props.usage })}
      </Text>
    </Text>
  );
}
