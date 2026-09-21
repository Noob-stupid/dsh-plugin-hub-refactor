// L1 · domain —— selfupdate.js（控制台自更新：**包管理器优先**，保证升级真的写进 pnpm-lock.yaml）
//
// 缺陷背景（2026-09-20 用户实测报告，附完整时间线）：
//   旧的 `/self-update` 直接把 npm tarball 的文件铺进 profile 的 node_modules，**不碰 pnpm-lock.yaml**；
//   而 profile 的依赖是 pnpm 按 lock 管理的（`dsh plugin` 本身就是 pnpm 的薄转发器）。于是只要发生
//   **任何一次 pnpm 操作**——开关任意插件（会改 `dsh.profile.bundles`）、`dsh plugin add/remove/install`——
//   pnpm 就按 lock 重装，把刚"升级"上去的版本**还原**回 lock 里钉住的旧版本。
//   用户侧现象：UI 一直提示有新版（package.json 写 `^0.3.47` 允许 0.3.54），点更新显示成功、重启后还是旧版。
//
// 现在的顺序：① spec 是版本范围 → `pnpm update <pkg>`（spec 不变、lock 提到范围内最新）
//            ② 仍不是 latest（超出范围 / spec 是 git·file 来源）→ `pnpm add <pkg>@<latest>`（spec 与 lock 同步改写）
//            ③ 回读核实 readInstalledVersion / lockVersion；都不匹配才回落手铺文件，且**必须**带 lockNote 警告。
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pnpmInstall } from './install.js'
import { runPnpmWithFallback } from '../infra/exec.js'

const CONSOLE_PACKAGE = '@noob-stupid/dsh-plugin-console'

/** spec 是否是 registry 版本范围（`^1.2.3` / `~1.2.3` / `1.2.3` / `>=1` / `=1`）。
 * 只有这种才能用 `pnpm update` 在**不改写 spec**的前提下把 lock 提到范围内最新；
 * git / file / link / workspace 来源没有"范围"可言，只能走 `pnpm add <pkg>@<版本>`。 */
function isRegistryRange(spec) {
  if (typeof spec !== 'string') return false
  const s = spec.trim()
  if (/^[\^~]?\d/u.test(s)) return true
  return /^(>=|>|=)\s*\d/u.test(s)
}

/** profile 里该包的依赖声明（spec）。读不到返回 null。 */
function profileSpec(profileDir, name) {
  try {
    const pkg = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
    const spec = pkg?.dependencies?.[name]
    return typeof spec === 'string' ? spec : null
  } catch {
    return null
  }
}

/** 已安装版本（直接读 node_modules 里那份 package.json）。 */
function readInstalledVersion(profileDir, name) {
  try {
    const pkg = JSON.parse(readFileSync(join(profileDir, 'node_modules', ...name.split('/'), 'package.json'), 'utf8'))
    return typeof pkg?.version === 'string' ? pkg.version : null
  } catch {
    return null
  }
}

/**
 * 从 pnpm-lock.yaml 读出该包被**钉住**的版本。
 * 解析策略（lock 格式五花八门，只认两种确定性位置，避免子串误命中）：
 *   ① importers 段：行内容恰为 `'<name>':`（可带缩进），随后几行内的 `version: X`；
 *   ② packages 段：行首（可带缩进/引号）`<name>@<版本或 git+...>:` 的键名。
 * 读不到返回 null（调用方据此判定"没能核实"，不谎报成功）。
 */
