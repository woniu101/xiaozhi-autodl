import net from 'node:net'
import { spawn } from 'node:child_process'
import { closeSync, openSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { PROJECT_ROOT, RUNTIME_ROOT, SUPERVISOR_CONFIG } from './config.js'
import { run } from './process.js'
import { affectedComponentsForFiles, fetchDeploymentBranch, git, isRepositoryKey, REPOSITORIES, repositoryState, type RepositoryKey } from './versions.js'

type UpdateState = 'running' | 'done' | 'failed' | 'rolled-back'
type UpdateStep = { name: string; label: string; state: 'pending' | 'running' | 'done' | 'failed' | 'skipped'; message?: string; startedAt?: string; finishedAt?: string }

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
  workerPid?: number
}

const supervisorctl = '/root/miniconda3/bin/supervisorctl'
const updateStatePath = resolve(RUNTIME_ROOT, 'run/update-operation.json')
const updateHistoryPath = resolve(RUNTIME_ROOT, 'run/update-history.json')
let currentUpdate: UpdateOperation | undefined

async function persistUpdate(operation: UpdateOperation) {
  await mkdir(resolve(RUNTIME_ROOT, 'run'), { recursive: true })
  const temporary = `${updateStatePath}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify(operation, null, 2)}\n`, { mode: 0o600 })
  await rename(temporary, updateStatePath)
}

async function persistedUpdate(): Promise<UpdateOperation | undefined> {
  try { return JSON.parse(await readFile(updateStatePath, 'utf8')) as UpdateOperation }
  catch { return undefined }
}

export async function updateHistory(): Promise<UpdateOperation[]> {
  try { return JSON.parse(await readFile(updateHistoryPath, 'utf8')) as UpdateOperation[] }
  catch { return [] }
}

async function archiveUpdate(operation: UpdateOperation) {
  const existing = (await updateHistory()).filter((item) => item.id !== operation.id)
  const history = [{ ...operation }, ...existing].slice(0, 10)
  const temporary = `${updateHistoryPath}.${process.pid}.${crypto.randomUUID()}.tmp`
  await writeFile(temporary, `${JSON.stringify(history, null, 2)}\n`, { mode: 0o600 })
  await rename(temporary, updateHistoryPath)
}

function processRunning(pid?: number): boolean {
  if (!pid) return false
  try { process.kill(pid, 0); return true } catch { return false }
}

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
    : repository === 'index-tts' ? ['index-tts'] : ['dashboard']
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
    : repository === 'index-tts'
      ? [/^(?:pyproject\.toml|uv\.lock|requirements.*\.txt)$/]
      : [/^(?:environment.*\.ya?ml|requirements.*\.txt)$/]
  return result.stdout.trim().split('\n').filter(Boolean).filter((file) => blockers.some((pattern) => pattern.test(file)))
}

