# Sentinel migration checkpoint — 2026-10-18

This branch is a transport checkpoint. The user stopped code work on the old machine and authorized publishing this handoff for migration. No production source was edited for this publication. Development and sentinel-supervisor remain separate live refs.

Read [GOAL.md](GOAL.md), then [SESSION-HANDOFF.md](SESSION-HANDOFF.md). The latter is the detailed historical 12:09 handoff; this file supplies portable paths and takes precedence for migration instructions. Start new code work only in the new machine's continuation checkout.

## What is preserved

- The complete committed integration ancestry through `80e7a3dcede4eea1c9325ba4338098f986b8336e` is the parent history of this branch. Principal helper tip `5321a4e682cbcb329ed39e6b9639a793f67f4ca5` is an ancestor.
- All seven paused dirty/untracked files are byte-exact inert `.snapshot` files. `restore-map.json` names their original paths, bases and SHA-256 hashes. The three principal test files have identical base contents at5321 and80e7, so all seven can be restored together onto80e7. This does not accept or validate the unfinished changes.
- Four original tracked patches and the original workspace snapshot preserve provenance. The new untracked routing test exists only in the full snapshots, not the tracked patch.
- Curated acceptance records, the pending owner request, canary packet and prepared inputs are under `evidence/`; `evidence-index.json` lists included originals and hashes. These are historical records, not new independent verification. Raw logs, complete receipt graphs, caches, credentials, installed dependencies and authoritative state stores are not included.
- `validation-reference.py.snapshot` preserves the previous bounded runner as inert reference text. Adapt its hardcoded checkout, evidence, cache and toolchain paths on the new machine before use. Preserve its source/dependency identity checks, scrubbed environment, permission restrictions and 300-second bound.
- `SHA256SUMS.json` authenticates all package files except itself. The original checksum manifest refers to the original layout; use the new manifest to verify this package.

## Restore on the new machine

Clone full history. A depth-one clone is a later validation surface, not the initial recovery checkout.

```sh
git clone --branch handoff/sentinel-migration-2026-10-18-1216 https://github.com/ubiquity/sentinel.git sentinel-migration
cd sentinel-migration
git worktree add -b continuation/sentinel-migration ../sentinel-continuation 80e7a3dcede4eea1c9325ba4338098f986b8336e
```

From the migration clone, verify and restore the snapshots into that fresh continuation worktree:

```sh
python3 - handoff/2026-10-18-1216 ../sentinel-continuation <<'PY'
from pathlib import Path
import hashlib, json, subprocess, sys
package, target = (Path(p).resolve() for p in sys.argv[1:])
digest = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
for relative, expected in json.loads((package / 'SHA256SUMS.json').read_text()).items():
    assert digest(package / relative) == expected, relative
manifest = json.loads((package / 'restore-map.json').read_text())
git = lambda *a: subprocess.check_output(['git', '-C', str(target), *a], timeout=30).decode().strip()
assert git('rev-parse', 'HEAD') == manifest['base']
assert git('status', '--porcelain') == '', 'Refuse to overwrite existing work'
assert len(manifest['files']) == 7
for item in manifest['files']:
    source, destination = package / item['snapshot'], target / item['path']
    assert digest(source) == item['sha256'], item['path']
    assert destination.exists() == item['existedAtBase'], item['path']
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_bytes(source.read_bytes())
print(git('status', '--short'))
PY
```

Leave these seven files dirty until their pending checks and review are complete. Do not apply the patches as well. Read AGENTS.md, MASTER-PLAN.md, docs/DECISIONS.md and docs/build-status.md in the continuation checkout and reconcile the stale ledger against the exact handoff records. The next primary owns integration and ledger changes.

Old `/workspace/evidence/...` references map to `evidence/...` under this package only when listed in `evidence-index.json`. All other absolute workspace paths are historical and unavailable unless copied separately. Re-fetch native GitHub evidence or rerun only the necessary bounded checks when missing evidence prevents acceptance; do not infer pass from a missing log. Session-local agents and pending async questions do not transfer to the new machine.

## Current boundaries to recheck

At publication preparation, development is `12bc367852188aa94132b7658d774ec413295c1d`, live launcher is `00b6649eeff51a9754bf3748f793137db9bf8605`, and installed runtime is healthy R81 `da98f5f49c45b57cfa97a45fe647c36b1021f302` / generation81. Development CI39124867746 was still in progress. These are observations, not timeless facts; re-read them first. No migration-branch CI or rollout acceptance is claimed.

The immediate open P1 is the missing-principal fallback: actual host admission could start replacement work for an issue already linked to an open PR. The helper is accepted; host wiring and the connected causal GREEN are unfinished. The restored files contain that exact work plus the three authority-path protections. Preserve App-only mutation authority and restrictive routing when App proof is absent.

Code changes, tests, installs, canary effects and production activation remain stopped on the old machine. The new machine may resume the original authorized goal. No source activation, queue proof, future pins or grants were enabled by this checkpoint.

## Canary precedence and approval

The runtime App's Merge queues permission was granted and accepted. The isolated canary request is **requested and unanswered**; production ruleset approval is also absent. The earlier packet/brief says “not requested yet”; the later included `owner-request.json` supersedes that wording. Obtain an explicit reply on the new machine if no reply accompanies migration. Do not re-request the already-granted App permission.

Preserve historical packet bytes/hashes. Re-read native refs, workflow bytes, PR inventory, CI and owner assignment before any approved effects. `final-fixture-plan.json` and its sequencing addendum supersede the older one-minute/unchanged-workflow timeout description inside the retained fixture patch: the prepared missing-trigger case uses a five-minute timeout, keeps the PR trigger, and restores the exact baseline workflow. Use the newer applicability-984 removal/restoration patches and workflow bytes in the package.

Later joint-floor design takes precedence over older rollout plans: future runtime F must itself contain accepted compiled queue proof/policy before it is frozen and launcher L pins it. Queue activation requires both its queue floor and the independent existing-PR custody floor; new takeover admission may stay false. Health alone is not child queue readiness. Production rules must wait until Sentinel can enqueue and the owner has approved that separate step.

No prepared canary JSON or patch authorizes its execution. Fixture IDs and grants remain absent; ruleset bodies are disabled proposals. First test PR must survive real Ubiquity OS processing before further fixtures. Reuse matching PRs, authenticate Sentinel App runtime effects, and assign the authenticated human to source issues for manual work.
