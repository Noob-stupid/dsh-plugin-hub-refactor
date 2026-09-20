// L2 · routes —— GitHub 登录（POST /github-login）：用粘贴的 token 换登录名并写入
// <DSH_HOME>/github-auth.json（与独立插件 dsh-github-login 同一份文件、同一格式 { token, login }）。
//
// 为什么需要它：市场页那个「未登录 GitHub」徽章原来只是展示，用户点了没反应；而 token 文件此前
// 只能靠独立插件写入。补一条"直接粘贴 token"的通道后，用户不必再装第二个插件。
//
// 三条安全约束（改这里时不要破）：
//   ① token 只进不出 —— 响应只回 login，绝不回显 token，也不写任何日志（日志会进 console 文件）
//   ② 先校验形状再发网络请求 —— 明显不是 PAT 的串不浪费一次 GitHub 往返
//   ③ 落盘尽量收紧权限（POSIX 0600；Windows 无此权限模型，失败忽略）

import { chmodSync, mkdirSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { GITHUB_API, collectBody, githubRequest, githubViaGh } from '../infra/http.js'
import { sendError, sendJson } from '../infra/httpd.js'
import { dshHome } from '../infra/paths.js'

/** GitHub personal access token 形状：classic（ghp_/gho_/ghu_/ghs_/ghr_）与 fine-grained（github_pat_）。 */
const GH_TOKEN_PATTERN = /^(?:gh[pousr]_[A-Za-z0-9]{20,255}|github_pat_[A-Za-z0-9_]{20,255})$/u

/** node:https 通道（官方 + 镜像）：认证头就是用户给的这个 token。 */
async function viaHttps(token) {
  const res = await githubRequest(`${GITHUB_API}/user`, { token })
  const status = res.statusCode ?? 0
  const body = await collectBody(res)
  // 与 githubJson 同一套错误语义：限流单独说明，其余只报 HTTP 状态（都不含 token）
  if (status === 403 && Number(res.headers['x-ratelimit-remaining'] ?? '1') === 0) {
    throw new Error('GitHub 接口限流已用尽，请稍后再试')
  }
  if (status < 200 || status >= 300) throw new Error(`GitHub 请求失败 (HTTP ${status})`)
  return JSON.parse(body)
}

/**
 * 用**给定 token 专属**的通道取当前用户。
 *
 * 为什么不能直接用 githubJson：它内部会与 gh CLI 通道并行竞速（raceFirst2xx），而 gh 默认用
 * 本机 keyring 里已有的凭据、**完全忽略我们传入的 token**。本机装了已登录的 gh 时，一个填错的
 * token 也会因 gh 通道 2xx 而"验证成功"（2026-09-20 实测：本机 gh 登录 Noob-stupid，ghp_aaa…
 * 拿到的是 Noob-stupid），于是错误 token 被写进 github-auth.json，把用户真实登录态顶掉。
 *
 * 两条通道都只认用户给的这个 token（gh 走 GH_TOKEN 环境变量覆盖 keyring 凭据）：
 *   · https：通用主通道，无子进程
 *   · gh：node:https 被中间设备劫持时（本机实测 "unable to verify the first certificate"）
 *         的唯一可用通道 —— 少了它，本机粘对 token 也会被判成"令牌无效"
 * 两条通道认证的是同一个 token，所以谁先成功都等价；一旦某条给出 401/403（令牌本身不对），
 * 立刻采信，不等另一条慢超时。
 */
async function fetchGithubUser(token) {
  const attempts = [
    viaHttps(token),
    githubViaGh('/user', token),
  ]
  return await new Promise((resolve, reject) => {
    let pending = attempts.length
    let firstError = null
    for (const attempt of attempts) {
      attempt.then(resolve, (error) => {
        const message = error instanceof Error ? error.message : String(error)
        if (/HTTP (?:401|403)/u.test(message)) {
          reject(error)
          return
        }
        if (firstError === null) firstError = error
        pending -= 1
        if (pending === 0) reject(firstError)
      })
    }
  })
}

async function routeGithubLogin(req, res, rc) {
  const token = typeof rc.body?.token === 'string' ? rc.body.token.trim() : ''
  if (!GH_TOKEN_PATTERN.test(token)) {
    sendError(res, 400, '令牌格式不正确（应为 GitHub personal access token，ghp_/github_pat_ 开头）')
    return
  }
  let login = null
  try {
    const me = await fetchGithubUser(token)
    login = typeof me?.login === 'string' && me.login !== '' ? me.login : null
  } catch (error) {
    // gh 通道的原始报错带 execFile 的 "Command failed: gh api …" 命令回显与多行 stderr，
    // 压成一行再给用户看（原文只含状态与命令名，不含 token —— 我们从不把 token 传进命令行）
    const message = (error instanceof Error ? error.message : String(error))
      .replace(/Command failed:[^\n]*\n?/gu, '')
      .replace(/\s+/gu, ' ')
      .trim()
    // 与 A 条同一课：**"没验成"不等于"令牌无效"**。通道全挂（证书/超时/DNS）时报"令牌无效"
    // 会把用户往错的方向带（去重新生成 token），必须分开说；文案里仍然不带 token 本身。
    const transport = /证书|certificate|超时|timeout|ECONN|ENOTFOUND|EAI_AGAIN|getaddrinfo|socket|network|aborted|未找到 gh CLI/iu.test(message)
    sendError(res, 400, transport
      ? `无法连接 GitHub 校验令牌（网络/证书问题，不代表令牌无效，可重试）：${message}`
      : `令牌无效或权限不足：${message}`)
    return
  }
  if (login === null) {
    sendError(res, 400, '令牌无效或权限不足：GitHub 未返回登录名')
    return
  }
  const file = join(dshHome(), 'github-auth.json')
  try {
    mkdirSync(dshHome(), { recursive: true })
    // mode 只在新建时生效，所以再显式 chmod 一次：老文件可能是 0644（token 不该对同机其他用户可读）
    await writeFile(file, `${JSON.stringify({ token, login }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    try { chmodSync(file, 0o600) } catch {}
  } catch (error) {
    sendError(res, 500, `写入登录状态失败：${error instanceof Error ? error.message : String(error)}`)
    return
  }
  sendJson(res, 200, { ok: true, login })
}

export { routeGithubLogin }
