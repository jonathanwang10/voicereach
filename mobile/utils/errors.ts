// How the app shows a caught error (C-16, H2-6.16): one toast with the backend's reason.
// services/api never toasts, so these are the only error toasts.
import Toast from 'react-native-toast-message';

export const RECORDING_FAILED = 'Could not record audio. Please try again.';

// Text to show for any caught error. An ApiError's message is its backend `detail`.
export const errorMessage = (e: unknown): string => {
  if (e && typeof e === 'object') {
    const detail = (e as any).detail;
    if (typeof detail === 'string' && detail) return detail;
    const message = (e as any).message;
    if (typeof message === 'string' && message) return message;
  }
  if (typeof e === 'string' && e) return e;
  return 'Something went wrong. Please try again.';
};

// Show a caught error once, as a toast.
export const showApiError = (e: unknown, title: string = 'Error'): void => {
  Toast.show({
    type: 'error',
    text1: title,
    text2: errorMessage(e),
    position: 'top',
    visibilityTime: 4000,
    autoHide: true,
    topOffset: 50,
  });
};
