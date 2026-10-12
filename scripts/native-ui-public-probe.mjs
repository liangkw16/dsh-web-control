/** Test-only plugin composed through the public boot graph, registration facade and service interfaces. */
export function registerPublicProbe(composed = false, ownRenderer = false) {
  globalThis.__ModuleLoader__.load({ id: 'native-ui-public-probe', factory: require => ({
    inject: ['configForms', 'connection', 'modules', 'loader'],
    async apply(ctx) {
      const stockForms = ctx.configForms;
      const form = stockForms.get('ui-conversation');
      const snapshot = () => {
        const value = form.getSnapshot();
        return { isLoopback: ctx.connection.isLoopback, status: value.status, mode: value.mode, writable: value.writable, busyEnter: value.value?.busyEnter ?? null, mirrorStatus: ctx.configForms.describe().getSnapshot().status };
      };
      let value = Object.freeze({ status: 'loading', value: undefined, base: undefined, user: undefined, revision: undefined, writable: false, mode: 'host' });
      const listeners = new Set();
      let fiber, disposeQueueShadow;
      let disposeMount, mounts = 0, unmounts = 0;
      if (ownRenderer) {
        const rendererScope = ctx.isolate('uiRenderer');
        const rendererFiber = rendererScope.plugin(ctx.loader.unwrapExports(require('@deepseek-ai/dsh-client-ui-renderer/client')));
        await rendererFiber.await();
        const renderer = rendererScope.get('uiRenderer');
        if (!renderer) throw new Error('Original renderer did not activate');
        ctx.provide('uiRenderer', { mount(container) {
          if (mounts !== 0) throw new Error('Unexpected duplicate native root');
          const dispose = renderer.mount(container);
          mounts++;
          disposeMount = () => { if (unmounts === 0) { dispose(); unmounts++; } };
          return disposeMount;
        } });
      }
      if (composed) {
        const readonlyForm = {
          getSnapshot: () => value,
          subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
          async set() { return false; }, async unset() { return false; }, async mutate() { return false; },
        };
        const scoped = ctx.isolate('configForms');
        const forms = {
          get: ns => ns === 'ui-conversation' ? readonlyForm : stockForms.get(ns),
          describe: () => stockForms.describe(),
          whileServed: (ns, register) => stockForms.whileServed(ns, register),
          developerTools: stockForms.developerTools,
        };
        const provider = scoped.plugin({ name: 'native-ui-readonly-preference', apply(owner) { owner.provide('configForms', forms); } });
        await provider.await();
        fiber = scoped.plugin(ctx.loader.unwrapExports(require('@deepseek-ai/dsh-client-ui-conversation/client')));
      }
      globalThis.__nativeUiPublicProbe = {
        snapshot,
        unmount() {
          if (!disposeMount) throw new Error('Native root was not owned');
          disposeMount();
          return { mounts, unmounts };
        },
        setComposerBlock(sessionId, blocked) {
          ctx.get('conversation').blocks.set(sessionId, blocked ? { reason: 'Queue editing unavailable' } : undefined);
        },
        hideQueueDock() {
          disposeQueueShadow ??= ctx.get('slots').register({ name: 'conversation.input.dock', id: 'queue', priority: -100 }, () => null);
        },
        diagnostics: () => ({
          childState: fiber?.state,
          childServices: fiber ? Object.fromEntries(['uiConversation', 'conversation', 'slots', 'sessions', 'fileUpload', 'uiSession', 'uiWorkspace', 'locale', 'configForms'].map(name => [name, fiber.ctx.get(name) !== undefined])) : null,
          rootUiConversation: ctx.root.get('uiConversation') !== undefined,
          entries: [...ctx.loader.entries()].map(entry => ({ name: entry.options.name, state: entry.fiber?.state })),
        }),
        async tryPublicSeed(view) {
          const before = snapshot();
          await ctx.configForms.describe().ensure();
          ctx.configForms.describe().acceptView(view);
          const afterAccept = snapshot();
          const accepted = await form.set('busyEnter', view.value.busyEnter);
          return { before, afterAccept, setReturned: accepted, afterSet: snapshot() };
        },
        async composeReadOnlyPreference(view) {
          if (!['steer', 'queue'].includes(view.value?.busyEnter) || !Number.isInteger(view.revision)) throw new Error('Invalid actual Host preference');
          if (!fiber) throw new Error('Composition was not installed before boot');
          await fiber.await();
          if (fiber.state !== 2) throw new Error('Original conversation did not activate');
          value = Object.freeze({ status: 'ready', value: view.value, base: view.base, user: view.user, revision: view.revision, writable: false, mode: 'host' });
          for (const listener of listeners) listener();
          return { busyEnter: value.value.busyEnter, writable: value.writable, isLoopback: ctx.connection.isLoopback, originalFiberState: fiber.state };
        },
      };
      ctx.effect(() => () => { disposeMount?.(); disposeQueueShadow?.(); delete globalThis.__nativeUiPublicProbe; });
      if (fiber) return fiber.await().then(() => () => fiber.dispose());
      return () => {};
    },
  }) });
}
export const publicProbeGraph = `
const graph = globalThis.__DSH_BOOT__;
graph.entries.push({ id: 'native-ui-public-probe', url: 'native-ui-public-probe.js', rev: 'fixture-1', inject: ['@deepseek-ai/dsh-client-ui-settings', '@deepseek-ai/dsh-client-connection', '@deepseek-ai/dsh-client-ui-conversation', '@deepseek-ai/dsh-client-ui-renderer'] });
graph.batches.push({ phase: 'application', url: 'native-ui-public-probe.js', rev: 'fixture-1', entries: ['native-ui-public-probe'] });
`;

/** Own the documented HTML facade composition; upstream module/shell bytes are unchanged. */
export const publicCompositionBoot = `
const facade = globalThis.__ModuleLoader__;
const create = facade.create.bind(facade);
facade.create = options => {
  const modules = create(options);
  modules.manifest = { ...modules.manifest, plugins: modules.manifest.plugins.filter(row => row.id !== '@deepseek-ai/dsh-client-ui-conversation' && (!globalThis.__nativeUiOwnRenderer || row.id !== '@deepseek-ai/dsh-client-ui-renderer')) };
  return modules;
};
`;
