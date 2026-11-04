#!/bin/zsh
# Plays every case on production and makes the judge inputs: run-iter.sh <iter> [--only id1,id2]
# Needs evals/judged/.env (gitignored) with ADMIN_SECRET; results go to evals/judged/<iter>/ (gitignored).
set -a; source "${0:A:h}/.env"; set +a
L=${0:A:h}; it=$1; shift
mkdir -p $L/$it
cd $L/../..
npx tsx evals/abtest/run.ts --cases $L/cases --out $L/$it/run.json --parallel 4 --variants current "$@" 2>&1 | tee $L/$it/run.log | grep -v "^\s*$" | tail -80
python3 $L/mkjudge.py $L/$it/run.json $L/$it/judge 4
