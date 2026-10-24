/**
 * Pure helpers for the voice assistant screen (ModernVoiceAssistantScreen).
 *
 * Every message update is keyed by id and returns a new array (C-25, C-59), so a
 * follow-up question can't steal or lose an earlier answer's text. Nothing here
 * touches React Native, so it is unit-tested directly.
 */

export interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
}

export const SPEAKING_PLACEHOLDER = '[Speaking...]';
export const PROCESSING_PLACEHOLDER = '[Processing your speech...]';
export const SPEECH_DELIVERED = '[Speech response delivered]';
export const RESPONSE_INTERRUPTED = '[Response interrupted]';
export const LISTENING_PLACEHOLDER = '[Listening...]';
export const TRANSCRIPT_UNAVAILABLE = "[Couldn't transcribe]";

const isPlaceholder = (content: string) => !content || content === SPEAKING_PLACEHOLDER;

// Append an assistant bubble showing the speaking placeholder. A known id is a no-op.
export function addAssistantMessage(messages: Message[], id: string, now: Date = new Date()): Message[] {
  if (messages.some(m => m.id === id)) return messages;
  return [...messages, { id, role: 'assistant', content: SPEAKING_PLACEHOLDER, timestamp: now }];
}

export function setMessageContent(messages: Message[], id: string, content: string): Message[] {
  return messages.map(m => (m.id === id ? { ...m, content } : m));
}

export function removeMessage(messages: Message[], id: string): Message[] {
  return messages.filter(m => m.id !== id);
}

// Stream text straight into a bubble. Creates the bubble if it isn't there yet.
export function appendAssistantText(messages: Message[], id: string, delta: string): Message[] {
  const withBubble = addAssistantMessage(messages, id);
  return withBubble.map(m =>
    m.id === id ? { ...m, content: `${isPlaceholder(m.content) ? '' : m.content}${delta}` } : m
  );
}

// Add text to an item's own bubble, after any text already shown. With no text, a
// placeholder becomes `fallback`.
export function finalizeAssistantText(
  messages: Message[],
  id: string,
  text: string,
  fallback: string = SPEECH_DELIVERED
): Message[] {
  return messages.map(m => {
    if (m.id !== id) return m;
    const shown = isPlaceholder(m.content) ? '' : m.content;
    if (text && text.trim()) return { ...m, content: shown + text };
    return shown ? m : { ...m, content: fallback };
  });
}

// The worker's spoken question (H2-5.6): a bubble per input item, filled by the server's
// input transcription. A known id is a no-op.
export function addUserSpeechMessage(messages: Message[], id: string, now: Date = new Date()): Message[] {
  if (messages.some(m => m.id === id)) return messages;
  return [...messages, { id, role: 'user', content: LISTENING_PLACEHOLDER, timestamp: now }];
}

export function setUserTranscript(messages: Message[], id: string, transcript: unknown): Message[] {
  const text = typeof transcript === 'string' ? transcript.trim() : '';
  return setMessageContent(messages, id, text || TRANSCRIPT_UNAVAILABLE);
}

// Full duplex: the mic keeps streaming while a reply plays, so the worker can talk over
// it. Set false if the reply's echo cuts itself off on the device (D5.7).
export const FULL_DUPLEX_MIC = true;

export function shouldSendMicFrame(s: {
  listening: boolean; socketOpen: boolean; replyPlaying: boolean; fullDuplex: boolean;
}): boolean {
  return s.listening && s.socketOpen && (s.fullDuplex || !s.replyPlaying);
}

export function audioAppendEvent(base64: string): object {
  return { type: 'input_audio_buffer.append', audio: base64 };
}

// Stopping mid-speech sends what was said; otherwise the buffer is dropped.
export function stopListeningEvents(speechInProgress: boolean): object[] {
  return speechInProgress
    ? [{ type: 'input_audio_buffer.commit' }, { type: 'response.create' }]
    : [{ type: 'input_audio_buffer.clear' }];
}

// Barge-in (H2-5.7): cancel the reply, then cut the assistant item at what the worker
// actually heard, so the model forgets the rest.
export function bargeInEvents(itemId: string, playedMs: number): object[] {
  return [
    { type: 'response.cancel' },
    { type: 'conversation.item.truncate', item_id: itemId, content_index: 0, audio_end_ms: Math.max(0, Math.floor(playedMs)) },
  ];
}

// The server may have cancelled the reply first (interrupt_response): not worth a toast
export function isIgnorableServerError(event: any): boolean {
  return event?.error?.code === 'response_cancel_not_active';
}

const WS_OPEN = 1; // WebSocket.OPEN

export function isSocketOpen(ws: { readyState: number } | null | undefined): boolean {
  return ws?.readyState === WS_OPEN;
}

// The frames for one question. Both are on the backend allowlist; the app never sends
// session.update (the server sets the session itself).
export function userTextEvents(text: string): object[] {
  return [
    {
      type: 'conversation.item.create',
      item: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
    },
    { type: 'response.create' },
  ];
}

const AUTH_REFUSED = 'Not signed in or not allowed to use the voice assistant. Sign in again, then tap Retry.';
const mentions403 = (text: unknown) => typeof text === 'string' && /\b403\b/.test(text);

// The error to show when the socket closes unexpectedly. No auto-reconnect: the worker taps Retry.
export function closeMessage(code: number | undefined, reason: string | undefined): string {
  if (mentions403(reason)) return AUTH_REFUSED;
  switch (code) {
    case 1008:
      return reason || 'Too many connections or session time limit reached. Try again in a minute.';
    case 1011:
      return reason ? `${reason}. Try again later.` : 'Voice assistant is unavailable right now. Try again later.';
    case 1000:
      return 'Voice assistant disconnected. Tap Retry to reconnect.';
    default:
      return 'Connection lost. Tap Retry to reconnect.';
  }
}

// The error to show when the socket fails to open (an auth failure is refused as HTTP 403).
export function connectErrorMessage(err: any): string {
  if (mentions403(err?.message)) return AUTH_REFUSED;
  return "Couldn't connect to the voice assistant. Tap Retry.";
}
