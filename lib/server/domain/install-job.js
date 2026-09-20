// L1 · domain —— install-job.js（安装任务编排：多通道安装 + 套装补丁 + 适配门 + 收尾）。
// 分层 Step 8c-2 从 lib/index.js 搬出；形参由 ctx 收窄为 ports（调用方注入的窄接口），只搬移未改逻辑。
// 分组见 D:\dsh\dsh-plugin-hub-plan\architecture.zh.md 三

import { readFileSync, existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { aiRepair } from './ai-run.js'
import { maybeAutoAdaptCompat } from './compat.js'
import { DEFAULT_BUNDLES, addBundleToManifest, backfillMissingDeps, curlManualInstall, detectBundleOnly, ensureBundlePatchIntegrity, githubReleaseInstall, pnpmInstall, raceInstallChannels, readBundlePatchRefNames, readGithubAuth, syncAggregateSubpackageVersions } from './install.js'
import { fetchRepoPackage, fetchSubpackageNames, subpackageCandidates } from './market.js'
import { appendInsert, readPatchState, syncNameFromNote } from './patch.js'
import { deriveEntryId, listEntries } from './runtime.js'
import { detectSkillRepo, runSkillInstallJob } from './skills.js'
import { gitCloneUrls, orderedRegistries, readSources } from './sources.js'
import { probeGitmodules, resolveInstallKind, runSuiteInstallJob } from './suite.js'
import { execFileAsync } from '../infra/exec.js'
import { cleanupStalePackageDir } from '../infra/fsx.js'
import { GITHUB_API, curlJson, githubJson } from '../infra/http.js'
import { entryPkgMeta, findPatchPath, packageNameOf, profileDirOf, resolvePackageJson } from '../infra/paths.js'

async function runInstallJob(job, ports) {
  try {
    job.stage = 'preparing'
    // 2026-09-06 事故（室友机器）：对 deepseek-ai/deepseek-harness（框架本体仓库）点「添加到本地/安装」
    // 会按 bundle 规则注册其 patch，其中 deepseek-ai-dsh-root 等框架级行的包只存在于 npx 缓存/框架树，
    // profile node_modules 不存在 → 整服务启动崩溃。直接拦截。
    const repoNorm = String(job.repo ?? '').toLowerCase().replace(/^git\+/u, '').replace(/\.git$/u, '')
    if (repoNorm === 'deepseek-ai/deepseek-harness') {
      job.status = 'failed'
      job.error = '这是 DSH 框架本体仓库，不能按插件安装（其组件引用框架内部包，安装后会导致服务启动失败）。如需升级框架请用「框架升级」按钮；如需生态插件请选择 dsh-plugin 插件仓库。'
      return
    }
    let candidates = [job.packageName].filter((name) => typeof name === 'string' && name !== '')
    let subpackageMode = false
    if (candidates.length === 0) {
      // 套装兜底：submodule 聚合仓库（根 .gitmodules 内容校验通过）→ 自动转套装安装，
      // 不依赖前端标记（搜索结果 enrich 是异步的、索引浏览条目无 enrich）。
      // 判据是**内容**（resolveInstallKind），不是"探测非 null"：后者会把代理/CDN 对不存在文件回的
      // 2xx 空 body、垃圾页当成套装（2026-09-19 用户反馈的「未找到 .gitmodules」事故根因）。
      if (resolveInstallKind(job.kind, await probeGitmodules(job.repo)) === 'suite') {
        job.kind = 'suite'
        const suiteResult = await runSuiteInstallJob(job, ports)
        // clone 后才发现没有 .gitmodules（探测假阳性 / 仓库已重构）→ 回落普通安装，不给用户一个失败
        if (suiteResult?.notASuite !== true) return
        job.kind = 'plugin'
        job.suiteNote = '探测到的 .gitmodules 与仓库实际内容不符（不是 submodule 套装仓库），已自动回落普通插件安装'
      }
      // 兜底：宿主端自行拉取仓库元数据（githubJson 与 curl 竞速 + 3s 超时降级，黑洞期不卡 40s）
      const meta = await Promise.race([
        Promise.any([
          githubJson(`${GITHUB_API}/repos/${job.repo}`),
          curlJson(`${GITHUB_API}/repos/${job.repo}`, 12000),
        ]),
        new Promise((resolve) => setTimeout(() => resolve(null), 3000)),
      ]).catch(() => null)
      const branch = meta?.default_branch ?? 'main'
      const pkg = await fetchRepoPackage(job.repo, branch)
      if (pkg === null) {
        // 无 package.json：先探测是否技能仓库（含 SKILL.md）→ 自动转技能安装；
        // 否则标记 hint=repo-land，前端给出「仓库落地」一键入口（克隆到本地目录）。
        const skillProbe = await detectSkillRepo(job.repo, branch)
        if (skillProbe.hasSkill) {
          job.kind = 'skill'
          await runSkillInstallJob(job, ports)
          return
        }
        job.status = 'failed'
        job.hint = 'repo-land'
        job.error = `仓库 ${job.repo} 没有 package.json（也不是技能仓库），无法作为插件安装——可改用「仓库落地」克隆到本地目录。`
        return
      }
      if (pkg.private === true) {
        // 私有 monorepo 根：自动列出子包作为候选（把人工修复经验自动化），聚合包优先
        subpackageMode = true
        candidates = await subpackageCandidates(job.repo, branch)
        if (candidates.length === 0) {
          job.status = 'failed'
          job.error = `仓库 ${job.repo} 的根包未发布到 npm（private: true）且未发现子包；请到"查看"详情确认`
          return
        }
        job.subpackages = candidates
      } else {
        candidates = [pkg.name]
      }
      job.packageName = pkg.name
    }
    // 给了根包名但根包实际是 private 聚合仓库（如直接填 dsh-web-ui）：
    // 与仓库模式同路径——直接展开子包（聚合包优先），跳过 git 装根包的无意义尝试
    if (!subpackageMode && job.repo && job.packageName !== null) {
      const rootPkg = await fetchRepoPackage(job.repo, 'main')
      if (rootPkg !== null && rootPkg.private === true) {
        subpackageMode = true
        const subs = await subpackageCandidates(job.repo, 'main', readGithubAuth().token)
        if (subs.length > 0) {
          candidates = [...subs.filter((name) => !candidates.includes(name)), ...candidates]
          job.subpackages = subs
        }
      }
    }
    job.stage = 'installing'
    const patchPath = findPatchPath(ports)
    const profileDir = dirname(patchPath)
    const taken = new Set(listEntries(ports).map((entry) => entry.rowId))
    const patch = await readPatchState(patchPath)
    for (const id of [...patch.inserts, ...patch.disables, ...patch.forced]) taken.add(id)
    let installedName = null
    let lastError = null
    let expanded = false
    // 可配置软件源：主→备依次尝试（默认 npmmirror → npmjs，可增删自定义/内网源）
    const registries = orderedRegistries(readSources())
    const deadline = Date.now() + 8 * 60 * 1000
    for (let index = 0; index < candidates.length && installedName === null; index += 1) {
      if (Date.now() > deadline) break
      const name = candidates[index]
        // 加法优化：包已在 node_modules 且名字匹配时，不再重复安装/触发 EPERM，直接进入启用流程
        if (installedName === null) {
          const existingTarget = join(profileDir, 'node_modules', name, 'package.json')
          if (existsSync(existingTarget)) {
            try {
              const existingPkg = JSON.parse(readFileSync(existingTarget, 'utf8'))
              if (existingPkg && existingPkg.name === name && job.update !== true) {
                installedName = name
                job.curlNote = `已检测到本地已安装 ${name}@${existingPkg.version ?? '?'}，跳过重复下载`
              }
            } catch {}
          }
        }
        // 加法并行竞速：pnpm 与 curl 同时启动，先成功者生效；失败方 abort，不影响后续串行通道
        if (installedName === null && !subpackageMode && !expanded) {
          const raced = await raceInstallChannels(profileDir, name, registries)
          if (raced) {
            installedName = name
            if (raced.channel === 'curl') {
              const racedInfo = raced.info
              const stillMissing = await backfillMissingDeps(profileDir, racedInfo.missingDeps, registries)
              job.curlNote = `已通过并行 curl 通道安装 v${racedInfo.version}${stillMissing.length > 0 ? `（依赖仍未补齐：${stillMissing.join('、')}，网络恢复后建议重新安装）` : '（捆绑依赖已补齐）'}`
              if (racedInfo.boxNote) job.curlNote += `（盒子验证：${racedInfo.boxNote}）`
            }
          }
        }
      // 通道 1..n：配置的软件源依次尝试（每源 90 秒封顶）
      for (let ri = 0; ri < registries.length && installedName === null; ri += 1) {
        try {
          await pnpmInstall(profileDir, name, registries[ri])
          installedName = name
          break
        } catch (error) {
          lastError = error
        }
      }
      if (installedName === null) {
        // 通道 n+1：curl 手动安装（node 网络黑洞时 pnpm 下载卡死、curl 可用）——
        // 下载 registry tarball 解压到 node_modules，零依赖包可完整安装
        if (!subpackageMode && !expanded) {
          try {
            const info = await curlManualInstall(profileDir, name, registries)
            installedName = name
            const stillMissing = await backfillMissingDeps(profileDir, info.missingDeps, registries)
            job.curlNote = `已通过 curl 通道安装 v${info.version}${stillMissing.length > 0 ? `（依赖仍未补齐：${stillMissing.join('、')}，网络恢复后建议重新安装）` : '（捆绑依赖已补齐）'}`
            if (info.boxNote) job.curlNote += `（盒子验证：${info.boxNote}）`
          } catch (curlError) {
            lastError = curlError
          }
        }
      }
      if (installedName === null) {
        // 通道 n+1b：GitHub release 下载安装（npm 上不存在的包，例如面板自身
        // @deepseek-ai/dsh-plugin-console）——拉 latest release 源码 tarball → 盒子验证 → 覆盖。
        // 触发条件：curl 通道失败（registry 404/网络），且能从 job.repo 或已装包 repository 反查到 GitHub。
        if (!subpackageMode && !expanded) {
          let ghRepo = typeof job.repo === 'string' && job.repo !== '' && job.repo.includes('/') ? job.repo : null
          if (ghRepo === null) {
            try {
              const meta = entryPkgMeta(name, ports.baseUrl ?? 'file:///', profileDirOf(ports))
              const repoUrl = typeof meta?.repository === 'string' ? meta.repository : (meta?.repository && typeof meta.repository === 'object' ? meta.repository.url : null)
              const m = typeof repoUrl === 'string' ? repoUrl.replace(/^git\+/u, '').match(/github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?$/u) : null
              if (m) ghRepo = m[1]
            } catch {}
          }
          if (ghRepo !== null) {
            try {
              const info = await githubReleaseInstall(profileDir, ghRepo, name)
              installedName = name
              const stillMissing = await backfillMissingDeps(profileDir, info.missingDeps, registries)
              job.curlNote = `已通过 GitHub release 通道安装 v${info.version}${stillMissing.length > 0 ? `（依赖仍未补齐：${stillMissing.join('、')}，网络恢复后建议重新安装）` : '（捆绑依赖已补齐）'}`
              if (info.boxNote) job.curlNote += `（盒子验证：${info.boxNote}）`
            } catch (ghError) {
              lastError = ghError
            }
          }
        }
      }
      if (installedName === null) {
        // 通道 n+2：git 通道（GitHub 走加速代理+直连；Gitee 走对应平台；各 60 秒封顶）
        if (!subpackageMode && !expanded) {
          const gitSpecs = job.source === 'gitee'
            ? [`git+https://gitee.com/${job.repo}.git`]
            : [
                ...gitCloneUrls(job.repo).map((u) => `git+${u}`),
                `github:${job.repo}`,
              ]
          for (const spec of gitSpecs) {
            try {
              await pnpmInstall(profileDir, spec, undefined, 60000)
              installedName = name
              break
            } catch (gitError) {
              lastError = gitError
            }
          }
        }
      }
      if (installedName !== null) break
      // Windows 原子替换失败（陈旧目录 / _tmp_ 残留）是 EPERM 类错误的根因：
      // 清理后用主源重试一次（把 AI 人工修复经验自动化，减少 AI 兜底触发）
      if (installedName === null && /EPERM|EACCES|rename/i.test(String(lastError?.message ?? ''))) {
        const cleaned = cleanupStalePackageDir(profileDir, name)
        if (cleaned > 0) {
          try {
            await pnpmInstall(profileDir, name, registries[0])
            installedName = name
          } catch (error) {
            lastError = error
          }
        }
      }
      if (installedName !== null) break
      // 懒惰展开：registry 与 git 通道都失败时，自动发现仓库子包继续尝试（聚合包优先），
      // 覆盖"给了根包名但根包未发布"的场景——AI 兜底只处理真正无解的案例
      if (!expanded && job.repo) {
        expanded = true
        let subs = await fetchSubpackageNames(job.repo, 'main', readGithubAuth().token)
        if (subs.length === 0) subs = await fetchSubpackageNames(job.repo, 'master', readGithubAuth().token)
        if (subs.length > 0) {
          const extra = subs
            .slice()
            .sort((a, b) => Number(/(^|-)all$/u.test(b.name) || /-all-/u.test(b.name)) - Number(/(^|-)all$/u.test(a.name) || /-all-/u.test(a.name)))
            .map((sub) => sub.name)
            .filter((n) => !candidates.includes(n))
            .slice(0, 8)
          if (extra.length > 0) {
            candidates = [...candidates, ...extra]
            if (!Array.isArray(job.subpackages)) job.subpackages = []
            for (const e of extra) if (!job.subpackages.includes(e)) job.subpackages.push(e)
          }
        }
      }
    }
    if (installedName === null) {
      // 本地 AI 兜底会调用模型 API、产生费用：挂起等待用户明确同意后再执行
      job.stage = 'ai-consent'
      job.aiPending = { lastError: lastError?.message ?? null }
      job.aiWait = new Promise((resolve) => { job.aiPending.resolver = resolve })
      const decision = await Promise.race([
        job.aiWait,
        new Promise((resolve) => setTimeout(() => resolve({ approved: false, timeout: true }), 600000)),
      ])
      job.aiPending = null
      job.aiWait = null
      if (decision.approved === true) {
        await aiRepair(job, ports, profileDir, candidates, lastError?.message ?? null)
      } else {
        job.status = 'failed'
        job.error = decision.timeout === true
          ? '等待授权超时（10 分钟），已取消本地 AI 兜底（该操作会调用模型 API 产生费用）'
          : '用户取消本地 AI 兜底（该操作会调用模型 API 产生费用）'
      }
      return
    }
    job.packageName = installedName
    // 聚合包子包版本对齐（确保更新后所有子包也到新版声明版本）
    let syncedNames = []
    try {
      const synced = await syncAggregateSubpackageVersions(profileDir, installedName, registries)
      if (synced.length > 0) {
        syncedNames = synced.map(syncNameFromNote).filter((n) => n !== null)
        job.bundleNote = (job.bundleNote ? job.bundleNote + '；' : '') + `子包版本对齐：更新 ${synced.length} 个（${synced.join('、')}）`
      }
    } catch {}
    // 聚合包完整性保障（防崩）：bundle patch 引用的包缺失 → 补装；仍缺自动禁用该行。
    // 本次作业刚同步过版本的包（syncedNames）处于更新瞬时态，跳过"缺失自动禁用"判定。
    try {
      const integrity = await ensureBundlePatchIntegrity(profileDir, installedName, patchPath, [...syncedNames, installedName])
      if (integrity.checked > 0) {
        job.bundleNote = `聚合包完整性：检查 ${integrity.checked} 个引用`
          + (integrity.installed.length > 0 ? `，补装 ${integrity.installed.length} 个（${integrity.installed.join('、')}）` : '')
          + (integrity.disabled.length > 0 ? `，自动禁用缺失行 ${integrity.disabled.length} 个（${integrity.disabled.join('、')}）` : '')
          + (integrity.pending.length > 0 ? `，本次已同步包跳过缺失判定 ${integrity.pending.length} 个（${integrity.pending.join('、')}）` : '')
          + (integrity.missing.length > 0 ? `，仍缺失 ${integrity.missing.join('、')}（网络恢复后建议重新更新）` : '')
      }
    } catch {}
    // 框架升级适配门：更新完成后自动校验兼容性，通过则移除禁用块解锁启用
    try {
      const adapt = await maybeAutoAdaptCompat({ profileDir, packageName: installedName, syncedNames, patchPath, ports })
      if (adapt !== null && adapt.ran === true) job.compatNote = adapt.note
    } catch {}
    job.stage = 'configuring'
    // 2026-09-06 事故（i18n 更新变重复行）：@linxin666/dsh-i18n 声明了 dsh.bundle.patch，
    // 更新流程按「bundle 安装规则」把它追加进 bundles → 与全家桶内的 web-ui-i18n 行（同包）重复。
    // 防护：该包已被现有行提供 → 只更新包，不注册任何新行/bundle。
    const alreadyServed = listEntries(ports).some((e) => String(e.moduleName).startsWith(installedName)
      || String(e.moduleName) === installedName
      || packageNameOf(e.moduleName) === installedName)
    if (await detectBundleOnly(profileDir, installedName)) {
      // 官方 dsh plugin add 行为：声明 dsh.bundle 的包追加为 profile bundle 层，
      // 其 cordis.patch.yml 在下次启动时参与组合（含皮肤包与 web-ui-settings 这类有入口的包）
      if (!alreadyServed) {
        // 通用防线（2026-09-06 事故：装 dsh-desktop 类插件时,其 bundle patch 引用 @deepseek-ai/dsh-root 等
        // 框架级行,包不在 profile node_modules → 注册后整服务启动崩溃）：
        // 注册前校验 bundle patch 引用的行模块全部可解析（**含 @deepseek-ai/* —— 正是室友崩塌的那些框架级包**）,
        // 缺失即拒绝注册并给出清单。
        const refs = readBundlePatchRefNames(profileDir, installedName)
        const missing = refs.filter((n) => resolvePackageJson(n, profileDir) === null)
        if (missing.length > 0) {
          job.status = 'failed'
          job.error = `该聚合包（${installedName}）的插件组引用以下未安装模块：${missing.join('、')}。若这些是框架内部包（@deepseek-ai/*）,该包不能作为插件安装（会导致服务启动失败）；若为本应随包安装的依赖,请重试或检查网络。已取消注册。`
          return
        }
        await addBundleToManifest(profileDir, installedName)
        job.bundle = true
      } else {
        job.bundleNote = (job.bundleNote ? job.bundleNote + '；' : '') + `${installedName} 已由已安装聚合包提供，仅更新包本身，不再注册重复行`
      }
      job.status = 'done'
      return
    }
    if (alreadyServed) {
      job.note = `${installedName} 已由已安装条目提供，仅更新包本身，不重复注册`
      job.status = 'done'
      return
    }
    const entryId = deriveEntryId(installedName, taken)
    await appendInsert(patchPath, entryId, installedName)
    job.entryId = entryId
    job.status = 'done'
  } catch (error) {
    job.status = 'failed'
    job.error = error instanceof Error ? error.message : String(error)
  } finally {
    job.finishedAt = Date.now()
  }
}

/** 用 corepack pnpm 移除包（与安装同一管理器与凭据抑制环境）。
 * 注意：pnpm remove 不支持 --registry 选项，去掉避免静默失败。 */
async function pnpmRemove(profileDir, packageName) {
  const args = ['pnpm', 'remove', packageName]
  const opts = {
    cwd: profileDir,
    timeout: 120000,
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, COREPACK_NPM_REGISTRY: 'https://registry.npmmirror.com', GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
  }
  if (process.platform === 'win32') {
    const corepackJs = join(dirname(process.execPath), 'node_modules', 'corepack', 'dist', 'corepack.js')
    if (existsSync(corepackJs)) {
      await execFileAsync(process.execPath, [corepackJs, ...args], opts)
      return
    }
    const cmd = `${JSON.stringify('corepack')} ${args.map((arg) => JSON.stringify(arg)).join(' ')}`
    await execFileAsync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', cmd], opts)
    return
  }
  await execFileAsync('corepack', args, opts)
}

/** 读取用户额外 bundle（非官方模板）的补丁插入行 id 与包名，用于"额外插件"判定。 */
async function readExtraBundleRows(profileDir) {
  const rows = new Set()
  try {
    const manifest = JSON.parse(await readFile(join(profileDir, 'package.json'), 'utf8'))
    const bundles = manifest.dsh?.profile?.bundles ?? []
    for (const pkg of bundles) {
      if (DEFAULT_BUNDLES.includes(pkg)) continue
      try {
        const pk = resolvePackageJson(pkg, profileDir)
        const dir = dirname(pk ?? join(profileDir, 'node_modules', ...String(pkg).split('/'), 'package.json'))
        const text = await readFile(join(dir, 'cordis.patch.yml'), 'utf8')
        const lines = text.split(/\r?\n/u)
        let inInsert = false
        for (let index = 0; index < lines.length; index += 1) {
          const line = lines[index]
          if (/^- insert:\s*$/u.test(line)) {
            inInsert = true
            continue
          }
          if (/^- /u.test(line)) inInsert = false
          if (!inInsert) continue
          const idMatch = line.match(/^ {4}- id: ([A-Za-z0-9_.-]+)\s*$/u)
          if (!idMatch) continue
          rows.add(idMatch[1])
          const nameMatch = (lines[index + 1] ?? '').match(/^ {6}name: ['"]([^'"]+)['"]\s*$/u)
          if (nameMatch) rows.add(nameMatch[1])
        }
      } catch {}
    }
  } catch {}
  return rows
}
export { runInstallJob, pnpmRemove, readExtraBundleRows }
