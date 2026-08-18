#!/bin/sh

######### RUNNING TESTS ###############

# stderr is deliberately NOT discarded. `deno test`'s own failure output — assertion diffs, stack
# traces, and the performance regression gate's own report naming the metric that dropped and by
# how much — all go to stderr, and it is the only thing that tells the developer WHAT broke.
# Sending it to /dev/null and then printing a fixed message about `.only`/`.skip` explained every
# failure as the one cause it happened to know about, which is wrong for any other failure and
# actively misleading for a performance regression.
deno test --allow-all
status=$?

if [ "$status" -ne 0 ]; then
  printf '\n\033[1;31merror[pre-push]\033[0m: `deno test --allow-all` failed (exit %s). Not pushing. (override with the --no-verify flag).\n' "$status"

  # A focused or skipped test is ONE specific cause among many — Deno fails the whole run when a
  # test is marked `only`. Reported as a hint, and only when the tree actually contains one, rather
  # than asserted as the explanation for whatever just failed.
  focused=$(git grep -nE 'Deno\.test\.only|only: *true|\.skip\(|ignore: *true' -- 'src/**/*.test.ts' 2>/dev/null | head -n 5)
  if [ -n "$focused" ]; then
    printf '\n\033[0;33mhint[pre-push]\033[0m: the working tree also contains a focused/skipped test, which by itself makes the run fail:\n%s\n' "$focused"
  fi

  exit "$status"
fi

exit 0
