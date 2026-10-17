import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parse } from 'yaml'

/** Credential store location shared by every DSH installation. */
function credentialsPath(): string {
  return join(homedir(), '.dsh', '.credentials.yaml')
}

/**
 * Check whether a credential is available without exposing its value: the
 * process environment first, then the user's DSH credential store.
 * @param envName - environment variable / credential reference name.
 * @returns true when a non-empty credential is resolvable.
 */
export function credentialPresent(envName: string): boolean {
  const fromEnv = process.env[envName]
  if (typeof fromEnv === 'string' && fromEnv !== '') return true
  const path = credentialsPath()
  if (!existsSync(path)) return false
  try {
    const parsed = parse(readFileSync(path, 'utf8')) as { refs?: Record<string, unknown> } | null
    const value = parsed?.refs?.[envName]
    return typeof value === 'string' && value !== ''
  } catch {
    return false
  }
}

/**
 * Resolve a credential value for the child environment: process environment
 * first, then the user's DSH credential store. The value must never be written
 * to run artifacts.
 * @param envName - environment variable / credential reference name.
 * @returns the credential, or null when unavailable.
 */
export function resolveCredential(envName: string): string | null {
  const fromEnv = process.env[envName]
  if (typeof fromEnv === 'string' && fromEnv !== '') return fromEnv
  const path = credentialsPath()
  if (!existsSync(path)) return null
  try {
    const parsed = parse(readFileSync(path, 'utf8')) as { refs?: Record<string, unknown> } | null
    const value = parsed?.refs?.[envName]
    return typeof value === 'string' && value !== '' ? value : null
  } catch {
    return null
  }
}
