// Window creation order is not load order: the hidden avatar can become the
// first Playwright page after a restart. Select the actual panel by its URL.
export async function panelWindow(application, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const page = application.windows().find((window) => window.url().endsWith('/index.html'));
    if (page) return page;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('The companion panel did not load before the test deadline');
}
