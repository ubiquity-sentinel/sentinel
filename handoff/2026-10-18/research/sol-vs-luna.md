# Sol vs luna — implementation cell tally

| Run | Model | Cells | Candidate produced | Interrupted (output bound) | Other failure | Output chars (candidates) | Duration (candidates) |
|---|---|---|---|---|---|---|---|
| 39080597401 (706969a9f, 2026-10-17 23:51Z) | gpt-reserve (luna) | 4 | 0 | 3 (≈4.0M chars each, model_unknown) | 1 port_error model_candidate_unchanged_base (task 130721617949…) | — | — |
| 39082934785 (87e28fd4a, 2026-10-18 00:29Z) | gpt-6.1-sol | 11 | 9 | 0 | 1 failed model_other (569k chars, no candidate); 1 port_error model_candidate_unchanged_base (same task 130721617949…, B10) | 277k–779k | 3.7–16.8 min |
| 39085544527 (87e28fd4a, 2026-10-18 01:11Z) | gpt-6.1-sol | 4 | 2 | 0 | 2 port_error model_candidate_unchanged_base (no output; repeat-failure B10 shape) | 0.98M–1.13M | 15.4–17.9 min |

Running total: luna 0 of 4 cells produced a candidate; sol 11 of 15. Every sol failure except one is the "model ended without changing anything" shape (B10), which also hits luna.

Still to measure per candidate: CI green on first try, review rounds to clean, merge.
