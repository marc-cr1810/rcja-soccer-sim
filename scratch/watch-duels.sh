#!/usr/bin/env bash
# Follow the four orbit-variant duels as they play.
#   varA = pursuit to a shrinking standoff point behind the ball
#   varB = the existing law, steering offset capped at 60 degrees
# fwd/rev are the same pairing with the sides swapped.
S="/tmp/claude-1000/-home-marc-programming-typescript-rcja-soccer-sim/3e7b1bdf-efd5-4db7-8e8f-e7c4bc8bb33e/scratchpad"

while true; do
  printf "\033[2J\033[H"
  echo "duels in flight — left column is violet, right is lime"
  echo "(rev runs are side-swapped: the change is on the RIGHT there)"
  echo
  done_all=1
  for name in ${DUELS:-handshake-fwd handshake-rev}; do
    f="$S/duel-$name.txt"
    if [ ! -f "$f" ]; then
      printf '  %-10s  queued\n' "$name"
      done_all=0
      continue
    fi
    n=$(grep -c '^  seed' "$f" 2>/dev/null | head -1); n=${n:-0}
    score=$(grep -E '^  SCORE' "$f" 2>/dev/null | head -1)
    if [ -n "$score" ]; then
      printf '  %-10s  %2d/50  DONE %s\n' "$name" "$n" "${score#  SCORE}"
    else
      printf '  %-10s  %2d/50  %s\n' "$name" "$n" "$(grep '^  seed' "$f" | tail -1 | sed 's/^  //')"
      done_all=0
    fi
  done
  echo
  echo "last few matches:"
  tail -n 4 "$(ls -t $S/duel-var*.txt 2>/dev/null | head -1)" 2>/dev/null | sed 's/^/  /'
  [ "$done_all" = "1" ] && { echo; echo "all four finished."; break; }
  echo
  echo "Ctrl-C to stop watching (the duels keep running)."
  sleep 10
done
