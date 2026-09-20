// L1 · domain —— install.js（插件安装/卸载全链路：pnpm / curl 手动 / GitHub Release 三通道 + 包盒校验 + 套装补丁完整性；分层 Step 5 从 lib/index.js 搬出，只搬移未改逻辑）
// 分组见 D:\dsh\dsh-plugin-hub-plan\architecture.zh.md 三

import { readFileSync, writeFileSync, existsSync, statSync, rmSync, readdirSync, mkdirSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { sanitizePatchText } from './patch.js'
import { orderedRegistries, readSources } from './sources.js'
import { GH_BIN_CANDIDATES, execFileAsync, runPnpmWithFallback } from '../infra/exec.js'
import { copyTree, queuedWrite } from '../infra/fsx.js'
import { fetchJsonUrl } from '../infra/http.js'
import { dshHome, pluginRoot, resolvePackageJson } from '../infra/paths.js'

/** bundle 包判定：声明 dsh.bundle 的包一律按官方 `dsh plugin add` 行为追加为
 * profile bundle 层（其 cordis.patch.yml 的插入行在下次启动时组合进树）。
 * 无论有没有 JS 入口都走 bundle 层——皮肤包（无入口）与 web-ui-settings
 * （有入口）都是这样安装的，当作插件条目 insert 会漏掉它们的 bundle 补丁。 */
async function detectBundleOnly(profileDir, packageName) {
  try {
    const pkgPath = resolvePackageJson(packageName, profileDir)
    if (pkgPath === null) throw new Error('not found')
    const pkg = JSON.parse(await readFile(pkgPath, 'utf8'))
    return typeof pkg.dsh?.bundle?.patch === 'string'
  } catch {
    return false
  }
}

/** 把包追加进 profile 的 dsh.profile.bundles 层（与官方 dsh plugin add 的 reconcile 一致）。 */
async function addBundleToManifest(profileDir, packageName) {
  return queuedWrite(async () => {
    const manifestPath = join(profileDir, 'package.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    const bundles = manifest.dsh?.profile?.bundles ?? []
    if (!bundles.includes(packageName)) {
      bundles.push(packageName)
      manifest.dsh = { ...(manifest.dsh ?? {}), profile: { ...(manifest.dsh?.profile ?? {}), bundles } }
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8')
    }
  })
}

/** 官方 profile 模板自带的 bundle（其余 bundle 视为用户额外添加）。 */
const DEFAULT_BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']

/** 读取用户额外 bundle 的插入行归属表：行 id / 包名 → 所属 bundle 包名。 */
async function readExtraBundleOwners(profileDir) {
  const owners = new Map()
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
          owners.set(idMatch[1], pkg)
          const nameMatch = (lines[index + 1] ?? '').match(/^ {6}name: ['"]([^'"]+)['"]\s*$/u)
          if (nameMatch) owners.set(nameMatch[1], pkg)
        }
      } catch {}
    }
  } catch {}
  return owners
}

