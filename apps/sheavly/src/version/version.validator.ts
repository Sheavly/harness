import { z } from 'zod';
import { VersionError } from '../errors/cli.errors.js';

const packageSchema = z.object({ version: z.string().min(1) });

/** The `version` of a parsed `package.json`; throws when there is none, naming `file`. */
export function parsePackageVersion(params: { json: unknown; file: string }): string {
  const { json, file } = params;
  const parsed = packageSchema.safeParse(json);

  if (!parsed.success) throw new VersionError({ message: `${file} has no version`, file });

  return parsed.data.version;
}
