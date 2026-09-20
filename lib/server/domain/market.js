// L1 · domain —— market.js（分层 Step 从 lib/index.js 搬出，只搬移未改逻辑）
// 分组见 D:\dsh\dsh-plugin-hub-plan\architecture.zh.md §三

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { detectSkillRepo } from './skills.js'
import { GITHUB_API, curlJson, curlText, githubJson, looksLikeGitmodules, rawTextWithFallback } from '../infra/http.js'
import { ENRICH_CACHE_FILE, baseDirOf, resolvePackageJson } from '../infra/paths.js'

function readEnrichCache() {
  try {
    const j = JSON.parse(readFileSync(ENRICH_CACHE_FILE(), 'utf8'))
    return j !== null && typeof j === 'object' ? j : {}
  } catch { return {} }
}

function writeEnrichCache(cache) {
  try {
    mkdirSync(dirname(ENRICH_CACHE_FILE()), { recursive: true })
    const entries = Object.entries(cache).sort((a, b) => (b[1]?.at ?? 0) - (a[1]?.at ?? 0)).slice(0, 2000)
    writeFileSync(ENRICH_CACHE_FILE(), JSON.stringify(Object.fromEntries(entries), null, 2), 'utf8')
  } catch {}
}

/** 单项识别：官方通道 / 聚合仓库 / 技能 / 套装（失败返回 official=null）。 */
async function enrichItemOne(item) {
  let official = /^deepseek-ai\//u.test(item.fullName ?? '') ? true : null
  let aggregate = false
  let aggregateInstallable = false
  let hasSkill = false
  let hasSuite = false
  try {
    const branch = item.defaultBranch ?? 'main'
    const base = `https://raw.githubusercontent.com/${item.fullName}/${encodeURIComponent(branch)}/package.json`
    const [pkgResult, skillResult, suiteResult] = await Promise.allSettled([
      Promise.any([
        curlText(base, 4000),
        curlText(`https://ghproxy.net/${base}`, 4000),
      ]),
      detectSkillRepo(item.fullName, branch),
      rawTextWithFallback(item.fullName, branch, '.gitmodules'),
    ])
    // 套装判定必须过内容校验：代理/CDN 对不存在的 .gitmodules 也可能回 2xx 空 body，
    // 只判"探测非 null"会把普通插件标成套装置仓库（2026-09-19 事故）。
    if (suiteResult.status === 'fulfilled' && looksLikeGitmodules(suiteResult.value)) {
      hasSuite = true
    }
    if (pkgResult.status === 'fulfilled') {
      const pkg = JSON.parse(pkgResult.value)
      if (typeof pkg.dsh?.bundle?.patch === 'string') {
        official = true
      } else {
        // 成功读到 package.json 且没有 dsh.bundle.patch → 确定「非官方」。
        // 必须落成 false（而不是留 null），否则缓存条件 official !== null 永不成立，
        // 每个非官方插件每次打开都重新请求 → /enrich 缓存命中也要十几秒。
        official = false
        if (pkg.private === true && (Array.isArray(pkg.workspaces) || /(^|-)dsh[-/]/u.test(String(pkg.name ?? '')))) {
          aggregate = true
          try {
            const tree = await curlJson(`https://api.github.com/repos/${item.fullName}/git/trees/${encodeURIComponent(branch)}?recursive=1`, 6000)
            const pkgPaths = (tree.tree ?? [])
              .filter((n) => n.type === 'blob' && /^packages\/[^/]+\/package\.json$/u.test(n.path))
              .map((n) => n.path)
              .slice(0, 12)
            if (pkgPaths.length > 0) {
              const subs = await Promise.all(pkgPaths.map((p) => curlText(`https://raw.githubusercontent.com/${item.fullName}/${encodeURIComponent(branch)}/${p}`, 4000)
                .then((t) => { try { return JSON.parse(t) } catch { return null } })
                .catch(() => null)))
              if (subs.some((sp) => sp && typeof sp.dsh?.bundle?.patch === 'string')) {
                aggregateInstallable = true
              }
            }
          } catch {}
        }
      }
    }
    if (skillResult.status === 'fulfilled' && skillResult.value?.hasSkill === true) {
      hasSkill = true
    }
  } catch {}
  return { ...item, official, aggregate, aggregateInstallable, hasSkill, hasSuite }
}