function lockVersion(profileDir, name) {
  const file = join(profileDir, 'pnpm-lock.yaml')
  if (!existsSync(file)) return null
  let lines = []
  try {
    lines = readFileSync(file, 'utf8').split(/\r?\n/u)
  } catch {
    return null
  }
  for (let i = 0; i < lines.length; i += 1) {
    const bare = lines[i].trim().replace(/^'|':?$/gu, '').replace(/'$/u, '')
    if (bare === name || lines[i].trim() === `'${name}':`) {
      for (let k = i + 1; k < Math.min(i + 5, lines.length); k += 1) {
        const m = /^\s*version:\s*(\S+)\s*$/u.exec(lines[k])
        if (m) return m[1]
        if (/^\s*\S+:/u.test(lines[k]) && !/^\s*version:/u.test(lines[k])) break
      }
    }
  }
  const escaped = name.replace(/[/\\^$*+?.()|[\]{}]/gu, '\\$&')
  const keyRe = new RegExp(`^\\s*'?${escaped}@([^':\\s]+)'?:`, 'u')
  for (const line of lines) {
    const m = keyRe.exec(line)
    if (m) return m[1]
  }
  return null
}

/** 给用户的兜底建议命令（照用户报告里那条：让 lock 也变成新版本，而不是只改文件）。 */
function selfUpdateCommand(latest, profileName = '<你的profile>') {
  return `dsh plugin --profile ${profileName} add ${CONSOLE_PACKAGE}@${latest}`
}

/**
 * 把控制台升到 `latest` 并**确保写进 lock**。
 * 依赖以参数注入（便于单测替换）：`runPnpm`（默认 runPnpmWithFallback）、`pnpmAdd`（默认 pnpmInstall）、
 * `curlManualInstall`（手铺文件兜底，由路由传入）。
 */
async function selfUpdateToLatest({ profileDir, latest, registries, curlManualInstall, runPnpm = runPnpmWithFallback, pnpmAdd = pnpmInstall, profileName = null, execOpts = {} }) {
  const command = selfUpdateCommand(latest, profileName ?? '<你的profile>')
  const spec = profileSpec(profileDir, CONSOLE_PACKAGE)
  const errors = []
  let method = null
  const label = (e) => (e instanceof Error ? e.message : String(e))

  // ① spec 是版本范围 → pnpm update（spec 不变，lock 提到范围内最新）
  if (isRegistryRange(spec)) {
    try {
      await runPnpm(['update', CONSOLE_PACKAGE], { execOpts: { cwd: profileDir, timeout: 300000, ...execOpts } })
      method = 'pnpm-update'
    } catch (error) {
      errors.push(`pnpm update 失败：${label(error)}`)
    }
  }
  // ② 还没到 latest（超出 range / git·file 来源）→ pnpm add <pkg>@<latest>（spec 与 lock 一起改写）
  if (readInstalledVersion(profileDir, CONSOLE_PACKAGE) !== latest) {
    try {
      await pnpmAdd(profileDir, `${CONSOLE_PACKAGE}@${latest}`, registries?.[0])
      method = method === null ? 'pnpm-add' : `${method}+pnpm-add`
    } catch (error) {
      errors.push(`pnpm add 失败：${label(error)}`)
    }
  }

  let installed = readInstalledVersion(profileDir, CONSOLE_PACKAGE)
  let lock = lockVersion(profileDir, CONSOLE_PACKAGE)
  let lockUpdated = installed === latest && lock === latest
  let lockNote = null

  // ③ 包管理器都没成 → 手铺文件兜底（**不写 lock**），并且必须明确警告，不能让人以为升级成功
  if (!lockUpdated) {
    try {
      const info = await curlManualInstall(profileDir, CONSOLE_PACKAGE, registries, null, latest)
      method = method === null ? 'manual-copy' : `${method}+manual-copy`
      installed = info?.version ?? readInstalledVersion(profileDir, CONSOLE_PACKAGE)
      lock = lockVersion(profileDir, CONSOLE_PACKAGE)
      lockUpdated = installed === latest && lock === latest
    } catch (error) {
      errors.push(`手动铺文件失败：${label(error)}`)
    }
    if (!lockUpdated) {
      lockNote = `此更新未写入 pnpm-lock.yaml（lock 里仍是 ${lock ?? '未知'}）：之后任何 pnpm 操作（开关插件、dsh plugin add/remove）都会把它还原成 lock 里的版本。要真正落地请执行：${command}`
    }
  }

  const sourceSwitch = spec !== null && !isRegistryRange(spec) ? `安装来源已从 ${spec} 变为 registry 版本 ${latest}` : null
  const noteParts = [lockUpdated ? '已写入 pnpm-lock.yaml，重启服务后生效' : '已铺入文件但未写入 pnpm-lock.yaml：重启后可用，但会被 pnpm 还原']
  if (sourceSwitch !== null) noteParts.push(sourceSwitch)

  return { method, spec, installedVersion: installed, lockVersion: lock, lockUpdated, lockNote, command, note: noteParts.join('；'), errors }
}

export { CONSOLE_PACKAGE, isRegistryRange, readInstalledVersion, lockVersion, profileSpec, selfUpdateCommand, selfUpdateToLatest }
