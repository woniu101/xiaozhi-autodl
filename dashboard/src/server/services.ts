import net from 'node:net'
import { open } from 'node:fs/promises'
import { resolve } from 'node:path'
import { RUNTIME_ROOT, SERVICES, SUPERVISOR_CONFIG, type ServiceAction, type ServiceName } from './config.js'
import { run } from './process.js'
import { observeStability, serviceSignals } from './service-metrics.js'

export type ServicePhase = 'READY' | 'STARTING' | 'STOPPING' | 'DEGRADED' | 'BLOCKED' | 'STOPPED' | 'FAILED'
export type LogLevel = 'all' | 'info' | 'warn' | 'error'
export type LogSource = 'service' | 'access' | 'error' | 'raw' | 'slow'
export type LogPreset = 'http-errors' | 'manager-requests'

export interface ServiceActions {
  start: boolean
  stop: boolean
  restart: boolean
}

export interface ServicePreflight {
  service: string
  ok: boolean
  kind?: 'resource' | 'dependency'
  reason: string
  checkedAt: string
  checks: Array<{ key: string; label: string; ok: boolean; actual: unknown; required: unknown; unit?: string }>
}

export class ServiceOperationConflict extends Error {}

const activeActions = new Map<ServiceName, ServiceAction>()
const preflightCache = new Map<ServiceName, { expiresAt: number; result: ServicePreflight }>()

const startOrder: ServiceName[] = ['mysql', 'redis', 'manager-api', 'index-tts', 'xiaozhi-server', 'web-gateway']
const stopOrder = [...startOrder].reverse()

function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port })
    const finish = (value: boolean) => { socket.destroy(); resolve(value) }
    socket.setTimeout(700)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
  })
}

async function supervisorStatus(): Promise<Map<string, { state: string; detail: string; pid?: number }>> {
  const result = await run('/root/miniconda3/bin/supervisorctl', ['-c', SUPERVISOR_CONFIG, 'status'])
  const map = new Map<string, { state: string; detail: string; pid?: number }>()
  for (const line of result.stdout.split('\n')) {
    const match = line.match(/^(\S+)\s+(\S+)\s*(.*)$/)
    if (!match) continue
    const pid = match[3].match(/pid (\d+)/)?.[1]
    map.set(match[1], { state: match[2], detail: match[3], pid: pid ? Number(pid) : undefined })
  }
  return map
}

async function systemServicePid(name: 'mysql' | 'redis'): Promise<number | undefined> {
  const patterns = name === 'mysql' ? ['mysqld'] : ['redis-server']
  for (const pattern of patterns) {
    const result = await run('/usr/bin/pgrep', ['-o', '-x', pattern])
    const pid = Number(result.stdout.trim())
    if (result.code === 0 && Number.isInteger(pid) && pid > 0) return pid
  }
  return undefined
}

async function systemServiceHealthy(name: 'mysql' | 'redis'): Promise<boolean> {
  const result = name === 'redis'
    ? await run('/usr/bin/redis-cli', ['--raw', 'PING'], 2_000)
    : await run('/usr/bin/mysqladmin', ['--defaults-file=/etc/mysql/debian.cnf', 'ping'], 2_000)
  return result.code === 0 && (name === 'redis' ? result.stdout.trim() === 'PONG' : /mysqld is alive/i.test(result.stdout))
}

async function systemServiceRunning(name: 'mysql' | 'redis'): Promise<boolean> {
  const [healthy, pid, listening] = await Promise.all([
    systemServiceHealthy(name),
    systemServicePid(name),
    portOpen(SERVICES[name].port),
  ])
  return healthy || Boolean(pid) || listening
}

export function actionsForPhase(phase: ServicePhase, locked = false): ServiceActions {
  if (locked || phase === 'STOPPING' || phase === 'BLOCKED') return { start: false, stop: false, restart: false }
  if (phase === 'READY' || phase === 'DEGRADED') return { start: false, stop: true, restart: true }
  if (phase === 'STARTING') return { start: false, stop: true, restart: false }
  return { start: true, stop: false, restart: false }
}

