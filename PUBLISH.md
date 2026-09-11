# Publishing dsh-workspace-merge

Owner: **LoserForLoser** (447231214@qq.com).

## Status

| Step | State |
| --- | --- |
| GitHub repo | **live** — https://github.com/LoserForLoser/dsh-workspace-merge (3 commits, `main`) |
| Installable from the repo | **verified** — `dsh plugin add github:LoserForLoser/dsh-workspace-merge` installed in 5.9 s, added itself to `dsh.profile.bundles`, and its tools registered on a real boot |
| Marketplace branch | **pushed** — `LoserForLoser/awesome-dsh-plugin`, branch `add-dsh-workspace-merge` (+1 file, data-only) |
| Marketplace PR | **held by CI's own rule** — `MIN_AGE_DAYS = 1` in `scripts/check-submission.mjs`, and the repo was created 2026-09-11 05:25 UTC. Open the PR after **2026-09-12 13:30 (CST)** |
| npm publish | **blocked** — this machine has no npm credential (`npm whoami` → `ENEEDAUTH`); npm accounts are separate from GitHub |
| Repo metadata | **needs one web click** — add the `dsh-plugin` topic (and a description) under the repo's About panel; topics cannot be set over SSH |

Open the PR here (branch already pushed):
<https://github.com/LoserForLoser/awesome-dsh-plugin/pull/new/add-dsh-workspace-merge>

Local CI equivalent, already run against the real repository data:

* the entry yields **exactly +1 line in both `README.md` and `README.zh.md`**, in
  the `workflow` section;
* `url` and `name` agree, `category: workflow` is valid, the file is the only
  thing the branch adds, and the generated READMEs are left untouched (the
  intended data-only shape);
* `npx awesome-lint` reports **0 errors** in a clone whose `origin` is upstream —
  the two errors seen in the fork clone are only the fork's missing `awesome`
  and `awesome-list` topics, which forks do not inherit. The 76 warnings are
  pre-existing on `main`;
* `SKIP_PUBLISH_CHECKS=1 node scripts/build-site.mjs` cannot be verified locally:
  it derives each entry's added-date from full git history, which needs the real
  PR checkout (`fetch-depth: 0`).

## Remaining human actions

1. **Add the `dsh-plugin` topic** to the plugin repo (About panel), plus a short
   description.
2. **Log in to npm** (`npm login`, same e-mail) or export `NPM_TOKEN`, then:

   ```bash
   cd /Users/songzhaoyang/Desktop/JLXY/dsh-workspace-merge
   npm whoami                                   # must print your npm user first
   npm publish --registry https://registry.npmjs.org/
   ```

   After this, `dsh plugin add dsh-workspace-merge` works by name for anyone.
3. **Open the marketplace PR** once the repo is a day old (see above). No other
   action is needed: the branch is pushed and verified.

## Appendix: original checklist

Everything below is already done except where the Status table says otherwise.

1. **Add this machine's SSH key** — Settings → SSH and GPG keys → New SSH key,
   paste the line below (fingerprint
   `SHA256:ptYT32fnEWBTzodZa6b2ZQCkRCRkNBQWy8Ya7hK0/rA`):

   ```
   ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQDfZo1/9rL/sp7iIrOSVAJx8X5MYsX2wwcINt/aD3itYyz0ogdJmJMGrrujTcEy617kmmFR6M82EfEIkNvKQdGtaf2jQwC/nF3MmwMVA/lUIKy+JBvcQSWLIjmxtkWCg4NIzWJs10s92962bOg0syQFy9+BNXC99HjXBjLDsWruvcYMpRQb/ffh0yYfPz456is3sbP18Q+y13Yl6k+PSEhPypXxFHf5AOUtIuh0FM68DCJBEZdwYc1c6y0LfSc/olV7loETKgfW6VpdDrxkKRNqhgTIBWJh9Fl5YYCOxRbZhTXhfFyk5nf4xjrMI57zw8eR9UXisgC9tJVsIxUWEMCx
   ```
2. **Create the repository** `LoserForLoser/dsh-workspace-merge` — public, empty
   (no README, no .gitignore, no licence), so the push below lands clean.
   *(A token with `repo` scope would remove this step: `gh repo create
   LoserForLoser/dsh-workspace-merge --public --source=. --push`.)*

Verify with `ssh -T git@github.com` — it must answer
`Hi LoserForLoser! You've successfully authenticated…`.

## 1. Push the plugin

```bash
git remote add origin git@github.com:LoserForLoser/dsh-workspace-merge.git   # already configured
git push -u origin main
```

`node_modules/` and `*.tgz` are gitignored. The `node_modules` symlinks to
`@deepseek-ai/dsh-tools` / `dsh-sandbox` / `cordis` exist only so `npm test` can
resolve the harness's own core packages; they are not part of the published
package (`files` in package.json ships `lib/`, `cordis.patch.yml` and the docs).

## 2. npm

The npm account is separate from GitHub. Log in once with the same e-mail
(`npm login`), or export a token:

```bash
npm whoami                                   # must print your npm user first
npm publish --registry https://registry.npmjs.org/
```

Pre-flight (already verified here):

```bash
npm pack --dry-run     # 6 files: lib/index.js, cordis.patch.yml, package.json,
                       # README.md, README.zh.md, LICENSE
npm test               # 31 passed, 0 failed
```

The package is unscoped, so `publishConfig.access: public` plus the explicit
`registry` in package.json keep it off the npmmirror mirror. After this,
`dsh plugin add dsh-workspace-merge` works for anyone.

## 3. Marketplace entry

`awesome-dsh-plugin` (upstream `awesome-dsh-plugin/awesome-dsh-plugin`, default
branch `main`) takes exactly one YAML file per plugin at
`data/plugins/<owner>__<repo>.yml`. The ready copy is
`market/LoserForLoser__dsh-workspace-merge.yml` — the filename already follows
that convention, so it can be copied verbatim.

**Fork first** (github.com/awesome-dsh-plugin/awesome-dsh-plugin → Fork), then:

```bash
git clone --depth 1 git@github.com:LoserForLoser/awesome-dsh-plugin.git
cd awesome-dsh-plugin
git remote add upstream https://github.com/awesome-dsh-plugin/awesome-dsh-plugin.git
git checkout -b add-dsh-workspace-merge
cp /Users/songzhaoyang/Desktop/JLXY/dsh-workspace-merge/market/LoserForLoser__dsh-workspace-merge.yml \
   data/plugins/LoserForLoser__dsh-workspace-merge.yml
git add data/plugins/LoserForLoser__dsh-workspace-merge.yml
git commit -m "Add dsh-workspace-merge"
git push origin add-dsh-workspace-merge
```

Then open the PR with the compare URL GitHub prints, or:

```
https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/compare/main...LoserForLoser:awesome-dsh-plugin:add-dsh-workspace-merge?expand=1
```

Rules that matter (from the marketplace's `contributing.md`):

* one file per plugin, path `data/plugins/<owner>__<repo>.yml`;
* `description.en` is the only required description field;
* any description containing `": "` must be quoted;
* never edit the generated READMEs — they are rebuilt from the data files;
* PRs that only add data files are merged without further review.
