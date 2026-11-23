import type { ApprovalRequest, ApprovalResponse } from '@sheavly/protocol/approval/approval.types';
import { approvalIdSchema } from '@sheavly/protocol/approval/approval.validator';
import { ApprovalRegistry } from '../approvals/approvals.service.js';

/**
 * An approval registry whose requests are numbered `a1`, `a2`, … so a test can name the one it
 * means. A real registry's ids are random (`ApprovalRegistry`), so a test of those uses `new`.
 */
export function numberedApprovals(): ApprovalRegistry {
  let next = 1;

  return new ApprovalRegistry({ newId: () => approvalIdSchema.parse(`a${String(next++)}`) });
}

/** A UI that approves every request as soon as it's announced. Returns the unsubscribe. */
export function approveEverything(approvals: ApprovalRegistry): () => void {
  return approvals.subscribe((update) => {
    if (update.type === 'approval_requested') {
      approvals.respond({ id: update.request.id, response: { decision: 'approve' } });
    }
  });
}

/**
 * A UI stand-in that answers every request with `response` as soon as it's announced, and
 * records the requests it was asked, in order.
 */
export function answeringUi(response: ApprovalResponse): {
  approvals: ApprovalRegistry;
  asked: ApprovalRequest[];
} {
  const approvals = new ApprovalRegistry();
  const asked: ApprovalRequest[] = [];

  approvals.subscribe((update) => {
    if (update.type !== 'approval_requested') return;
    asked.push(update.request);
    approvals.respond({ id: update.request.id, response });
  });

  return { approvals, asked };
}
