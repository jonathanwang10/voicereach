import React, { useState, useEffect, useRef } from 'react';
import { View, Text, TextInput, StyleSheet, ScrollView, TouchableOpacity, Alert, ActivityIndicator } from 'react-native';
import Toast from 'react-native-toast-message';
import { api, DuplicateMatch } from '../services/api';
import { errorMessage, showApiError } from '../utils/errorHandler';
import { bestMergeableMatch, confirmSaveAsNew } from '../utils/duplicateMatches';
import {
  coerceFieldData,
  coerceFieldValue,
  formatFieldValue,
  toggleMultiSelect,
  validateFieldValue,
} from '../utils/fieldValues';
import { LocationData } from '../types';
import { Category, categoryLabel } from '../utils/categoryPayload';
import {
  fieldKeyboardType,
  fieldPlaceholder,
  isEssentialCategory,
  isLongTextCategory,
  sortCategories,
} from '../utils/categoryDisplay';
import { MergeUI } from './MergeUI';
import { CategoryLoadError } from './CategoryLoadError';

interface ManualEntryFormProps {
  onSave: (data: Record<string, any>) => void;
  onCancel: () => void;
  selectedLocation?: { latitude: number; longitude: number; address?: string } | null;
}

export const ManualEntryForm: React.FC<ManualEntryFormProps> = ({
  onSave,
  onCancel,
  selectedLocation,
}) => {
  // One entry per category, set once the categories load
  const [formData, setFormData] = useState<Record<string, any>>({});

  const [errors, setErrors] = useState<Record<string, string>>({});
  // The backend's reason when a save is rejected, shown in the form (C-16)
  const [saveError, setSaveError] = useState<string | null>(null);
  const [categories, setCategories] = useState<Category[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  // Why the category load failed (C-35); shown with Retry
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  // Blocks a second tap on Save that lands before the re-render disables it (C-13)
  const savingRef = useRef(false);
  const [showMergeUI, setShowMergeUI] = useState(false);
  const [pendingData, setPendingData] = useState<Record<string, any>>({});
  const [selectedMatch, setSelectedMatch] = useState<DuplicateMatch | null>(null);

  // Fetch categories from API on component mount
  useEffect(() => {
    fetchCategories();
  }, []);

  const fetchCategories = async () => {
    try {
      setIsLoading(true);
      setLoadError(null);
      const sortedCategories = sortCategories<Category>((await api.getCategories()) || []);
      setCategories(sortedCategories);
      setFormData(emptyForm(sortedCategories));
    } catch (error) {
      setLoadError(errorMessage(error));
    } finally {
      setIsLoading(false);
    }
  };

  // One empty value per category field
  const emptyForm = (cats: Category[]): Record<string, any> =>
    Object.fromEntries(cats.map(cat => [cat.name, '']));

  // After a successful save the form starts over, so the same person can't be
  // saved twice by tapping Save again (C-13)
  const resetForm = () => {
    setFormData(emptyForm(categories));
    setErrors({});
    setSaveError(null);
    setPendingData({});
    setShowMergeUI(false);
    setSelectedMatch(null);
  };

  const handleFieldChange = (fieldName: string, value: string | string[]) => {
    setFormData(prev => ({
      ...prev,
      [fieldName]: value,
    }));

    // Any edit makes the last save rejection stale
    setSaveError(null);
    // Clear error when user starts typing
    if (errors[fieldName]) {
      setErrors(prev => ({
        ...prev,
        [fieldName]: '',
      }));
    }
  };

  const validateForm = (): boolean => {
    const newErrors: Record<string, string> = {};
    let isValid = true;

    // Same checks as voice review (utils/fieldValues), mirroring the backend (C-15)
    categories.forEach(category => {
      const error = validateFieldValue(category, formData[category.name]);
      if (error) {
        newErrors[category.name] = error;
        isValid = false;
      }
    });

    setErrors(newErrors);
    return isValid;
  };

  const currentLocation = (): LocationData | null =>
    selectedLocation
      ? {
          latitude: selectedLocation.latitude,
          longitude: selectedLocation.longitude,
          address: selectedLocation.address || 'Unknown Address',
        }
      : null;

  const handleSave = async () => {
    if (isSaving || savingRef.current) return;
    setSaveError(null);

    if (!validateForm()) {
      Alert.alert('Validation Error', 'Please fix the errors before saving.');
      return;
    }

    savingRef.current = true;
    setIsSaving(true);
    try {
      // Real types (numbers, height in inches, matched labels, multi-select arrays);
      // empty fields are not sent at all (C-09, C-14)
      const fields = coerceFieldData(formData, categories);

      // Check for potential duplicates. If the check fails, ask before saving as
      // new: a failure must never read as "no match" (C-08).
      let potentialMatches: DuplicateMatch[] = [];
      try {
        potentialMatches = await api.checkDuplicates(fields);
      } catch {
        if (!(await confirmSaveAsNew())) return;
      }

      // A real, live person (not one whose delete is pending) opens the merge UI
      const bestMatch = bestMergeableMatch(potentialMatches);
      if (bestMatch) {
        setSelectedMatch(bestMatch);
        setPendingData(fields);
        setShowMergeUI(true);
        return;
      }

      // No meaningful match, save as new
      await api.saveIndividual({ data: fields, location: currentLocation() });
      Toast.show({
        type: 'success',
        text1: 'Success',
        text2: 'Data saved successfully!'
      });
      resetForm();
      onSave(fields);
    } catch (error: any) {
      setSaveError(errorMessage(error));
    } finally {
      savingRef.current = false;
      setIsSaving(false);
    }
  };

  const handleMerge = async (mergedData: Record<string, any>, mergeWithId: string) => {
    try {
      await api.saveIndividual({
        data: coerceFieldData(mergedData, categories),
        merge_with_id: mergeWithId,
        location: currentLocation(),
      });
      Toast.show({
        type: 'success',
        text1: 'Success',
        text2: 'Data merged successfully!'
      });
      resetForm();
      onSave(mergedData);
    } catch (error: any) {
      showApiError(error, 'Save failed');
    }
  };

  const handleCreateNew = async (data: Record<string, any>) => {
    try {
      await api.saveIndividual({ data: coerceFieldData(data, categories), location: currentLocation() });
      Toast.show({
        type: 'success',
        text1: 'Success',
        text2: 'New individual created successfully!'
      });
      resetForm();
      onSave(data);
    } catch (error: any) {
      showApiError(error, 'Save failed');
    }
  };

  const handleMergeCancel = () => {
    setShowMergeUI(false);
    setSelectedMatch(null);
    setIsSaving(false);
  };

  const renderField = (category: Category) => {
    const value = formData[category.name];
    const error = errors[category.name];
    const isRequired = category.is_required;

    return (
      <View key={category.id} style={styles.fieldContainer}>
        <Text style={[
          styles.fieldLabel,
          isRequired && styles.requiredLabel,
          error && styles.errorLabel
        ]}>
          {categoryLabel(category)}
          {isRequired && ' *'}
        </Text>

        {/* Preset options for quick filling (if available) */}
        {category.options && Array.isArray(category.options) && category.options.length > 0 && (
          <View style={styles.presetOptionsContainer}>
            <Text style={styles.presetOptionsLabel}>Quick options:</Text>
            <View style={styles.presetOptionsRow}>
              {category.options.map((option: any) => {
                const optionLabel = option.label || option;
                
                return (
                  <TouchableOpacity
                    key={optionLabel}
                    style={styles.presetOptionButton}
                    onPress={() => handleFieldChange(
                      category.name,
                      category.type === 'multi_select'
                        ? toggleMultiSelect(coerceFieldValue(category, value), optionLabel)
                        : optionLabel
                    )}
                  >
                    <Text style={styles.presetOptionText}>{optionLabel}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </View>
        )}

        {/* Always render as text input for flexibility */}
        <TextInput
          style={[
            styles.fieldInput,
            error && styles.errorInput
          ]}
          value={typeof value === 'string' ? value : formatFieldValue(value) ?? ''}
          onChangeText={(text) => handleFieldChange(category.name, text)}
          placeholder={fieldPlaceholder(category)}
          placeholderTextColor="#999"
          keyboardType={fieldKeyboardType(category)}
          multiline={isLongTextCategory(category)}
          numberOfLines={isLongTextCategory(category) ? 4 : 1}
        />

        {error && (
          <Text style={styles.errorText}>{error}</Text>
        )}
      </View>
    );
  };

  if (isLoading) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color="#007AFF" />
        <Text style={styles.loadingText}>Loading form fields...</Text>
      </View>
    );
  }

  if (categories.length === 0) {
    return <CategoryLoadError error={loadError} onRetry={fetchCategories} />;
  }

  // Show MergeUI if there's a medium confidence match
  if (showMergeUI && selectedMatch) {
    return (
      <MergeUI
        newData={pendingData}
        potentialMatch={selectedMatch}
        onMerge={handleMerge}
        onCreateNew={handleCreateNew}
        onCancel={handleMergeCancel}
      />
    );
  }

  return (
    <ScrollView style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>Manual Entry</Text>
        <Text style={styles.subtitle}>
          Enter information manually instead of voice recording
        </Text>
      </View>

      <View style={styles.formContainer}>
        {/* Essential Information - Name, Height, Weight, Age (already in order) */}
        {(() => {
          const essentialCategories = categories.filter(isEssentialCategory);
          if (essentialCategories.length === 0) return null;
          return (
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Essential Information</Text>
              {essentialCategories.map(category => renderField(category))}
            </View>
          );
        })()}

        {/* Location Information */}
        {selectedLocation && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Location Information</Text>
            <View style={styles.locationContainer}>
              <Text style={styles.locationText}>
                📍 {selectedLocation.address || `${selectedLocation.latitude.toFixed(6)}, ${selectedLocation.longitude.toFixed(6)}`}
              </Text>
            </View>
          </View>
        )}

        {/* Other Information - All non-essential categories */}
        {(() => {
          const otherCategories = categories.filter(cat => !isEssentialCategory(cat));
          if (otherCategories.length === 0) return null;
          return (
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Other Information</Text>
              {otherCategories.map(category => renderField(category))}
            </View>
          );
        })()}
      </View>

      {saveError && (
        <Text style={[styles.errorText, styles.saveErrorText]}>{saveError}</Text>
      )}

      {/* Action Buttons */}
      <View style={styles.buttonContainer}>
        <TouchableOpacity style={styles.cancelButton} onPress={onCancel}>
          <Text style={styles.cancelButtonText}>Cancel</Text>
        </TouchableOpacity>
        <TouchableOpacity 
          style={[styles.saveButton, isSaving && styles.saveButtonDisabled]} 
          onPress={handleSave}
          disabled={isSaving}
        >
          <Text style={styles.saveButtonText}>
            {isSaving ? 'Saving...' : 'Save'}
          </Text>
        </TouchableOpacity>
      </View>
    </ScrollView>
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
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 16,
    color: '#666',
  },
  formContainer: {
    padding: 20,
  },
  section: {
    marginBottom: 24,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: '#333',
    marginBottom: 16,
  },
  fieldContainer: {
    marginBottom: 20,
  },
  fieldLabel: {
    fontSize: 16,
    fontWeight: '600',
    color: '#333',
    marginBottom: 8,
  },
  requiredLabel: {
    color: '#dc3545',
  },
  errorLabel: {
    color: '#dc3545',
  },
  fieldInput: {
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 8,
    padding: 12,
    fontSize: 16,
    backgroundColor: '#fff',
  },
  errorInput: {
    borderColor: '#dc3545',
    backgroundColor: '#fff5f5',
  },
  errorText: {
    color: '#dc3545',
    fontSize: 12,
    marginTop: 4,
  },
  saveErrorText: {
    fontSize: 14,
    paddingHorizontal: 20,
  },
  buttonContainer: {
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
  saveButton: {
    flex: 1,
    backgroundColor: '#007AFF',
    paddingVertical: 16,
    borderRadius: 8,
    alignItems: 'center',
  },
  saveButtonDisabled: {
    backgroundColor: '#94A3B8',
  },
  saveButtonText: {
    color: 'white',
    fontSize: 16,
    fontWeight: '600',
  },
  locationContainer: {
    padding: 12,
    backgroundColor: '#e3f2fd',
    borderRadius: 8,
    borderLeftWidth: 4,
    borderLeftColor: '#2196f3',
  },
  locationText: {
    fontSize: 14,
    color: '#1976d2',
    fontWeight: '500',
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#fff',
  },
  loadingText: {
    marginTop: 10,
    color: '#666',
  },
  presetOptionsContainer: {
    marginBottom: 10,
    paddingHorizontal: 10,
  },
  presetOptionsLabel: {
    fontSize: 14,
    color: '#555',
    marginBottom: 5,
  },
  presetOptionsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  presetOptionButton: {
    backgroundColor: '#f0f0f0',
    borderRadius: 20,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderWidth: 1,
    borderColor: '#ddd',
  },
  presetOptionText: {
    fontSize: 12,
    color: '#333',
  },
}); 
