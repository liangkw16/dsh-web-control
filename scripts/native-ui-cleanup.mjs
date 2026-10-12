/** Always attempt every owned cleanup, preserving failure facts for the final receipt. */
export async function cleanupNativeFixture(actions) {
  const result = { browserClosed: false, hostExited: false, errors: [] };
  for (const operation of ['browser', 'proxy', 'host', 'key']) {
    try {
      const value = await actions[operation]();
      if (operation === 'browser') result.browserClosed = true;
      if (operation === 'host') result.hostExited = true;
      if (operation === 'proxy' && value !== undefined) result.proxyCleanup = value;
    } catch (error) { result.errors.push({ operation, name: error instanceof Error ? error.name : 'Error' }); }
  }
  return result;
}