async function servicePreflight(name: ServiceName, useCache = true): Promise<ServicePreflight | undefined> {
  if (name !== 'index-tts' && name !== 'xiaozhi-server') return undefined
  const cached = preflightCache.get(name)
  if (useCache && cached && cached.expiresAt > Date.now()) return cached.result
  const result = await run('/root/xiaozhi-autodl/bin/service-preflight', [name, '--json'], 4_000)
  try {
    const parsed = JSON.parse(result.stdout.trim()) as ServicePreflight
    if (!parsed || typeof parsed.ok !== 'boolean' || typeof parsed.reason !== 'string') return undefined
    preflightCache.set(name, { expiresAt: Date.now() + 4_000, result: parsed })
    return parsed
  } catch {
    return undefined
  }
}

async function processUsage(pid?: number): Promise<{ cpu?: number; memory?: number; uptime?: number }> {
  if (!pid) return {}
  const result = await run('/usr/bin/ps', ['-p', String(pid), '-o', '%cpu=,rss=,etimes='])
  if (result.code !== 0) return {}
  const [cpu, rss, uptime] = result.stdout.trim().split(/\s+/).map(Number)
  return {
    cpu: Number.isFinite(cpu) ? cpu : undefined,
    memory: Number.isFinite(rss) ? rss * 1024 : undefined,
    uptime: Number.isFinite(uptime) ? uptime : undefined,
  }
}

