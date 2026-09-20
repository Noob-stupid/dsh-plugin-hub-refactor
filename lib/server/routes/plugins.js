// L2 · routes —— 插件开关与清理（/toggle · /uninstall · /clean-residuals · /self-update · /adapt-unlock · /adapt-unlock-all）
// 分层 Step 8b：从 lib/index.js 的 handle() 原样搬出（只搬移未改逻辑；缩进保持原样）

import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { checkPluginFrameworkCompat, probePluginImport, readCompatPending, rowIdModuleMap, writeCompatPending } from '../domain/compat.js'
import { pnpmRemove } from '../domain/install-job.js'
import { curlManualInstall, readExtraBundleOwners } from '../domain/install.js'
import { disableEntry, enableEntry, readPatchState, removeDisableBlock, removeInsertRow } from '../domain/patch.js'
import { markPendingAdopted } from '../domain/quarantine.js'
import { pendingRestartJobs, packageDirIn, needsPnpmRemove, revokePendingInstall } from '../domain/revoke.js'
import { deriveEntryId, isProtectedModule } from '../domain/runtime.js'
import { orderedRegistries, readSources } from '../domain/sources.js'
import { fetchJsonUrl } from '../infra/http.js'
import { sendError, sendJson } from '../infra/httpd.js'
import { removeDirVerified } from '../infra/fsx.js'
import { findPatchPath, pluginRoot, resolvePackageJson, rowIdOf } from '../infra/paths.js'
import { installJobs } from '../state.js'

/** 插件控制台自身的包名（撤销分支禁止删自己；@deepseek-ai/* 由通用护栏拒绝）。 */
const CONSOLE_PACKAGE = '@noob-stupid/dsh-plugin-console'

/**
 * 把与这次删除对应的「已安装·重启后生效」任务记为已撤销（/state 的 pendingRestart 据此过滤）。
 * 为什么两处都要调：无论按 entryId（重启后从列表删）还是按 jobId（重启前撤销）删掉一个包，
 * 它的安装任务若还挂着 status==='done'，/state 就会继续显示一行删不掉的幽灵行。
 * 同一包名的多条记录（装过又更新过）一并作废 —— 它们指向同一个包。
 */
function markJobsRevoked(packageName, rowId) {
  for (const job of installJobs.values()) {
    if (job.status !== 'done' || job.revokedAt !== undefined) continue
    if (job.packageName === packageName || (typeof rowId === 'string' && rowId !== '' && job.entryId === rowId)) {
      job.revokedAt = Date.now()
    }
  }
}

