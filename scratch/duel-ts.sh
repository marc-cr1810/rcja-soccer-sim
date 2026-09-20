#!/usr/bin/env bash
# Duel the working-tree TypeScript champion against the pinned one, and gate it.
#
# The champion is a rewrite of the python striker/goalie that already has to
# beat the python example (`scratch/duel-champion.sh`). This is the same
# question asked one rewrite deeper: a changed champion must beat the frozen
# one, or the change has no business in the tree. The frozen champion is the
# sha in scratch/champion-ts, materialised in a git worktree, played over the
# wire by scratch/agent-ts.ts (the pinned runner imported from that worktree
# runs the pinned champion's own code, and the working in-process champion
# plays the other side).
#
# Both arrangements are played and pooled, so a side effect cannot be mistaken
# for an improvement:
#   A: pinned on lime (wire) vs working on violet (in-process)
#   B: pinned on violet (wire) vs working on lime (in-process)
#
#   scratch/duel-ts.sh               # seeds 1-5, i.e. 10 pooled matches
#   scratch/duel-ts.sh 1-10          # longer verdicts, ~30 minutes
#
# Promotion, written down so a confident day cannot move it:
#   * working aggregate goals >= 1.15 x pinned aggregate, and
#   * working wins more matches than pinned (a majority, not a fluke), and
#   * every decisive result stands on at least 8 pooled matches.
# When all three hold, the result is recorded into scratch/champion-ts next to
# the working HEAD sha, so the next duel has a bar to beat rather than a
# feeling to have.
set -euo pipefail

cd "$(dirname "$0")/.."

SEEDS=${1:-1-5}
PIN=$(tail -n 1 scratch/champion-ts)
SHORT=$(git rev-parse --short "$PIN")
WT="scratch/.wt-champion-$SHORT"
OUT=$(mktemp)
trap 'rm -f "$OUT"' EXIT

# --- bootstrap the pinned worktree ------------------------------------------
if ! git -C "$WT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git worktree add "$WT" "$PIN" >/dev/null
fi
WTABS=$(cd "$WT" && pwd)

# The pinned worktree needs the runner, which is harness rather than champion:
# it imports the pinned champion from the pinned tree, so copying today's
# runner does not smuggle today's champion into the measurement.
if [ ! -f "$WT/scratch/agent-ts.ts" ] || ! cmp -s scratch/agent-ts.ts "$WT/scratch/agent-ts.ts"; then
  cp scratch/agent-ts.ts "$WT/scratch/agent-ts.ts"
fi

# And the workspace deps. Only `@rcja/shared` is touched by the champion, and
# the symlink keeps the pinned tree on its own semantics while sharing the one
# install.
if [ ! -L "$WT/node_modules" ]; then
  ln -s "$PWD/node_modules" "$WT/node_modules"
fi

echo "duelling working HEAD $(git rev-parse --short HEAD) vs pinned $SHORT (seeds $SEEDS x2 arrangements)"
echo "  arrangement A: pinned on lime, working on violet"
bun run bench \
  --team lime \
  --spawn "bun $WTABS/scratch/agent-ts.ts --team lime --url {url}" \
  --opponent champion \
  --seeds "$SEEDS" 2>&1 | tee "$OUT" >/dev/null
echo "  arrangement B: pinned on violet, working on lime"
bun run bench \
  --team violet \
  --spawn "bun $WTABS/scratch/agent-ts.ts --team violet --url {url}" \
  --opponent champion \
  --seeds "$SEEDS" 2>&1 | tee -a "$OUT" >/dev/null

# Every seed line reads "pinned - working", whichever arrangement: the tested
# side is the pinned wire runner in both.
pinned=0
working=0
matches=0
wins_pinned=0
wins_working=0
while read -r p w; do
  pinned=$((pinned + p))
  working=$((working + w))
  matches=$((matches + 1))
  if [ "$p" -gt "$w" ]; then wins_pinned=$((wins_pinned + 1));
  elif [ "$w" -gt "$p" ]; then wins_working=$((wins_working + 1)); fi
done < <(sed -nE 's/^  seed ([0-9]+): ([0-9]+) - ([0-9]+).*/\2 \3/p' "$OUT")

echo
echo "candidate: working $working - $pinned pinned over $matches matches"

if [ "$matches" -lt 8 ]; then
  echo "verdict:   run at least 8 matches before taking a verdict (got $matches)"
  exit 3
fi

fair=$(awk "BEGIN { printf \"%.2f\", $working / $pinned }")
enough=$(awk "BEGIN { print ($working >= 1.15 * $pinned) ? \"ok\" : \"no\" }")
wins="no"; if [ "$wins_working" -gt "$wins_pinned" ]; then wins="ok"; fi

echo "  promoter: working x1.15 -> $enough  ($fair of pinned's total)"
echo "  promoter: majority wins  -> $wins  (wins $wins_working - $wins_pinned)"

if [ "$enough" = "ok" ] && [ "$wins" = "ok" ]; then
  # Promote only a committed state. HEAD is where the changed champion lives,
  # and an uncommitted working tree would record a pin that does not reproduce
  # the result (the pinned runner would replay the pre-change code).
  if [ -n "$(git status --porcelain)" ]; then
    echo "verdict:   PROMOTE but tree is dirty — the champion is not yet at HEAD."
    echo "           commit it, re-run the duel, and promote the clean tree."
    exit 4
  fi
  echo "verdict:   PROMOTE"
  SHA=$(git rev-parse HEAD)
  {
    echo "# working $(git rev-parse --short HEAD) at $(date -u +%F) over seeds $SEEDS (both arrangements)"
    echo "#   $working goals for, $pinned against; made the promotion gate."
    echo "$SHA"
  } > scratch/champion-ts
  echo "recorded in scratch/champion-ts"
  exit 0
fi

echo "verdict:   hold — the working champion does not beat the pinned one decisively"
exit 1