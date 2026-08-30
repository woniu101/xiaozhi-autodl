import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { RUNTIME_ROOT } from './config.js'
import { run, type CommandResult } from './process.js'

export type RepositoryKey = 'xiaozhi' | 'index-tts'

export const REPOSITORIES: Record<RepositoryKey, { label: string; path: string; deployBranch: string }> = {
  xiaozhi: { label: 'xiaozhi-esp32-server', path: '/root/xiaozhi-esp32-server', deployBranch: 'mvp' },
  'index-tts': { label: 'index-tts', path: '/root/index-tts', deployBranch: 'main' },
}

const checkRecordPath = resolve(RUNTIME_ROOT, 'run/version-check.json')
const automaticCheckIntervalMs = 30 * 60 * 1000
let automaticTimer: NodeJS.Timeout | undefined
type FetchResult = { key: RepositoryKey; ok: boolean; message: string; checkedAt: string }
const activeChecks = new Map<RepositoryKey, Promise<FetchResult>>()
type CheckProgress = { key: RepositoryKey; stage: 'connecting' | 'retrying' | 'fetching'; attempt: number; totalAttempts: number; startedAt: number }
const activeProgress = new Map<RepositoryKey, CheckProgress>()
let checkRecordQueue: Promise<void> = Promise.resolve()

type CheckRecord = Record<string, { checkedAt: string; ok: boolean; message?: string }>

async function readCheckRecord(): Promise<CheckRecord> {
  try { return JSON.parse(await readFile(checkRecordPath, 'utf8')) as CheckRecord }
  catch { return {} }
}

