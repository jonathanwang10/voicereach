// T11: pure helpers behind the voice assistant screen.
// C-25: answer text is keyed by item id, so follow-ups can't steal or lose it.
// H2-5.6: mic frames, stopping a turn, and the worker's input-transcription bubble.
// C-59: updates are immutable; sends need an OPEN socket.
// T10 contract: only allowlisted client events, close-code messages.
import {
  Message,
  SPEAKING_PLACEHOLDER,
  SPEECH_DELIVERED,
  addAssistantMessage,
  appendAssistantText,
  finalizeAssistantText,
  setMessageContent,
  removeMessage,
  LISTENING_PLACEHOLDER,
  TRANSCRIPT_UNAVAILABLE,
  addUserSpeechMessage,
  setUserTranscript,
  shouldSendMicFrame,
  audioAppendEvent,
  stopListeningEvents,
  bargeInEvents,
  isIgnorableServerError,
  isSocketOpen,
  userTextEvents,
  closeMessage,
  connectErrorMessage,
} from '../assistantMessages';

const T = new Date('2026-01-01T00:00:00Z');
const user = (id: string, content: string): Message => ({ id, role: 'user', content, timestamp: T });

describe('C-25 keyed assistant text', () => {
  it('flushes answer 1 into its own bubble even when a follow-up question is last', () => {
    let msgs: Message[] = [user('u1', 'Q1')];
    msgs = addAssistantMessage(msgs, 'a1', T);
    msgs = [...msgs, user('u2', 'Q2')]; // worker asks again during playback
    msgs = finalizeAssistantText(msgs, 'a1', 'Answer one');
    expect(msgs.find(m => m.id === 'a1')!.content).toBe('Answer one');
    expect(msgs.find(m => m.id === 'u2')!.content).toBe('Q2');
  });

  it('uses the fallback only for a placeholder with no text', () => {
    let msgs = addAssistantMessage([], 'a1', T);
    msgs = finalizeAssistantText(msgs, 'a1', '');
    expect(msgs[0].content).toBe(SPEECH_DELIVERED);
    // Text already shown (e.g. streamed while muted) is kept.
    msgs = setMessageContent(msgs, 'a1', 'Shown');
    msgs = finalizeAssistantText(msgs, 'a1', '');
    expect(msgs[0].content).toBe('Shown');
  });

  it('finalize adds buffered text after text already shown (mute, then unmute mid-answer)', () => {
    let msgs = addAssistantMessage([], 'a1', T);
    msgs = appendAssistantText(msgs, 'a1', 'Stay back. '); // streamed while muted
    msgs = finalizeAssistantText(msgs, 'a1', 'Call 911.'); // buffered after unmute
    expect(msgs[0].content).toBe('Stay back. Call 911.');
  });

  it('appendAssistantText replaces the placeholder, then appends; it creates a missing bubble', () => {
    let msgs = addAssistantMessage([], 'a1', T);
    expect(msgs[0].content).toBe(SPEAKING_PLACEHOLDER);
    msgs = appendAssistantText(msgs, 'a1', 'Hel');
    msgs = appendAssistantText(msgs, 'a1', 'lo');
    expect(msgs[0].content).toBe('Hello');
    msgs = appendAssistantText(msgs, 'a9', 'New');
    expect(msgs.map(m => [m.id, m.content])).toEqual([['a1', 'Hello'], ['a9', 'New']]);
  });

  it('addAssistantMessage ignores a duplicate id (created + added both arrive)', () => {
    const once = addAssistantMessage([], 'a1', T);
    expect(addAssistantMessage(once, 'a1', T)).toBe(once);
  });

  it('never mutates the previous state', () => {
    const before = addAssistantMessage([user('u1', 'Q')], 'a1', T);
    const snapshot = JSON.stringify(before);
    appendAssistantText(before, 'a1', 'x');
    finalizeAssistantText(before, 'a1', 'y');
    setMessageContent(before, 'u1', 'z');
    removeMessage(before, 'u1');
    expect(JSON.stringify(before)).toBe(snapshot);
  });

  it('removeMessage drops only that id', () => {
    const msgs = [user('u1', 'a'), user('u2', 'b')];
    expect(removeMessage(msgs, 'u1').map(m => m.id)).toEqual(['u2']);
  });
});