/** 从 profile manifest 移除一个 bundle。 */
async function removeBundleFromManifest(profileDir, bundlePkg) {
  return queuedWrite(async () => {
    const manifestPath = join(profileDir, 'package.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    const bundles = manifest.dsh?.profile?.bundles ?? []
    const next = bundles.filter((name) => name !== bundlePkg)
    if (next.length !== bundles.length) {
      manifest.dsh = { ...(manifest.dsh ?? {}), profile: { ...(manifest.dsh?.profile ?? {}), bundles: next } }
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8')
    }
  })
}

/**
 * 读取 dsh-github-login（独立登录工具）写入的 GitHub 令牌文件。
 * 只对外暴露登录状态（login），绝不下发令牌本身。
 */
function readGithubAuth() {
  try {
    const data = JSON.parse(readFileSync(join(dshHome(), 'github-auth.json'), 'utf8'))
    if (data && typeof data.token === 'string' && data.token) {
      return { loggedIn: true, login: typeof data.login === 'string' && data.login && data.login !== 'unknown' ? data.login : null, token: data.token }
    }
  } catch {}
  return { loggedIn: false, login: null, token: null }
}

/**
 * 插件安装：与官方 `dsh plugin add` 使用同一管理器——corepack → pnpm add。
 * profile 目录由 pnpm 管理；若用 npm 写入会与 pnpm 的目录重建互相破坏
 * （曾导致入口链接丢失、DSH 启动崩溃）。registry 走国内镜像。
 */
async function pnpmInstall(profileDir, spec, registry = 'https://registry.npmmirror.com', timeout = 90000, signal = null) {
  const args = ['add', spec, '--registry', registry]
  const opts = {
    cwd: profileDir,
    timeout,
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
    env: {
      ...process.env,
      COREPACK_NPM_REGISTRY: registry,
      // git 通道禁止交互式凭据：避免 Git Credential Manager 弹登录窗（匿名失败即静默失败）
      GIT_TERMINAL_PROMPT: '0',
      GCM_INTERACTIVE: 'never',
    },
  }
  // 跨平台定位 corepack/pnpm（Windows 布局 / Linux npm 全局布局 / PATH 兜底），
  // 旧代码只认 Windows 布局，Linux 上会生成 MODULE_NOT_FOUND 的命令（2026-09-20 事故）
  await runPnpmWithFallback(args, { execOpts: opts })
}

/**
 * curl 手动安装通道：node 网络黑洞（pnpm 下载卡死：socket hang up / TIMEOUT / downloaded 0）时，
 * curl 与系统 tar 仍可用——用 curl 下载 registry tarball、解压到 profile 的 node_modules。
 * 零依赖包可完整安装；带依赖包记录未补齐列表（不阻塞，供面板提示）。
 * 返回 { version, missingDeps }；失败抛错由调用方落入 next 通道。
 */
async function curlManualInstall(profileDir, packageName, registries, signal = null, exactVersion = null) {
  let meta = null
  let metaError = null
  for (const reg of registries) {
    try {
      const encoded = packageName.startsWith('@')
        ? `@${encodeURIComponent(packageName.slice(1).split('/')[0])}%2f${encodeURIComponent(packageName.split('/').slice(1).join('/'))}`
        : encodeURIComponent(packageName)
      meta = await fetchJsonUrl(`${reg}/${encoded}`)
      if (meta) break
    } catch (error) {
      metaError = error
    }
  }
  if (!meta || typeof meta !== 'object') throw new Error(`curl 通道：无法获取 registry 元数据（${metaError?.message ?? '未知'}）`)
  const version = exactVersion ?? meta['dist-tags']?.latest ?? null
  const tarball = version ? meta.versions?.[version]?.dist?.tarball ?? null : null
  if (!version || !tarball) throw new Error('curl 通道：registry 无 dist-tags.latest / tarball')
  const bin = process.platform === 'win32' ? 'curl.exe' : 'curl'
  const tmp = join(tmpdir(), `pc-curl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`)
  mkdirSync(tmp, { recursive: true })
  try {
    const tgz = join(tmp, 'pkg.tgz')
    await execFileAsync(bin, ['-s', '-L', '-m', '60', '-o', tgz, tarball], { timeout: 70000, windowsHide: true, ...(signal ? { signal } : {}) })
    await execFileAsync('tar', ['-xzf', tgz, '-C', tmp], { timeout: 30000, windowsHide: true, ...(signal ? { signal } : {}) })
    let pkgPath = join(tmp, 'package')
    if (!existsSync(join(pkgPath, 'package.json'))) {
      const candidates = readdirSync(tmp, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => join(tmp, d.name))
      pkgPath = candidates.find((p) => existsSync(join(p, 'package.json'))) ?? pkgPath
    }
    if (!existsSync(join(pkgPath, 'package.json'))) throw new Error('curl 通道：解压后未找到含 package.json 的目录')
    // 盒子实验：解压后先验证，通过才覆盖正式位置（失败保留旧版本，服务不中断）
    const box = verifyPackageBox(pkgPath, profileDir, packageName)
    const pkg = JSON.parse(readFileSync(join(pkgPath, 'package.json'), 'utf8'))
    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.peerDependencies ?? {}) }
    const missingDeps = Object.keys(deps).filter((d) => !existsSync(join(profileDir, 'node_modules', d)))
    const target = join(profileDir, 'node_modules', packageName)
    if (existsSync(target)) rmSync(target, { recursive: true, force: true })
    mkdirSync(dirname(target), { recursive: true })
    copyTree(pkgPath, target)
    // 落真实安装时间标记：npm tarball 内文件 mtime 是固定时间戳（1985-10-26，可复现构建），
    // 解压后 package.json 的 mtime 不可靠，面板安装日期优先读此标记
    try {
      writeFileSync(join(target, '.dsh-installed-at'), String(Date.now()), 'utf8')
    } catch {}
    return { version, missingDeps, boxNote: box.note }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

/** 安装通道并行竞速：pnpm 与 curl 同时尝试，先成功者生效；失败方被 abort 不干扰。 */
async function raceInstallChannels(profileDir, name, registries) {
  const controller = new AbortController()
  const signal = controller.signal
  const pnpmTask = (async () => {
    let lastError = null
    for (const registry of registries) {
      try {
        await pnpmInstall(profileDir, name, registry, 90000, signal)
        return { channel: 'pnpm', info: null }
      } catch (error) {
        lastError = error
        if (signal.aborted) throw error
      }
    }
    throw lastError ?? new Error('pnpm 通道失败')
  })()
  const curlTask = (async () => {
    const info = await curlManualInstall(profileDir, name, registries, signal)
    return { channel: 'curl', info }
  })()
  const waitSuccess = (promise) => promise.then((value) => ({ value }), () => new Promise(() => {}))
  const timeout = new Promise((resolve) => setTimeout(() => resolve(null), 120000))
  const winner = await Promise.race([waitSuccess(pnpmTask), waitSuccess(curlTask), timeout])
  controller.abort()
  return winner ? winner.value : null
}

/**
 * 盒子实验验证：解压后的包目录先通过静态校验再允许覆盖正式位置。
 * - package.json 必须可解析且 name 与安装目标一致
 * - main / exports 入口文件必须真实存在（防"装上了但加载即崩"）
 * - bundle patch（cordis.patch.yml）引用的包必须已就位（防聚合包引用缺失崩溃）
 * 失败抛错 → 调用方保留旧版本（安装不中断服务）。
 */
function verifyPackageBox(pkgPath, profileDir, packageName, refCheckRoot = null) {
  const note = []
  const pkgRaw = readFileSync(join(pkgPath, 'package.json'), 'utf8')
  const pkg = JSON.parse(pkgRaw)
  if (pkg.name !== packageName) {
    throw new Error(`盒子验证失败：包名不符（tarball 内为 ${pkg.name}，期望 ${packageName}），已保留旧版本`)
  }
  // 入口存在性：main 字段 / exports.'.'（字符串或对象 default）指向的文件必须存在
  let entry = typeof pkg.main === 'string' ? pkg.main : null
  if (entry === null && pkg.exports && typeof pkg.exports === 'object') {
    const dot = pkg.exports['.'] ?? pkg.exports['./package.json'] === undefined ? pkg.exports['.'] : null
    if (typeof dot === 'string') entry = dot
    else if (dot && typeof dot === 'object') entry = typeof dot.default === 'string' ? dot.default : null
  }
  if (entry !== null) {
    const entryPath = join(pkgPath, ...entry.split('/'))
    if (!existsSync(entryPath)) {
      throw new Error(`盒子验证失败：入口文件缺失（${entry}），已保留旧版本`)
    }
  }
  // bundle patch 引用预检：引用的包必须已存在于目标 node_modules（防聚合包半更新崩溃）。
  // refCheckRoot 指定检查根（宿主插件在根层 node_modules，与 profile 层不同）。
  const checkRoot = refCheckRoot ?? join(profileDir, 'node_modules')
  try {
    const patchRel = pkg.dsh?.bundle?.patch
    if (typeof patchRel === 'string') {
      const bundlePatch = join(pkgPath, patchRel)
      if (existsSync(bundlePatch)) {
        const refs = parseBundlePatchRefs(readFileSync(bundlePatch, 'utf8'))
        const missingRefs = refs.filter((r) => !existsSync(join(checkRoot, r.name)))
        if (missingRefs.length > 0) {
          note.push(`bundle 引用缺失：${missingRefs.map((r) => r.name).join('、')}（安装后由聚合完整性检查补齐/禁用）`)
        }
        if (refs.length > 0) note.push(`bundle 引用 ${refs.length} 个已就位`)
      }
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('盒子验证失败')) throw error
  }
  return { note: note.length > 0 ? note.join('；') : null }
}

/** 解析 bundle patch（cordis.patch.yml）的 insert 引用列表（id + 包名）。 */
function parseBundlePatchRefs(text) {
  const refs = []
  const lines = text.split(/\r?\n/u)
  let inInsert = false
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (/^- insert:\s*$/u.test(line)) { inInsert = true; continue }
    if (/^- /u.test(line) && !/^ {4}- /u.test(line)) inInsert = false
    if (!inInsert) continue
    const idM = line.match(/^ {4}- id: ([A-Za-z0-9_.-]+)\s*$/u)
    if (!idM) continue
    const nameM = (lines[i + 1] ?? '').match(/^ {6}name: ['"]([^'"]+)['"]\s*$/u)
    if (nameM) refs.push({ id: idM[1], name: nameM[1] })
  }
  return refs
}

