// T11: pure helpers behind the voice assistant screen.
// C-25: answer text is keyed by item id, so follow-ups can't steal or lose it.
// C-23: an empty transcript is "nothing to send".
// C-59: updates are immutable; sends need an OPEN socket.
// T10 contract: ignore ctx_ items, only allowlisted client events, close-code messages.
import {
  Message,
  SPEAKING_PLACEHOLDER,
  SPEECH_DELIVERED,
  addAssistantMessage,
  appendAssistantText,
  finalizeAssistantText,
  setMessageContent,
  removeMessage,
  bufferText,
  takeText,
  cleanTranscript,
  isContextItem,
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

  it("a second item's fallback never lands in the first item's bubble", () => {
    let msgs: Message[] = [];
    msgs = addAssistantMessage(msgs, 'a1', T);
    msgs = addAssistantMessage(msgs, 'a2', T);
    let buffers = bufferText({}, 'a1', 'Answer ');
    buffers = bufferText(buffers, 'a1', 'one');
    buffers = bufferText(buffers, 'a2', 'Answer two');

    const one = takeText(buffers, 'a1');
    msgs = finalizeAssistantText(msgs, 'a1', one.text);
    const two = takeText(one.rest, 'a2');
    msgs = finalizeAssistantText(msgs, 'a2', two.text);

    expect(msgs.map(m => m.content)).toEqual(['Answer one', 'Answer two']);
    expect(two.rest).toEqual({});
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

  it('takeText of an unknown id is empty and leaves the buffers alone', () => {
    const buffers = { a1: 'x' };
    expect(takeText(buffers, 'zz')).toEqual({ text: '', rest: { a1: 'x' } });
  });
});

describe('C-23 transcripts', () => {
  it('blank or missing transcripts are empty (nothing to send)', () => {
    expect(cleanTranscript('')).toBe('');
    expect(cleanTranscript('   ')).toBe('');
    expect(cleanTranscript(undefined)).toBe('');
    expect(cleanTranscript(null)).toBe('');
  });

  it('short real answers like "OK" are kept (only empty is rejected)', () => {
    expect(cleanTranscript(' OK ')).toBe('OK');
  });
});

describe('T10 contract and C-59 socket guard', () => {
  it('ctx_ items are the server-injected reference data', () => {
    expect(isContextItem({ id: 'ctx_0123456789abcdef01234567', role: 'user' })).toBe(true);
    expect(isContextItem({ id: 'item_abc', role: 'user' })).toBe(false);
    expect(isContextItem(undefined)).toBe(false);
  });

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
