import { ProtocolError, type Json } from './types.js'
import { validateJson } from './schema.js'
export const CURRENT_FILES_CAPABILITY = 'current-files-v1'
export const CURRENT_FILE_TEXT_BYTES = 256 * 1024
export const CURRENT_FILE_TEXT_LINES = 5000
export const CURRENT_FILE_FAILURES = ['missing', 'outside', 'not-regular', 'too-large', 'not-text', 'changed', 'unsupported'] as const
export type CurrentFileFailureCode = typeof CURRENT_FILE_FAILURES[number]
export interface CurrentFileStat { absolutePath: string; relativePath: string; version: string; bytes: number }
export interface CurrentFileText { absolutePath: string; version: string; bytes: number; offset: number; text: string; lines: number; eof: boolean }
export type CurrentFileResult<T> = { ok: true; value: T } | { ok: false; code: CurrentFileFailureCode }
function invalid(): never { throw new ProtocolError('INVALID_MESSAGE') }
function object(value: Json, keys: string[]): Record<string, Json> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) invalid()
  return value
}
function text(value: Json): value is string { return typeof value === 'string' && value.length > 0 && value.length <= 4096 }
function uint(value: Json, max = Number.MAX_SAFE_INTEGER): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= max }
function result<T>(input: unknown, check: (value: Json) => void): CurrentFileResult<T> {
  const raw = validateJson(input)
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) invalid()
  if (raw.ok === false) {
    const value = object(raw, ['ok', 'code'])
    if (!CURRENT_FILE_FAILURES.includes(value.code as CurrentFileFailureCode)) invalid()
  } else {
    const value = object(raw, ['ok', 'value'])
    if (value.ok !== true) invalid()
    check(value.value)
  }
  return raw as unknown as CurrentFileResult<T>
}
export function parseCurrentFileStat(input: unknown): CurrentFileResult<CurrentFileStat> {
  return result(input, raw => {
    const value = object(raw, ['absolutePath', 'relativePath', 'version', 'bytes'])
    if (!text(value.absolutePath) || !value.absolutePath.startsWith('/') || !text(value.relativePath) || value.relativePath.startsWith('/') || value.relativePath.split('/').some(p => !p || p === '.' || p === '..') || !text(value.version) || !uint(value.bytes, 32 * 1024 * 1024)) invalid()
  })
}
export function parseCurrentFileText(input: unknown): CurrentFileResult<CurrentFileText> {
  return result(input, raw => {
    const value = object(raw, ['absolutePath', 'version', 'bytes', 'offset', 'text', 'lines', 'eof'])
    if (!text(value.absolutePath) || !value.absolutePath.startsWith('/') || !text(value.version) || !uint(value.bytes, 32 * 1024 * 1024) || !uint(value.offset) || value.offset < 1 || typeof value.text !== 'string' || new TextEncoder().encode(value.text).length > CURRENT_FILE_TEXT_BYTES || value.text.includes('\0') || !uint(value.lines, CURRENT_FILE_TEXT_LINES) || typeof value.eof !== 'boolean') invalid()
    if (value.lines === 0 ? value.text !== '' : value.text.split('\n').length !== value.lines) invalid()
  })
}