async function routeToggle(req, res, rc) {
  const isProtectedModule = rc.deps.isProtectedModule
  const rowIdModuleMap = rc.deps.rowIdModuleMap
  const ctx = rc.ctx
  const url = rc.url
  const pathname = rc.pathname
  const method = rc.method
  const body = rc.body
    const { entryId, enabled } = body
    if (typeof entryId !== 'string' || !/^[A-Za-z0-9_:.-]{1,80}$/u.test(entryId)) {
      sendError(res, 400, 'entryId 无效')
      return
    }
    if (typeof enabled !== 'boolean') {
      sendError(res, 400, 'enabled 必须是布尔值')
      return
    }
    const exists = ctx.loader.entries().some((entry) => entry.id === entryId)
    if (!exists) {
      sendError(res, 404, `没有名为 ${entryId} 的插件条目`)
      return
    }
    const target = ctx.loader.entries().find((entry) => entry.id === entryId)
    if (isProtectedModule(target?.options?.name)) {
      sendError(res, 403, `${target.options.name} 属于宿主基础设施，禁止开关（停用会破坏热加载/传输/存储链）`)
      return
    }
    const rowId = rowIdOf(ctx, entryId)
    if (rowId === 'plugin-console') {
      sendError(res, 400, '不能停用插件控制台自身')
      return
    }
    if (enabled) {
      // 框架升级适配门（用户定案 2026-09-11：**软禁**）——自动禁用的目的是「保证新框架能起来」，
      // 不是「剥夺用户控制权」：默认自动禁用，但允许手动强行启用（首次请求返回 needsConfirm，
      // 前端弹风险提示确认框；带 confirmRisky:true 才放行）。
      // 注意下面还有一条**硬**门禁：启用前的 import 冒烟检查——那条是事实性崩溃（模块根本加载不了），
      // 不允许覆盖（否则下次启动必崩，与「服务永不崩」冲突）。
      const compatPending = readCompatPending()
      const pend = (compatPending?.pending ?? []).find((p) => p.rowId === rowId && (p.status ?? 'pending') === 'pending')
      if (pend) {
        if (body.confirmRisky !== true) {
          sendError(
            res,
            409,
            `「${rowId}」在框架升级适配门清单中（框架 ${compatPending.frameworkVersion ?? '?'}${pend.checkNote ? `，判定：${pend.checkNote}` : ''}）——已自动禁用。强行启用可能让 DSH 下次启动失败，需要你确认。`,
            {
              code: 'compat-confirm',
              rowId,
              moduleName: pend.moduleName ?? null,
              frameworkVersion: compatPending.frameworkVersion ?? null,
              checkNote: pend.checkNote ?? null,
            },
          )
          return
        }
        try {
          const next = readCompatPending()
          const rec = (next?.pending ?? []).find((p) => p.rowId === rowId)
          if (rec) { rec.riskyApprovedAt = Date.now(); writeCompatPending(next) }
        } catch {}
      }
    }
    const patchPath = findPatchPath(ctx)
    // 启用前冒烟检查（服务永不崩机制）：第三方模块在独立子进程中试 import，
    // 失败（SyntaxError/缺失导出/模块缺失）即拒绝启用，杜绝「单行 import 失败→整个服务启动崩溃」
    if (enabled) {
      const moduleName = target?.options?.name
      if (typeof moduleName === 'string' && !moduleName.startsWith('cordis:') && !moduleName.startsWith('@deepseek-ai/')) {
        try {
          const probe = await probePluginImport(moduleName, dirname(patchPath))
          if (probe.ok !== true) {
            sendError(res, 409, `启用前冒烟检查未通过：模块加载失败（${probe.detail ?? '未知'}）——该插件与当前框架不兼容或依赖缺失，已阻止启用（服务不会再被拖崩）；请先「检测更新/更新并适配」其适配版`)
            return
          }
        } catch {}
      }
    }
    const result = enabled
      ? await enableEntry(patchPath, rowId)
      : await disableEntry(patchPath, rowId)
    // v0.3.45（用户定案：启用即视为已适配，但保留痕迹）：手动启用一个待适配行后，
    // 清单里的 pending 记录要转成 adopted —— 否则重启后界面上会出现「已启用却还挂着【待适配】」，
    // 用户实测就是这样（5 行）。check / checkNote / riskyApprovedAt 一律保留供事后查。
    if (enabled) {
      try {
        const list = readCompatPending()
        const meta = rowIdModuleMap(ctx).get(rowId) ?? null
        if (list !== null && markPendingAdopted(list, rowId, 'manual-enable', meta)) {
          list.updatedAt = new Date().toISOString()
          writeCompatPending(list)
        }
      } catch {}
    }
    sendJson(res, 200, { ok: true, entryId, rowId, enabled, changed: result.changed, patchPath })
    return
}

/**
 * 按安装任务撤销「已安装但尚未生效」的安装（/uninstall 的 jobId 分支）。
 *
 * 2026-09-20 真装真卸演练实测的缺口：面板装完插件后 /install 返回 entryId: null、
 * GET /state 里新增 loader 条目 = 0（bundle 型要重启才被加载），而旧 /uninstall 只按
 * **运行中** loader 条目查找 → 恒 404，于是「刚装错的插件在重启前无法从面板卸载」。
 * 安全护栏与 entry 分支完全一致：@deepseek-ai/* · isProtectedModule · 控制台自身。
 */
