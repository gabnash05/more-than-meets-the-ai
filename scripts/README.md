# Repository scripts

Small helpers that make local Git behaviour consistent across clones.

## Notebook Git plumbing

`nbstripout` strips notebook outputs so we do not commit execution junk, and
`nbdime` makes notebook diffs readable. Both are registered in **local** Git
configuration, which is not shared by a clone, so every collaborator has to set
them up once.

```sh
scripts/configure-notebook-git.sh
```

That registers `scripts/nbstripout-safe` as the clean filter and textconv
command, and adds the attribute rules that switch them on. It is idempotent and
safe to rerun.

### Why a wrapper instead of `nbstripout --install`

`nbstripout --install` writes the absolute path of one interpreter into `.git/config`.
That works on the machine that ran it and nowhere else, and it surfaces two
pieces of noise that read like failures:

| Symptom | Cause | What the wrapper does |
|---|---|---|
| `BrokenPipeError: [Errno 32] Broken pipe`, `Could not strip ...`, with a traceback over a diff | Python ignores `SIGPIPE`; when a pager, `head` or a diff viewer closes the pipe first, nbstripout's write fails | restores the default `SIGPIPE` disposition so it exits silently |
| `MissingIDFieldWarning: Cell is missing an id field` on every historical diff | nbformat warns about notebooks committed before cell ids were required | suppresses warnings in textconv (display) mode only |

Neither one affects the stripped output: the wrapper is byte-for-byte identical
to plain `nbstripout` on stdout, and the clean filter keeps its warnings so a
notebook that is genuinely missing ids still complains when staged.

The interpreter is resolved from `$NBSTRIPOUT_PYTHON` first, then the Guesser
and Referee evaluation environments, then `python3`. Set `NBSTRIPOUT_PYTHON` in
a clone with a different environment layout.

### Verify

```sh
git check-attr -a -- models/guesser/evaluation/notebooks/00_environment_check.ipynb
git config --local --get-regexp '^(filter\.nbstripout|diff\.ipynb)'
```

The attribute output should show `filter: nbstripout` and `diff: ipynb` for the
notebook. The `pre-commit` hook described in
`models/guesser/evaluation/README.md` is a second safety net and still needs
`pre-commit install` per clone.
