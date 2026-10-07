#!/usr/bin/env bash
cd "$HOME/wolv-stock" || exit 1
git add data/snapshots.jsonl
git diff --cached --quiet -- data/snapshots.jsonl && exit 0
git commit -qm "chore: price snapshot [skip ci]" -- data/snapshots.jsonl
git push -q