async function uninstallByJobId(res, rc, jobId) {
  const isProtectedModule = rc.deps.isProtectedModule
  const listEntries = rc.deps.listEntries
  const pnpmRemove = rc.deps.pnpmRemove
  const ctx = rc.ctx
    const job = installJobs.get(jobId)
    if (job === undefined) {
      sendError(res, 404, `没有这个安装任务（jobId=${jobId}）——无法撤销`)
      return
    }
    if (job.revokedAt !== undefined) {
      sendError(res, 400, `该安装任务已经撤销过了（${new Date(job.revokedAt).toISOString()}），无需重复操作`)
      return
    }
    if (job.status !== 'done') {
      sendError(res, 400, job.status === 'installing'
        ? `该安装任务还在进行中（stage=${job.stage ?? '?'}），完成后才能撤销`
        : `该安装任务没有成功装成（status=${job.status}${job.error ? `：${job.error}` : ''}），没有可撤销的安装`)
      return
    }
    const packageName = typeof job.packageName === 'string' ? job.packageName.trim() : ''
    if (packageName === '') {
      sendError(res, 400, '该安装任务没有记录包名（可能未装成、或已由现有聚合包提供），无法按任务撤销')
      return
    }
    if (packageName.startsWith('@deepseek-ai/')) {
      sendError(res, 403, `${packageName} 是 DSH 框架官方包，禁止删除`)
      return
    }
    if (isProtectedModule(packageName)) {
      sendError(res, 403, `${packageName} 属于宿主基础设施，禁止删除`)
      return
    }
    const rowId = typeof job.entryId === 'string' && job.entryId !== '' ? job.entryId : deriveEntryId(packageName, new Set())
    if (rowId === 'plugin-console' || packageName === CONSOLE_PACKAGE) {
      sendError(res, 400, '不能删除插件控制台自身')
      return
    }
    // 本分支只服务「已安装但尚未生效」：包名若已在运行中的 loader 条目里（重启已完成），
    // 撤销会留下「包已删、模块还挂在内存里」的半状态 —— 如实拒绝并指路（按列表条目删除）。
    if (pendingRestartJobs([job], listEntries(ctx)).length === 0) {
      sendError(res, 400, `「${packageName}」已经在运行中的插件列表里（重启已完成）——请直接在列表里删除该条目，不必按 jobId 撤销`)
      return
    }
    const patchPath = findPatchPath(ctx)
    const profileDir = dirname(patchPath)
    const result = await revokePendingInstall(job, { profileDir, patchPath, pnpmRemove })
    // 只有包目录真的没了才算「这次安装已撤销」：此后不再出现在 /state 的 pendingRestart 里。
    // 包还在盘上时不打这个标记 —— 保留待重启条目让用户能再点一次删除，比假装干净好。
    if (result.verified.packageGone === true) markJobsRevoked(result.packageName, typeof job.entryId === 'string' ? job.entryId : null)
    sendJson(res, 200, {
      ok: true,
      removed: 'pending-install',
      jobId,
      packageName: result.packageName,
      bundle: result.bundle,
      restart: false,
      rowIds: result.rowIds,
      verified: result.verified,
      warn: result.warn,
      uninstallError: result.uninstallError,
    })
    return
}