async function executeUpdate(operation: UpdateOperation) {
  const repository = REPOSITORIES[operation.repository]
  let oldCommit = ''
  let changedSource = false
  const runtimeStates: Record<string, string> = {}
  const programs = operation.repository === 'xiaozhi'
    ? ['web-gateway', 'manager-api', 'xiaozhi-server']
    : operation.repository === 'index-tts' ? ['index-tts'] : ['dashboard']
  try {
    for (const program of programs) runtimeStates[program] = await supervisorState(program)
    for (const step of operation.steps) {
      step.state = 'running'
      step.startedAt = new Date().toISOString()
      await persistUpdate(operation)
      if (step.name === 'preflight') {
        const state = await repositoryState(operation.repository)
        if (!state.available || !state.commit || !state.branch || !state.upstream) throw new Error('仓库或上游分支不可用')
        if (state.updateBlocked) throw new Error(`存在受保护的本地改动：${state.blockingChanges?.join('；')}`)
        oldCommit = state.commit
        operation.fromCommit = oldCommit.slice(0, 10)
        addLog(operation, `预检通过，当前版本 ${state.shortCommit}`)
      } else if (step.name === 'fetch') {
        const fetched = await fetchDeploymentBranch(operation.repository)
        if (fetched.code !== 0) throw new Error((fetched.timedOut ? `GitHub 连接超时（已尝试 ${fetched.attempts} 条线路）` : fetched.stderr || fetched.errorMessage || '拉取远端元数据失败').trim())
        addLog(operation, `GitHub 元数据已通过 ${fetched.transport === 'autodl' ? 'AutoDL 学术加速' : fetched.transport === 'custom' ? '自定义代理' : '直接连接'}获取`)
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
          step.finishedAt = new Date().toISOString()
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
          dashboard: { program: 'dashboard', port: 6006, timeout: 60_000, health: 'http://127.0.0.1:6006/api/health' },
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
      step.finishedAt = new Date().toISOString()
      await persistUpdate(operation)
    }
    operation.state = 'done'
    operation.message = `已更新到 ${operation.toCommit}`
  } catch (error) {
    const message = error instanceof Error ? error.message : '更新失败'
    const runningStep = operation.steps.find((step) => step.state === 'running')
    if (runningStep) {
      runningStep.state = 'failed'
      runningStep.finishedAt = new Date().toISOString()
      runningStep.message = message
    }
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
    await persistUpdate(operation)
    try { await archiveUpdate(operation) }
    catch (error) { addLog(operation, `更新历史写入失败：${error instanceof Error ? error.message : error}`); await persistUpdate(operation) }
  }
}

function stepsForRepository(repository: RepositoryKey): UpdateStep[] {
  const labels = repository === 'xiaozhi'
    ? ['安全预检', '获取 mvp', '快进源码', '构建受影响组件', '刷新服务并验收']
    : repository === 'index-tts'
      ? ['安全预检', '获取 main', '快进源码', '刷新 IndexTTS', '等待模型与健康验收']
      : ['安全预检', '获取 main', '快进源码', '安装依赖并构建', '重启 Dashboard 并验收']
  return ['preflight', 'fetch', 'install', 'build', 'verify'].map((name, index) => ({ name, label: labels[index], state: 'pending' }))
}

export async function startSafeUpdate(repository: string, targetRef?: string): Promise<UpdateOperation> {
  if (!isRepositoryKey(repository)) throw new Error('不支持的代码仓库')
  const previous = await currentSafeUpdate()
  if (previous?.state === 'running') throw new Error('已有安全更新正在执行')
  const operation: UpdateOperation = {
    id: crypto.randomUUID(),
    repository,
    targetRef: targetRef?.trim() || undefined,
    state: 'running',
    startedAt: new Date().toISOString(),
    steps: stepsForRepository(repository),
    logs: [],
  }
  await persistUpdate(operation)
  if (repository === 'xiaozhi-autodl') {
    await mkdir(resolve(RUNTIME_ROOT, 'logs'), { recursive: true })
    const workerLog = openSync(resolve(RUNTIME_ROOT, 'logs/self-update.log'), 'a', 0o600)
    const worker = spawn(process.execPath, [resolve(PROJECT_ROOT, 'dashboard/dist/server/self-update-worker.js'), operation.id], {
      cwd: PROJECT_ROOT,
      detached: true,
      stdio: ['ignore', workerLog, workerLog],
      env: { ...process.env, XIAOZHI_AUTODL_UPDATE_WORKER: '1' },
    })
    closeSync(workerLog)
    worker.once('error', (error) => {
      operation.state = 'failed'
      operation.finishedAt = new Date().toISOString()
      operation.message = `无法启动自更新助手：${error.message}`
      operation.steps[0].state = 'failed'
      operation.steps[0].message = operation.message
      void persistUpdate(operation)
    })
    worker.unref()
  } else {
    currentUpdate = operation
    void executeUpdate(operation)
  }
  return operation
}

export async function runPersistedSelfUpdate(operationId: string): Promise<void> {
  const operation = await persistedUpdate()
  if (!operation || operation.id !== operationId || operation.repository !== 'xiaozhi-autodl') throw new Error('自更新任务不存在或已失效')
  if (operation.state !== 'running') return
  operation.workerPid = process.pid
  await persistUpdate(operation)
  currentUpdate = operation
  await executeUpdate(operation)
}

export async function currentSafeUpdate(): Promise<UpdateOperation | undefined> {
  const persisted = await persistedUpdate()
  if (persisted?.state === 'running' && persisted.repository === 'xiaozhi-autodl' && (!persisted.workerPid || !processRunning(persisted.workerPid))) {
    const age = Date.now() - new Date(persisted.startedAt).getTime()
    if (age > 10_000) {
      persisted.state = 'failed'
      persisted.finishedAt = new Date().toISOString()
      persisted.message = '自更新助手意外退出，请查看 Dashboard 日志后重试'
      const step = persisted.steps.find((item) => item.state === 'running' || item.state === 'pending')
      if (step) {
        step.state = 'failed'
        step.message = persisted.message
      }
      await persistUpdate(persisted)
    }
  }
  return persisted || currentUpdate
}
