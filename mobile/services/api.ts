import { supabase, autoLogin, isSignedOutByUser } from './supabase';
import { getApiUrl } from '../config/api';
import { getDeviceId } from './deviceId';
import { daysSince } from '../utils/urgencyScore';
import { stripEmpty } from '../utils/fieldValues';
import { SearchResult, IndividualProfile, Interaction, FieldError, LocationData } from '../types';
import type { Category, CreateCategoryPayload } from '../utils/categoryPayload';

// The one error type every backend call throws (C-16). `detail` is the backend's
// `detail` (a FastAPI 422 list is joined as "field: msg; field: msg"), or a generic
// message when there is none.
// Callers show it once (utils/errors.showApiError); the transport never toasts.
export class ApiError extends Error {
  status: number; // HTTP status; 0 = network failure, timeout or no session
  detail: string;
  kind: 'http' | 'network' | 'timeout' | 'auth';

  constructor(status: number, detail: string, kind: ApiError['kind']) {
    super(detail);
    this.name = 'ApiError';
    this.status = status;
    this.detail = detail;
    this.kind = kind;
    Object.setPrototypeOf(this, ApiError.prototype);
  }
}

const DEFAULT_TIMEOUT_MS = 30_000;
const TRANSCRIBE_TIMEOUT_MS = 120_000;
const NETWORK_RETRY_DELAY_MS = 500;
const NOT_SIGNED_IN = 'Not signed in. Check that the demo user exists in Supabase (see README setup).';
const SIGNED_OUT = 'You signed out. Sign in again to continue.';

// Every backend route needs a signed-in session. After the worker's own Sign Out
// there is no automatic sign-in: the request fails (Minor 3).
export const getAuthToken = async (): Promise<string> => {
  let { data: { session } } = await supabase.auth.getSession();
  if (!session) {
    if (isSignedOutByUser()) throw new ApiError(0, SIGNED_OUT, 'auth');
    await autoLogin();
    ({ data: { session } } = await supabase.auth.getSession());
  }
  if (!session) {
    throw new ApiError(0, NOT_SIGNED_IN, 'auth');
  }
  return session.access_token;
};

// After a 401: refresh the session; if that fails (refresh token expired after a long
// idle), sign in again (C-37).
const renewAuthToken = async (): Promise<string> => {
  try {
    const { data, error } = await supabase.auth.refreshSession();
    if (!error && data?.session?.access_token) return data.session.access_token;
  } catch {
    // fall through to a fresh sign-in
  }
  if (isSignedOutByUser()) throw new ApiError(0, SIGNED_OUT, 'auth');
  await autoLogin();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw new ApiError(0, NOT_SIGNED_IN, 'auth');
  return session.access_token;
};

const buildHeaders = (init: RequestInit, token: string, deviceId: string): Record<string, string> => {
  const headers: Record<string, string> = { ...((init.headers as Record<string, string>) || {}) };
  if (typeof init.body === 'string' && !Object.keys(headers).some(h => h.toLowerCase() === 'content-type')) {
    headers['Content-Type'] = 'application/json';
  }
  headers.Authorization = `Bearer ${token}`;
  headers['X-Device-Id'] = deviceId; // tells phones on the shared account apart (H2-6.15)
  return headers;
};

const fetchWithTimeout = async (url: string, init: RequestInit, timeoutMs: number): Promise<Response> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch {
    if (controller.signal.aborted) {
      throw new ApiError(0, 'The server took too long to respond. Please try again.', 'timeout');
    }
    throw new ApiError(0, 'No connection to the server. Check your network and try again.', 'network');
  } finally {
    clearTimeout(timer);
  }
};

