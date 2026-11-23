/**
 * Test-only: a Responses API request as a fake model reads it: its input items, and the text of its
 * first user message, which names the session that asked (a sub-agent's task, or the first prompt).
 */
export async function modelRequest(
  input: string | URL | Request,
  init?: RequestInit,
): Promise<{ input: unknown[]; task: string | undefined }> {
  const body = JSON.parse(await new Request(input, init).text()) as {
    input: { role?: string; content?: string | { text: string }[] }[];
  };
  const first = body.input.find((item) => item.role === 'user')?.content;
  const task = typeof first === 'string' ? first : first?.map(({ text }) => text).join('');

  return { input: body.input, task };
}
