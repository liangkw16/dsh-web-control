/** rc.2 workspace composition: preserve its original navigation and components,
 * but omit unsupported session actions at their public contribution boundaries.
 * The Host's finite RPC allowlist remains the authority check.
 */
const actionSeats = new Set(['sidebar.workspaces.session.menu.item', 'sidebar.workspaces.session.row.action'])
const actionOverlays = new Set(['workspace.session-rename', 'workspace.session-archive'])
const blockedCommands = new Set(['session.rename', 'session.fork', 'session.archive'])

export async function registerNativeWorkspace(ctx: any, require: (id: string) => any, canManage = false): Promise<void> {
  if (canManage) {
    const plugin = ctx.plugin(ctx.loader.unwrapExports(require('@deepseek-ai/dsh-client-ui-workspace/client')))
    await plugin.await()
    if (plugin.state !== 2) throw new Error('Native workspace unavailable')
    ctx.effect(() => () => plugin.dispose())
    return
  }
  const slots = ctx.slots, shortcuts = ctx.shortcuts, t = ctx.locale.bind('webControl')
  const React = require('react'), { MenuItemButton, Toast } = require('@deepseek-ai/dsh-client-ui-primitives')
  let notice = 0, sequence = 0
  const listeners = new Set<() => void>()
  const publish = (next: number) => { notice = next; for (const listener of listeners) listener() }
  const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
  const unarchiveUnavailable = async () => {
    publish(++sequence)
    // rc.2 hard-codes search-result restore without a disabled capability. Refuse
    // at its declared action injection; never issue RPC or report durable success.
    throw new Error(t('unarchiveUnavailable'))
  }
  slots.inject('shell.overlay', () => slots.register({ name: 'shell.overlay', id: 'remote-workspace-unavailable', locale: 'webControl' }, ({ t }: any) => {
    const current = React.useSyncExternalStore(subscribe, () => notice)
    return current ? React.createElement(Toast, { key: current, text: t('unarchiveUnavailable'), onDone: () => publish(0) }) : null
  }))
  const scope = ctx.isolate('slots').isolate('shortcuts')
  const provider = scope.plugin({ name: 'remote-workspace-capabilities', apply(owner: any) {
    owner.provide('slots', {
      provideRoot: (...args: any[]) => slots.provideRoot(...args),
      entries: (key: string) => slots.entries(key),
      subscribe: (key: string, listener: () => void) => slots.subscribe(key, listener),
      inject: (key: string, callback: () => unknown) => actionSeats.has(key) ? () => {} : slots.inject(key, callback),
      register: (options: any, component: any) => {
        if (actionSeats.has(options.name) || (options.name === 'shell.overlay' && actionOverlays.has(options.id))) return () => {}
        if (options.name !== 'sidebar.workspaces') return slots.register(options, component)
        return slots.register({ ...options, inject: (...args: any[]) => ({ ...options.inject(...args), requestSessionRename: () => {}, unarchiveSession: unarchiveUnavailable }) }, component)
      },
    })
    // Workspace uses only the declared register and catalog faces of Shortcuts.
    owner.provide('shortcuts', {
      catalog: shortcuts.catalog,
      register: (command: any) => shortcuts.register(blockedCommands.has(command.id)
        ? { ...command, resolve: () => ({ status: 'blocked', reason: t('desktopAction') }) }
        : command),
    })
  } })
  await provider.await()
  const plugin = scope.plugin(ctx.loader.unwrapExports(require('@deepseek-ai/dsh-client-ui-workspace/client')))
  await plugin.await()
  if (plugin.state !== 2) throw new Error('Native workspace unavailable')
  ctx.effect(() => () => plugin.dispose())
  // rc.2 owns the ellipsis button itself. Keep its menu informative without
  // copying action components or touching the stock DOM to hide the anchor.
  slots.inject('sidebar.workspaces.session.menu.item', () => slots.register({
    name: 'sidebar.workspaces.session.menu.item', id: 'remote-session-readonly', locale: 'webControl',
  }, ({ t }: any) => React.createElement(MenuItemButton, { disabled: true }, t('desktopAction'))))
}