// Adds the bearer token and a timeout. On 401 it renews the session and retries once;
// a network failure is retried once for GET only (a POST may already have been applied),
// or for a non-GET that is safe to repeat (`retryNetwork`: a save with an
// Idempotency-Key, H2-2.4). Timeouts and HTTP errors are never retried.
// Returns the Response for any HTTP status; throws ApiError only for network failure,
// timeout or when no session can be obtained.
export const authedFetch = async (
  path: string,
  init: RequestInit = {},
  opts: { timeoutMs?: number; retryNetwork?: boolean } = {}
): Promise<Response> => {
  const url = getApiUrl(path);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const isGet = (init.method || 'GET').toUpperCase() === 'GET';
  const retryNetwork = isGet || !!opts.retryNetwork;
  const deviceId = await getDeviceId();

  const send = async (token: string): Promise<Response> => {
    const request = { ...init, headers: buildHeaders(init, token, deviceId) };
    try {
      return await fetchWithTimeout(url, request, timeoutMs);
    } catch (e) {
      if (retryNetwork && e instanceof ApiError && e.kind === 'network') {
        await new Promise(resolve => setTimeout(resolve, NETWORK_RETRY_DELAY_MS));
        return fetchWithTimeout(url, request, timeoutMs);
      }
      throw e;
    }
  };

  const response = await send(await getAuthToken());
  if (response.status !== 401) return response;
  return send(await renewAuthToken());
};

const genericMessage = (status: number): string => {
  if (status === 401) return 'Your session expired. Please try again.';
  if (status === 403) return "This account isn't allowed to do that.";
  if (status === 404) return 'Not found.';
  if (status === 413) return 'That file is too large.';
  if (status === 429) return 'Too many requests. Try again in a minute.';
  if (status >= 500) return 'Server error. Please try again.';
  return `Request failed (${status}).`;
};

// FastAPI 422 item -> "height: Field required". The field is the last string in `loc`
// (list indexes are skipped; a bare "body" means the whole request, so no prefix).
const format422Item = (d: unknown): string => {
  if (!d || typeof d !== 'object' || typeof (d as any).msg !== 'string') return '';
  const loc = Array.isArray((d as any).loc) ? (d as any).loc : [];
  const field = [...loc].reverse().find((part: unknown) => typeof part === 'string');
  return field && field !== 'body' ? `${field}: ${(d as any).msg}` : (d as any).msg;
};

const parseDetail = (detail: unknown): string => {
  if (typeof detail === 'string') return detail;
  if (Array.isArray(detail)) {
    // FastAPI 422: [{loc, msg, type}, ...]
    return detail.map(format422Item).filter(Boolean).join('; ');
  }
  return '';
};

// Parses the backend's {"detail": ...} and throws one ApiError for a non-2xx response.
export const throwIfNotOk = async (res: Response): Promise<void> => {
  if (res.ok) return;
  let detail = '';
  try {
    detail = parseDetail(JSON.parse(await res.text())?.detail);
  } catch {
    // not JSON (for example a proxy's HTML error page): use the generic message
  }
  throw new ApiError(res.status, detail || genericMessage(res.status), res.status === 401 ? 'auth' : 'http');
};

// authedFetch + throwIfNotOk + JSON. NEVER toasts: callers show the error once.
export const apiRequest = async <T = any>(
  path: string,
  init: RequestInit = {},
  opts: { timeoutMs?: number; retryNetwork?: boolean } = {}
): Promise<T> => {
  const res = await authedFetch(path, init, opts);
  await throwIfNotOk(res);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
};

// One "last seen" everywhere (C-32): the backend's `last_seen` (latest interaction,
// else created_at), counted in whole days.
const toSearchResult = (item: any): SearchResult => ({
  id: item.id,
  name: item.name,
  urgency_score: item.urgency_score,
  urgency_override: item.urgency_override ?? null,
  display_score: item.display_score,
  last_seen: item.last_seen,
  last_seen_days: daysSince(item.last_seen),
  last_interaction_date: item.last_seen, // compat alias
  abbreviated_address: item.last_location?.address ?? item.abbreviated_address ?? undefined,
  ...(item.similarity_score !== undefined && { similarity_score: item.similarity_score }),
  ...(item.search_type !== undefined && { search_type: item.search_type }),
});

export const LIST_PAGE_SIZE = 50;

// One page of the default list
export interface IndividualsPage {
  items: SearchResult[];
  nextCursor: string | null;
  total: number;
}

// One possible duplicate from the backend's check (confidence 0-100; only >= 60 is returned)
export interface DuplicateMatch {
  id: string;
  name: string;
  confidence: number;
}

// Transcription response types
export interface TranscriptionResult {
  transcription: string;
  categorized_data: Record<string, any>;
  missing_required: string[];
  potential_matches: DuplicateMatch[];
  validation_errors: FieldError[];
  // True when the server's duplicate check failed, so an empty potential_matches
  // means "unknown", not "no match": the app re-checks before saving (C-08)
  duplicate_check_failed?: boolean;
}