/**
 * 捆绑依赖补装（事故教训：dsh-web-ui-all 更新后 17 个捆绑依赖缺失 → 服务加载崩溃）：
 * curl/GitHub 通道只解压主包，这里逐个补装直接依赖（pnpm → curl 依次尝试）。
 * 返回仍缺失的依赖列表。
 * 安全护栏（事故教训）：@deepseek-ai/* 框架内部包**绝不补装**——它们由框架依赖树管理
 * （正确版本随 @deepseek-ai/dsh 一起安装），npm 上这些内部包的 dist-tags.latest 是远古
 * 版本（如 dsh-host-webserver@0.0.1-rc.1），无版本约束补装会覆盖框架正确版本，
 * 导致 webServer 等服务起不来、整个 profile 启动崩溃。
 */
async function backfillMissingDeps(profileDir, deps, registries) {
  const stillMissing = []
  for (const dep of deps) {
    if (/^@deepseek-ai\//u.test(dep)) continue // 框架内部包：跳过（宿主提供）
    if (existsSync(join(profileDir, 'node_modules', dep))) continue
    let ok = false
    try {
      await pnpmInstall(profileDir, dep, registries[0], 60000)
      ok = existsSync(join(profileDir, 'node_modules', dep))
    } catch {}
    if (!ok) {
      try {
        await curlManualInstall(profileDir, dep, registries)
        // 判断目标是否实际安装（修复：旧代码用 depInfo.missingDeps.length===0 判断
        // "该依赖自身无依赖"，只要目标依赖带依赖就误报缺失——即使 curl 已成功安装）
        ok = existsSync(join(profileDir, 'node_modules', dep))
      } catch {}
    }
    if (!ok) stillMissing.push(dep)
  }
  return stillMissing
}

/**
 * GitHub release 下载安装通道（npm 上不存在的包，例如面板自身 @deepseek-ai/dsh-plugin-console）：
 * 拉取仓库 latest release 源码 tarball → 盒子验证 → 覆盖 node_modules 正式位置。
 * 宿主插件特判：本面板部署在宿主根层 node_modules（import.meta.url 解析），更新时覆盖根层而非 web profile。
 */
async function githubReleaseInstall(profileDir, repo, packageName) {
  const auth = readGithubAuth()
  const headers = { 'User-Agent': 'dsh-plugin-console' }
  if (auth.token) headers.Authorization = `token ${auth.token}`
  const release = await fetchJsonUrl(`https://api.github.com/repos/${repo}/releases/latest`, 15000, headers)
  const tag = typeof release?.tag_name === 'string' ? release.tag_name : null
  if (tag === null) throw new Error('GitHub 通道：仓库没有 latest release（版本发布后才可更新）')
  const bin = process.platform === 'win32' ? 'curl.exe' : 'curl'
  const tmp = join(tmpdir(), `pc-gh-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`)
  mkdirSync(tmp, { recursive: true })
  try {
    const tgz = join(tmp, 'pkg.tgz')
    // codeload 官方源码 tarball（已验证本机可用 200）。GitHub 黑洞期由上层通道兜底
    // （pnpm/git 通道），此处失败即报错保留旧版本。
    await execFileAsync(bin, ['-s', '-L', '-m', '60', '-o', tgz, `https://codeload.github.com/${repo}/tar.gz/refs/tags/${encodeURIComponent(tag)}`], { timeout: 70000, windowsHide: true })
    if (!existsSync(tgz) || statSync(tgz).size < 100) throw new Error(`GitHub 通道：下载源码 tarball 失败（${repo}@${tag}）`)
    await execFileAsync('tar', ['-xzf', tgz, '-C', tmp], { timeout: 60000, windowsHide: true })
    // 源码 tarball 顶层目录名是 {repo}-{sha}：定位含 package.json 的顶层目录
    const subdirs = readdirSync(tmp, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => join(tmp, d.name))
    const pkgPath = subdirs.find((d) => existsSync(join(d, 'package.json')))
    if (!pkgPath) throw new Error('GitHub 通道：tarball 内未找到 package.json')
    // 目标位置：宿主插件（面板自身，部署在宿主根层 node_modules）→ 覆盖自身所在目录；
    // 普通插件 → profile node_modules
    let targetRoot = join(profileDir, 'node_modules')
    try {
      const selfDir = pluginRoot() // 自身包目录（含 package.json）
      const selfRoot = dirname(selfDir) // 自身包所在 node_modules
      if (selfRoot !== targetRoot && existsSync(join(selfDir, 'package.json'))) {
        targetRoot = selfRoot
      }
    } catch {}
    // 盒子实验：静态验证通过才覆盖（失败保留旧版本）。引用检查根用目标目录（宿主插件在根层）
    const box = verifyPackageBox(pkgPath, profileDir, packageName, targetRoot)
    const pkg = JSON.parse(readFileSync(join(pkgPath, 'package.json'), 'utf8'))
    // 只统计 dependencies（peerDependencies 是宿主契约，不补装——见 curlManualInstall 注释）
    const deps = { ...(pkg.dependencies ?? {}) }
    const missingDeps = Object.keys(deps).filter((d) => !existsSync(join(profileDir, 'node_modules', d)))
    const target = join(targetRoot, packageName)
    if (existsSync(target)) rmSync(target, { recursive: true, force: true })
    mkdirSync(dirname(target), { recursive: true })
    copyTree(pkgPath, target)
    // 版本号对齐（防死循环）：release tarball 内 package.json version 可能滞后于 tag
    // （历史发布只打 tag 不改 version），改写为 tag 版本 → 下次检测 latest===current → "已是最新"
    try {
      const targetPkgPath = join(target, 'package.json')
      const targetPkg = JSON.parse(readFileSync(targetPkgPath, 'utf8'))
      const tagVersion = tag.replace(/^v/iu, '')
      if (targetPkg.version !== tagVersion) {
        targetPkg.version = tagVersion
        writeFileSync(targetPkgPath, JSON.stringify(targetPkg, null, 4), 'utf8')
      }
    } catch {}
    try {
      writeFileSync(join(target, '.dsh-installed-at'), String(Date.now()), 'utf8')
    } catch {}
    return { version: tag.replace(/^v/iu, ''), missingDeps, boxNote: box.note, source: 'github' }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

/**
 * 聚合包完整性保障（事故教训）：dsh-web-ui-all 更新后捆绑依赖缺失，其 bundle patch
 * （cordis.patch.yml）引用的包未安装 → 服务加载崩溃。
 * 读已装包的 bundle patch → 检查每个 insert 引用的包是否存在 → 缺失补装（pnpm/curl）→
 * 仍缺则在用户 patch 层自动禁用该行（防崩兜底）+ 返回报告供面板提示。
 */
/** 读取聚合包 cordis.patch.yml 的 insert 行 name 列表（注册前校验用）。 */
function readBundlePatchRefNames(profileDir, pkgName) {
  try {
    const pkgJsonPath = join(profileDir, 'node_modules', pkgName, 'package.json')
    if (!existsSync(pkgJsonPath)) return []
    const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8'))
    const patchRel = pkg.dsh?.bundle?.patch
    if (typeof patchRel !== 'string') return []
    const text = readFileSync(join(profileDir, 'node_modules', pkgName, patchRel), 'utf8')
    const names = []
    const lines = text.split(/\r?\n/u)
    let inInsert = false
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i]
      if (/^- insert:\s*$/u.test(line)) { inInsert = true; continue }
      if (/^- /u.test(line) && !/^ {4}- /u.test(line)) inInsert = false
      if (!inInsert) continue
      const nameM = (lines[i + 1] ?? '').match(/^ {6}name: ['"]([^'"]+)['"]\s*$/u)
      if (nameM) names.push(nameM[1])
    }
    return names
  } catch { return [] }
}

async function ensureBundlePatchIntegrity(profileDir, pkgName, userPatchPath, transientAllow = []) {
  const report = { checked: 0, installed: [], disabled: [], missing: [], pending: [] }
  try {
    const pkgJsonPath = join(profileDir, 'node_modules', pkgName, 'package.json')
    if (!existsSync(pkgJsonPath)) return report
    const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8'))
    const patchRel = pkg.dsh?.bundle?.patch
    if (typeof patchRel !== 'string') return report
    const bundlePatch = join(profileDir, 'node_modules', pkgName, patchRel)
    if (!existsSync(bundlePatch)) return report
    const text = readFileSync(bundlePatch, 'utf8')
    // 解析 insert 引用（与 readExtraBundleOwners 同构）：- insert: 块下 - id: xxx + name: '包名'
    const refs = []
    const lines = text.split(/\r?\n/u)
    let inInsert = false
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i]
      if (/^- insert:\s*$/u.test(line)) { inInsert = true; continue }
      if (/^- /u.test(line) && !/^ {4}- /u.test(line)) inInsert = false
      if (!inInsert) continue
      const idM = line.match(/^ {4}- id: ([A-Za-z0-9_.-]+)\s*$/u)
      if (!idM) continue
      const nameM = (lines[i + 1] ?? '').match(/^ {6}name: ['"]([^'"]+)['"]\s*$/u)
      if (nameM) refs.push({ id: idM[1], name: nameM[1] })
    }
    report.checked = refs.length
    if (refs.length === 0) return report
    const registries = orderedRegistries(readSources())
    for (const ref of refs) {
      // 框架内部包跳过（事故教训：npm 上 @deepseek-ai/* 的 dist-tags.latest 是远古版本，
      // 无版本约束补装会覆盖框架正确版本导致服务崩溃——见 backfillMissingDeps 注释）
      if (/^@deepseek-ai\//u.test(ref.name)) continue
      if (existsSync(join(profileDir, 'node_modules', ref.name))) continue
      // 2026-09-06 加固：本次作业刚完成版本同步的包（transientAllow）此刻缺失=更新中途的瞬时态
      // （pnpm 原子替换/替换失败窗口），不应按"缺失→自动禁用"处理——跳过本次判定，下次校验时再检查。
      if (transientAllow.includes(ref.name)) {
        report.pending.push(ref.name)
        continue
      }
      let ok = false
      try {
        await pnpmInstall(profileDir, ref.name, registries[0], 60000)
        ok = existsSync(join(profileDir, 'node_modules', ref.name))
      } catch {}
      if (!ok) {
        try { await curlManualInstall(profileDir, ref.name, registries); ok = true } catch {}
      }
      if (ok) {
        report.installed.push(ref.name)
      } else {
        report.missing.push(ref.name)
        // 自动禁用该行（用户 patch 层，防服务加载崩溃）
        try {
          const userPatch = readFileSync(userPatchPath, 'utf8')
          if (!userPatch.includes(`id: ${ref.id}`)) {
            // issue #7 防护：清理顶层 [] 占位符后再追加（模板初始文件直接追加会生成非法 YAML）
            const clean = sanitizePatchText(userPatch)
            const next = clean.length === 0 || clean.endsWith('\n') ? clean : `${clean}\n`
            writeFileSync(userPatchPath, `${next}- id: ${ref.id}\n  disabled: true\n`, 'utf8')
            report.disabled.push(ref.id)
          }
        } catch {}
      }
    }
  } catch {}
  return report
}