async function routeUninstall(req, res, rc) {
  const isProtectedModule = rc.deps.isProtectedModule
  const pnpmRemove = rc.deps.pnpmRemove
  const ctx = rc.ctx
  const url = rc.url
  const pathname = rc.pathname
  const method = rc.method
  const body = rc.body
    // 入参两种形态：entryId（运行中的 loader 条目）· jobId（已安装但尚未生效的安装任务，见 domain/revoke.js）
    const { entryId, jobId } = body
    const entryIdOk = typeof entryId === 'string' && /^[A-Za-z0-9_:.-]{1,80}$/u.test(entryId)
    const jobIdOk = typeof jobId === 'string' && /^[A-Za-z0-9_.:-]{1,80}$/u.test(jobId)
    if (!entryIdOk && !jobIdOk) {
      sendError(res, 400, 'entryId 无效（撤销尚未生效的安装请改传 jobId）')
      return
    }
    const entry = entryIdOk ? ctx.loader.entries().find((candidate) => candidate.id === entryId) : undefined
    if (!entry) {
      if (jobIdOk) {
        await uninstallByJobId(res, rc, jobId)
        return
      }
      sendError(res, 404, `没有名为 ${entryId} 的插件条目`)
      return
    }
    const moduleName = entry.options.name
    const rowId = rowIdOf(ctx, entryId)
    if (rowId === 'plugin-console') {
      sendError(res, 400, '不能删除插件控制台自身')
      return
    }
    if (isProtectedModule(moduleName)) {
      sendError(res, 403, `${moduleName} 属于宿主基础设施，禁止删除`)
      return
    }
    const patchPath = findPatchPath(ctx)
    const profileDir = dirname(patchPath)
    const patch = await readPatchState(patchPath)
    // bundle 来源的额外插件（如皮肤中心）：删除其所属 bundle
    const owners = await readExtraBundleOwners(profileDir)
    const ownerBundle = owners.get(rowId) ?? owners.get(moduleName)
    if (ownerBundle !== undefined) {
      // 2026-09-04 事故教训：删除聚合包子路径行（如 @linxin666/dsh-web-all/plugin-manager）时
      // 曾把整个 bundle 从清单移除，pnpm 卸载失败（corepack 报错）后重启，全家桶整体消失。
      // 现改为：任何 bundle 行的「删除」= 仅停用该行（patch disabled:true），bundle 清单不动，
      // 之后随时可「启用」恢复；整体卸载请走包管理器。
      await disableEntry(patchPath, rowId)
      sendJson(res, 200, {
        ok: true,
        removed: 'row',
        packageName: moduleName,
        restart: false,
        note: '该行来自聚合包 ' + ownerBundle + '，已仅停用本行（bundle 保留，可随时启用恢复）；整体卸载请用包管理器执行 pnpm remove ' + ownerBundle,
      })
      return
    }
    if (!patch.inserts.includes(rowId)) {
      sendError(res, 400, '该插件不是用户安装的额外插件（不可删除）')
      return
    }
    await removeInsertRow(patchPath, rowId)
    let uninstallError = null
    // 目录已不在、manifest 也没引用 → 不必再拉一次 pnpm：那只会在本机换来一句没有信息量的
    // "Command failed: corepack pnpm remove …"（演练实测）。判断规则与 jobId 撤销分支同一套。
    if (await needsPnpmRemove(profileDir, moduleName)) {
      try {
        await pnpmRemove(profileDir, moduleName)
      } catch (error) {
        uninstallError = error instanceof Error ? error.message : String(error)
      }
    }
    // 任务记录是否作废看**事实**（包目录真的没了），不看 pnpm 的退出码；删不干净时留着让用户重试
    if (!existsSync(packageDirIn(profileDir, moduleName))) markJobsRevoked(moduleName, rowId)
    sendJson(res, 200, { ok: true, removed: 'entry', packageName: moduleName, restart: false, uninstallError })
    return
}

async function routeAdaptUnlock(req, res, rc) {
  const ctx = rc.ctx
  const url = rc.url
  const pathname = rc.pathname
  const method = rc.method
  const body = rc.body
    // 待适配行「已适配，立即解锁」：无需等新版本——对已装模块重跑源码扫描，通过即移除禁用块。
    const rowId = typeof body.rowId === 'string' ? body.rowId : ''
    if (!/^[A-Za-z0-9_:.-]{1,80}$/u.test(rowId)) {
      sendError(res, 400, 'rowId 无效')
      return
    }
    const pending = readCompatPending()
    const entry = (pending?.pending ?? []).find((p) => p.rowId === rowId && (p.status ?? 'pending') === 'pending')
    if (entry === undefined) {
      sendError(res, 404, '该行不在适配门待适配清单中（或已解锁）')
      return
    }
    const patchPath = findPatchPath(ctx)
    const profileDir = dirname(patchPath)
    let pkg = null
    let pkgDir = null
    let version = null
    try {
      const require = createRequire(join(profileDir, 'package.json'))
      const pkgPath = resolvePackageJson(entry.moduleName, profileDir)
      if (pkgPath !== null) {
        pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
        version = typeof pkg?.version === 'string' ? pkg.version : null
        pkgDir = dirname(pkgPath)
      }
    } catch {}
    const fwVer = typeof pending.frameworkVersion === 'string' ? pending.frameworkVersion : '?'
    const check = pkg !== null ? checkPluginFrameworkCompat(pkg, fwVer, pkgDir) : { decision: 'unknown', reason: '无法读取包信息' }
    if (check.decision === 'fail') {
      sendError(res, 409, `适配校验未通过：${check.reason}`)
      return
    }
    await removeDisableBlock(patchPath, rowId)
    entry.status = 'adopted'
    entry.adoptedAt = Date.now()
    entry.adoptedVersion = version
    entry.adoptedFramework = fwVer
    entry.check = check.decision
    entry.checkNote = check.reason ?? null
    writeCompatPending(pending)
    sendJson(res, 200, { ok: true, rowId, adopted: true, check: check.decision, note: check.reason ?? null })
    return
}