// What the worker did with the match on the merge screen: a label for the duplicate
// eval (H2-3.6). Sent only with a save made from the merge screen.
export interface DuplicateDecision {
  matched_id: string;
  confidence: number;
  decision: 'merged' | 'saved_new';
}

// POST /api/individuals. `data` is category fields only; the rest travel at the root.
export interface SaveIndividualRequest {
  data: Record<string, any>;
  merge_with_id?: string | null;
  location?: LocationData | null;
  transcription?: string | null;
  // The merge target's version when the review loaded it; a stale one is a 409 (H2-2.3)
  expected_version?: number | null;
  // One per review session, reused on retry: the server replays the first save (H2-2.4)
  idempotency_key?: string;
  duplicate_decision?: DuplicateDecision | null;
}

// Every backend call the app makes. Each throws ApiError; the caller shows it once.
export const api = {
  // Transcribe a recording (Whisper + field extraction + duplicate check)
  transcribe: async (audioUri: string): Promise<TranscriptionResult> => {
    // Read the local recording and send it inline as base64
    const response = await fetch(audioUri);
    const blob = await response.blob();
    const base64Audio = await new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result as string);
      reader.readAsDataURL(blob);
    });

    // Whisper + GPT-4o + the duplicate check run in one request, so allow longer
    return apiRequest<TranscriptionResult>('/api/transcribe', {
      method: 'POST',
      body: JSON.stringify({ audio_data: base64Audio }),
    }, { timeoutMs: TRANSCRIBE_TIMEOUT_MS });
  },

  // Save a new person, or merge into `merge_with_id`. `data` holds category fields
  // only; it is never destructured, so a category called "location" or "id" is just
  // a field. Empty values are stripped so nothing is stored or shown as null (C-09).
  // Throws ApiError (a 400's detail names the field: "weight: ..."); the caller shows it.
  saveIndividual: async (req: SaveIndividualRequest): Promise<{ id: string; individual: any }> => {
    const body: Record<string, any> = { data: stripEmpty(req.data) };
    if (req.merge_with_id) body.merge_with_id = req.merge_with_id;
    if (req.location) body.location = req.location;
    if (req.transcription) body.transcription = req.transcription;
    if (req.merge_with_id && req.expected_version != null) body.expected_version = req.expected_version;
    if (req.duplicate_decision) body.duplicate_decision = req.duplicate_decision;

    // The key travels as a header, and makes one retry after a network failure safe:
    // the server answers a repeated key with the first save's result.
    const response = await apiRequest('/api/individuals', {
      method: 'POST',
      body: JSON.stringify(body),
      ...(req.idempotency_key ? { headers: { 'Idempotency-Key': req.idempotency_key } } : {}),
    }, { retryNetwork: !!req.idempotency_key });
    const id = response?.individual?.id;
    // A 2xx without the saved record is a bad reply from the server (502), not a
    // network failure (status 0)
    if (!id) throw new ApiError(502, 'The server did not confirm the save. Please try again.', 'http');
    return { id, individual: response.individual };
  },

  // Search individuals: GET /api/individuals. An empty query is the default list,
  // most recently seen first. The backend escapes the term (no PostgREST filter
  // built from raw input, C-41). Throws ApiError: an outage must not look like
  // "no one recorded yet" (C-17).
  // The default list, a page at a time (H2-6.10): newest first, the next page by cursor
  listIndividuals: async (cursor: string | null): Promise<IndividualsPage> => {
    const params = new URLSearchParams({ limit: String(LIST_PAGE_SIZE) });
    if (cursor) params.set('cursor', cursor);
    const result = await apiRequest(`/api/individuals?${params.toString()}`);
    return {
      items: (result?.individuals ?? []).map(toSearchResult),
      nextCursor: result?.next_cursor ?? null,
      total: result?.total ?? 0,
    };
  },

  // A text search (with a term; the list without one is listIndividuals)
  searchIndividuals: async (query: string): Promise<SearchResult[]> => {
    const params = new URLSearchParams({ search: query.trim(), limit: '100' });
    const result = await apiRequest(`/api/individuals?${params.toString()}`);
    return (result?.individuals ?? []).map(toSearchResult);
  },

  // Semantic search using embeddings
  // Throws ApiError on failure; the Search screen decides whether to fall back.
  semanticSearchIndividuals: async (query: string): Promise<SearchResult[]> => {
    const result = await apiRequest('/api/embeddings/search', {
      method: 'POST',
      body: JSON.stringify({
        query: query,
        top_k: 20,
        similarity_threshold: 0.15  // Lower threshold for better semantic matching
      }),
    });

    return (result?.results ?? []).map(toSearchResult);
  },

  // Get individual profile
  // Throws ApiError; only status 404 means the person does not exist (C-17).
  getIndividualProfile: async (individualId: string): Promise<IndividualProfile> => {
    const result = await apiRequest(`/api/individuals/${individualId}`);

    // Convert to IndividualProfile format. A failed history load fails the whole
    // profile instead of showing "No interactions recorded".
    const individual = result.individual;
    const interactions = await api.getInteractions(individualId);
    // Same rule as the list's last_seen: the latest interaction, else created_at
    const latest = interactions.reduce<string | null>(
      (max, i) => (!max || new Date(i.created_at) > new Date(max) ? i.created_at : max), null);
    const profile: IndividualProfile = {
      id: individual.id,
      name: individual.name,
      urgency_score: individual.urgency_score,
      urgency_override: individual.urgency_override,
      data: individual.data || {},
      created_at: individual.created_at,
      updated_at: individual.updated_at,
      last_location: individual.last_location || null,
      last_seen: latest ?? individual.created_at,
      version: individual.version ?? 1,
      interactions,
      total_interactions: interactions.length
    };

    return profile;
  },

  // Update urgency override (null clears it). The backend validates 0-100 and
  // invalidates the voice assistant's cache (C-10). Throws ApiError.
  updateUrgencyOverride: async (
    individualId: string,
    overrideValue: number | null
  ): Promise<{ urgency_score: number; urgency_override: number | null; display_score: number }> => {
    return apiRequest(`/api/individuals/${individualId}/urgency-override`, {
      method: 'PUT',
      body: JSON.stringify({ urgency_override: overrideValue }),
    });
  },

  // Delete individual. The backend cascades interactions and embeddings and
  // invalidates the assistant cache. A 404 means it is already gone, so it counts
  // as done. Throws ApiError on any other failure. Screens call this through
  // utils/delayedDelete (undo window), not directly.
  deleteIndividual: async (individualId: string): Promise<void> => {
    const res = await authedFetch(`/api/individuals/${individualId}`, { method: 'DELETE' });
    if (res.status === 404) return;
    await throwIfNotOk(res);
  },

  // Get categories
  // Throws ApiError on failure
  getCategories: async (): Promise<any[]> => {
    const result = await apiRequest('/api/categories');
    return result?.categories ?? [];
  },

  // Export CSV
  exportCSV: async (): Promise<string> => {
    const response = await authedFetch('/api/export');
    await throwIfNotOk(response);
    return response.text();
  },

  // Interaction history for one individual (backend returns `changes`; the app's Interaction type uses `data`)
  // Throws ApiError on failure
  getInteractions: async (individualId: string): Promise<Interaction[]> => {
    const result = await apiRequest(`/api/individuals/${individualId}/interactions`);
    return (result?.interactions ?? []).map((i: any) => ({
      id: i.id,
      individual_id: individualId,
      user_id: '',
      transcription: i.transcription ?? undefined,
      data: i.changes ?? {},
      location: i.location ?? undefined,
      created_at: i.created_at,
      worker_name: i.user_name,
      abbreviated_address: i.location?.address,
    }));
  },

  // Create category (payload from utils/categoryPayload.buildCategoryPayload).
  // Throws ApiError: 409 when the name's key already exists, 422 when invalid.
  createCategory: async (data: CreateCategoryPayload): Promise<Category> => {
    return apiRequest<Category>('/api/categories', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },

  // Check the given fields for possible duplicates (the same LLM check /api/transcribe
  // runs). Throws ApiError when the check fails: a failure must never read as
  // "no match" (C-08). The caller asks before saving as new; nothing toasts here.
  checkDuplicates: async (data: Record<string, any>): Promise<DuplicateMatch[]> => {
    const result = await apiRequest<{ potential_matches?: DuplicateMatch[] }>('/api/individuals/check-duplicates', {
      method: 'POST',
      body: JSON.stringify(data),
    });
    return result?.potential_matches ?? [];
  },
}; 
