import net from 'node:net'
import { open } from 'node:fs/promises'
import { resolve } from 'node:path'
import { RUNTIME_ROOT, SERVICES, SUPERVISOR_CONFIG, type ServiceAction, type ServiceName } from './config.js'
import { run } from './process.js'
import { observeStability, serviceSignals } from './service-metrics.js'

export type ServicePhase = 'READY' | 'STARTING' | 'DEGRADED' | 'STOPPED' | 'FAILED'
export type LogLevel = 'all' | 'info' | 'warn' | 'error'
export type LogSource = 'service' | 'access' | 'error'
export type LogPreset = 'http-errors' | 'manager-requests'

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
    const response = await fetch(url, { signal: AbortSignal.timeout(1_500) })
    return { ok: response.ok, status: response.status, latencyMs: Math.round(performance.now() - started) }
  } catch {
    return { ok: false, latencyMs: Math.round(performance.now() - started) }
  }
}

export async function listServices() {
  const supervisor = await supervisorStatus()
  return Promise.all((Object.entries(SERVICES) as [ServiceName, typeof SERVICES[ServiceName]][]).map(async ([name, config]) => {
    const listening = await portOpen(config.port)
    const processState = config.supervisor ? supervisor.get(name) : undefined
    const appHealth = listening ? await health(config.health) : { ok: false }
    const pid = processState?.pid || (!config.supervisor ? await systemServicePid(name as 'mysql' | 'redis') : undefined)
    const usage = await processUsage(pid)
    const rawState = config.supervisor ? (processState?.state || 'NOT_MANAGED') : (listening ? 'RUNNING' : 'STOPPED')
    const phase: ServicePhase = appHealth.ok && listening
      ? 'READY'
      : rawState === 'STARTING'
        ? 'STARTING'
        : listening
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
      pid,
      ...usage,
      listening,
      healthy: listening && appHealth.ok,
      healthStatus: appHealth.status,
      healthLatencyMs: appHealth.latencyMs,
      stability,
      signals,
      lastError: await lastError(config.log),
    }
  }))
}

export async function actOnService(name: ServiceName, action: ServiceAction) {
  const config = SERVICES[name]
  if (config.supervisor) {
    const state = (await supervisorStatus()).get(name)?.state
    if (action === 'start' && (state === 'RUNNING' || state === 'STARTING')) return { message: `${config.label} 已经在运行` }
    if (action === 'stop' && (!state || ['STOPPED', 'EXITED', 'FATAL', 'BACKOFF'].includes(state))) return { message: `${config.label} 已经停止` }
  } else {
    const listening = await portOpen(config.port)
    if (action === 'start' && listening) return { message: `${config.label} 已经在运行` }
    if (action === 'stop' && !listening) return { message: `${config.label} 已经停止` }
  }
  const result = config.supervisor
    ? await run('/root/miniconda3/bin/supervisorctl', ['-c', SUPERVISOR_CONFIG, action, name], 30_000)
    : await run('/usr/sbin/service', [name === 'redis' ? 'redis-server' : name, action], 30_000)
  if (result.code !== 0) throw new Error((result.stderr || result.stdout || '操作失败').trim())
  return { message: (result.stdout || `${config.label} ${action} 完成`).trim() }
}

function logPath(name: ServiceName, source: LogSource): string {
  if (source === 'access' && (name === 'web-gateway' || name === 'manager-api')) return resolve(RUNTIME_ROOT, 'logs/nginx-access.log')
  if (source === 'error' && name === 'web-gateway') return resolve(RUNTIME_ROOT, 'logs/nginx-error.log')
  return SERVICES[name].log
}

function effectiveSource(name: ServiceName, source?: LogSource): LogSource {
  if (source === 'access' && (name === 'web-gateway' || name === 'manager-api')) return source
  if (source === 'error' && name === 'web-gateway') return source
  if (!source && name === 'web-gateway') return 'access'
  return 'service'
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
    const filtered = filterWithErrorContext(content.split('\n'), level)
      .filter((line) => matchesPreset(line, options.preset) && (!keyword || line.toLocaleLowerCase().includes(keyword)))
    return { path, source, content: filtered.slice(-options.lines).join('\n') }
  } catch (error) {
    return { path, source, content: '', error: error instanceof Error ? error.message : '日志不可读' }
  }
}

async function waitFor(name: ServiceName, running: boolean): Promise<void> {
  const timeout = name === 'index-tts' ? 10 * 60_000 : name === 'manager-api' || name === 'xiaozhi-server' ? 3 * 60_000 : 60_000
  const started = Date.now()
  while (Date.now() - started < timeout) {
    const listening = await portOpen(SERVICES[name].port)
    if (running ? listening : !listening) return
    await new Promise((resolve) => setTimeout(resolve, 1_500))
  }
  throw new Error(`${SERVICES[name].label} 等待${running ? '启动' : '停止'}超时`)
}

export interface BatchStep {
  service: ServiceName
  label: string
  action: 'start' | 'stop'
  state: 'pending' | 'running' | 'done' | 'failed'
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
  try {
    for (const step of operation.steps) {
      step.state = 'running'
      try {
        const result = await actOnService(step.service, step.action)
        await waitFor(step.service, step.action === 'start')
        step.state = 'done'
        step.message = result.message
      } catch (error) {
        step.state = 'failed'
        step.message = error instanceof Error ? error.message : '操作失败'
        failed = true
        // 单项失败不阻断后续服务，避免重启全部时把网关或数据库留在停止状态。
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
  if (currentOperation?.state === 'running') throw new Error('已有批量操作正在执行')
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
