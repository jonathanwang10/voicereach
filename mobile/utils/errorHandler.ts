// Comprehensive Error Handling Utility
import Toast from 'react-native-toast-message';

export interface AppError {
  code: string;
  message: string;
  userMessage: string;
  retryable: boolean;
  severity: 'low' | 'medium' | 'high' | 'critical';
}

export class ErrorHandler {
  // Network errors
  static handleNetworkError = (error: any): AppError => {
    if (error?.message?.includes('Network request failed')) {
      return {
        code: 'NETWORK_ERROR',
        message: 'Network request failed',
        userMessage: 'No internet connection. Please check your network and try again.',
        retryable: true,
        severity: 'high'
      };
    }
    
    if (error?.message?.includes('timeout')) {
      return {
        code: 'TIMEOUT_ERROR',
        message: 'Request timeout',
        userMessage: 'Request timed out. Please try again.',
        retryable: true,
        severity: 'medium'
      };
    }
    
    return {
      code: 'UNKNOWN_NETWORK_ERROR',
      message: error?.message || 'Unknown network error',
      userMessage: 'Network error occurred. Please try again.',
      retryable: true,
      severity: 'medium'
    };
  };

  // API errors
  static handleApiError = (error: any): AppError => {
    if (error?.message?.includes('401')) {
      return {
        code: 'UNAUTHORIZED',
        message: 'Authentication failed',
        userMessage: 'Please log in again to continue.',
        retryable: false,
        severity: 'high'
      };
    }
    
    if (error?.message?.includes('403')) {
      return {
        code: 'FORBIDDEN',
        message: 'Access denied',
        userMessage: 'You don\'t have permission to perform this action.',
        retryable: false,
        severity: 'high'
      };
    }
    
    if (error?.message?.includes('404')) {
      return {
        code: 'NOT_FOUND',
        message: 'Resource not found',
        userMessage: 'The requested resource was not found.',
        retryable: false,
        severity: 'medium'
      };
    }
    
    if (error?.message?.includes('500')) {
      return {
        code: 'SERVER_ERROR',
        message: 'Server error',
        userMessage: 'Server error occurred. Please try again later.',
        retryable: true,
        severity: 'high'
      };
    }
    
    if (error?.message?.includes('Real API disabled')) {
      return {
        code: 'DEMO_MODE',
        message: '✅ Demo mode active - using mock data',
        userMessage: '✅ Demo mode: Using realistic mock transcription data.',
        retryable: false,
        severity: 'low'
      };
    }
    
    return {
      code: 'UNKNOWN_API_ERROR',
      message: error?.message || 'Unknown API error',
      userMessage: 'An error occurred. Please try again.',
      retryable: true,
      severity: 'medium'
    };
  };

  // Recording errors
  static handleRecordingError = (error: any): AppError => {
    if (error?.message?.includes('permission')) {
      return {
        code: 'RECORDING_PERMISSION_DENIED',
        message: 'Recording permission denied',
        userMessage: 'Please allow microphone access to record audio.',
        retryable: false,
        severity: 'high'
      };
    }
    
    if (error?.message?.includes('Only one Recording object')) {
      return {
        code: 'RECORDING_IN_PROGRESS',
        message: 'Recording already in progress',
        userMessage: 'Please wait for the current recording to finish.',
        retryable: false,
        severity: 'medium'
      };
    }
    
    return {
      code: 'RECORDING_ERROR',
      message: error?.message || 'Recording error',
      userMessage: 'Failed to record audio. Please try again.',
      retryable: true,
      severity: 'medium'
    };
  };

  // Location errors
  static handleLocationError = (error: any): AppError => {
    if (error?.message?.includes('permission')) {
      return {
        code: 'LOCATION_PERMISSION_DENIED',
        message: 'Location permission denied',
        userMessage: 'Please allow location access to capture GPS coordinates.',
        retryable: false,
        severity: 'medium'
      };
    }
    
    if (error?.message?.includes('timeout')) {
      return {
        code: 'LOCATION_TIMEOUT',
        message: 'Location request timeout',
        userMessage: 'Location request timed out. Please try again.',
        retryable: true,
        severity: 'medium'
      };
    }
    
    return {
      code: 'LOCATION_ERROR',
      message: error?.message || 'Location error',
      userMessage: 'Failed to get location. Please try again.',
      retryable: true,
      severity: 'medium'
    };
  };

  // Validation errors
  static handleValidationError = (errors: Record<string, string>): AppError => {
    const errorMessages = Object.values(errors).join(', ');
    return {
      code: 'VALIDATION_ERROR',
      message: `Validation failed: ${errorMessages}`,
      userMessage: `Please fix the following errors: ${errorMessages}`,
      retryable: false,
      severity: 'medium'
    };
  };

  // Show error to user
  static showError = (error: AppError) => {
    // Use different logging level for demo mode
    if (error.code === 'DEMO_MODE') {
      console.log(`[${error.code}] ${error.message}`);
    } else {
      console.error(`[${error.code}] ${error.message}`);
    }

    // Don't show toast for low severity errors
    if (error.severity === 'low') {
      return;
    }
    
    Toast.show({
      type: 'error',
      text1: 'Error',
      text2: error.userMessage,
      position: 'top',
      visibilityTime: 4000,
      autoHide: true,
      topOffset: 50
    });
  };

  // Show success message
  static showSuccess = (message: string) => {
    Toast.show({
      type: 'success',
      text1: 'Success',
      text2: message,
      position: 'top',
      visibilityTime: 3000,
      autoHide: true,
      topOffset: 50
    });
  };

  // Show info message
  static showInfo = (message: string) => {
    Toast.show({
      type: 'info',
      text1: 'Info',
      text2: message,
      position: 'top',
      visibilityTime: 3000,
      autoHide: true,
      topOffset: 50
    });
  };

  // Generic error handler (null-safe: some callers pass whatever was caught)
  static handleError = (error: any, context: string = 'Unknown'): AppError => {
    console.error(`Error in ${context}:`, error);
    
    // Try to categorize the error
    if (error?.message?.includes('Network') || error?.message?.includes('fetch')) {
      return this.handleNetworkError(error);
    }
    
    if (error?.message?.includes('API') || error?.message?.includes('401') || error?.message?.includes('500')) {
      return this.handleApiError(error);
    }
    
    if (error?.message?.includes('Recording') || error?.message?.includes('microphone')) {
      return this.handleRecordingError(error);
    }
    
    if (error?.message?.includes('Location') || error?.message?.includes('GPS')) {
      return this.handleLocationError(error);
    }
    
    // Default error
    return {
      code: 'UNKNOWN_ERROR',
      message: error?.message || 'Unknown error',
      userMessage: 'An unexpected error occurred. Please try again.',
      retryable: true,
      severity: 'medium'
    };
  };
}

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

// Show a caught error once, as a toast. services/api never toasts, so this is the only one.
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
