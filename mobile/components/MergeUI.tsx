import React, { useState, useMemo, useEffect, useRef } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, Alert, ActivityIndicator } from 'react-native';
import { api } from '../services/api';

interface PotentialMatch {
  id: string;
  confidence: number;
  name: string;
}

interface MergeUIProps {
  newData: Record<string, any>;
  potentialMatch: PotentialMatch;
  existingData?: Record<string, any>; // Will be fetched from backend
  onMerge: (mergedData: Record<string, any>) => void;
  onCreateNew: (data: Record<string, any>) => void;
  onCancel: () => void;
}

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
  
  const [fetchedExistingData, setFetchedExistingData] = useState<Record<string, any>>(existingData);
  const [isLoadingExistingData, setIsLoadingExistingData] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const lastFetchedIdRef = useRef<string | null>(null);

  // Fetch existing individual data if not provided
  useEffect(() => {
    const fetchExistingData = async () => {
      // Only fetch if no existing data provided and we have a potential match ID
      // And we haven't already fetched for this specific ID
      if (Object.keys(existingData).length === 0 && potentialMatch.id && lastFetchedIdRef.current !== potentialMatch.id) {
        lastFetchedIdRef.current = potentialMatch.id;

        // Skip fetching if the ID looks like a mock ID (not a valid UUID)
        const isValidUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(potentialMatch.id);

        if (!isValidUUID) {
          console.warn('⚠️ Skipping fetch for non-UUID ID:', potentialMatch.id);
          // Only update if not already empty to avoid infinite re-renders
          setFetchedExistingData(prev => Object.keys(prev).length === 0 ? prev : {});
          setIsLoadingExistingData(false);
          return;
        }

        setIsLoadingExistingData(true);
        setLoadError(null);

        try {
          console.log('🔍 Fetching existing individual data for merge comparison:', potentialMatch.id);
          const profile = await api.getIndividualProfile(potentialMatch.id);
          
          if (profile) {
            console.log('✅ Fetched existing individual data:', profile.data);
            setFetchedExistingData(profile.data || {});
          } else {
            console.warn('⚠️ Could not fetch existing individual data');
            setLoadError('Could not load existing individual data');
          }
        } catch (error) {
          console.error('❌ Error fetching existing individual data:', error);
          setLoadError('Failed to load existing individual data');
        } finally {
          setIsLoadingExistingData(false);
        }
      } else {
        // Use provided existing data
        setFetchedExistingData(existingData);
      }
    };

    fetchExistingData();
  }, [potentialMatch.id]); // Remove existingData from dependencies to prevent infinite loops

  // Track if initial selection has been set
  const [selectedFields, setSelectedFields] = useState<Record<string, 'new' | 'existing'>>({});
  const isSelectionInitializedRef = useRef(false);

  // Memoize the initial field selection to prevent infinite loops
  const initialFieldSelection = useMemo(() => {
    if (!isLoadingExistingData) {
      const selection: Record<string, 'new' | 'existing'> = {};

      // Get all fields from both new and existing data
      const allFields = new Set([...Object.keys(newData), ...Object.keys(fetchedExistingData)]);

      allFields.forEach(field => {
        // Prefer new data if it exists, otherwise use existing
        if (newData[field] !== undefined && newData[field] !== null && newData[field] !== '') {
          selection[field] = 'new';
        } else if (fetchedExistingData[field] !== undefined && fetchedExistingData[field] !== null && fetchedExistingData[field] !== '') {
          selection[field] = 'existing';
        } else {
          selection[field] = 'new'; // Default to new
        }
      });

      return selection;
    }
    return {};
  }, [newData, fetchedExistingData, isLoadingExistingData]);

  // Initialize field selection only once when data is loaded
  useEffect(() => {
    // Only initialize once when we have data to work with
    if (!isSelectionInitializedRef.current && Object.keys(initialFieldSelection).length > 0) {
      setSelectedFields(initialFieldSelection);
      isSelectionInitializedRef.current = true;
    }
  }, [initialFieldSelection]);

  // Reset the initialization flag when the potential match changes
  useEffect(() => {
    isSelectionInitializedRef.current = false;
  }, [potentialMatch.id]);

  const handleFieldSelection = (fieldName: string, source: 'new' | 'existing') => {
    setSelectedFields(prev => ({
      ...prev,
      [fieldName]: source,
    }));
  };

  const handleMerge = () => {
    const mergedData: Record<string, any> = {};
    
    // Combine data based on user selections
    Object.keys(selectedFields).forEach(field => {
      const source = selectedFields[field];
      if (source === 'new') {
        mergedData[field] = newData[field];
      } else if (source === 'existing') {
        mergedData[field] = fetchedExistingData[field];
      }
    });

    // Fallback: if no fields were selected, use all new data
    if (Object.keys(mergedData).length === 0 && Object.keys(newData).length > 0) {
      console.warn('⚠️ No fields selected, using all new data as fallback');
      Object.assign(mergedData, newData);
    }

    // Ensure we have the merge ID
    if (!potentialMatch.id) {
      console.error('❌ Invalid merge ID:', potentialMatch.id);
      Alert.alert('Error', 'Invalid merge target. Please try again.');
      return;
    }

    // Add the existing individual's ID for merging (using backend's expected field name)
    mergedData.merge_with_id = potentialMatch.id;
    
    console.log('🔄 Merging data:', mergedData);
    onMerge(mergedData);
  };

  const handleCreateNew = () => {
    onCreateNew(newData);
  };

  const getFieldValue = (fieldName: string, source: 'new' | 'existing') => {
    const data = source === 'new' ? newData : fetchedExistingData;
    const value = data[fieldName];
    
    if (value === undefined || value === null || value === '') {
      return '—';
    }
    
    return String(value);
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
    const hasNewData = newData[fieldName] !== undefined && newData[fieldName] !== null && newData[fieldName] !== '';
    const hasExistingData = fetchedExistingData[fieldName] !== undefined && fetchedExistingData[fieldName] !== null && fetchedExistingData[fieldName] !== '';

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
    console.error('❌ MergeUI received invalid ID:', potentialMatch.id);
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
          <TouchableOpacity style={styles.retryButton} onPress={onCancel}>
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
        <TouchableOpacity style={styles.cancelButton} onPress={onCancel}>
          <Text style={styles.cancelButtonText}>Cancel</Text>
        </TouchableOpacity>
        
        <TouchableOpacity style={styles.createNewButton} onPress={handleCreateNew}>
          <Text style={styles.createNewButtonText}>Create New</Text>
        </TouchableOpacity>
        
        <TouchableOpacity style={styles.mergeButton} onPress={handleMerge}>
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
}); 