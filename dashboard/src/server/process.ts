import { execFile } from 'node:child_process'

export interface CommandResult {
  stdout: string
  stderr: string
  code: number
  timedOut: boolean
  errorCode?: string
  errorMessage?: string
  signal?: string
}

export function run(file: string, args: string[], timeout = 10_000, environment?: NodeJS.ProcessEnv): Promise<CommandResult> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8', env: { ...process.env, ...environment } }, (error, stdout, stderr) => {
      const failure = error as (NodeJS.ErrnoException & { killed?: boolean; signal?: string }) | null
      const timedOut = Boolean(failure?.killed && failure.signal === 'SIGTERM')
      const code = typeof failure?.code === 'number' ? failure.code : timedOut ? 124 : error ? 1 : 0
      resolve({
        stdout: stdout || '',
        stderr: stderr || '',
        code,
        timedOut,
        errorCode: typeof failure?.code === 'string' ? failure.code : undefined,
        errorMessage: failure?.message,
        signal: failure?.signal,
      })
    })
  })
}
