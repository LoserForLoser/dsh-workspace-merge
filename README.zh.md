# dsh-workspace-merge(工作区合并)

一个会话,同时改多个项目。

DSH 会话只锚定一个工作目录——它同时是沙箱边界、工作区键和所有相对路径的基准。
这个默认在绝大多数场景是对的,但有一种很常见的布局会很别扭:同一产品的 PC 端与
移动端、必须保持同步的 iOS 与 鸿蒙 App、公共库与它的调用方。它们是兄弟目录,于是
"同一个文件两边都改"退化成绝对路径 + 反复调用,两边悄悄漂移。

本插件引入 **工作区组(workspace group)**:一组有序的本地项目根目录,外加八个
`ws_*` 工具——把"一个相对路径 × 组内所有根目录"当作一次操作,并逐根目录给出结果,
而不是一个含糊的失败。

```
            一次调用: ws_edit src/components/AmountInput.vue
                                │
        ┌───────────────────────┼───────────────────────┐
        ▼                       ▼                       ▼
  [pc]  ecam-ui           [mobile] ecam-mobile     [shared] lib-ui
  changed · 1 处替换       changed · 1 处替换        not-found
```

## 安装

```bash
dsh plugin add dsh-workspace-merge
```

手工安装:把包装到 `$DSH_HOME/profiles/web`,并在 `dsh.profile.bundles` 里列出
`dsh-workspace-merge`。

## 配置

一个组 = 名称 + 根目录列表。`id` 是其它工具使用的短标签,`path` 可为绝对路径或
`~` 开头。

```jsonc
// ws_group_set {group:"ecam", description:"PC + 移动端", roots:[
//   {id:"pc",     path:"~/Desktop/JLXY/ecam-ui"},
//   {id:"mobile", path:"~/Desktop/JLXY/ecam-mobile-ui"}
// ]}
```

写入 `$DSH_HOME/workspace-groups.json`,纯 JSON,也可手工编辑。

**组的选择**:调用可显式传 `group`;否则用"根目录包含当前会话目录"的组(嵌套根目录
取最长匹配);无匹配时,若只定义了一个组则直接用它,否则必须显式指定名称。

## 工具

| 工具 | 作用 |
| --- | --- |
| `ws_groups` | 列出所有组、根目录 id,以及当前会话命中的组。 |
| `ws_group_set` / `ws_group_remove` | 维护注册表(绝不触碰项目文件)。 |
| `ws_ls` | 在各根目录下列出同一个相对目录——一次定位所有项目里的同一组件。 |
| `ws_read` | 从每个根目录读取同一相对路径并全部返回。 |
| `ws_diff` | 逐行对比各副本(第一个根目录为基线),改之前先看清差异。 |
| `ws_edit` | 把同一个字面替换应用到每个根目录,逐根给出结果。 |
| `ws_write` | 把同一份完整内容写到每个根目录——新建公共文件,或把副本强制同步。 |

`ws_edit` 沿用内置 `edit` 的匹配规则:`old_string` 必须唯一出现,除非设置
`replace_all`。`ws_edit` / `ws_write` 支持 `dry_run` 预览和 `roots:["pc"]` 收窄范围。
逐根状态是显式的——`changed` / `unchanged` / `not-found` / `ambiguous` / `missing` /
`invalid` / `denied`,部分成功可见,绝不静默。

## 沙箱行为

每次写入都先解析会话的 `sandboxPolicy`,本插件**不会**放宽它:

* `danger-full-access` —— 不受围栏,与其它工具一致。
* `workspace-write` —— 目标路径先做规范化(不存在的文件会挂到最近的已存在祖先下重新
  锚定,因此符号链接父目录无法把写入偷渡出去),必须落在策略的可写根之内。
* `read-only` —— 全部写入被拒。

越界目标会以官方标记 `[sandbox: file access denied under … mode]` 加升级提示被拒,
可用 `sandbox_permissions` + `justification` 重试一次——与内置 `write`/`edit` 完全一致。
组注册表(`ws_group_set` / `ws_group_remove`)同样受策略约束:只读会话无法悄悄改配置。

## 说明与限制

* **组不是 monorepo**:它只改变 `ws_*` 工具的指向,不改变会话工作目录,因此内置
  `read`/`edit`/`write`/`bash` 仍只以会话根为基准。当"一次改动必须落到多个项目"时用它。
* 写入走 harness 的文件系统服务(`ctx.fs`):写入前先通过官方 `fs/observed` 事件登记
  版本,使文件观察策略下发 `replaceIfVersion` 而不是以 `FS_NOT_OBSERVED` 拒绝,同时
  允许其它插件通过 `fs/write-intent` 拦截。该服务未挂载时改用 `node:fs`,但策略判定
  已在前——并且结果会**明说**(`via: node:fs (fs service failed: …)`),集成问题
  不会静默。
* `ws_ls` 跳过 `.git` / `node_modules`,每根目录最多输出 200 条路径。
* `ws_diff` 每侧最多对齐 4000 行,更大文件退化为体量摘要。

## 测试

```bash
npm test
```

31 条断言,基于一次性 DSH home 与两个一次性根目录:注册、注册表增删、组选择、
读/对比/列目录、dry-run、逐根变更状态、路径越界拒绝、root id 校验,以及沙箱用例
(`danger-full-access`、`workspace-write` 拒绝、`read-only` 拒绝、注册表写入策略)。

测试桩复现了两条**曾让本插件在真实启动中整行回滚**的 cordis 规则,并在回归时立即失败:

* 未在 `inject` 中声明的服务不是可读属性——`ctx.systemPrompt` 会**抛错**(而非返回
  undefined),并把整行连同其已注册的工具一起悄悄带走;可选服务必须用 `ctx.get(name)` 读;
* 提示词位次由中枢分配——`getSectionOrder()` 对未知位次名返回 undefined,而 order 非
  有限数会抛错。本插件使用 `TOOLS_SDK` 位次并带数字兜底。

### 启动诊断

`WSM_DEBUG=1` 会把启动各阶段(模块求值 → apply → tools 服务就绪 → 注册结果)写入
stderr 与 `<tmpdir>/dsh-workspace-merge-debug.log`。当 row 已在合成树里、但会话中
看不到工具时,用它定位。

## 许可证

MIT © 宋朝阳
