import type { Command, Json } from '../../../protocol/src/index.ts'

export interface SessionAdapter {
  /** Immutable per-dispatch authority; an unbound adapter must refuse mutations. */
  withAdmission(check: () => void): SessionAdapter
  assertSession(sessionId: string): Promise<void>
  list(workspaceId: string, cursor?: string): Promise<Json>
  create(workspaceId: string, sessionId: string): Promise<Json>
  prompt(command: Extract<Command, { op: 'session.prompt' }>, signal: AbortSignal): Promise<Json>
  page(command: Extract<Command, { op: 'session.page' }>, signal: AbortSignal, jsonBytes?: number): Promise<Json>
  currentStopToken(sessionId: string): string | null
  stop(sessionId: string, token: string): Json
}
export type AdditionalHandlers = Partial<{
  [K in 'ui.manage' | 'ui.catalog' | 'ui.search' | 'ui.read' | 'session.queue' | 'interaction.delegate' | 'interaction.answer' | 'file.stat' | 'file.text' | 'file.read' | 'file.changes' | 'file.diff']:
    (command: Extract<Command, { op: K }>, signal: AbortSignal, admission: () => void) => Promise<Json>
}>
