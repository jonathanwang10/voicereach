// Optional Sentry error reports (H2-8.2): only with EXPO_PUBLIC_SENTRY_DSN, JS errors
// only (no native layer, whose crash reports and network breadcrumbs skip beforeSend).
// An event keeps the error's type and stack and the screen names it passed through;
// never a message, request data, user, screenshots or the view hierarchy.
import React from 'react';
import * as Sentry from '@sentry/react-native';
import type { Breadcrumb, Event } from '@sentry/react-native';
import { API_CONFIG } from '../config/api';

let enabled = false;

const withoutQuery = (url: string) => url.split('?')[0];

export function scrubBreadcrumb(crumb: Breadcrumb): Breadcrumb | null {
  // Screen names only: fetch/xhr carry URLs with ?search=, console and touch carry text
  if (crumb.category !== 'navigation') return null;
  const { data: _data, ...rest } = crumb;
  return rest;
}

export function scrubEvent<T extends Event>(event: T): T {
  if (event.request) {
    event.request = event.request.url ? { url: withoutQuery(event.request.url) } : {};
  }
  event.exception?.values?.forEach(value => { value.value = ''; });
  delete event.user;
  delete event.extra;
  if (Array.isArray(event.breadcrumbs)) {
    event.breadcrumbs = event.breadcrumbs.map(scrubBreadcrumb).filter((c): c is Breadcrumb => c !== null);
  }
  return event;
}

export function initSentry(dsn: string = API_CONFIG.SENTRY_DSN): boolean {
  if (!dsn) return false;
  Sentry.init({
    dsn,
    sendDefaultPii: false,
    enableNative: false,
    attachScreenshot: false,
    attachViewHierarchy: false,
    environment: __DEV__ ? 'development' : 'production',
    beforeSend: scrubEvent,
    beforeBreadcrumb: scrubBreadcrumb,
  });
  enabled = true;
  return true;
}

export function wrapRoot<P extends object>(Root: React.ComponentType<P>): React.ComponentType<P> {
  // Sentry.wrap is typed for Record<string, unknown> props; the wrapped root keeps P
  return enabled ? (Sentry.wrap(Root as React.ComponentType<any>) as React.ComponentType<P>) : Root;
}

export function reportError(error: unknown): void {
  if (enabled) Sentry.captureException(error);
}
