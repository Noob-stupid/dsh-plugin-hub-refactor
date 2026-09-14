// L2 · routes —— 技能（GET /skills-installed · POST /skill-remove · POST /skill-toggle）
// 分层 Step 8b：从 lib/index.js 的 handle() 原样搬出（只搬移未改逻辑；缩进保持原样）

import { existsSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { listInstalledSkills, setSkillEnabled } from '../domain/skills.js'
import { sendError, sendJson } from '../infra/httpd.js'
import { dshHome } from '../infra/paths.js'

async function routeSkillsInstalledGet(req, res, rc) {
  const ctx = rc.ctx
  const url = rc.url
  const pathname = rc.pathname
  const method = rc.method
    // 已安装技能清单（~/.dsh/skills 用户根）+ 插件自带技能（ctx.skills 聚合，只读展示）
    const skills = listInstalledSkills()
    let pluginSkills = []
    try {
      const skillsSvc = ctx.get('skills')
      const extra = await Promise.race([
        (async () => (typeof skillsSvc?.list === 'function' ? await skillsSvc.list({}) : []))(),
        new Promise((resolve) => setTimeout(() => resolve([]), 1500)),
      ])
      for (const s of extra ?? []) {
        if (s && typeof s.name === 'string' && !skills.some((x) => x.name === s.name)) {
          pluginSkills.push({ name: s.name, description: s.description ?? null, provider: s.provider ?? null, system: true })
        }
      }
    } catch {}
    sendJson(res, 200, { ok: true, skills, pluginSkills })
    return
}

async function routeSkillRemove(req, res, rc) {
  const ctx = rc.ctx
  const url = rc.url
  const pathname = rc.pathname
  const method = rc.method
  const body = rc.body
    // 删除已安装技能：仅接受 kebab-case 名称（防目录穿越），删除 ~/.dsh/skills/<name>
    const name = typeof body.name === 'string' ? body.name.trim() : ''
    if (name.startsWith('.')) {
      // 点号开头是系统/隐藏技能根（如 .system，dsh-skill-filesystem 保留目录）：禁止删除
      sendError(res, 403, `技能 ${name} 属于系统/隐藏技能，禁止删除（保留 DSH 自带技能）`)
      return
    }
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/u.test(name)) {
      sendError(res, 400, '技能名称无效（仅允许 kebab-case）')
      return
    }
    const dest = join(dshHome(), 'skills', name)
    if (!existsSync(dest)) {
      sendError(res, 404, `技能 ${name} 不存在`)
      return
    }
    try {
      rmSync(dest, { recursive: true, force: true })
      sendJson(res, 200, { ok: true, name })
    } catch (error) {
      sendError(res, 500, `删除技能失败：${error instanceof Error ? error.message : String(error)}`)
    }
    return
}

async function routeSkillToggle(req, res, rc) {
  const ctx = rc.ctx
  const url = rc.url
  const pathname = rc.pathname
  const method = rc.method
  const body = rc.body
    // 停用/启用技能：写入官方调用策略 frontmatter（disable-model-invocation / user-invocable），
    // 可逆（原始内容备份于技能目录 .dsh-skill-fm.bak）；系统/隐藏技能禁止停用（保护机制）。
    const name = typeof body.name === 'string' ? body.name.trim() : ''
    if (name.startsWith('.')) {
      // 点号开头是系统/隐藏技能根（如 .system，dsh-skill-filesystem 保留目录）：禁止停用
      sendError(res, 403, `技能 ${name} 属于系统/隐藏技能，禁止停用（保留 DSH 自带技能）`)
      return
    }
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/u.test(name)) {
      sendError(res, 400, '技能名称无效（仅允许 kebab-case）')
      return
    }
    const dest = join(dshHome(), 'skills', name)
    let skillFile = join(dest, 'SKILL.md')
    if (!existsSync(skillFile)) {
      // 平铺技能（<name>.md）
      const flat = `${dest}.md`
      if (existsSync(flat)) skillFile = flat
      else {
        sendError(res, 404, `技能 ${name} 不存在`)
        return
      }
    }
    const enabled = body.enabled === true
    try {
      setSkillEnabled(skillFile, enabled)
      sendJson(res, 200, { ok: true, name, enabled, skillFile })
    } catch (error) {
      sendError(res, 500, `${enabled ? '启用' : '停用'}技能失败：${error instanceof Error ? error.message : String(error)}`)
    }
    return
}

export { routeSkillsInstalledGet, routeSkillRemove, routeSkillToggle }