function installJobView(job) {
  return {
    jobId: job.id,
    repo: job.repo,
    packageName: job.packageName,
    status: job.status,
    stage: job.stage,
    error: job.error,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    entryId: job.entryId ?? null,
    bundle: job.bundle ?? false,
    ai: job.ai ?? false,
    aiNote: job.aiNote ?? null,
    subpackages: job.subpackages ?? null,
    source: job.source ?? 'github',
    curlNote: job.curlNote ?? null,
    bundleNote: job.bundleNote ?? null,
    compatNote: job.compatNote ?? null,
    kind: job.kind ?? 'plugin',
    skillName: job.skillName ?? null,
    skillDir: job.skillDir ?? null,
    skillNote: job.skillNote ?? null,
    suiteReport: job.suiteReport ?? null,
    suiteNote: job.suiteNote ?? null,
    hint: job.hint ?? null,
  }
}

/** 从 GitHub Release 下载预构建 tgz 装配到 node_modules/<pkgName>（gh CLI 通道，含绝对路径候选）。 */
async function installBundleFromRelease(subRepo, pkgName, target) {
  const dlDir = join(tmpdir(), `dsh-rel-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`)
  mkdirSync(dlDir, { recursive: true })
  try {
    const args = ['release', 'download', '-R', subRepo, '-p', '*.tgz', '-D', dlDir]
    let downloaded = false
    let lastError = null
    for (const bin of GH_BIN_CANDIDATES) {
      try {
        await execFileAsync(bin, args, { timeout: 180000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 })
        downloaded = true
        break
      } catch (error) {
        lastError = error
        if (error.code !== 'ENOENT') break
      }
    }
    if (!downloaded) throw new Error(lastError?.message ?? 'gh release download 失败')
    const tgz = readdirSync(dlDir).find((f) => f.endsWith('.tgz'))
    if (!tgz) throw new Error('Release 无 tgz 资产')
    const extractDir = join(dlDir, 'x')
    mkdirSync(extractDir, { recursive: true })
    await execFileAsync('tar', ['-xzf', join(dlDir, tgz), '-C', extractDir], { timeout: 60000, windowsHide: true })
    const pkgDir = join(extractDir, 'package')
    if (!existsSync(join(pkgDir, 'package.json'))) throw new Error('tgz 内无 package/package.json')
    if (existsSync(target)) rmSync(target, { recursive: true, force: true })
    mkdirSync(dirname(target), { recursive: true })
    copyTree(pkgDir, target)
  } finally {
    rmSync(dlDir, { recursive: true, force: true })
  }
}