describe('H2-5.6 streamed questions', () => {
  it.each([
    [{ listening: true, socketOpen: true, replyPlaying: true, fullDuplex: true }, true],
    [{ listening: true, socketOpen: true, replyPlaying: true, fullDuplex: false }, false],
    [{ listening: true, socketOpen: true, replyPlaying: false, fullDuplex: false }, true],
    [{ listening: true, socketOpen: false, replyPlaying: false, fullDuplex: true }, false],
    [{ listening: false, socketOpen: true, replyPlaying: false, fullDuplex: true }, false],
  ])('shouldSendMicFrame(%o) is %s', (state, expected) => {
    expect(shouldSendMicFrame(state)).toBe(expected);
  });

  it('a frame is an input_audio_buffer.append', () => {
    expect(audioAppendEvent('AAAA')).toEqual({ type: 'input_audio_buffer.append', audio: 'AAAA' });
  });

  it('stopping mid-speech commits and asks for a response; otherwise clears', () => {
    expect(stopListeningEvents(true)).toEqual([{ type: 'input_audio_buffer.commit' }, { type: 'response.create' }]);
    expect(stopListeningEvents(false)).toEqual([{ type: 'input_audio_buffer.clear' }]);
  });

  it('the worker bubble starts as listening and takes the input transcript', () => {
    let msgs = addUserSpeechMessage([], 'i1', T);
    expect(msgs).toEqual([{ id: 'i1', role: 'user', content: LISTENING_PLACEHOLDER, timestamp: T }]);
    expect(addUserSpeechMessage(msgs, 'i1', T)).toBe(msgs);
    msgs = setUserTranscript(msgs, 'i1', ' Where is the shelter? ');
    expect(msgs[0].content).toBe('Where is the shelter?');
  });

  it('a blank input transcript says it could not be transcribed', () => {
    const msgs = addUserSpeechMessage([], 'i1', T);
    for (const blank of ['', '   ', undefined, null, 3]) {
      expect(setUserTranscript(msgs, 'i1', blank)[0].content).toBe(TRANSCRIPT_UNAVAILABLE);
    }
  });
});

describe('H2-5.7 barge-in', () => {
  it('bargeInEvents cancels, then truncates at the whole milliseconds played', () => {
    expect(bargeInEvents('a1', 1234.7)).toEqual([
      { type: 'response.cancel' },
      { type: 'conversation.item.truncate', item_id: 'a1', content_index: 0, audio_end_ms: 1234 }]);
    expect(bargeInEvents('a1', -5)[1]).toMatchObject({ audio_end_ms: 0 });
  });

  it('response_cancel_not_active is ignorable; other errors are not', () => {
    expect(isIgnorableServerError({ type: 'error', error: { code: 'response_cancel_not_active' } })).toBe(true);
    expect(isIgnorableServerError({ type: 'error', error: { code: 'event_not_allowed' } })).toBe(false);
    expect(isIgnorableServerError({ type: 'error' })).toBe(false);
    expect(isIgnorableServerError(undefined)).toBe(false);
  });
});

describe('T10 contract and C-59 socket guard', () => {
  it('only an OPEN socket can be sent to', () => {
    expect(isSocketOpen({ readyState: 1 } as any)).toBe(true);
    expect(isSocketOpen({ readyState: 0 } as any)).toBe(false); // CONNECTING
    expect(isSocketOpen({ readyState: 3 } as any)).toBe(false); // CLOSED
    expect(isSocketOpen(null)).toBe(false);
  });

  it('a question is a user input_text item then a bare response.create, never session.update', () => {
    const events = userTextEvents('Where is the nearest shelter?');
    expect(events).toEqual([
      {
        type: 'conversation.item.create',
        item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Where is the nearest shelter?' }] },
      },
      { type: 'response.create' },
    ]);
  });

  it('maps close codes to short, accurate messages', () => {
    expect(closeMessage(1008, 'Session time limit reached')).toBe('Session time limit reached');
    expect(closeMessage(1008, '')).toMatch(/too many connections|time limit/i);
    expect(closeMessage(1011, '')).toMatch(/unavailable/i);
    expect(closeMessage(1011, 'Upstream unavailable')).toMatch(/Upstream unavailable/);
    expect(closeMessage(1006, "Expected HTTP 101 response but was '403 Forbidden'")).toMatch(/not allowed|sign/i);
    expect(closeMessage(1006, '')).toMatch(/connection lost/i);
    expect(closeMessage(1000, '')).toMatch(/disconnected/i);
  });

  it('a handshake refused with 403 says so', () => {
    expect(connectErrorMessage({ message: "Expected HTTP 101 response but was '403 Forbidden'" })).toMatch(/not allowed|sign/i);
    expect(connectErrorMessage({})).toMatch(/couldn't connect/i);
  });
});