async function routeAdaptUnlockAll(req, res, rc) {
  const rowIdModuleMap = rc.deps.rowIdModuleMap
  const ctx = rc.ctx
  const url = rc.url
  const pathname = rc.pathname
  const method = rc.method
  const body = rc.body
    // 全家桶「一键启用已适配」：对家庭内所有待适配行批量重跑源码扫描，通过的全部解锁，未通过保留禁用。
    const root = typeof body.root === 'string' ? body.root : ''
    if (!/^(@[a-z0-9-][a-z0-9-._~]*\/)?[a-z0-9-][a-z0-9-._~]*$/u.test(root) || root.length > 214) {
      sendError(res, 400, 'root 无效')
      return
    }
    const pending = readCompatPending()
    const patchPath = findPatchPath(ctx)
    const profileDir = dirname(patchPath)
    // v0.3.45：匹配规则改成「moduleName 前缀 **或** 属主行集合」——
    // 隔离记录合并进来的老行 moduleName 为空（脚本只写 rowId），只按 moduleName 比会匹配不到，
    // 于是用户点「一键启用已适配」得到「该全家桶没有待适配行」（实测就是这个）。
    const info = rowIdModuleMap(ctx)
    const bundleRowIds = new Set()
    for (const [rowId, meta] of info) {
      const name = meta?.moduleName
      if (typeof name === 'string' && name !== '' && (name === root || name.startsWith(root + '/'))) bundleRowIds.add(rowId)
    }
    const inFamily = (p) => {
      if (typeof p.moduleName === 'string' && p.moduleName !== '' && (p.moduleName === root || p.moduleName.startsWith(root + '/'))) return true
      return bundleRowIds.has(p.rowId) || info.get(p.rowId)?.moduleName === root
    }
    // 目标 = ① 待适配（pending）② **已记已适配、但从没通过源码扫描**（check !== 'pass'）。
    // ② 这类正是"账面上已适配、补丁里却还禁着"的行 —— 老逻辑只挑 pending，于是用户点「一键启用已适配」
    // 得到"没有待适配行、无需操作"，可它们其实一行都没启用（实测就是这个）。
    const targets = (pending?.pending ?? []).filter((p) => {
      if (!inFamily(p)) return false
      const status = p.status ?? 'pending'
      if (status === 'pending') return true
      return status === 'adopted' && p.check !== 'pass'
    })
    if (targets.length === 0) {
      // 无待适配行=全部已适配/已解锁，属正常状态：返回友好提示而非错误（点击「一键启用已适配」不应报"操作失败"）
      sendJson(res, 200, { ok: true, unlocked: [], kept: [], note: '该全家桶内没有待扫描/待解锁的行（全部已通过源码扫描或已解锁）' })
      return
    }
    const fwVer = typeof pending.frameworkVersion === 'string' ? pending.frameworkVersion : '?'
    const unlocked = []
    const kept = []
    for (const p of targets) {
      let pkg = null
      let pkgDir = null
      let version = null
      try {
        const pkgPath = resolvePackageJson(p.moduleName, profileDir)
        if (pkgPath !== null) {
          pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
          version = typeof pkg?.version === 'string' ? pkg.version : null
          pkgDir = dirname(pkgPath)
        }
      } catch {}
      const check = pkg !== null ? checkPluginFrameworkCompat(pkg, fwVer, pkgDir) : { decision: 'fail', reason: '无法读取包信息' }
      if (check.decision === 'fail') {
        kept.push({ rowId: p.rowId, reason: check.reason })
        continue
      }
      await removeDisableBlock(patchPath, p.rowId)
      p.status = 'adopted'
      p.adoptedAt = Date.now()
      p.adoptedVersion = version
      p.adoptedFramework = fwVer
      p.check = check.decision
      p.checkNote = check.reason ?? null
      unlocked.push(p.rowId)
    }
    writeCompatPending(pending)
    // kept = 扫描未通过（保持禁用，并带上原因）；unlocked = 本次真解锁的行
    sendJson(res, 200, {
      ok: true,
      root,
      unlocked,
      kept,
      scanned: targets.length,
      note: kept.length === 0
        ? `已重跑源码扫描并解锁 ${unlocked.length} 行`
        : `扫描 ${targets.length} 行：解锁 ${unlocked.length} 行，${kept.length} 行未通过（保持禁用，原因见下）`,
    })
    return
}

