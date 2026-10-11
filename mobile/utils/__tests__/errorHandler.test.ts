// C-16: one toast per failure, showing the backend detail; handleError tolerates null.
jest.mock('react-native-toast-message', () => ({ __esModule: true, default: { show: jest.fn() } }));

import Toast from 'react-native-toast-message';
import { ErrorHandler, showApiError, errorMessage } from '../errorHandler';

beforeEach(() => jest.clearAllMocks());

it('handleError does not throw on null or undefined', () => {
  expect(() => ErrorHandler.handleError(null)).not.toThrow();
  expect(() => ErrorHandler.handleError(undefined, 'x')).not.toThrow();
  expect(ErrorHandler.handleError(null).code).toBe('UNKNOWN_ERROR');
});

it('errorMessage prefers the ApiError detail', () => {
  const apiError = Object.assign(new Error('gender: Invalid option'), { status: 400, detail: 'gender: Invalid option', kind: 'http' });
  expect(errorMessage(apiError)).toBe('gender: Invalid option');
  expect(errorMessage(new Error('boom'))).toBe('boom');
  expect(errorMessage(null)).toMatch(/try again/i);
  expect(errorMessage('plain')).toBe('plain');
});

it('showApiError shows exactly one toast with the detail', () => {
  const apiError = Object.assign(new Error('Category already exists'), { status: 409, detail: 'Category already exists', kind: 'http' });
  showApiError(apiError, 'Could not create category');
  expect(Toast.show).toHaveBeenCalledTimes(1);
  expect((Toast.show as jest.Mock).mock.calls[0][0]).toMatchObject({
    type: 'error', text1: 'Could not create category', text2: 'Category already exists',
  });
});
