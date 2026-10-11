import { assertReviewDispatchBounds } from "./owner-install-review-dispatch.ts";
import { assertReviewModelStart } from "./owner-install-review-start.ts";
import { assertReviewSuccessors } from "./owner-install-review-successors.ts";
import { assertReviewExecutionBounds } from "./owner-install-review-execution.ts";
import { assertReviewBoundRollbacks } from "./owner-install-review-bound-rollbacks.ts";
import { assertReviewCandidateRollbacks } from "./owner-install-review-candidate-rollbacks.ts";
import { assertReviewPublicationRollbacks } from "./owner-install-review-publication-rollbacks.ts";

Deno.test(
  "owner install: review model revision preserves install and rollback gates",
  () => {
    const review = assertReviewModelStart();
    const successors = assertReviewSuccessors(review);
    const dispatch = assertReviewDispatchBounds(successors);
    const execution = assertReviewExecutionBounds(dispatch);
    assertReviewBoundRollbacks(execution);
    assertReviewCandidateRollbacks(execution);
    assertReviewPublicationRollbacks(execution);
  },
);
