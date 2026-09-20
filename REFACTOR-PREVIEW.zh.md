# 分层重构预览线（对外指针 + 后续抽包规划）

> 本文件属于**重构线**，随 `dsh-hub-Exp` 一起维护。最后更新：2026-09-14。

## 一、这条线是什么

| 项 | 说明 |
|---|---|
| 工作仓库 | `dsh-hub-Exp`（**私有**，用户看不到；重构的所有提交都在这里） |
| 对外指针 | **独立公开仓库**：[`Noob-stupid/dsh-plugin-hub-refactor`](https://github.com/Noob-stupid/dsh-plugin-hub-refactor)（本仓库，默认分支 `main`） |
| 对外发布 | GitHub **Pre-release `v0.4.0-beta.7`**（标注实验性，指向该分支） |
| 稳定线 | hub `main` = 单体版 **0.3.51**（npm `latest`，用户日常用这个） |

**为什么单独开一个仓库**（用户 2026-09-14 决定）：① 预览线与稳定线的入口彻底分开，用户不会误装；② hub 仓库的 Releases/分支/tag 只保留稳定版，不再出现"单体 + 重构"两条线混在一起；③ 本仓库 `package.json` 标了 `"private": true`，物理上不可能误发 npm 覆盖稳定版；④ 将来的抽包（Stage 2）直接在这里做，天然是独立的包工作区。

## 二、预览版包含什么

- `lib/index.js`：**142 行**（只剩插件元信息 + `apply` 装配）
- `lib/server/**`：**36 个模块** = 7 infra + 18 domain + 11 routes + `state.js`
- 47 个路由 handler 从 `handle()`（2758 行 / 45 条 if 分支）搬进 `lib/server/routes/**`，改为**表驱动分发**
- 宿主服务经 `routeDeps()` / `rc.deps` **注入**，domain 层零 `ctx`（形参统一为 ports）
- 依赖方向由测试守卫强制：`routes → domain → infra`
- 测试套件同步为模块化版本（**18 套**，含新增的 `test-architecture-guard.mjs` 与 `test-suite-detect.mjs`）

**功能零变化**：与单体版逐条对打 47 条路由，`status` + 响应字段 **47/47 一致**。

## 三、已验证 / 未验证（发布前必须如实告知）

已验收：18/18 套件（46 条路由契约 + 12 条响应契约 + 落盘格式契约）、8 条架构守卫断言、部署副本哈希一致 + 真实 HTTP 探针、与单体版的路由差分。

**尚未实测**：真框架升级 / 真回滚、重启守护链路、真装真卸（pnpm）、组件进程启停、AI 真跑、Gitee OAuth 回调。
→ 主观风险估计：上述长尾存在"测试看不见的缺陷"的概率约 **10%~25%**。**这是预览版只发 Pre-release、不进 npm 的原因。**

## 四、抽包（Stage 2）—— 以后在本线做，现在**不做**

用户 2026-09-14 的决定：**先不抽包**；将来仍在**本预览线**里做。

### 方案里的三个包（`architecture.zh.md` §五）

| 包 | 迁出模块 | 对外价值 | npm 名是否可用 |
|---|---|---|---|
| `@noob-stupid/dsh-plugin-manager` | `patch` + `install`（含 `install-job`/`suite`） | 任何人写 DSH 工具都能"装/卸/启停插件" | ✅ 未占用（2026-09-14 查） |
| `@noob-stupid/dsh-upgrade-guard` | `framework` + `compat`（含 `quarantine`/`presets`） | 升级前备份、失败回滚、适配门 | ✅ 未占用 |
| `@noob-stupid/dsh-deploy-planner` | `ai` + `components`（含 `ai-run`） | 来源 → AI 出计划 → 白名单执行 | ✅ 未占用 |
| hub 自身保留 | `sources` `market` `skills` `repoland` + `routes` + `client` | 三个包的**第一个消费者** | —— |

### 开工前必须先解开的 6 处边界问题（2026-09-14 实测，按真实 import 统计）

| 越界 | 处数 | 性质 | 建议解法 |
|---|---|---|---|
| `manager → hub 保留` | 5 | hub 依赖 manager、manager 又依赖 hub 的模块 → 无法分家 | 把被依赖的小件下沉到共享层 |
| `deploy-planner → hub 保留` | 1 | 同上 | 同上 |
| `manager → upgrade-guard`、`manager → deploy-planner` | 各 1 | **环**（与 `guard→manager`、`planner→guard` 对冲） | 解环：公共依赖下沉 |
| `共享 infra → upgrade-guard` | 1 | **反向依赖**（`domain/runtime.js → domain/compat.js`） | `runtime.js` 归入 upgrade-guard，或把该引用下沉 |
| 安装流程 | —— | 现在用户是"复制 `lib/` + `package.json`"；hub 一旦依赖三个外部包，这条文档路径会断 | 改为 pnpm 安装，或把依赖打进包；升级/回滚脚本里"备份插件自身"的逻辑需同步改 |

### 待定决策（抽包开工前必须先定）

**共享 infra（`paths` `semver` `http` `fsx` `exec` `mask` `httpd` + `state.js` `jobs.js` `runtime.js`）放哪？**

- **A（推荐）**：独立第 4 个包 `@noob-stupid/dsh-plugin-core` —— 三个包都只依赖它，环立刻消失，`manager` 也不会变成"什么都装"的大包。
- **B（按方案字面）**：塞进 `manager`，另两个包依赖 `manager` —— 改动小，但 `manager` 职责会浑（"插件管理"里带 http 客户端与状态管理）。

### 抽包时的工作方式（沿用分层阶段的纪律）

1. 一次一刀、**一步一个 commit**，每刀都跑：18 套测试 + 架构守卫 + 与单体版差分 + 部署冒烟；
2. 包边界 = 现有模块边界，**不改业务逻辑**，只改 import 路径与 `package.json`；
3. 版本与发布：三个包先 `npm pack` 本地验证，**发布等用户明确点头**；发布顺序 core → manager → guard → planner → hub；
4. 三个包各自带 README / LICENSE / SECURITY，并各自带最小单测（领域模块已可脱离 cordis 单测）。

## 五、这条线的纪律（不变）

- 重构提交**只进 `dsh-hub-Exp`**；对 hub 的公开动作（分支/标签/Release）须经用户明确指示；
- **hub `main` 保持单体版**，直到用户决定把预览线合入；
- 任何"回补产品 bug"的动作单独走 `main`（2026-09-13 已回补 3 条，见 `refactor-bugs.zh.md`）。
