# Publishing dsh-workspace-merge

The bundle is finished and verified locally; only the two publishing steps below
need credentials. Run them from the repository root.

## 1. GitHub

```bash
git init
git add .
git commit -m "dsh-workspace-merge 0.1.0: named workspace groups for multi-root sessions"
git branch -M main
git remote add origin git@github.com:<owner>/dsh-workspace-merge.git
git push -u origin main
```

`node_modules/` and `*.tgz` are gitignored. The `node_modules` symlinks to
`@deepseek-ai/dsh-tools` / `dsh-sandbox` / `cordis` exist only so `npm test` can
resolve the harness's own core packages; they are not part of the published
package (`files` in package.json ships `lib/`, `cordis.patch.yml` and the docs).

## 2. npm

```bash
npm login                     # or: npm config set //registry.npmjs.org/:_authToken=$NPM_TOKEN
npm publish --registry https://registry.npmjs.org/
```

Pre-flight (already verified):

```bash
npm pack --dry-run            # 8 files after the docs land: lib/index.js, cordis.patch.yml,
                              # package.json, README.md, README.zh.md, LICENSE
npm test                      # 30 passed, 0 failed
```

The package is unscoped, so `publishConfig.access: public` + the explicit
`registry` in package.json keep it off the npmmirror mirror.

## 3. Marketplace entry

`awesome-dsh-plugin` takes exactly one YAML file per plugin at
`data/plugins/<owner>__<repo>.yml`. A ready copy is in
`market/awesome-dsh-plugin-entry.yml`.

```bash
gh repo fork awesome-dsh-plugin/awesome-dsh-plugin --clone
cp market/awesome-dsh-plugin-entry.yml \
   awesome-dsh-plugin/data/plugins/<owner>__dsh-workspace-merge.yml
cd awesome-dsh-plugin && git checkout -b add-dsh-workspace-merge
git add data/plugins/<owner>__dsh-workspace-merge.yml
git commit -m "Add dsh-workspace-merge"
git push origin add-dsh-workspace-merge    # then open the PR
```

Rules that matter (from the marketplace's `contributing.md`):

* one file per plugin, path `data/plugins/<owner>__<repo>.yml`;
* `description.en` is the only required description field;
* any description containing `": "` must be quoted;
* never edit the generated READMEs — they are rebuilt from the data files.

After the npm publish, `dsh plugin add dsh-workspace-merge` works for anyone.