async function writeCheckRecord(record: CheckRecord) {
  await mkdir(resolve(RUNTIME_ROOT, 'run'), { recursive: true })
  const temporary = `${checkRecordPath}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 })
  await rename(temporary, checkRecordPath)
}

export function isRepositoryKey(value: string): value is RepositoryKey {
  return Object.prototype.hasOwnProperty.call(REPOSITORIES, value)
}

export async function git(path: string, args: string[], timeout = 10_000) {
  return run('/usr/bin/git', ['-C', path, ...args], timeout, { GIT_TERMINAL_PROMPT: '0' })
}

type RemoteResult = CommandResult & { attempts: number; elapsedMs: number }

async function remoteGit(path: string, args: string[], options: {
  timeout?: number
  retryTimeout?: number
  onAttempt?: (attempt: number, totalAttempts: number) => void
} = {}): Promise<RemoteResult> {
  const startedAt = Date.now()
  const timeouts = options.retryTimeout ? [options.timeout || 15_000, options.retryTimeout] : [options.timeout || 15_000]
  let result: CommandResult | undefined
  let attempts = 0
  for (let index = 0; index < timeouts.length; index++) {
    attempts = index + 1
    options.onAttempt?.(index + 1, timeouts.length)
    result = await git(path, ['-c', 'http.version=HTTP/1.1', ...args], timeouts[index])
    if (result.code === 0) break
    if (index + 1 < timeouts.length) await new Promise((resolve) => setTimeout(resolve, 1_000))
  }
  return { ...(result as CommandResult), attempts, elapsedMs: Date.now() - startedAt }
}

export async function fetchDeploymentBranch(key: RepositoryKey, onAttempt?: (attempt: number, totalAttempts: number) => void) {
  const repository = REPOSITORIES[key]
  const branchRefspec = `+refs/heads/${repository.deployBranch}:refs/remotes/origin/${repository.deployBranch}`
  return remoteGit(repository.path, ['fetch', '--prune', 'origin', branchRefspec], { timeout: 60_000, onAttempt })
}

export function affectedComponentsForFiles(key: RepositoryKey, files: string[]): string[] {
  const documentation = /^(?:README(?:\.[^/]*)?|LICENSE(?:\.[^/]*)?|docs\/|\.github\/)/i
  if (key === 'index-tts') return files.some((file) => !documentation.test(file)) ? ['index-tts'] : []
  const selected = new Set<string>()
  for (const file of files) {
    if (file.startsWith('main/manager-web/')) selected.add('manager-web')
    else if (file.startsWith('main/manager-api/')) selected.add('manager-api')
    else if (file.startsWith('main/xiaozhi-server/')) selected.add('xiaozhi-server')
    else if (!documentation.test(file)) {
      selected.add('manager-web')
      selected.add('manager-api')
      selected.add('xiaozhi-server')
    }
  }
  return [...selected]
}

function safeRemote(value: string): string {
  return value.replace(/(https?:\/\/)[^/@\s]+@/i, '$1[credentials]@').trim()
}

export async function repositoryState(key: RepositoryKey) {
  const repository = REPOSITORIES[key]
  const deployRef = `origin/${repository.deployBranch}`
  const [branchResult, commitResult, shortResult, subjectResult, dateResult, statusResult, deployRefResult, remoteResult] = await Promise.all([
    git(repository.path, ['branch', '--show-current']),
    git(repository.path, ['rev-parse', 'HEAD']),
    git(repository.path, ['rev-parse', '--short=10', 'HEAD']),
    git(repository.path, ['log', '-1', '--pretty=%s']),
    git(repository.path, ['log', '-1', '--pretty=%cI']),
    git(repository.path, ['status', '--porcelain=v1', '--untracked-files=normal']),
    git(repository.path, ['rev-parse', '--verify', `refs/remotes/${deployRef}`]),
    git(repository.path, ['remote', 'get-url', 'origin']),
  ])
  if (commitResult.code !== 0) return { key, label: repository.label, path: repository.path, available: false }
  const branch = branchResult.stdout.trim() || '(detached)'
  const upstream = deployRefResult.code === 0 ? deployRef : undefined
  let ahead = 0
  let behind = 0
  let incomingCommits: Array<{ commit: string; subject: string }> = []
  let changedFiles: string[] = []
  let canFastForward = false
  if (upstream) {
    const divergence = await git(repository.path, ['rev-list', '--left-right', '--count', `HEAD...${upstream}`])
    const [left, right] = divergence.stdout.trim().split(/\s+/).map(Number)
    ahead = Number.isFinite(left) ? left : 0
    behind = Number.isFinite(right) ? right : 0
    if (behind > 0) {
      const [logResult, filesResult, ancestorResult] = await Promise.all([
        git(repository.path, ['log', '--format=%h%x09%s', '--max-count=8', `HEAD..${upstream}`]),
        git(repository.path, ['diff', '--name-only', 'HEAD', upstream]),
        git(repository.path, ['merge-base', '--is-ancestor', 'HEAD', upstream]),
      ])
      incomingCommits = logResult.stdout.trim().split('\n').filter(Boolean).map((line) => {
        const [commit, ...subject] = line.split('\t')
        return { commit, subject: subject.join('\t') }
      })
      changedFiles = filesResult.stdout.trim().split('\n').filter(Boolean)
      canFastForward = ancestorResult.code === 0
    }
  }
  const changes = statusResult.stdout.trim().split('\n').filter(Boolean)
  const allowedUntracked = key === 'index-tts' ? [/^\?\? (?:checkpoints|reference|voices|outputs)\//] : []
  const blockingChanges = changes.filter((line) => !allowedUntracked.some((pattern) => pattern.test(line)))
  if (branch !== repository.deployBranch) blockingChanges.unshift(`当前分支为 ${branch}，请先切换到 ${repository.deployBranch}`)
  const dependencyPatterns = key === 'xiaozhi'
    ? [
        /^main\/xiaozhi-server\/(?:requirements.*\.txt|pyproject\.toml|uv\.lock)$/,
        /^main\/manager-web\/(?:package|package-lock)\.json$/,
        /^main\/manager-api\/(?:pom\.xml|\.mvn\/|mvnw)/,
      ]
    : [/^(?:pyproject\.toml|uv\.lock|requirements.*\.txt)$/]
  const dependencyChanges = changedFiles.filter((file) => dependencyPatterns.some((pattern) => pattern.test(file)))
  const affectedComponents = affectedComponentsForFiles(key, changedFiles)
  const refs = [deployRef]
  return {
    key,
    label: repository.label,
    path: repository.path,
    deployBranch: repository.deployBranch,
    available: true,
    branch,
    branchMismatch: branch !== repository.deployBranch,
    commit: commitResult.stdout.trim(),
    shortCommit: shortResult.stdout.trim(),
    subject: subjectResult.stdout.trim(),
    committedAt: dateResult.stdout.trim(),
    dirty: changes.length > 0,
    updateBlocked: blockingChanges.length > 0,
    blockingChanges: blockingChanges.slice(0, 8),
    changedCount: changes.length,
    changes: changes.slice(0, 8),
    upstream,
    ahead,
    behind,
    updateAvailable: behind > 0,
    incomingCommits,
    changedFiles: changedFiles.slice(0, 20),
    canFastForward,
    dependencyChanges,
    dependencyBlocked: dependencyChanges.length > 0,
    affectedComponents,
    remoteUrl: remoteResult.code === 0 ? safeRemote(remoteResult.stdout) : undefined,
    refs,
  }
}

export async function versionState() {
  const checkRecord = await readCheckRecord()
  const repositories = await Promise.all((Object.keys(REPOSITORIES) as RepositoryKey[]).map(repositoryState))
  return {
    inspectedAt: new Date().toISOString(),
    repositories: repositories.map((repository) => {
      const checked = checkRecord[repository.key]
      return {
        ...repository,
        remoteCheckedAt: checked?.checkedAt,
        remoteCheckOk: checked?.ok,
        remoteCheckMessage: checked?.message,
      }
    }),
  }
}

async function recordFetchResult(result: FetchResult) {
  const task = checkRecordQueue.then(async () => {
    const record = await readCheckRecord()
    record[result.key] = { checkedAt: result.checkedAt, ok: result.ok, message: result.message || undefined }
    await writeCheckRecord(record)
  })
  checkRecordQueue = task.catch(() => undefined)
  await task
}

function remoteFailureMessage(result: RemoteResult): string {
  const raw = (result.stderr || result.errorMessage || result.stdout || '').trim().replace(/(https?:\/\/)[^/@\s]+@/gi, '$1[credentials]@')
  const suffix = `（尝试 ${result.attempts} 次，耗时 ${(result.elapsedMs / 1000).toFixed(1)} 秒）`
  if (result.timedOut) return `连接 GitHub 超时${suffix}`
  if (/could not resolve host|name or service not known|temporary failure in name resolution/i.test(raw)) return `GitHub 域名解析失败${suffix}`
  if (/ssl|tls|certificate|gnutls/i.test(raw)) return `GitHub TLS 连接失败：${raw.slice(0, 160)} ${suffix}`
  if (/failed to connect|connection (?:reset|refused|timed out)|network is unreachable/i.test(raw)) return `无法连接 GitHub：${raw.slice(0, 160)} ${suffix}`
  if (/http.*(?:429|5\d\d)|the requested url returned error/i.test(raw)) return `GitHub HTTP 请求失败：${raw.slice(0, 160)} ${suffix}`
  return `${raw || 'GitHub 远端检查失败'} ${suffix}`.trim()
}

export function repositoryCheckProgress() {
  return {
    repositories: [...activeProgress.values()].map((progress) => ({
      ...progress,
      elapsedSeconds: Math.max(0, Math.floor((Date.now() - progress.startedAt) / 1000)),
    })),
  }
}

async function checkRepositoryOnce(key: RepositoryKey): Promise<FetchResult> {
  const existing = activeChecks.get(key)
  if (existing) return existing
  const check = (async () => {
    const repository = REPOSITORIES[key]
    const remoteRef = `refs/heads/${repository.deployBranch}`
    const startedAt = Date.now()
    const remote = await remoteGit(repository.path, ['ls-remote', '--heads', 'origin', remoteRef], {
      timeout: 15_000,
      retryTimeout: 20_000,
      onAttempt: (attempt, totalAttempts) => activeProgress.set(key, { key, stage: attempt > 1 ? 'retrying' : 'connecting', attempt, totalAttempts, startedAt }),
    })
    let result = remote
    if (remote.code === 0) {
      const remoteCommit = remote.stdout.trim().split(/\s+/)[0]
      const local = await git(repository.path, ['rev-parse', `refs/remotes/origin/${repository.deployBranch}`])
      if (!remoteCommit || local.code !== 0 || local.stdout.trim() !== remoteCommit) {
        result = await fetchDeploymentBranch(key, (attempt, totalAttempts) => activeProgress.set(key, { key, stage: 'fetching', attempt, totalAttempts, startedAt }))
      }
    }
    const checkedAt = new Date().toISOString()
    const message = result.code === 0 ? '' : remoteFailureMessage(result).slice(0, 300)
    const fetchResult = { key, ok: result.code === 0, message, checkedAt }
    await recordFetchResult(fetchResult)
    return fetchResult
  })()
  activeChecks.set(key, check)
  try { return await check }
  finally {
    if (activeChecks.get(key) === check) activeChecks.delete(key)
    activeProgress.delete(key)
  }
}

export async function checkRepositoryUpdates(key?: string) {
  if (key && !isRepositoryKey(key)) throw new Error('不支持的代码仓库')
  const keys: RepositoryKey[] = key ? [key as RepositoryKey] : Object.keys(REPOSITORIES) as RepositoryKey[]
  const fetches = await Promise.all(keys.map(checkRepositoryOnce))
  return { ...(await versionState()), fetches }
}

export function startAutomaticVersionChecks(log: (message: string) => void, warn: (message: string) => void) {
  if (automaticTimer) clearInterval(automaticTimer)
  const check = () => {
    void checkRepositoryUpdates()
      .then((state) => state.fetches.every((item) => item.ok)
        ? log('Deployment branches checked for updates')
        : warn(`Deployment branch check failed: ${state.fetches.filter((item) => !item.ok).map((item) => item.key).join(', ')}`))
      .catch((error) => warn(`Automatic version check failed: ${error instanceof Error ? error.message : error}`))
  }
  setTimeout(check, 8_000)
  automaticTimer = setInterval(check, automaticCheckIntervalMs)
  automaticTimer.unref()
}
