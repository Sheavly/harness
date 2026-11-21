---
description: write_file + edit_file, read both back, then delete one
workspace: basic
check:
  {
    'areas':
      [
        'extensions/coding/src/write-file',
        'extensions/coding/src/edit-file',
        'extensions/coding/src/delete-file',
        'extensions/coding/src/files',
        'packages/runtime/src/locks',
        'packages/workspace/src/file-reads',
        'packages/workspace/src/workspace',
        'packages/loop/src/stream-agent',
        'packages/loop/src/queue',
        'packages/loop/src/hooks',
        'packages/loop/src/abort',
        'packages/loop/src/events',
        'packages/providers/src/responses',
        'packages/providers/src/anthropic-messages',
        'packages/providers/src/openai',
        'packages/providers/src/azure',
        'apps/terminal/src/render',
        'apps/terminal/src/client',
        'apps/backend/src/serve.ts',
        'apps/backend/src/run-server',
        'packages/client/src',
      ],
    'expect':
      {
        'reply': ['hej', 'a + b'],
        'tools': ['write_file', 'edit_file', 'read_file', 'delete_file'],
        'outcome': 'completed',
      },
  }
---

Create src/math.ts exporting a function add(a: number, b: number) that returns a + b. Then edit src/greet.ts so the greeting is "hej" instead of "hello". Then read both files back and show me their contents. Then delete src/math.ts.
