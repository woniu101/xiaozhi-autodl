import net from 'node:net'
import { SUPERVISOR_CONFIG } from './config.js'
import { run } from './process.js'
import { affectedComponentsForFiles, fetchDeploymentBranch, git, isRepositoryKey, REPOSITORIES, repositoryState, type RepositoryKey } from './versions.js'

type UpdateState = 'running' | 'done' | 'failed' | 'rolled-back'
type UpdateStep = { name: string; label: string; state: 'pending' | 'running' | 'done' | 'failed' | 'skipped'; message?: string }

export interface UpdateOperation {
  id: string
  repository: RepositoryKey
  state: UpdateState
  startedAt: string
  finishedAt?: string
  fromCommit?: string
  toCommit?: string
  targetRef?: string
  components?: string[]
  steps: UpdateStep[]
  logs: string[]
  message?: string
}

const supervisorctl = '/root/miniconda3/bin/supervisorctl'
let currentUpdate: UpdateOperation | undefined

function addLog(operation: UpdateOperation, message: string) {
  operation.logs.push(`[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${message}`)
  if (operation.logs.length > 200) operation.logs.shift()
}

async function supervisorState(program: string): Promise<string> {
  const result = await run(supervisorctl, ['-c', SUPERVISOR_CONFIG, 'status', program])
  return result.stdout.trim().split(/\s+/)[1] || 'UNKNOWN'
}

function wasRunning(state: string) {
  return state === 'RUNNING' || state === 'STARTING'
}

async function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port })
    const finish = (value: boolean) => { socket.destroy(); resolve(value) }
    socket.setTimeout(1_000)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
  })
}

async function httpHealthy(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2_000) })
    return response.ok
  } catch {
    return false
  }
}

async function waitReady(check: { port: number; timeout: number; health?: string }): Promise<boolean> {
  const started = Date.now()
  while (Date.now() - started < check.timeout) {
    if (await portOpen(check.port) && (!check.health || await httpHealthy(check.health))) return true
    await new Promise((resolve) => setTimeout(resolve, 2_000))
  }
  return false
}

async function refreshComponents(repository: RepositoryKey, selected?: string[]) {
  const components = selected !== undefined ? selected : repository === 'xiaozhi'
    ? ['manager-web', 'manager-api', 'xiaozhi-server']
    : ['index-tts']
  if (!components.length) return { code: 0, stdout: '本次仅文档变更，无需构建或刷新运行服务', stderr: '' }
  return run('/root/xiaozhi-autodl/scripts/refresh-runtime', components, 30 * 60_000)
}

async function changedComponents(repository: RepositoryKey, path: string, from: string, to: string): Promise<string[]> {
  const result = await git(path, ['diff', '--name-only', from, to])
  const files = result.stdout.trim().split('\n').filter(Boolean)
  return affectedComponentsForFiles(repository, files)
}

async function dependencyChanges(repository: RepositoryKey, path: string, from: string, to: string): Promise<string[]> {
  const result = await git(path, ['diff', '--name-only', from, to])
  const blockers = repository === 'xiaozhi'
    ? [
        /^main\/xiaozhi-server\/(?:requirements.*\.txt|pyproject\.toml|uv\.lock)$/,
        /^main\/manager-web\/(?:package|package-lock)\.json$/,
        /^main\/manager-api\/(?:pom\.xml|\.mvn\/|mvnw)/,
      ]
    : [/^(?:pyproject\.toml|uv\.lock|requirements.*\.txt)$/]
  return result.stdout.trim().split('\n').filter(Boolean).filter((file) => blockers.some((pattern) => pattern.test(file)))
}