/**
 * 批量识别（★ 筛选数据源）：并发限流 + 24h 结果缓存。
 * 网络黑洞期（raw.githubusercontent 大部分拉取失败）自动回退缓存中的上次判定，
 * 保证「只看官方」不因瞬时网络而坍缩成 0/1 条。
 */
async function enrichItems(items) {
  const cache = readEnrichCache()
  const out = new Array(items.length)
  let next = 0
  let cacheDirty = false
  async function worker() {
    while (true) {
      const i = next
      next += 1
      if (i >= items.length) return
      const item = items[i]
      const key = `${item.fullName}@${item.defaultBranch ?? 'main'}`
      const cached = cache[key]
      try {
        // official 已判定（true/false）→ 24h 缓存；判定失败（null）→ 1h 短缓存，减少无谓重试
        if (cached !== undefined && typeof cached?.at === 'number' && cached.data) {
          const ttl = cached.data.official === null ? 60 * 60 * 1000 : ENRICH_CACHE_TTL
          if (Date.now() - cached.at < ttl) {
            out[i] = { ...item, ...cached.data }
            continue
          }
        }
        let result = await enrichItemOne(item)
        // 本次失败 → 回退缓存（哪怕已过期），避免「看天吃饭」
        if ((result.official === null && !/^deepseek-ai\//u.test(item.fullName ?? '')) && cached?.data) {
          result = { ...item, ...cached.data }
        } else {
          cache[key] = { at: Date.now(), data: { official: result.official, aggregate: result.aggregate, aggregateInstallable: result.aggregateInstallable, hasSkill: result.hasSkill, hasSuite: result.hasSuite } }
          cacheDirty = true
        }
        out[i] = result
      } catch {
        // 抛错的条目也必须写缓存（null 结果 + 1h 短 TTL），否则每次打开都重试同一批，
        // /enrich 即使「命中缓存」也要等十几秒。
        if (cached?.data) {
          out[i] = { ...item, ...cached.data }
        } else {
          const miss = { official: null, aggregate: false, aggregateInstallable: false, hasSkill: false, hasSuite: false }
          cache[key] = { at: Date.now(), data: miss }
          cacheDirty = true
          out[i] = { ...item, ...miss }
        }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(12, items.length) }, worker))
  if (cacheDirty) writeEnrichCache(cache)
  return out
}

/** 平台搜索返回归一化（数组或 {items} 均可；兼容 GitHub/Gitee/自定义源字段）。 */
function normalizePlatformItems(data, fallbackBranch = 'main') {
  const list = Array.isArray(data) ? data : (data && Array.isArray(data.items) ? data.items : [])
  return list
    .filter((item) => item && typeof item === 'object')
    .map((item) => ({
      fullName: String(item.full_name ?? item.path_with_namespace ?? item.name ?? '').trim(),
      description: item.description ?? '',
      htmlUrl: item.html_url ?? item.web_url ?? '',
      stars: item.stargazers_count ?? item.star_count ?? 0,
      updatedAt: item.updated_at ?? item.last_activity_at ?? '',
      defaultBranch: item.default_branch ?? fallbackBranch,
      topics: Array.isArray(item.topics) ? item.topics : [],
    }))
    .filter((item) => item.fullName !== '')
}

function githubRepoInfo(repo) {
  const match = String(repo).trim().match(/^(?:https:\/\/github\.com\/|https:\/\/gitee\.com\/|git@github\.com:|git@gitee\.com:)?([^\s\/?#]+)\/([^\s\/?#]+?)(?:\.git)?$/u)
  if (!match) throw new Error('仓库名格式应为 owner/name（支持完整仓库 URL 与中文路径）')
  return `${match[1]}/${match[2]}`
}

async function fetchRepoPackage(repo, branch) {
  try {
    const body = await rawTextWithFallback(repo, branch, 'package.json')
    if (body === null) return null
    const pkg = JSON.parse(body)
    if (pkg == null || typeof pkg !== 'object' || typeof pkg.name !== 'string') return null
    return pkg
  } catch {
    return null
  }
}

/** 提取 README 的标题与开篇段落摘要（首个二级标题之前的正文）。 */
function summarizeReadme(text) {
  const lines = text.split(/\r?\n/u)
  let title = ''
  const intro = []
  for (const line of lines) {
    const heading = line.match(/^(#{1,3})\s+(.+)$/u)
    if (heading) {
      if (title === '') {
        title = heading[2].trim()
        continue
      }
      break
    }
    if (title === '' && /^[-=]{3,}$/u.test(line.trim()) && line.trim() !== '') continue
    if (title === '') continue
    const cleaned = line
      .replace(/!\[[^\]]*\]\([^)]*\)/gu, '')
      .replace(/\[([^\]]+)\]\([^)]*\)/gu, '$1')
      .replace(/[`*_~]/gu, '')
      .trim()
    if (cleaned) intro.push(cleaned)
    if (intro.join(' ').length > 700) break
  }
  return { title, summary: intro.join(' ').trim().slice(0, 900) }
}

/** 读取一个已加载插件的 package.json 元信息与 README 摘要。 */
async function readPluginDetails(moduleName, baseUrl, profileDir) {
  if (typeof moduleName !== 'string' || moduleName.startsWith('cordis:')) return { meta: null, readme: null }
  try {
    const pkgPath = resolvePackageJson(moduleName, baseDirOf(baseUrl), profileDir ?? null)
    if (pkgPath === null) throw new Error('not found')
    const pkg = JSON.parse(await readFile(pkgPath, 'utf8'))
    const meta = {
      name: moduleName,
      version: pkg.version ?? null,
      description: pkg.description ?? null,
      homepage: pkg.homepage ?? null,
      repository: typeof pkg.repository === 'string' ? pkg.repository : (pkg.repository?.url ?? null),
    }
    let readme = null
    for (const candidate of ['README.zh.md', 'README.md']) {
      try {
        const text = await readFile(join(dirname(pkgPath), candidate), 'utf8')
        readme = summarizeReadme(text)
        break
      } catch {}
    }
    return { meta, readme }
  } catch {
    return { meta: null, readme: null }
  }
}

/** 服务端列出仓库子包（git trees 递归 + 并行读 package.json 的 name）。 */
async function fetchSubpackageNames(repo, branch, auth) {
  try {
    const data = await githubJson(`${GITHUB_API}/repos/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`, undefined, auth)
    const paths = (data.tree ?? [])
      .filter((node) => node.type === 'blob' && /^(?:packages|examples|plugins|skills|apps|extensions|src|lib)\/[^/]+\/package\.json$/u.test(node.path))
      .map((node) => node.path)
    // 并行读取：黑洞期单条最坏 40s，24 条串行会拖到十几分钟
    const results = await Promise.all(paths.slice(0, 24).map(async (path) => {
      const bodyText = await rawTextWithFallback(repo, branch, path)
      if (bodyText === null) return null
      try {
        const pkg = JSON.parse(bodyText)
        if (pkg && typeof pkg.name === 'string') return { dir: path.split('/')[1], path: path.split('/').slice(0, -1).join('/'), name: pkg.name }
      } catch {}
      return null
    }))
    return results.filter((item) => item !== null)
  } catch {
    return []
  }
}

/** 子包候选：聚合包（名字带 all）优先，上限 8 个。 */
async function subpackageCandidates(repo, branch, auth) {
  const isAll = (name) => /(^|-)all$/u.test(name) || /-all-/u.test(name)
  const subs = await fetchSubpackageNames(repo, branch, auth)
  return subs
    .slice()
    .sort((a, b) => Number(isAll(b.name)) - Number(isAll(a.name)))
    .map((sub) => sub.name)
    .slice(0, 8)
}

const ENRICH_CACHE_TTL = 24 * 60 * 60 * 1000

export { readEnrichCache, writeEnrichCache, enrichItemOne, enrichItems, normalizePlatformItems, githubRepoInfo, fetchRepoPackage, summarizeReadme, readPluginDetails, fetchSubpackageNames, subpackageCandidates, ENRICH_CACHE_TTL }
