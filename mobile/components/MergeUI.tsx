import React, { useState, useMemo, useEffect, useRef } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, Alert, ActivityIndicator } from 'react-native';
import { api } from '../services/api';
import { showApiError } from '../utils/errorHandler';
import { formatFieldValue, isEmptyValue } from '../utils/fieldValues';

interface PotentialMatch {
  id: string;
  confidence: number;
  name: string;
}

interface MergeUIProps {
  newData: Record<string, any>;
  potentialMatch: PotentialMatch;
  existingData?: Record<string, any>; // Will be fetched from backend
  // Field data only; the merge target id is passed separately (never mixed into the data).
  // While a returned promise is pending, every button is disabled (C-13).
  onMerge: (mergedData: Record<string, any>, mergeWithId: string) => void | Promise<void>;
  onCreateNew: (data: Record<string, any>) => void | Promise<void>;
  onCancel: () => void;
}

type Source = 'new' | 'existing';

// Default choice per field: the new value when there is one, else the existing one
const defaultSelection = (newData: Record<string, any>, existing: Record<string, any>) => {
  const selection: Record<string, Source> = {};
  new Set([...Object.keys(newData), ...Object.keys(existing)]).forEach(field => {
    selection[field] = isEmptyValue(newData[field]) && !isEmptyValue(existing[field]) ? 'existing' : 'new';
  });
  return selection;
};

