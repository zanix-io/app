#!/bin/sh

######### RUNNING TESTS ###############
deno test --allow-all 2>/dev/null

if [ "$?" = "1" ]
then
  commit=`git log --pretty=format:'%Cred%h%Creset %s' -G "(.only|.skip)" | head -n1`
  echo "\033[1;31merror[pre-push]\033[0m: Found test skip. This change was last introduced in the commit: \033[0;32m$commit\033[0m.\n\n         Not pushing. (override with the --no-verify flag).\n"
  exit 1
fi
exit 0
