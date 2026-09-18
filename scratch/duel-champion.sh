#!/usr/bin/env bash
# Duel the TypeScript champion against the Python example, and gate it.
#
# The standing question is whether the champion has earned its name: it is a
# rewrite of the Python striker/goalie, so the honest bar is beating that
# example, in its own language, over enough matches that a fair flip cannot
# explain the result. A few seeds meander (three matches swung three goals the
# other way when the two were even), so this duels a default of ten.
#
#   scratch/duel-champion.sh                # seeds 1-10
#   scratch/duel-champion.sh 1-25           # longer verdicts, ~25 minutes
#
# The bench runs the sim in-process and spawns the python robots itself, so
# nothing needs to be served first. The scoreline is printed python-left and
# champion-right -- `--team lime` is the team under test.
#
# Promotion, written down so a confident day cannot move it:
#   * champion aggregate goals >= 1.15 x python aggregate (the rewritten team
#     measured ~1.10 over its pre-rewrite best; the bar digs past that), and
#   * champion wins more matches than python (a majority, not a fluke), and
#   * every decisive result stands on at least 8 matches (more = fairer).
# When all three hold, the result is recorded in scratch/champion-vs-python
# next to the champion sha, so the next duel has a bar to beat rather than a
# feeling to have.
set -euo pipefail

cd "$(dirname "$0")/.."

SEEDS=${1:-1-10}
OUT=$(mktemp)
trap 'rm -f "$OUT"' EXIT

echo "duelling champion vs python (seeds $SEEDS) — two halves per seed"
bun run bench \
  --team lime \
  --spawn "python3 python/examples/play.py --only lime --url {url}" \
  --opponent champion \
  --seeds "$SEEDS" 2>&1 | tee "$OUT" >/dev/null

python=0
champion=0
matches=0
wins_python=0
wins_champion=0
while read -r p c; do
  python=$((python + p))
  champion=$((champion + c))
  matches=$((matches + 1))
  if [ "$p" -gt "$c" ]; then wins_python=$((wins_python + 1));
  elif [ "$c" -gt "$p" ]; then wins_champion=$((wins_champion + 1)); fi
done < <(sed -nE 's/^  seed [0-9]+: ([0-9]+) - ([0-9]+).*/\1 \2/p' "$OUT")

echo
echo "candidate: champion $champion - $python python over $matches matches"

if [ "$matches" -lt 8 ]; then
  echo "verdict:   run at least 8 matches before taking a verdict (got $matches)"
  exit 3
fi

fair=$(awk "BEGIN { printf \"%.2f\", $champion / $python }")
enough=$(awk "BEGIN { print ($champion >= 1.15 * $python) ? \"ok\" : \"no\" }")
wins="no"; if [ "$wins_champion" -gt "$wins_python" ]; then wins="ok"; fi

echo "  promoter: champion x1.15 -> $enough  ($fair of python's total)"
echo "  promoter: majority wins  -> $wins  (wins $wins_champion - $wins_python)"

if [ "$enough" = "ok" ] && [ "$wins" = "ok" ]; then
  echo "verdict:   PROMOTE"
  SHA=$(git rev-parse HEAD)
  RECORD=scratch/champion-vs-python
  {
    echo "# champion $(git rev-parse --short HEAD) at $(date -u +%F) over seeds $SEEDS"
    echo "#   $champion goals for, $python against; made the promotion gate."
    echo "$SHA"
  } > "$RECORD"
  echo "recorded in $RECORD"
  exit 0
fi

echo "verdict:   hold — champion does not beat the python example decisively"
exit 1