async function executeUpdate(operation: UpdateOperation) {
  const repository = REPOSITORIES[operation.repository]
  let oldCommit = ''
  let changedSource = false
  const runtimeStates: Record<string, string> = {}
  const programs = operation.repository === 'xiaozhi' ? ['web-gateway', 'manager-api', 'xiaozhi-server'] : ['index-tts']
  try {
    for (const program of programs) runtimeStates[program] = await supervisorState(program)
    for (const step of operation.steps) {
      step.state = 'running'
      if (step.name === 'preflight') {
        const state = await repositoryState(operation.repository)
        if (!state.available || !state.commit || !state.branch || !state.upstream) throw new Error('仓库或上游分支不可用')
        if (state.updateBlocked) throw new Error(`存在受保护的本地改动：${state.blockingChanges?.join('；')}`)
        oldCommit = state.commit
        operation.fromCommit = oldCommit.slice(0, 10)
        addLog(operation, `预检通过，当前版本 ${state.shortCommit}`)
      } else if (step.name === 'fetch') {
        const fetched = await fetchDeploymentBranch(operation.repository)
        if (fetched.code !== 0) throw new Error((fetched.stderr || '拉取远端元数据失败').trim())
        const state = await repositoryState(operation.repository)
        const targetRef = operation.targetRef || state.upstream
        if (!targetRef || !state.refs?.includes(targetRef)) throw new Error('目标版本不是允许的远端部署分支')
        operation.targetRef = targetRef
        const upstream = await git(repository.path, ['rev-parse', targetRef])
        const target = upstream.stdout.trim()
        if (!target) throw new Error('无法解析上游版本')
        operation.toCommit = target.slice(0, 10)
        if (target === oldCommit) {
          step.message = '已经是远端最新版本'
          addLog(operation, step.message)
          step.state = 'done'
          for (const later of operation.steps.slice(operation.steps.indexOf(step) + 1)) later.state = 'skipped'
          operation.state = 'done'
          operation.message = '已经是远端最新版本'
          return
        }
        const dependencies = await dependencyChanges(operation.repository, repository.path, oldCommit, target)
        if (dependencies.length) throw new Error(`检测到依赖清单变化，自动更新已暂停：${dependencies.join('、')}`)
        operation.components = await changedComponents(operation.repository, repository.path, oldCommit, target)
        const ancestor = await git(repository.path, ['merge-base', '--is-ancestor', oldCommit, target])
        if (ancestor.code !== 0) throw new Error('远端版本无法快进，需人工处理分支历史')
        addLog(operation, `远端目标版本 ${target.slice(0, 10)}，可安全快进；刷新组件：${operation.components.join('、')}`)
      } else if (step.name === 'install') {
        const merged = await git(repository.path, ['merge', '--ff-only', operation.targetRef || '@{upstream}'], 90_000)
        if (merged.code !== 0) throw new Error((merged.stderr || merged.stdout || '快进源码失败').trim())
        changedSource = true
        addLog(operation, '源码已快进，开始构建与刷新运行版本')
      } else if (step.name === 'build') {
        const refreshed = await refreshComponents(operation.repository, operation.components)
        if (refreshed.code !== 0) throw new Error((refreshed.stderr || refreshed.stdout || '构建刷新失败').trim().slice(-1200))
        addLog(operation, operation.components?.length ? '构建与原子替换完成' : '本次仅文档变更，无需构建或重启')
      } else if (step.name === 'verify') {
        const componentChecks: Record<string, { program: string; port: number; timeout: number; health?: string }> = {
          'manager-web': { program: 'web-gateway', port: 6008, timeout: 30_000, health: 'http://127.0.0.1:6008/' },
          'manager-api': { program: 'manager-api', port: 8002, timeout: 180_000, health: 'http://127.0.0.1:8002/xiaozhi/user/pub-config' },
          'xiaozhi-server': { program: 'xiaozhi-server', port: 8000, timeout: 180_000 },
          'index-tts': { program: 'index-tts', port: 8092, timeout: 10 * 60_000, health: 'http://127.0.0.1:8092/health/ready' },
        }
        const checks = (operation.components || []).map((component) => componentChecks[component]).filter(Boolean)
        for (const check of checks) {
          if (!wasRunning(runtimeStates[check.program])) {
            addLog(operation, `${check.program} 更新前为停止状态，保持停止并跳过在线探测`)
            continue
          }
          if (!await waitReady(check)) throw new Error(`${check.program} 更新后未在限时内通过健康检查`)
        }
        addLog(operation, '原运行服务均已通过端口就绪检查')
      }
      step.state = 'done'
    }
    operation.state = 'done'
    operation.message = `已更新到 ${operation.toCommit}`
  } catch (error) {
    const message = error instanceof Error ? error.message : '更新失败'
    operation.steps.find((step) => step.state === 'running')!.state = 'failed'
    addLog(operation, message)
    if (changedSource && oldCommit) {
      addLog(operation, `开始回滚到 ${oldCommit.slice(0, 10)}`)
      const reset = await git(repository.path, ['reset', '--hard', oldCommit], 90_000)
      const refreshed = reset.code === 0 ? await refreshComponents(operation.repository, operation.components) : { code: 1, stderr: reset.stderr, stdout: reset.stdout }
      if (refreshed.code === 0) {
        operation.state = 'rolled-back'
        operation.message = `更新失败，已自动回滚：${message}`
        addLog(operation, '源码、构建产物与运行状态已回滚')
      } else {
        operation.state = 'failed'
        operation.message = `更新失败且自动回滚未完成：${message}`
        addLog(operation, (refreshed.stderr || refreshed.stdout || '回滚失败').trim().slice(-800))
      }
    } else {
      operation.state = 'failed'
      operation.message = message
    }
  } finally {
    operation.finishedAt = new Date().toISOString()
  }
}

export function startSafeUpdate(repository: string, targetRef?: string): UpdateOperation {
  if (!isRepositoryKey(repository)) throw new Error('不支持的代码仓库')
  if (currentUpdate?.state === 'running') throw new Error('已有安全更新正在执行')
  const operation: UpdateOperation = {
    id: crypto.randomUUID(),
    repository,
    targetRef: targetRef?.trim() || undefined,
    state: 'running',
    startedAt: new Date().toISOString(),
    steps: [
      { name: 'preflight', label: '安全预检', state: 'pending' },
      { name: 'fetch', label: '检查远端', state: 'pending' },
      { name: 'install', label: '快进源码', state: 'pending' },
      { name: 'build', label: '构建与替换', state: 'pending' },
      { name: 'verify', label: '重启与验收', state: 'pending' },
    ],
    logs: [],
  }
  currentUpdate = operation
  void executeUpdate(operation)
  return operation
}

export function currentSafeUpdate() {
  return currentUpdate
}
