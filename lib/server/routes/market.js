// L2 · routes —— 市场（/search · /enrich · /repo · /subpackages · /market-index）
// 分层 Step 8b：从 lib/index.js 的 handle() 原样搬出（只搬移未改逻辑；缩进保持原样）

import { readFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { readGithubAuth } from '../domain/install.js'
import { enrichItems, fetchRepoPackage, fetchSubpackageNames, githubRepoInfo, normalizePlatformItems } from '../domain/market.js'
import { SKILL_TOPICS, detectSkillRepo, fetchSkillMeta } from '../domain/skills.js'
import { DEFAULT_SEARCH, gitCloneUrls, readGiteeConfig, readSources } from '../domain/sources.js'
import { GITHUB_API, curlJson, fetchJsonUrl, githubJson, rawTextWithFallback } from '../infra/http.js'
import { sendError, sendJson } from '../infra/httpd.js'
import { marketIndexCacheFile } from '../infra/paths.js'
import { marketIndexCache, setMarketIndexCache } from '../state.js'

async function routeSearch(req, res, rc) {
  const DEFAULT_SEARCH = rc.deps.DEFAULT_SEARCH
  const ctx = rc.ctx
  const pathname = rc.pathname
  const method = rc.method
  const body = rc.body
    const raw = typeof body.q === 'string' ? body.q.trim() : ''
    const query = raw === '' ? DEFAULT_SEARCH : raw
    const page = Math.max(Math.min(Number.parseInt(String(body.page), 10) || 1, 5), 1)
    const source = typeof body.source === 'string' && body.source !== '' ? body.source : 'github'
    const all = body.all === true
    const auth = readGithubAuth()
    let items = []
    if (body.multi === true) {
      // 多源汇总：GitHub + 全部自定义搜索源并行检索，结果合并（每项带 source 标记）。
      // Gitee 为直装模式（关键词搜索无意义），不参与多源汇总。
      const sources = readSources()
      const tasks = [
        (async () => {
          try {
            const data = await githubJson(
              `${GITHUB_API}/search/repositories?q=${encodeURIComponent(all ? query : `${query} topic:dsh-plugin`)}&sort=stars&order=desc&per_page=20&page=${page}`,
              req.signal,
              auth.token,
            )
            return normalizePlatformItems(data.items ?? [], 'main').map((item) => ({ ...item, source: 'github', sourceName: 'GitHub' }))
          } catch {
            return []
          }
        })(),
        ...sources.searchSources.filter((s) => s.type === 'custom').map((s) => (async () => {
          try {
            const url = s.url.replace('{q}', encodeURIComponent(query)).replace('{page}', String(page))
            const data = await fetchJsonUrl(url, 15000, s.headers ?? {})
            return normalizePlatformItems(data, 'main').map((item) => ({ ...item, source: s.id, sourceName: s.name }))
          } catch {
            return []
          }
        })()),
      ]
      const results = await Promise.all(tasks)
      items = results.flat()
      items = await enrichItems(items)
      sendJson(res, 200, { ok: true, query, items, authenticated: auth.loggedIn, source: 'all', multi: true })
      return
    }
    if (body.skills === true) {
      // 技能模式搜索：agent-skills / claude-skills / dsh-skill 三 topic 并行检索后合并去重
      // （GitHub search 的 OR 语法优先级不可靠，分开查最稳），按 star 排序取前 20。
      if (source !== 'github') {
        sendError(res, 400, '技能搜索仅支持 GitHub 源')
        return
      }
      const keyword = raw === '' ? '' : `${raw} in:name,description,topics `
      const tasks = SKILL_TOPICS.map((topic) => (async () => {
        try {
          const data = await githubJson(
            `${GITHUB_API}/search/repositories?q=${encodeURIComponent(`${keyword}topic:${topic}`)}&sort=stars&order=desc&per_page=20&page=${page}`,
            req.signal,
            auth.token,
          )
          return normalizePlatformItems(data.items ?? [], 'main').map((item) => ({ ...item, source: 'github', skillTopics: [topic] }))
        } catch {
          return []
        }
      })())
      const merged = (await Promise.all(tasks)).flat()
      const seen = new Set()
      items = []
      for (const item of merged.sort((a, b) => b.stars - a.stars)) {
        if (seen.has(item.fullName)) continue
        seen.add(item.fullName)
        items.push(item)
        if (items.length >= 20) break
      }
      items = await enrichItems(items)
      sendJson(res, 200, { ok: true, query, items, authenticated: auth.loggedIn, source: 'github', skills: true })
      return
    }
    if (source === 'gitee') {
      // Gitee 官方 v5 搜索接口（search/repositories）已废弃（恒返回空）；
      // so.gitee.com/v1（Indexea 后端）有百度云 WAF 反爬且需映答账号 token。
      // 因此 Gitee 源采用仓库直装模式：输入 owner/repo 直接取仓库信息（公开接口，无需登录）。
      const gitee = readGiteeConfig(readSources())
      let repo = ''
      let giteeError = ''
      try {
        repo = githubRepoInfo(query)
      } catch (error) {
        giteeError = error instanceof Error ? error.message : String(error)
      }
      if (repo) {
        try {
          const tokenQ = gitee.token ? `?access_token=${encodeURIComponent(gitee.token)}` : ''
          // repo 已由 githubRepoInfo 校验；分段编码（只编码中文等非 ASCII，斜杠保留原样——
          // Gitee 服务器不认 %2F 编码的路径分隔，返回 404）
          const [owner, name] = repo.split('/')
          const data = await fetchJsonUrl(`https://gitee.com/api/v5/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}${tokenQ}`)
          items = normalizePlatformItems([data], 'master').map((item) => ({ ...item, source: 'gitee' }))
        } catch (error) {
          giteeError = error instanceof Error ? error.message : String(error)
        }
      }
      sendJson(res, 200, { ok: true, query, items, authenticated: auth.loggedIn, source, giteeNeedsLogin: false, directOnly: true, giteeError })
      return
    } else if (source !== 'github') {
      // 自定义搜索源：URL 模板（{q}/{page} 占位符），返回数组或 {items} 结构；支持配置的请求头
      const sources = readSources()
      const custom = sources.searchSources.find((s) => s.id === source && s.type === 'custom')
      if (!custom) {
        sendError(res, 404, `没有这个搜索源：${source}`)
        return
      }
      const url = custom.url
        .replace('{q}', encodeURIComponent(query))
        .replace('{page}', String(page))
      const data = await fetchJsonUrl(url, 15000, custom.headers ?? {})
      items = normalizePlatformItems(data, 'main').map((item) => ({ ...item, source, sourceName: custom.name }))
    } else {
      const data = await githubJson(
        `${GITHUB_API}/search/repositories?q=${encodeURIComponent(all ? query : `${query} topic:dsh-plugin`)}&sort=stars&order=desc&per_page=20&page=${page}`,
        req.signal,
        auth.token,
      )
      items = normalizePlatformItems(data.items ?? [], 'main').map((item) => ({ ...item, source: 'github' }))
      items = await enrichItems(items)
      // monorepo 子包增强（OpenViking/examples/dsh-memory-plugin 等可按子包名搜到）
      if (raw !== '' && !body.skills) {
        try {
          const codeData = await githubJson(
            `${GITHUB_API}/search/code?q=${encodeURIComponent(`${raw} filename:package.json`)}`,
            req.signal,
            auth.token,
          )
          const subItems = []
          for (const hit of (codeData.items ?? []).slice(0, 10)) {
            const hitPath = typeof hit.path === 'string' ? hit.path : ''
            if (!/^(?:packages|examples|plugins|skills|apps|extensions|src|lib)\/[^/]+\/package\.json$/u.test(hitPath)) continue
            const repoName = hit.repository?.full_name ?? ''
            if (!repoName) continue
            const dir = hitPath.split('/').slice(0, -1).join('/')
            let packageName = dir.split('/').slice(-1)[0]
            try {
              const pkgText = await rawTextWithFallback(repoName, 'main', hitPath)
              if (pkgText !== null) {
                const pkg = JSON.parse(pkgText)
                if (pkg && typeof pkg.name === 'string') packageName = pkg.name
              }
            } catch {}
            subItems.push({
              fullName: repoName,
              description: `子包：${dir}`,
              htmlUrl: `https://github.com/${repoName}/tree/main/${dir}`,
              stars: 0,
              updatedAt: '',
              defaultBranch: 'main',
              topics: [],
              source: 'github',
              subpackagePath: dir,
              packageName,
            })
            if (subItems.length >= 5) break
          }
          for (const sub of subItems) {
            if (!items.some((x) => x.fullName === sub.fullName)) items.push(sub)
          }
        } catch {}
      }
    }
    items = items.filter((item) => item.fullName !== '')
    sendJson(res, 200, { ok: true, query, items, authenticated: auth.loggedIn, source })
    return
}

async function routeEnrich(req, res, rc) {
  const ctx = rc.ctx
  const url = rc.url
  const pathname = rc.pathname
  const method = rc.method
  const body = rc.body
    // 为浏览器直连的搜索结果补官方/聚合标记（服务端通道可靠；客户端直连无标记能力）
    const raw = Array.isArray(body.items) ? body.items.slice(0, 30) : []
    const items = await enrichItems(raw)
    sendJson(res, 200, { ok: true, items })
    return
}

async function routeRepo(req, res, rc) {
  const ctx = rc.ctx
  const url = rc.url
  const pathname = rc.pathname
  const method = rc.method
  const body = rc.body
    const repo = githubRepoInfo(typeof body.repo === 'string' ? body.repo : '')
    const auth = readGithubAuth()
    // meta 降级策略：githubJson（https+镜像+gh）与 curl 竞速，3 秒超时即降级——
    // Promise.any 全失败时要等最慢分支（黑洞期 https 41.5s），加 race 超时避免拖累整体。
    let meta = null
    try {
      meta = await Promise.race([
        Promise.any([
          githubJson(`${GITHUB_API}/repos/${repo}`, req.signal, auth.token),
          curlJson(`${GITHUB_API}/repos/${repo}`, 12000),
        ]),
        new Promise((resolve) => setTimeout(() => resolve(null), 3000)),
      ])
    } catch {}
    const branch = meta?.default_branch ?? 'main'
    const pkg = await fetchRepoPackage(repo, branch)
    const skill = await detectSkillRepo(repo, branch)
    const skillMeta = skill.hasSkill ? await fetchSkillMeta(repo, branch, skill.skillDir) : null
    // 套装识别：根 .gitmodules 存在（submodule 聚合仓库）
    const hasSuite = (await rawTextWithFallback(repo, branch, '.gitmodules')) !== null
    // 官方安装方式（详情面板展示 + 一键复制，供用户手动安装）：
    // 套装 → 仓库 install.ps1/README 的官方步骤；普通/聚合 → dsh plugin add 官方命令
    let installCommand = null
    if (hasSuite) {
      const short = repo.split('/')[1] ?? repo
      const hasInstallScript = (await rawTextWithFallback(repo, branch, 'install.ps1')) !== null
        || (await rawTextWithFallback(repo, branch, 'install.sh')) !== null
      // 纯命令（无注释，CMD/PowerShell 通用）；不再关闭 TLS 校验；
      // 脚本用 powershell -File 调用，CMD 里也能跑
      installCommand = [
        `git clone --recurse-submodules ${gitCloneUrls(repo)[0]}`,
        `cd ${short}`,
        hasInstallScript
          ? `powershell -ExecutionPolicy Bypass -File install.ps1`
          : `git submodule update --init --recursive`,
      ].join('\n')
    } else {
      installCommand = `dsh plugin --profile web add github:${repo}`
    }
    sendJson(res, 200, {
      ok: true,
      repo,
      defaultBranch: branch,
      description: meta?.description ?? '',
      stars: meta?.stargazers_count ?? 0,
      packageName: pkg?.name ?? null,
      packageDescription: pkg?.description ?? null,
      hasPackageJson: pkg !== null,
      privateRoot: pkg !== null && pkg.private === true,
      hasSkill: skill.hasSkill,
      skillDir: skill.skillDir,
      skill: skillMeta,
      hasSuite,
      installCommand,
      dshHint: pkg !== null && (
        typeof pkg.name === 'string' && /(^|-)dsh[-/]/u.test(pkg.name)
        || pkg.peerDependencies?.['@deepseek-ai/cordis'] !== undefined
        || Array.isArray(pkg.keywords) && pkg.keywords.includes('dsh-plugin')
      ),
    })
    return
}

async function routeSubpackages(req, res, rc) {
  const ctx = rc.ctx
  const url = rc.url
  const pathname = rc.pathname
  const method = rc.method
  const body = rc.body
    const repo = githubRepoInfo(typeof body.repo === 'string' ? body.repo : '')
    const branch = typeof body.branch === 'string' && body.branch ? body.branch : 'main'
    const auth = readGithubAuth()
    // 复用安装链的防护实现：任一 raw 拉取失败只跳过该子包，不整体 500
    const subpackages = await fetchSubpackageNames(repo, branch, auth.token)
    sendJson(res, 200, { ok: true, repo, branch, subpackages })
    return
}

async function routeMarketIndex(req, res, rc) {
  const ctx = rc.ctx
  const url = rc.url
  const pathname = rc.pathname
  const method = rc.method
  const body = rc.body
    // 静态插件索引：按「软件源 → 索引源」主→备顺序拉取 + 10 分钟内存缓存（市场秒开、零 GitHub API 调用）。
    // 全部索引源失败时回退落盘缓存（内网/断网仍可浏览，响应带 offline 标记），无缓存则区分错误类型。
    if (marketIndexCache !== null && Date.now() - marketIndexCache.at < 600000) {
      sendJson(res, 200, { ok: true, sourceName: marketIndexCache.sourceName ?? null, ...marketIndexCache.data })
      return
    }
    const indexConf = readSources()
    let indexList = [...(indexConf.indexSources ?? [])].sort((a, b) => (b.primary === true ? 1 : 0) - (a.primary === true ? 1 : 0))
    // 合并模式：并发拉取所有索引源并去重合并（公共索引 + 内网私有索引同时可见）
    if (indexConf.indexMerge === true && indexList.length > 1) {
      const fetched = await Promise.all(indexList.map(async (src) => {
        try {
          // 各源独立短超时：单个慢源（被墙镜像/不可达内网）不该拖垮整体
          const data = await fetchJsonUrl(src.url, 8000)
          return data && Array.isArray(data.items) ? { src, data } : null
        } catch { return null }
      }))
      const good = fetched.filter((x) => x !== null)
      if (good.length > 0) {
        const seen = new Set()
        const skillSeen = new Set()
        const items = []
        const skills = []
        for (const { data } of good) {
          for (const it of data.items) {
            const key = typeof it?.fullName === 'string' ? it.fullName : JSON.stringify(it)
            if (seen.has(key)) continue
            seen.add(key)
            items.push(it)
          }
          for (const sk of (Array.isArray(data.skills) ? data.skills : [])) {
            const key = typeof sk?.fullName === 'string' ? sk.fullName : JSON.stringify(sk)
            if (skillSeen.has(key)) continue
            skillSeen.add(key)
            skills.push(sk)
          }
        }
        const sourceName = good.map((g) => g.src.name).join(' + ')
        const merged = { items, skills, skillCount: skills.length, merged: true, sourceName }
        setMarketIndexCache({ at: Date.now(), data: merged, sourceName })
        try { await writeFile(marketIndexCacheFile(), JSON.stringify({ at: Date.now(), data: merged, sourceName }), 'utf8') } catch {}
        sendJson(res, 200, { ok: true, ...merged })
        return
      }
      // 所有源都失败 → 跳过逐个重试，直接进入下方缓存兜底
      indexList = []
    }
    let lastError = null
    let formatError = null
    for (const src of indexList) {
      try {
        const data = await fetchJsonUrl(src.url, 15000)
        if (data && Array.isArray(data.items)) {
          setMarketIndexCache({ at: Date.now(), data, sourceName: src.name })
          try { await writeFile(marketIndexCacheFile(), JSON.stringify({ at: Date.now(), data, sourceName: src.name }), 'utf8') } catch {}
          sendJson(res, 200, { ok: true, sourceName: src.name, ...data })
          return
        }
        formatError = `索引格式异常（${src.name} 未返回 items 数组）`
      } catch (error) {
        lastError = error
      }
    }
    try {
      const cached = JSON.parse(readFileSync(marketIndexCacheFile(), 'utf8'))
      if (cached && cached.data && Array.isArray(cached.data.items)) {
        setMarketIndexCache({ at: Date.now(), data: cached.data, sourceName: cached.sourceName ?? null })
        sendJson(res, 200, { ok: true, offline: true, cachedAt: typeof cached.at === 'number' ? cached.at : null, sourceName: cached.sourceName ?? null, ...cached.data })
        return
      }
    } catch {}
    const reason = formatError !== null
      ? formatError
      : `网络不可达（${indexList.length} 个索引源全部失败）：${lastError?.message ?? '未知错误'}`
    sendError(res, 500, `索引加载失败：${reason}`)
    return
}

export { routeSearch, routeEnrich, routeRepo, routeSubpackages, routeMarketIndex }
