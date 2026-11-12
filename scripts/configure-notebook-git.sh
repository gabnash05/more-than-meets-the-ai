#!/bin/sh
# Point this clone's notebook Git plumbing at the shared nbstripout wrapper.
#
# Run once per clone, after `uv sync`, from anywhere inside the repository:
#
#   scripts/configure-notebook-git.sh
#
# Git keeps filters, textconv commands and attribute files local, so they cannot
# be committed. What *can* be shared is the command they point at, which is why
# this script exists: clones normally register an absolute interpreter path from
# `nbstripout --install`, and that path belongs to one machine. Registering
# scripts/nbstripout-safe instead keeps the layout identical for every
# collaborator and gives notebook diffs one place to fix.
#
# Idempotent: running it again only rewrites the same values.

set -eu

root=$(git rev-parse --show-toplevel)
wrapper="$root/scripts/nbstripout-safe"

if [ ! -x "$wrapper" ]; then
    chmod +x "$wrapper" 2>/dev/null || true
fi

# Clean filter: strip outputs from the staged copy on `git add`.
git -C "$root" config --local filter.nbstripout.clean "$wrapper"
git -C "$root" config --local filter.nbstripout.smudge cat
git -C "$root" config --local filter.nbstripout.required true

# Textconv: strip for display only, and stay quiet about historical notebooks.
git -C "$root" config --local diff.ipynb.textconv "$wrapper --quiet -t"

# The attribute rules that switch the filter and driver on are local too.
attributes="$root/.git/info/attributes"
touch "$attributes"
for rule in '*.ipynb filter=nbstripout' '*.zpln filter=nbstripout' '*.ipynb diff=ipynb'; do
    if ! grep -qxF "$rule" "$attributes"; then
        printf '%s\n' "$rule" >> "$attributes"
    fi
done

echo "notebook git plumbing configured:"
git -C "$root" config --local --get-regexp '^(filter\.nbstripout|diff\.ipynb)' | sed 's/^/  /'
echo
echo "verify with:"
echo "  git check-attr -a -- models/guesser/evaluation/notebooks/00_environment_check.ipynb"
