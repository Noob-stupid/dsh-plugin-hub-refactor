// 由 Step 1 搬运工具从 lib/index.js 原样切出（只移动、未改逻辑）
// 分组见 D:\dsh\dsh-plugin-hub-plan\architecture.zh.md §三 L0 · infra

import { existsSync, rmSync, readdirSync, mkdirSync, copyFileSync } from 'node:fs'
import { dirname, join, basename } from 'node:path'

/**
 * 递归复制目录树（绕开 fs.cpSync 在本环境的目录复制 EIO bug：
 * cpSync 复制含子目录的树必报 `EIO, Access is denied`，而逐文件 copyFileSync 正常）。
 * 跳过 .git（技能/包副本不需要版本库元数据）。
 */

/** 清理陈旧包目录与 pnpm _tmp_ 残留（Windows 原子替换 EPERM 的根因），返回清理数量。 */

/** 串行化补丁文件写入，避免并发 toggle 的读改写竞争。 */

function copyTree(src, dest) {
  mkdirSync(dest, { recursive: true })
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    if (entry.name === '.git') continue
    const from = join(src, entry.name)
    const to = join(dest, entry.name)
    if (entry.isDirectory()) {
      copyTree(from, to)
    } else if (entry.isFile()) {
      copyFileSync(from, to)
    }
  }
}
function queuedWrite(fn) {
  const run = writeQueue.then(fn, fn)
  writeQueue = run.then(() => undefined, () => undefined)
  return run
}
function cleanupStalePackageDir(profileDir, packageName) {
  const segments = packageName.startsWith('@') ? packageName.split('/') : [packageName]
  const dir = join(profileDir, 'node_modules', ...segments)
  const base = basename(dir)
  const parent = dirname(dir)
  let removed = 0
  try {
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true })
      removed += 1
    }
  } catch {}
  try {
    for (const entry of readdirSync(parent)) {
      if (entry.startsWith(`${base}_tmp_`)) {
        try {
          rmSync(join(parent, entry), { recursive: true, force: true })
          removed += 1
        } catch {}
      }
    }
  } catch {}
  return removed
}
let writeQueue = Promise.resolve()

/**
 * 删除目录树并**核实删除结果**。
 * 为什么要核实：本机某些环境（受限令牌/沙箱/杀软占用）下 `rmSync` 会**静默落空**——不抛错、目录仍在。
 * 路由若删完直接 `{ok:true}` 就是对用户撒谎（2026-09-20 多类型演练实测：同一个 `rmSync` 在
 * `D:\dsh\repos` 删得掉，在 `C:\Users\<user>\.dsh\...` 下返回成功但目录原封不动）。
 * 返回 `{ok, attempts, error}`；`ok:false` 时调用方必须如实报错，不能吞。
 */
function removeDirVerified(dir) {
  let lastError = null
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 120 })
    } catch (error) {
      lastError = error
    }
    if (!existsSync(dir)) return { ok: true, attempts: attempt }
  }
  return { ok: false, attempts: 2, error: lastError instanceof Error ? lastError.message : null }
}

export { copyTree, queuedWrite, cleanupStalePackageDir, removeDirVerified, writeQueue }