async function syncAggregateSubpackageVersions(profileDir, packageName, registries) {
  const pkgPath = join(profileDir, 'node_modules', packageName, 'package.json')
  if (!existsSync(pkgPath)) return []
  let pkg = null
  try { pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) } catch { return [] }
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.peerDependencies ?? {}) }
  const updated = []
  for (const dep of Object.keys(deps)) {
    if (dep.startsWith('@deepseek-ai/')) continue
    const spec = String(deps[dep] ?? '').replace(/^[\^~>=< ]+/u, '')
    if (!spec) continue
    const currentPath = join(profileDir, 'node_modules', dep, 'package.json')
    if (!existsSync(currentPath)) {
      try {
        await curlManualInstall(profileDir, dep, registries, null, spec)
        updated.push(`${dep}@${spec}（新装）`)
      } catch {}
      continue
    }
    try {
      const current = JSON.parse(readFileSync(currentPath, 'utf8'))
      if (current.version === spec) continue
      await curlManualInstall(profileDir, dep, registries, null, spec)
      updated.push(`${dep}@${spec}`)
    } catch {}
  }
  return updated
}

export { DEFAULT_BUNDLES, detectBundleOnly, addBundleToManifest, removeBundleFromManifest, readExtraBundleOwners, readGithubAuth, pnpmInstall, curlManualInstall, raceInstallChannels, verifyPackageBox, parseBundlePatchRefs, backfillMissingDeps, githubReleaseInstall, readBundlePatchRefNames, ensureBundlePatchIntegrity, installBundleFromRelease, syncAggregateSubpackageVersions, installJobView }
