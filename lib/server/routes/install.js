// L2 · routes —— 安装（POST /install · POST /install-status）
// 分层 Step 8b：从 lib/index.js 的 handle() 原样搬出（只搬移未改逻辑；缩进保持原样）

import { installJobView } from '../domain/install.js'
import { runInstallJob } from '../domain/install-job.js'
import { githubRepoInfo } from '../domain/market.js'
import { runSkillInstallJob } from '../domain/skills.js'
import { runSuiteInstallJob } from '../domain/suite.js'
import { sendError, sendJson } from '../infra/httpd.js'
import { installJobs, nextInstallJobSeq } from '../state.js'

async function routeInstall(req, res, rc) {
  const ctx = rc.ctx
  const url = rc.url
  const pathname = rc.pathname
  const method = rc.method
  const runSuiteInstallJob = rc.deps.runSuiteInstallJob
  const runInstallJob = rc.deps.runInstallJob
  const body = rc.body
    // repo 允许为空：纯 registry 更新（已安装插件的"检测更新"走此路径，无 git 兜底）
    const rawRepo = typeof body.repo === 'string' ? body.repo.trim() : ''
    let repo = ''
    if (rawRepo !== '') {
      try { repo = githubRepoInfo(rawRepo) } catch {}
    }
    const givenName = typeof body.packageName === 'string' ? body.packageName.trim() : ''
    // 框架本体拦截：deepseek-harness 仓库与其根包 @deepseek-ai/dsh-root 是 DSH 框架自身，
    // 作为插件安装会试图构建整个框架源码——直接拒绝并提示
    if (repo === 'deepseek-ai/deepseek-harness'
      || givenName === '@deepseek-ai/dsh-root'
      || givenName === '@deepseek-ai/dsh') {
      sendError(res, 400, 'deepseek-harness 是 DSH 框架本体，不是插件——无需安装（升级请用官方 dsh 升级方式）')
      return
    }
    const kind = body.kind === 'skill' ? 'skill' : body.kind === 'suite' ? 'suite' : 'plugin'
    if ((kind === 'skill' || kind === 'suite') && repo === '') {
      sendError(res, 400, `${kind === 'skill' ? '技能' : '套装'}安装必须提供仓库（owner/name）`)
      return
    }
    const source = body.source === 'gitee' ? body.source : 'github'
    const npmNamePattern = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/u
    if (givenName !== '' && (!npmNamePattern.test(givenName) || givenName.length > 214)) {
      sendError(res, 400, 'packageName 不是合法的 npm 包名')
      return
    }
    // 防重（事故教训）：同一插件已在安装/更新中时拒绝新任务——否则反复点更新/安装会产生
    // 几十个并发下载任务（同一插件重复安装、消息刷屏、浪费流量）
    const dupJob = [...installJobs.values()].some((j) => j.status === 'installing'
      && ((repo !== '' && j.repo === repo) || (givenName !== '' && j.packageName === givenName)))
    if (dupJob) {
      sendError(res, 409, '该插件正在安装/更新中，请等待当前任务完成后再试')
      return
    }
    const job = {
      id: `job-${nextInstallJobSeq()}`,
      repo,
      source,
      packageName: givenName || null,
      status: 'installing',
      stage: 'preparing',
      error: null,
      startedAt: Date.now(),
      finishedAt: null,
      entryId: null,
      bundle: false,
      ai: false,
      aiNote: null,
      subpackages: null,
      lastError: null,
        update: body.update === true,
      kind,
    }
    installJobs.set(job.id, job)
    // 后台执行：请求立即返回，安装不受客户端断开/离开面板影响
    void (kind === 'skill' ? runSkillInstallJob(job, ctx) : kind === 'suite' ? runSuiteInstallJob(job, ctx) : runInstallJob(job, ctx))
    sendJson(res, 200, { ok: true, jobId: job.id, status: 'installing', kind })
    return
}

async function routeInstallStatus(req, res, rc) {
  const ctx = rc.ctx
  const url = rc.url
  const pathname = rc.pathname
  const method = rc.method
  const runSuiteInstallJob = rc.deps.runSuiteInstallJob
  const runInstallJob = rc.deps.runInstallJob
  const body = rc.body
    const jobId = typeof body.jobId === 'string' ? body.jobId : ''
    const job = installJobs.get(jobId)
    if (!job) {
      sendError(res, 404, '没有这个安装任务')
      return
    }
    sendJson(res, 200, { ok: true, ...installJobView(job) })
    return
}

export { routeInstall, routeInstallStatus }
