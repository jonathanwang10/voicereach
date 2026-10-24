// H2-8.2: optional Sentry in the app. Off without a DSN; with one, JS errors only, and
// nothing a request or a person's record carried leaves the phone.
const SENTINEL = 'Zebulon Quixley';

let Sentry: any;
let mod: typeof import('../sentry');

beforeEach(() => {
  // A fresh module per test, so the "enabled" flag never leaks between tests
  jest.isolateModules(() => {
    Sentry = require('@sentry/react-native');
    mod = require('../sentry');
  });
});

it('does nothing without a DSN', () => {
  expect(mod.initSentry('')).toBe(false);
  expect(Sentry.init).not.toHaveBeenCalled();
  const Root = () => null;
  expect(mod.wrapRoot(Root)).toBe(Root);
  mod.reportError(new Error('x'));
  expect(Sentry.captureException).not.toHaveBeenCalled();
});

it('initialises with privacy options when a DSN is set', () => {
  expect(mod.initSentry('https://pub@example.invalid/1')).toBe(true);
  expect(Sentry.init).toHaveBeenCalledWith(expect.objectContaining({
    dsn: 'https://pub@example.invalid/1', sendDefaultPii: false, enableNative: false,
    attachScreenshot: false, attachViewHierarchy: false,
    beforeSend: mod.scrubEvent, beforeBreadcrumb: mod.scrubBreadcrumb,
  }));
});

it('wraps the root and reports errors once it is on', () => {
  mod.initSentry('https://pub@example.invalid/1');
  const Root = () => null;
  mod.wrapRoot(Root);
  expect(Sentry.wrap).toHaveBeenCalledWith(Root);
  const error = new Error('x');
  mod.reportError(error);
  expect(Sentry.captureException).toHaveBeenCalledWith(error);
});

it('scrubEvent removes request data, query strings, user, extra, exception text and data breadcrumbs', () => {
  const out = mod.scrubEvent({
    request: { url: `https://api/x?search=${SENTINEL}`, data: { name: SENTINEL }, query_string: `search=${SENTINEL}`,
               headers: { Authorization: 'Bearer t' }, cookies: {} },
    exception: { values: [{ type: 'Error', value: `failed for ${SENTINEL}` }] },
    user: { email: 'a@b' }, extra: { n: SENTINEL },
    breadcrumbs: [{ category: 'fetch', data: { url: `/api/individuals?search=${SENTINEL}` } },
                  { category: 'navigation', message: 'Search', data: { params: SENTINEL } }],
  } as any);
  expect(JSON.stringify(out)).not.toContain('Quixley');
  expect(out.request).toEqual({ url: 'https://api/x' });
  expect(out.exception!.values![0]).toEqual({ type: 'Error', value: '' });
  expect(out.breadcrumbs).toEqual([{ category: 'navigation', message: 'Search' }]);
});

it('scrubEvent keeps a bare event as it is', () => {
  expect(mod.scrubEvent({ message: 'x' } as any)).toEqual({ message: 'x' });
});

it.each(['fetch', 'xhr', 'console', 'touch', 'ui.click', 'sentry.event'])('drops %s breadcrumbs', category => {
  expect(mod.scrubBreadcrumb({ category } as any)).toBeNull();
});