function redact(content: string): string {
  return content
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/((?:api[_-]?key|token|password|secret)\s*[:=]\s*["']?)[^\s,"'}]+/gi, '$1[REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, 'sk-[REDACTED]')
}

function stripAnsi(content: string): string {
  return content.replace(/[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d\/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g, '')
}

function lineLevel(line: string): Exclude<LogLevel, 'all'> | undefined {
  const clean = stripAnsi(line)
  if (/Traceback \(most recent call last\)|uncaught (?:exception|error)/i.test(clean)
    || /(?:^|[\s\]])(?:ERROR|FATAL|CRITICAL)(?:[\s\[(:-]|$)/.test(clean)
    || /\[error\]/i.test(clean)) return 'error'
  if (/(?:^|[\s\]])(?:WARN|WARNING)(?:[\s\[(:-]|$)/.test(clean) || /\[warn\]/i.test(clean)) return 'warn'
  if (/(?:^|[\s\]])(?:INFO|DEBUG|TRACE)(?:[\s\[(:-]|$)/.test(clean) || /\[info\]/i.test(clean)) return 'info'
  return undefined
}

async function readTail(path: string, maxBytes: number): Promise<string> {
  const handle = await open(path, 'r')
  try {
    const stats = await handle.stat()
    const length = Math.min(stats.size, maxBytes)
    const buffer = Buffer.alloc(length)
    await handle.read(buffer, 0, length, Math.max(0, stats.size - length))
    return buffer.toString('utf8')
  } finally {
    await handle.close()
  }
}

async function lastError(path: string): Promise<string | undefined> {
  try {
    const content = stripAnsi(redact(await readTail(path, 512 * 1024)))
    return content.split('\n').slice(-300).reverse().find((line) => lineLevel(line) === 'error')?.trim().slice(0, 240)
  } catch {
    return undefined
  }
}

async function health(url?: string): Promise<{ ok: boolean; status?: number; latencyMs?: number }> {
  if (!url) return { ok: true }
  const started = performance.now()
  try {
    const response = await fetch(url, {
      headers: { 'x-xiaozhi-health-probe': '1' },
      signal: AbortSignal.timeout(1_500),
    })
    return { ok: response.ok, status: response.status, latencyMs: Math.round(performance.now() - started) }
  } catch {
    return { ok: false, latencyMs: Math.round(performance.now() - started) }
  }
}

export async function listServices() {
  const supervisor = await supervisorStatus()
  return Promise.all((Object.entries(SERVICES) as [ServiceName, typeof SERVICES[ServiceName]][]).map(async ([name, config]) => {
    const systemName = !config.supervisor ? name as 'mysql' | 'redis' : undefined
    const [listening, nativeHealthy, preflight] = await Promise.all([
      portOpen(config.port),
      systemName ? systemServiceHealthy(systemName) : Promise.resolve(false),
      servicePreflight(name),
    ])
    const processState = config.supervisor ? supervisor.get(name) : undefined
    const appHealth = systemName
      ? { ok: nativeHealthy }
      : listening ? await health(config.health) : { ok: false }
    const pid = processState?.pid || (systemName ? await systemServicePid(systemName) : undefined)
    const usage = await processUsage(pid)
    const activeAction = activeActions.get(name)
    const blocked = !listening && !pid && preflight && !preflight.ok ? preflight : undefined
    const rawState = activeAction === 'stop'
      ? 'STOPPING'
      : activeAction === 'start' || activeAction === 'restart'
        ? 'STARTING'
        : blocked
          ? 'BLOCKED'
          : config.supervisor ? (processState?.state || 'NOT_MANAGED') : (nativeHealthy || listening || pid ? 'RUNNING' : 'STOPPED')
    const phase: ServicePhase = rawState === 'STOPPING'
      ? 'STOPPING'
      : rawState === 'STARTING'
        ? 'STARTING'
        : rawState === 'BLOCKED'
          ? 'BLOCKED'
          : appHealth.ok && listening
            ? 'READY'
            : listening || Boolean(pid)
          ? 'DEGRADED'
          : rawState === 'FATAL' || rawState === 'BACKOFF' || rawState === 'EXITED'
            ? 'FAILED'
            : 'STOPPED'
    const [stability, signals] = await Promise.all([
      observeStability(name, pid),
      serviceSignals(name, pid, appHealth.latencyMs),
    ])
    return {
      name,
      label: config.label,
      port: config.port,
      state: rawState,
      phase,
      detail: processState?.detail || '',
      blocker: blocked,
      pid,
      ...usage,
      listening,
      healthy: listening && appHealth.ok,
      activeAction,
      allowedActions: actionsForPhase(phase, Boolean(activeAction) || currentOperation?.state === 'running'),
      healthStatus: appHealth.status,
      healthLatencyMs: appHealth.latencyMs,
      stability,
      signals,
      lastError: await lastError(config.log),
    }
  }))
}

async function performServiceAction(name: ServiceName, action: ServiceAction) {
  const config = SERVICES[name]
  if (config.supervisor) {
    const state = (await supervisorStatus()).get(name)?.state
    if (action === 'start' && (state === 'RUNNING' || state === 'STARTING')) return { message: `${config.label} 已经在运行` }
    if (action === 'stop' && (!state || ['STOPPED', 'EXITED', 'FATAL', 'BACKOFF'].includes(state))) return { message: `${config.label} 已经停止` }
    if (action === 'restart' && (!state || ['STOPPED', 'EXITED', 'FATAL', 'BACKOFF'].includes(state))) {
      throw new ServiceOperationConflict(`${config.label} 当前未运行，请使用启动`)
    }
    if (action === 'restart' && state === 'STARTING') throw new ServiceOperationConflict(`${config.label} 正在启动，请等待就绪或先停止`)
    if (action === 'start') {
      const preflight = await servicePreflight(name, false)
      if (preflight && !preflight.ok) throw new ServiceOperationConflict(preflight.reason)
    }
  } else {
    const running = await systemServiceRunning(name as 'mysql' | 'redis')
    if (action === 'start' && running) return { message: `${config.label} 已经在运行` }
    if (action === 'stop' && !running) return { message: `${config.label} 已经停止` }
    if (action === 'restart' && !running) throw new ServiceOperationConflict(`${config.label} 当前未运行，请使用启动`)
  }

  let result: Awaited<ReturnType<typeof run>>
  if (config.supervisor) {
    result = await run('/root/miniconda3/bin/supervisorctl', ['-c', SUPERVISOR_CONFIG, action, name], 30_000)
  } else if (name === 'redis') {
    if (action === 'start') {
      result = await run('/root/xiaozhi-autodl/bin/start-redis', [], 30_000)
    } else {
      result = await run('/usr/bin/redis-cli', ['SHUTDOWN', 'SAVE'], 20_000)
      if (result.code !== 0 && await systemServiceRunning('redis')) {
        throw new Error((result.stderr || result.stdout || 'Redis 安全停止失败').trim())
      }
      if (action === 'restart') {
        await waitFor('redis', false)
        result = await run('/root/xiaozhi-autodl/bin/start-redis', [], 30_000)
      }
    }
  } else {
    result = await run('/usr/sbin/service', [name, action], 30_000)
  }
  if (result.code !== 0) throw new Error((result.stderr || result.stdout || '操作失败').trim())
  return { message: (result.stdout || `${config.label} ${action} 完成`).trim() }
}

async function executeServiceAction(name: ServiceName, action: ServiceAction, options: { batch?: boolean; wait?: boolean } = {}) {
  if (!options.batch && currentOperation?.state === 'running') throw new ServiceOperationConflict('批量操作正在执行，请等待完成')
  if (activeActions.has(name)) throw new ServiceOperationConflict(`${SERVICES[name].label} 正在执行其他操作`)
  activeActions.set(name, action)
  try {
    const result = await performServiceAction(name, action)
    if (options.wait) await waitFor(name, action !== 'stop')
    return result
  } finally {
    activeActions.delete(name)
  }
}

export async function actOnService(name: ServiceName, action: ServiceAction) {
  return executeServiceAction(name, action)
}

function logPath(name: ServiceName, source: LogSource): string {
  if (source === 'access' && (name === 'web-gateway' || name === 'manager-api')) return resolve(RUNTIME_ROOT, 'logs/nginx-access.log')
  if (source === 'error' && name === 'web-gateway') return resolve(RUNTIME_ROOT, 'logs/nginx-error.log')
  if (source === 'error' && name === 'mysql') return resolve(RUNTIME_ROOT, 'logs/mysql/error.log')
  if (source === 'slow' && name === 'mysql') return resolve(RUNTIME_ROOT, 'logs/mysql/slow.log')
  return SERVICES[name].log
}

function effectiveSource(name: ServiceName, source?: LogSource): LogSource {
  if (source === 'raw' && (name === 'index-tts' || name === 'xiaozhi-server')) return source
  if (source === 'access' && (name === 'web-gateway' || name === 'manager-api')) return source
  if (source === 'error' && name === 'web-gateway') return source
  if ((source === 'error' || source === 'slow') && name === 'mysql') return source
  if (!source && name === 'web-gateway') return 'access'
  return 'service'
}

export function isRoutineServiceLine(name: ServiceName, source: LogSource, line: string): boolean {
  if (source !== 'service') return false
  if (name === 'index-tts') {
    return /"GET \/(?:health\/(?:live|ready)|internal\/metrics) HTTP\/1\.[01]" 200 OK/.test(line)
  }
  if (name === 'xiaozhi-server') {
    return /^curl: \(7\) Failed to connect to 127\.0\.0\.1 port 8002\b/.test(line)
  }
  return false
}

function matchesPreset(line: string, preset?: LogPreset): boolean {
  if (preset === 'http-errors') return /"\s[45]\d\d\s/.test(line)
  if (preset === 'manager-requests') return /"(?:GET|POST|PUT|DELETE|PATCH) \/xiaozhi\/(?!v1\/)/.test(line)
  return true
}

function filterWithErrorContext(lines: string[], level: LogLevel): string[] {
  if (level === 'all') return lines
  const included = new Set<number>()
  lines.forEach((line, index) => {
    if (lineLevel(line) !== level) return
    included.add(index)
    if (level !== 'error') return
    for (let offset = 1; offset <= 12 && index + offset < lines.length; offset++) {
      if (lineLevel(lines[index + offset])) break
      included.add(index + offset)
    }
  })
  return lines.filter((_line, index) => included.has(index))
}

export async function serviceLogs(name: ServiceName, options: { lines: number; level?: LogLevel; keyword?: string; source?: LogSource; preset?: LogPreset }) {
  const source = effectiveSource(name, options.source)
  const path = logPath(name, source)
  try {
    const content = stripAnsi(redact(await readTail(path, 4 * 1024 * 1024)))
    const level = options.level || 'all'
    const keyword = options.keyword?.trim().toLocaleLowerCase()
    const visibleLines = content.split('\n').filter((line) => !isRoutineServiceLine(name, source, line))
    const filtered = filterWithErrorContext(visibleLines, level)
      .filter((line) => matchesPreset(line, options.preset) && (!keyword || line.toLocaleLowerCase().includes(keyword)))
    return { path, source, content: filtered.slice(-options.lines).join('\n') }
  } catch (error) {
    return { path, source, content: '', error: error instanceof Error ? error.message : '日志不可读' }
  }
}

async function serviceReady(name: ServiceName): Promise<boolean> {
  if (name === 'mysql' || name === 'redis') return systemServiceHealthy(name)
  if (!await portOpen(SERVICES[name].port)) return false
  return (await health(SERVICES[name].health)).ok
}

async function serviceStopped(name: ServiceName): Promise<boolean> {
  if (name === 'mysql' || name === 'redis') return !(await systemServiceRunning(name))
  const state = (await supervisorStatus()).get(name)?.state
  const stoppedState = !state || ['STOPPED', 'EXITED', 'FATAL', 'BACKOFF'].includes(state)
  return stoppedState && !await portOpen(SERVICES[name].port)
}

async function waitFor(name: ServiceName, running: boolean): Promise<void> {
  const timeout = name === 'index-tts' ? 10 * 60_000 : name === 'manager-api' || name === 'xiaozhi-server' ? 3 * 60_000 : 60_000
  const started = Date.now()
  while (Date.now() - started < timeout) {
    if (running && SERVICES[name].supervisor) {
      const processState = (await supervisorStatus()).get(name)
      if (processState && ['FATAL', 'BACKOFF', 'EXITED'].includes(processState.state)) {
        throw new Error(`${SERVICES[name].label} 启动失败：${processState.detail || processState.state}`)
      }
    }
    if (running ? await serviceReady(name) : await serviceStopped(name)) return
    await new Promise((resolve) => setTimeout(resolve, 1_500))
  }
  throw new Error(`${SERVICES[name].label} 等待${running ? '启动' : '停止'}超时`)
}

export interface BatchStep {
  service: ServiceName
  label: string
  action: 'start' | 'stop'
  state: 'pending' | 'running' | 'done' | 'failed' | 'skipped'
  message?: string
}

export interface BatchOperation {
  id: string
  action: ServiceAction
  state: 'running' | 'done' | 'failed'
  startedAt: string
  finishedAt?: string
  steps: BatchStep[]
}

let currentOperation: BatchOperation | undefined

const startDependencies: Partial<Record<ServiceName, ServiceName[]>> = {
  'manager-api': ['mysql', 'redis'],
  'xiaozhi-server': ['manager-api', 'index-tts'],
}

export function failedDependencies(service: ServiceName, failed: Iterable<ServiceName>): ServiceName[] {
  const failedSet = failed instanceof Set ? failed : new Set(failed)
  return (startDependencies[service] || []).filter((dependency) => failedSet.has(dependency))
}

function operationSteps(action: ServiceAction): BatchStep[] {
  const actions: Array<{ service: ServiceName; action: 'start' | 'stop' }> = action === 'restart'
    ? [...stopOrder.map((service) => ({ service, action: 'stop' as const })), ...startOrder.map((service) => ({ service, action: 'start' as const }))]
    : (action === 'start' ? startOrder : stopOrder).map((service) => ({ service, action }))
  return actions.map(({ service, action: stepAction }) => ({
    service,
    label: SERVICES[service].label,
    action: stepAction,
    state: 'pending',
  }))
}

async function executeBatch(operation: BatchOperation): Promise<void> {
  let failed = false
  const failedStarts = new Set<ServiceName>()
  try {
    for (const step of operation.steps) {
      if (step.action === 'start') {
        const unavailable = failedDependencies(step.service, failedStarts)
        if (unavailable.length) {
          step.state = 'skipped'
          step.message = `依赖 ${unavailable.map((name) => SERVICES[name].label).join('、')} 启动失败，已跳过`
          failedStarts.add(step.service)
          failed = true
          continue
        }
      }
      step.state = 'running'
      try {
        const result = await executeServiceAction(step.service, step.action, { batch: true, wait: true })
        step.state = 'done'
        step.message = result.message
      } catch (error) {
        step.state = 'failed'
        step.message = error instanceof Error ? error.message : '操作失败'
        failed = true
        if (step.action === 'start') failedStarts.add(step.service)
        // 停止操作始终继续；启动操作仅跳过依赖失败的下游，独立服务仍继续处理。
      }
    }
    operation.state = failed ? 'failed' : 'done'
  } catch {
    operation.state = 'failed'
  } finally {
    operation.finishedAt = new Date().toISOString()
  }
}

export function startBatchOperation(action: ServiceAction): BatchOperation {
  if (currentOperation?.state === 'running') throw new ServiceOperationConflict('已有批量操作正在执行')
  if (activeActions.size) throw new ServiceOperationConflict('有服务正在执行单项操作，请等待完成')
  const operation: BatchOperation = {
    id: crypto.randomUUID(),
    action,
    state: 'running',
    startedAt: new Date().toISOString(),
    steps: operationSteps(action),
  }
  currentOperation = operation
  void executeBatch(operation)
  return operation
}

export function getCurrentOperation(): BatchOperation | undefined {
  return currentOperation
}
