import { existsSync } from 'node:fs';
import path from 'node:path';
import { extensionDeclaresGrants } from './rules/extension-declares-grants.js';
import { extensionDefinition } from './rules/extension-definition.js';
import { extensionNoRuntimeRegistries } from './rules/extension-no-runtime-registries.js';
import { extensionOptionsUseServices } from './rules/extension-options-use-services.js';
import { extensionPublicContract } from './rules/extension-public-contract.js';
import { fileKind } from './rules/file-kind.js';
import { brandedIds } from './rules/branded-ids.js';
import { guardEnvRead } from './rules/guard-env-read.js';
import { guardEnvWrite } from './rules/guard-env-write.js';
import { guardFileToolResolve } from './rules/guard-file-tool-resolve.js';
import { guardSearchRoot } from './rules/guard-search-root.js';
import { guardWorkingRoot } from './rules/guard-working-root.js';
import { importsRule } from './rules/imports.js';
import { kindContents } from './rules/kind-contents.js';
import { layoutRule } from './rules/layout.js';
import { noBarrel } from './rules/no-barrel.js';
import { noBrandCast } from './rules/no-brand-cast.js';
import { noAdhocTaskKind } from './rules/no-adhoc-task-kind.js';
import { noDirectTaskStart } from './rules/no-direct-task-start.js';
import { noRawError } from './rules/no-raw-error.js';
import { noSilentCatch } from './rules/no-silent-catch.js';
import { permissionStoreRoot } from './rules/permission-store-root.js';
import { SYNTAX_RULES, syntaxRule } from './rules/syntax-rules.js';
import { pureImports } from './rules/pure-imports.js';
import { serverThroughFinder } from './rules/server-through-finder.js';
import { promptLocation } from './rules/prompt-location.js';
import { singleDefinition } from './rules/single-definition.js';
import { systemPromptReview } from './rules/system-prompt-review.js';
import { pointRulesToSkills } from './skill-pointers.js';
import { SkillMetadataError } from './skills.errors.js';
import { SKILLS_DIR } from './skills.js';

// This repo's root, from where this file is, so the skills read are always this repo's. If the
// package is ever used from elsewhere the skills are not there, and every pointer would silently
// vanish, so it fails instead.
const REPO_ROOT = path.resolve(import.meta.dirname, '../../..');

if (!existsSync(path.join(REPO_ROOT, SKILLS_DIR))) {
  throw new SkillMetadataError({
    file: SKILLS_DIR,
    problem: `not found from ${REPO_ROOT}; the lint plugin reads the skills of the repo it lives in`,
  });
}

const RULES = {
  'branded-ids': brandedIds,
  'extension-declares-grants': extensionDeclaresGrants,
  'extension-definition': extensionDefinition,
  'extension-no-runtime-registries': extensionNoRuntimeRegistries,
  'extension-options-use-services': extensionOptionsUseServices,
  'extension-public-contract': extensionPublicContract,
  'file-kind': fileKind,
  'guard-env-read': guardEnvRead,
  'guard-env-write': guardEnvWrite,
  'guard-file-tool-resolve': guardFileToolResolve,
  'guard-search-root': guardSearchRoot,
  'guard-working-root': guardWorkingRoot,
  imports: importsRule,
  'kind-contents': kindContents,
  layout: layoutRule,
  'no-adhoc-task-kind': noAdhocTaskKind,
  'no-barrel': noBarrel,
  'no-brand-cast': noBrandCast,
  'no-direct-task-start': noDirectTaskStart,
  'no-raw-error': noRawError,
  'no-silent-catch': noSilentCatch,
  'permission-store-root': permissionStoreRoot,
  'pure-imports': pureImports,
  'prompt-location': promptLocation,
  'server-through-finder': serverThroughFinder,
  'single-definition': singleDefinition,
  'system-prompt-review': systemPromptReview,
  ...Object.fromEntries(
    Object.entries(SYNTAX_RULES).map(([name, entries]) => [name, syntaxRule(entries)]),
  ),
};

/** The `harness/*` rules, each with the guide of the skill that names it appended to its messages. */
export const harnessPlugin = {
  meta: { name: 'harness' },
  rules: pointRulesToSkills({ rules: RULES, root: REPO_ROOT }),
};
