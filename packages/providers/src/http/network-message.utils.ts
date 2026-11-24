import { providerErrorText } from '@sheavly/core/text/diagnostic-text.utils';

/** What a failed request's error says, with Node's real reason (on `cause`) named. */
export function networkMessage(caughtError: unknown): string {
  const cause = caughtError instanceof Error ? caughtError.cause : undefined;
  const code = (cause as { code?: unknown } | undefined)?.code;
  const detail = cause instanceof Error ? cause.message : undefined;
  const reason = [typeof code === 'string' ? code : undefined, detail].filter(Boolean).join(': ');
  const message = caughtError instanceof Error ? caughtError.message : String(caughtError);

  return providerErrorText(reason ? `${message} (${reason})` : message);
}