async function routeCleanResiduals(req, res, rc) {
  const ctx = rc.ctx
  const url = rc.url
  const pathname = rc.pathname
  const method = rc.method
  const body = rc.body
    // 清理残余备份/旧子包：删除 .old-* 备份目录，以及聚合包未声明的 @linxin666 旧子包
    const profileDir = dirname(findPatchPath(ctx))
    const nodeModules = join(profileDir, 'node_modules')
    const removed = []
    const failed = []
    // 1) 删除 .old-* 残余备份（顶层 + 作用域目录）
    const scanDirs = [nodeModules]
    try { if (existsSync(join(nodeModules, '@linxin666'))) scanDirs.push(join(nodeModules, '@linxin666')) } catch {}
    for (const dir of scanDirs) {
      try {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue
          if (!/\.old-/u.test(entry.name)) continue
          const target = join(dir, entry.name)
          // 核实后再计入 removed：删不掉却报成功会让用户以为清干净了（见 removeDirVerified 注释）
          const r = removeDirVerified(target)
          if (r.ok) removed.push(entry.name)
          else failed.push({ name: entry.name, path: target, error: r.error })
        }
      } catch {}
    }
    // 2) 删除聚合包未声明的 @linxin666 旧子包（以 dsh-web-ui-all 的 dependencies 为准）
    try {
      const allPkgPath = join(nodeModules, '@linxin666', 'dsh-web-ui-all', 'package.json')
      if (existsSync(allPkgPath)) {
        const allPkg = JSON.parse(readFileSync(allPkgPath, 'utf8'))
        const declared = new Set(Object.keys(allPkg.dependencies ?? {}).filter((n) => n.startsWith('@linxin666/')))
        declared.add('@linxin666/dsh-web-ui-all')
        const scoped = join(nodeModules, '@linxin666')
        for (const entry of readdirSync(scoped, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue
          const full = '@linxin666/' + entry.name
          if (declared.has(full)) continue
          const pkgJson = join(scoped, entry.name, 'package.json')
          if (existsSync(pkgJson)) {
            const target = join(scoped, entry.name)
            const r = removeDirVerified(target)
            if (r.ok) removed.push(full)
            else failed.push({ name: full, path: target, error: r.error })
          }
        }
      }
    } catch {}
    if (failed.length > 0) {
      sendJson(res, 200, { ok: false, removed, count: removed.length, failed, error: `有 ${failed.length} 项没能删除（目录仍存在）：${failed.map((f) => f.name).join('、')}——当前环境可能禁止删除，请手动处理` })
      return
    }
    sendJson(res, 200, { ok: true, removed, count: removed.length })
    return
}

async function routeSelfUpdate(req, res, rc) {
  const ctx = rc.ctx
  const url = rc.url
  const pathname = rc.pathname
  const method = rc.method
  const body = rc.body
    // Hub 自身一键更新：下载 npm 最新 tarball 到当前 profile，成功后由前端重启生效
    let selfVersion = null
    try {
      const selfPkg = JSON.parse(readFileSync(join(pluginRoot(), 'package.json'), 'utf8'))
      selfVersion = typeof selfPkg.version === 'string' ? selfPkg.version : null
    } catch {}
    let latest = null
    try {
      const data = await fetchJsonUrl('https://registry.npmmirror.com/@noob-stupid%2fdsh-plugin-console')
      latest = data?.['dist-tags']?.latest ?? null
    } catch {}
    if (!latest || selfVersion === null || latest === selfVersion) {
      sendJson(res, 200, { ok: false, current: selfVersion, latest, updated: false, reason: latest === selfVersion ? '已是最新版本' : '版本检测失败' })
      return
    }
    const profileDir = dirname(findPatchPath(ctx))
    const registries = orderedRegistries(readSources())
    try {
      const info = await curlManualInstall(profileDir, '@noob-stupid/dsh-plugin-console', registries)
      sendJson(res, 200, { ok: true, current: selfVersion, latest, updated: true, version: info.version, note: '已下载最新代码，重启服务后生效' })
    } catch (error) {
      sendError(res, 500, `Hub 自动更新失败：${error instanceof Error ? error.message : String(error)}`)
    }
    return
}

export { routeToggle, routeUninstall, routeAdaptUnlock, routeAdaptUnlockAll, routeCleanResiduals, routeSelfUpdate }
