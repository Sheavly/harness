import type { SkillInfo } from '@sheavly/protocol/skill/skill.types';
import type { LiveConversation } from './conversations.types.js';
import { matchesSearch } from './conversations.utils.js';

/**
 * The skills a prompt in `live` can run, all or those `search` matches (name or description,
 * ignoring case): none when it has no skills.
 */
export async function skillsOf(params: {
  live: LiveConversation;
  search?: string | undefined;
  signal?: AbortSignal | undefined;
}): Promise<SkillInfo[]> {
  const { live, search, signal } = params;

  if (!live.skills) return [];

  const listed = await live.skills.list({ ...(signal && { signal }) });

  return search ? listed.filter((skill) => matchesSearch({ skill, search })) : listed;
}