export const MergeUI: React.FC<MergeUIProps> = ({
  newData,
  potentialMatch,
  existingData = {},
  onMerge,
  onCreateNew,
  onCancel,
}) => {
  // Validate that potentialMatch has a valid UUID
  const isValidUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(potentialMatch.id);
  const hasProvidedData = Object.keys(existingData).length > 0;

  // The matched person's data, tagged with the id it belongs to. Until it is loaded
  // for the current match, the screen shows a spinner and nothing can be merged, so
  // the field selection is always built from the loaded person (C-64).
  const [existing, setExisting] = useState<{ forId: string | null; data: Record<string, any> }>(() =>
    hasProvidedData ? { forId: potentialMatch.id, data: existingData } : { forId: null, data: {} });
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    if (!isValidUUID) return;
    if (hasProvidedData) {
      setExisting({ forId: potentialMatch.id, data: existingData });
      return;
    }
    let cancelled = false;
    setLoadError(null);
    api.getIndividualProfile(potentialMatch.id)
      .then(profile => {
        if (!cancelled) setExisting({ forId: potentialMatch.id, data: profile?.data || {} });
      })
      .catch(() => {
        if (!cancelled) setLoadError('Failed to load existing individual data');
      });
    return () => { cancelled = true; };
  }, [potentialMatch.id]); // existingData is not a dependency: a new {} each render would loop

  const isLoaded = existing.forId === potentialMatch.id;
  const fetchedExistingData = isLoaded ? existing.data : {};
  const isLoadingExistingData = isValidUUID && !isLoaded && !loadError;

  // The worker's choices on top of the defaults, reset when the match changes
  const [choices, setChoices] = useState<{ forId: string; fields: Record<string, Source> }>(
    { forId: potentialMatch.id, fields: {} });
  const selectedFields = useMemo(() => ({
    ...defaultSelection(newData, fetchedExistingData),
    ...(choices.forId === potentialMatch.id ? choices.fields : {}),
  }), [newData, fetchedExistingData, choices, potentialMatch.id]);

  const handleFieldSelection = (fieldName: string, source: Source) => {
    setChoices(prev => ({
      forId: potentialMatch.id,
      fields: { ...(prev.forId === potentialMatch.id ? prev.fields : {}), [fieldName]: source },
    }));
  };

  // One submit at a time: a double tap must not create two people or log two
  // interactions (C-13). The ref blocks a second tap before the re-render lands.
  const [isSubmitting, setIsSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const submit = async (action: () => void | Promise<void>) => {
    if (submittingRef.current) return;
    submittingRef.current = true;
    setIsSubmitting(true);
    try {
      await action();
    } catch (e) {
      // Both parents catch and report their own failures; this only stops a
      // rejecting handler from becoming an unhandled rejection, and says so once
      showApiError(e, 'Save failed');
    } finally {
      submittingRef.current = false;
      setIsSubmitting(false);
    }
  };

  const handleMerge = () => {
    const mergedData: Record<string, any> = {};

    // Combine data based on user selections
    Object.keys(selectedFields).forEach(field => {
      mergedData[field] = selectedFields[field] === 'existing' ? fetchedExistingData[field] : newData[field];
    });

    // Ensure we have the merge ID
    if (!potentialMatch.id) {
      Alert.alert('Error', 'Invalid merge target. Please try again.');
      return;
    }

    submit(() => onMerge(mergedData, potentialMatch.id));
  };

  const handleCreateNew = () => {
    submit(() => onCreateNew(newData));
  };

  const getFieldValue = (fieldName: string, source: 'new' | 'existing') => {
    const data = source === 'new' ? newData : fetchedExistingData;
    return formatFieldValue(data[fieldName]) ?? '—';
  };

  const getConfidenceColor = (confidence: number) => {
    if (confidence >= 80) return '#dc3545'; // Red for high confidence
    if (confidence >= 60) return '#ffc107'; // Yellow for medium confidence
    return '#28a745'; // Green for low confidence
  };

  const renderFieldComparison = (fieldName: string) => {
    const newValue = getFieldValue(fieldName, 'new');
    const existingValue = getFieldValue(fieldName, 'existing');
    const selectedSource = selectedFields[fieldName];
    const hasNewData = !isEmptyValue(newData[fieldName]);
    const hasExistingData = !isEmptyValue(fetchedExistingData[fieldName]);

    return (
      <View key={fieldName} style={styles.fieldRow}>
        <Text style={styles.fieldName}>
          {fieldName.charAt(0).toUpperCase() + fieldName.slice(1).replace(/_/g, ' ')}
        </Text>
        
        <View style={styles.fieldValues}>
          {/* New Data */}
          <TouchableOpacity
            style={[
              styles.valueContainer,
              selectedSource === 'new' && styles.selectedValue,
              !hasNewData && styles.emptyValue
            ]}
            onPress={() => handleFieldSelection(fieldName, 'new')}
            disabled={!hasNewData}
          >
            <Text style={styles.valueLabel}>New</Text>
            <Text style={[
              styles.valueText,
              selectedSource === 'new' && styles.selectedValueText,
              !hasNewData && styles.emptyValueText
            ]}>
              {newValue}
            </Text>
          </TouchableOpacity>

          {/* Existing Data */}
          <TouchableOpacity
            style={[
              styles.valueContainer,
              selectedSource === 'existing' && styles.selectedValue,
              !hasExistingData && styles.emptyValue
            ]}
            onPress={() => handleFieldSelection(fieldName, 'existing')}
            disabled={!hasExistingData}
          >
            <Text style={styles.valueLabel}>Existing</Text>
            <Text style={[
              styles.valueText,
              selectedSource === 'existing' && styles.selectedValueText,
              !hasExistingData && styles.emptyValueText
            ]}>
              {existingValue}
            </Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  };

  const allFields = useMemo(
    () => Array.from(new Set([...Object.keys(newData), ...Object.keys(fetchedExistingData)])),
    [newData, fetchedExistingData]
  );

  if (!isValidUUID) {
    return (
      <View style={styles.container}>
        <Text style={styles.errorText}>
          Invalid merge target. Please try again.
        </Text>
        <TouchableOpacity style={styles.cancelButton} onPress={onCancel}>
          <Text style={styles.cancelButtonText}>Cancel</Text>
        </TouchableOpacity>
      </View>
    );
  }

  // Show loading state while fetching existing data
  if (isLoadingExistingData) {
    return (
      <View style={styles.container}>
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color="#007AFF" />
          <Text style={styles.loadingText}>Loading individual data for comparison...</Text>
        </View>
      </View>
    );
  }

  // Show error state if failed to load existing data
  if (loadError) {
    return (
      <View style={styles.container}>
        <View style={styles.errorContainer}>
          <Text style={styles.errorTitle}>Unable to Load Data</Text>
          <Text style={styles.errorText}>{loadError}</Text>
          {/* The person may have been deleted, or the network failed: the recording
              can still be saved as a new person (C-19) */}
          <TouchableOpacity
            style={[styles.retryButton, styles.errorCreateNewButton, isSubmitting && styles.disabledButton]}
            onPress={handleCreateNew}
            disabled={isSubmitting}
          >
            <Text style={styles.retryButtonText}>Create New</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.retryButton} onPress={onCancel} disabled={isSubmitting}>
            <Text style={styles.retryButtonText}>Cancel</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>Potential Duplicate Found</Text>
        <View style={styles.confidenceContainer}>
          <Text style={styles.confidenceLabel}>Confidence:</Text>
          <Text style={[
            styles.confidenceScore,
            { color: getConfidenceColor(potentialMatch.confidence) }
          ]}>
            {potentialMatch.confidence}%
          </Text>
        </View>
        <Text style={styles.subtitle}>
          We found a similar individual: <Text style={styles.matchName}>{potentialMatch.name}</Text>
        </Text>
        <Text style={styles.instructions}>
          Select which data to keep for each field, then choose an action below.
        </Text>
      </View>

      <ScrollView style={styles.content}>
        <View style={styles.comparisonSection}>
          <Text style={styles.sectionTitle}>Field Comparison</Text>
          {allFields.map(fieldName => renderFieldComparison(fieldName))}
        </View>
      </ScrollView>

      <View style={styles.actionButtons}>
        <TouchableOpacity
          style={[styles.cancelButton, isSubmitting && styles.disabledButton]}
          onPress={onCancel}
          disabled={isSubmitting}
        >
          <Text style={styles.cancelButtonText}>Cancel</Text>
        </TouchableOpacity>
        
        <TouchableOpacity
          style={[styles.createNewButton, isSubmitting && styles.disabledButton]}
          onPress={handleCreateNew}
          disabled={isSubmitting}
        >
          <Text style={styles.createNewButtonText}>Create New</Text>
        </TouchableOpacity>
        
        <TouchableOpacity
          style={[styles.mergeButton, isSubmitting && styles.disabledButton]}
          onPress={handleMerge}
          disabled={isSubmitting}
        >
          <Text style={styles.mergeButtonText}>Merge</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff',
  },
  header: {
    padding: 20,
    borderBottomWidth: 1,
    borderBottomColor: '#e9ecef',
  },
  title: {
    fontSize: 24,
    fontWeight: 'bold',
    color: '#333',
    marginBottom: 12,
  },
  confidenceContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 8,
  },
  confidenceLabel: {
    fontSize: 16,
    color: '#666',
    marginRight: 8,
  },
  confidenceScore: {
    fontSize: 18,
    fontWeight: 'bold',
  },
  subtitle: {
    fontSize: 16,
    color: '#666',
    marginBottom: 8,
  },
  matchName: {
    fontWeight: '600',
    color: '#333',
  },
  instructions: {
    fontSize: 14,
    color: '#666',
    fontStyle: 'italic',
  },
  content: {
    flex: 1,
  },
  comparisonSection: {
    padding: 20,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: '#333',
    marginBottom: 16,
  },
  fieldRow: {
    marginBottom: 16,
  },
  fieldName: {
    fontSize: 16,
    fontWeight: '600',
    color: '#333',
    marginBottom: 8,
  },
  fieldValues: {
    flexDirection: 'row',
    gap: 12,
  },
  valueContainer: {
    flex: 1,
    borderWidth: 2,
    borderColor: '#ddd',
    borderRadius: 8,
    padding: 12,
    backgroundColor: '#f8f9fa',
  },
  selectedValue: {
    borderColor: '#007AFF',
    backgroundColor: '#e3f2fd',
  },
  emptyValue: {
    borderColor: '#ddd',
    backgroundColor: '#f8f9fa',
    opacity: 0.6,
  },
  valueLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: '#666',
    marginBottom: 4,
    textTransform: 'uppercase',
  },
  valueText: {
    fontSize: 14,
    color: '#333',
    fontWeight: '500',
  },
  selectedValueText: {
    color: '#007AFF',
    fontWeight: '600',
  },
  emptyValueText: {
    color: '#999',
    fontStyle: 'italic',
  },
  actionButtons: {
    flexDirection: 'row',
    padding: 20,
    gap: 12,
  },
  cancelButton: {
    flex: 1,
    backgroundColor: '#6c757d',
    paddingVertical: 16,
    borderRadius: 8,
    alignItems: 'center',
  },
  cancelButtonText: {
    color: 'white',
    fontSize: 16,
    fontWeight: '600',
  },
  createNewButton: {
    flex: 1,
    backgroundColor: '#28a745',
    paddingVertical: 16,
    borderRadius: 8,
    alignItems: 'center',
  },
  createNewButtonText: {
    color: 'white',
    fontSize: 16,
    fontWeight: '600',
  },
  mergeButton: {
    flex: 1,
    backgroundColor: '#007AFF',
    paddingVertical: 16,
    borderRadius: 8,
    alignItems: 'center',
  },
  mergeButtonText: {
    color: 'white',
    fontSize: 16,
    fontWeight: '600',
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 40,
  },
  loadingText: {
    marginTop: 16,
    fontSize: 16,
    color: '#666',
    textAlign: 'center',
  },
  errorContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 40,
  },
  errorTitle: {
    fontSize: 18,
    fontWeight: 'bold',
    color: '#dc3545',
    marginBottom: 8,
    textAlign: 'center',
  },
  errorText: {
    fontSize: 14,
    color: '#666',
    textAlign: 'center',
    marginBottom: 20,
  },
  retryButton: {
    backgroundColor: '#6c757d',
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 8,
  },
  retryButtonText: {
    color: 'white',
    fontSize: 16,
    fontWeight: '600',
  },
  errorCreateNewButton: {
    backgroundColor: '#28a745',
    marginBottom: 12,
  },
  disabledButton: {
    opacity: 0.5,
  },
}); 