// OD-3 (C-45): delete hides the person at once, the real DELETE runs only when the
// undo window expires, Undo cancels it, and a failed DELETE brings the person back.
const mockDelete = jest.fn<Promise<void>, [string]>();
jest.mock('../../services/api', () => ({
  api: { deleteIndividual: (id: string) => mockDelete(id) },
}));
jest.mock('react-native-toast-message', () => ({ __esModule: true, default: { show: jest.fn() } }));

import Toast from 'react-native-toast-message';
import {
  DELETE_UNDO_MS,
  scheduleDelete,
  isPendingDelete,
  subscribePendingDeletes,
  __resetPendingDeletesForTests,
} from '../delayedDelete';

// Let the awaited DELETE promise settle under fake timers
const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

let events: Array<{ id: string; type: string }>;
beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  __resetPendingDeletesForTests();
  mockDelete.mockResolvedValue(undefined);
  events = [];
  subscribePendingDeletes(e => events.push(e));
});
afterEach(() => {
  __resetPendingDeletesForTests();
  jest.useRealTimers();
});

it('waits about 5 seconds by default', () => {
  expect(DELETE_UNDO_MS).toBe(5000);
});

it('hides the person immediately but does not delete yet', () => {
  scheduleDelete('p1');
  expect(isPendingDelete('p1')).toBe(true);
  expect(isPendingDelete('p2')).toBe(false);
  expect(events).toEqual([{ id: 'p1', type: 'scheduled' }]);
  jest.advanceTimersByTime(DELETE_UNDO_MS - 1);
  expect(mockDelete).not.toHaveBeenCalled();
});

it('Undo cancels: nothing is deleted and the person is visible again', async () => {
  const handle = scheduleDelete('p1');
  expect(handle.cancel()).toBe(true);
  expect(isPendingDelete('p1')).toBe(false);
  jest.advanceTimersByTime(DELETE_UNDO_MS * 2);
  await flush();
  expect(mockDelete).not.toHaveBeenCalled();
  expect(events.map(e => e.type)).toEqual(['scheduled', 'cancelled']);
  expect(handle.cancel()).toBe(false);
});

it('runs the real DELETE once on expiry, keeping the person hidden until it succeeds', async () => {
  let finish: () => void = () => {};
  mockDelete.mockReturnValue(new Promise<void>(r => { finish = r; }));
  const handle = scheduleDelete('p1');
  jest.advanceTimersByTime(DELETE_UNDO_MS);
  expect(mockDelete).toHaveBeenCalledTimes(1);
  expect(mockDelete).toHaveBeenCalledWith('p1');
  expect(isPendingDelete('p1')).toBe(true);
  expect(handle.cancel()).toBe(false); // too late: the DELETE is in flight

  finish();
  await flush();
  expect(isPendingDelete('p1')).toBe(false);
  expect(events.map(e => e.type)).toEqual(['scheduled', 'committed']);
  expect(Toast.show).not.toHaveBeenCalled();
});

it('a failed DELETE un-hides the person, tells the user once, and calls onError', async () => {
  const failure = Object.assign(new Error('Server error'), { status: 500, detail: 'Delete individual failed' });
  mockDelete.mockRejectedValue(failure);
  const onError = jest.fn();
  scheduleDelete('p1', { onError });
  jest.advanceTimersByTime(DELETE_UNDO_MS);
  await flush();
  expect(isPendingDelete('p1')).toBe(false);
  expect(events.map(e => e.type)).toEqual(['scheduled', 'failed']);
  expect(onError).toHaveBeenCalledWith(failure);
  expect(Toast.show).toHaveBeenCalledTimes(1);
  expect((Toast.show as jest.Mock).mock.calls[0][0]).toMatchObject({
    type: 'error',
    text2: expect.stringContaining('Delete individual failed'),
  });
});

it('honours a custom delay and stops notifying after unsubscribe', () => {
  const extra = jest.fn();
  const unsubscribe = subscribePendingDeletes(extra);
  scheduleDelete('p1', { delayMs: 100 });
  unsubscribe();
  jest.advanceTimersByTime(100);
  expect(mockDelete).toHaveBeenCalledWith('p1');
  expect(extra).toHaveBeenCalledTimes(1); // 'scheduled' only
});

it('scheduling the same id twice runs one DELETE', async () => {
  scheduleDelete('p1');
  jest.advanceTimersByTime(1000);
  scheduleDelete('p1');
  jest.advanceTimersByTime(DELETE_UNDO_MS);
  await flush();
  expect(mockDelete).toHaveBeenCalledTimes(1);
});
