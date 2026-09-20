// L1 · domain —— repoland.js（仓库落地：落地目录配置 / 已落地列表 / 克隆；分层 Step 4 从 lib/index.js 搬出，只搬移未改逻辑）
// 分组见 D:\dsh\dsh-plugin-hub-plan\architecture.zh.md 三

import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { gitCloneUrls } from './sources.js'
import { execFileAsync, gitEnv } from '../infra/exec.js'
import { repoLandConfFile } from '../infra/paths.js'

/** 仓库落地根目录（可配置，默认 ~/.dsh/repos）。 */
let reposDirCache = null

function getReposDir() {
  if (reposDirCache !== null) return reposDirCache
  try {
    if (existsSync(repoLandConfFile())) {
      const conf = JSON.parse(readFileSync(repoLandConfFile(), 'utf8'))
      if (typeof conf.dir === 'string' && conf.dir.trim() !== '') {
        reposDirCache = conf.dir.trim()
        return reposDirCache
      }
    }
  } catch {}
  reposDirCache = join(homedir(), '.dsh', 'repos')
  return reposDirCache
}

function setReposDir(dir) {
  reposDirCache = String(dir ?? '').trim()
  mkdirSync(dirname(repoLandConfFile()), { recursive: true })
  writeFileSync(repoLandConfFile(), JSON.stringify({ dir: reposDirCache }, null, 2), 'utf8')
  return reposDirCache
}

/** 已落地仓库列表：扫描 dir 下两级目录（owner/name 下含 .git）。 */
function listLandedRepos() {
  const dir = getReposDir()
  const out = []
  try {
    if (!existsSync(dir)) return out
    for (const owner of readdirSync(dir, { withFileTypes: true })) {
      if (!owner.isDirectory() || owner.name.startsWith('.')) continue
      const ownerDir = join(dir, owner.name)
      for (const entry of readdirSync(ownerDir, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue
        const repoDir = join(ownerDir, entry.name)
        if (existsSync(join(repoDir, '.git'))) {
          out.push({ owner: owner.name, name: entry.name, repo: `${owner.name}/${entry.name}`, path: repoDir })
        }
      }
    }
  } catch {}
  return out
}

/** 逐条尝试的错误汇总（纯函数，单测覆盖）：报**第一个**错误（真实原因）+ 尝试清单。
 * 为什么要这样：多源重试时若第一次失败留下半成品目录，第二次会以
 * `fatal: destination path '…' already exists and is not an empty directory` 失败，
 * 旧代码把它当 lastError 抛出去 → 用户只看到"目录非空"，真实原因（镜像/网络不可达）被完全掩盖。
 * 2026-09-20 另一位用户实测报的就是这句。 */
function summarizeCloneErrors(errors) {
  const first = errors[0]
  const tried = errors.map((e) => (/already exists and is not an empty directory/u.test(e.message) ? `${e.url}（目录非空）` : e.url)).join('；')
  return `git clone 失败（首个错误：${first?.message ?? '未知'}）；已尝试 ${errors.length} 个源：${tried}`
}

/** git clone（镜像→直连；gitee 直连），返回 { url } 或抛错。 */
async function gitCloneRepo(repo, dest, source = 'github', timeout = 180000) {
  const urls = gitCloneUrls(repo, source)
  const errors = []
  for (const [attempt, url] of urls.entries()) {
    // 每次尝试前都清掉目标目录：上一次可能留下半成品（git 会先建目录再传输），
    // 不清就会让第二次以"目录非空"失败并掩盖真实原因（见 summarizeCloneErrors 注释）。
    try { rmSync(dest, { recursive: true, force: true }) } catch {}
    try {
      // eslint-disable-next-line no-await-in-loop
      await execFileAsync('git', ['clone', '--depth', '1', '--quiet', url, dest], {
        timeout,
        windowsHide: true,
        env: gitEnv(),
      })
      return { url, attempt: attempt + 1 }
    } catch (error) {
      errors.push({ url, message: error?.message ?? String(error) })
    }
  }
  throw new Error(summarizeCloneErrors(errors))
}

export { reposDirCache, getReposDir, setReposDir, listLandedRepos, gitCloneRepo, summarizeCloneErrors }
