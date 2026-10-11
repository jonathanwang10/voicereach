import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';

interface CategoryLoadErrorProps {
  // Why the load failed; null when it worked but no categories are configured
  error: string | null;
  onRetry: () => void;
  onCancel?: () => void;
}

// The "no form fields" state shared by manual entry and voice review (C-35): a
// failed load says what failed and offers Retry instead of an empty form.
export const CategoryLoadError: React.FC<CategoryLoadErrorProps> = ({ error, onRetry, onCancel }) => (
  <View style={styles.errorContainer}>
    <Text style={styles.errorTitle}>{error ? "Couldn't load form fields" : 'No Categories Found'}</Text>
    <Text style={styles.errorText}>
      {error ?? 'No form fields are configured. Please contact an administrator.'}
    </Text>
    <TouchableOpacity style={styles.retryButton} onPress={onRetry}>
      <Text style={styles.retryButtonText}>Retry</Text>
    </TouchableOpacity>
    {onCancel && (
      <TouchableOpacity style={styles.cancelButton} onPress={onCancel}>
        <Text style={styles.cancelButtonText}>Cancel</Text>
      </TouchableOpacity>
    )}
  </View>
);

const styles = StyleSheet.create({
  errorContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
    backgroundColor: '#fff',
  },
  errorTitle: {
    fontSize: 20,
    fontWeight: 'bold',
    color: '#dc3545',
    marginBottom: 10,
  },
  errorText: {
    color: '#dc3545',
    fontSize: 12,
    marginTop: 4,
    marginBottom: 16,
    textAlign: 'center',
  },
  retryButton: {
    backgroundColor: '#007AFF',
    paddingVertical: 12,
    paddingHorizontal: 25,
    borderRadius: 8,
  },
  retryButtonText: {
    color: 'white',
    fontSize: 16,
    fontWeight: '600',
  },
  cancelButton: {
    marginTop: 12,
    paddingVertical: 12,
    paddingHorizontal: 25,
  },
  cancelButtonText: {
    color: '#6c757d',
    fontSize: 16,
    fontWeight: '600',
  },
});
