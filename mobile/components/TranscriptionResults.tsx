import React, { useState, useEffect, useMemo, useRef } from 'react';
import { View, Text, TextInput, StyleSheet, ScrollView, TouchableOpacity, Alert, ActivityIndicator } from 'react-native';
import Toast from 'react-native-toast-message';
import { TranscriptionResult, DuplicateMatch, DuplicateDecision, api } from '../services/api';
import { errorMessage, showApiError } from '../utils/errors';
import {
  confidenceColor,
  confirmSaveAsNew,
  topMatches,
} from '../utils/duplicateMatches';
import {
  coerceFieldData,
  coerceFieldValue,
  formatFieldValue,
  isEmptyValue,
  toggleMultiSelect,
  validateFieldValue,
  fieldLabel,
} from '../utils/fieldValues';
import { Category, categoryLabel } from '../utils/categoryPayload';
import {
  fieldKeyboardType,
  fieldPlaceholder,
  isEssentialCategory,
  isLongTextCategory,
  sortCategories,
} from '../utils/categoryDisplay';
import { MergeUI } from './MergeUI';
import { newRequestId } from '../utils/requestId';
import { isVersionConflict } from '../utils/saveConflict';
import { CategoryLoadError } from './CategoryLoadError';
import { useCategories } from '../contexts/CategoryContext';

interface TranscriptionResultsProps {
  result: TranscriptionResult;
  onSave: (data: Record<string, any>) => void;
  onCancel: () => void;
  location?: {
    latitude: number;
    longitude: number;
    address: string;
  } | null;
  // A draft's recording id (H2-7.7): a second save after a failed draft delete must
  // return the first save, not create a second person
  idempotencyKey?: string;
  // A draft reviewed later: its matches are stale, so Save always re-checks
  recheckDuplicates?: boolean;
}

// Same fields with the same values (key order ignored)
const sameFields = (a: Record<string, any>, b: Record<string, any>): boolean => {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length &&
    keys.every(k => k in b && JSON.stringify(a[k]) === JSON.stringify(b[k]));
};

export const TranscriptionResults: React.FC<TranscriptionResultsProps> = ({
  result,
  onSave,
  onCancel,
  location,
  idempotencyKey: givenKey,
  recheckDuplicates = false,
}) => {
  const [categorizedData, setCategorizedData] = useState<Record<string, any>>(result.categorized_data);
  const [showMergeUI, setShowMergeUI] = useState(false);
  const [selectedMatch, setSelectedMatch] = useState<DuplicateMatch | null>(null);
  // From CategoryContext, the app's one category load (H2-6.5). A failed load is
  // shown with Retry instead of a fieldless form (C-35).
  const { categories, isLoading, error: loadError, refreshCategories } = useCategories();
  // Per-field problems: the backend's validation_errors from /api/transcribe, then the
  // client-side checks on Save (C-16). Editing a field clears its message.
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>(() =>
    Object.fromEntries((result.validation_errors ?? []).map(e => [e.field, e.message]))
  );
  // The backend's reason when the save is rejected, shown in the form (C-16)
  const [saveError, setSaveError] = useState<string | null>(null);

  const handleFieldChange = (fieldName: string, value: any) => {
    setCategorizedData(prev => ({
      ...prev,
      [fieldName]: value,
    }));
    // Any edit makes the last save rejection stale
    setSaveError(null);
    if (fieldErrors[fieldName]) {
      setFieldErrors(prev => {
        const { [fieldName]: _cleared, ...rest } = prev;
        return rest;
      });
    }
  };

  const [isSaving, setIsSaving] = useState(false);
  // Blocks a second tap on Save that lands before the re-render disables it (C-13)
  const savingRef = useRef(false);
  // The matches listed under "Potential Matches": the server's at first, then
  // exactly the list the last Save decided on, so the screen never shows a match
  // that Save ignored
  const [shownMatches, setShownMatches] = useState<DuplicateMatch[]>(
    () => topMatches(result.potential_matches));

  // Real types (numbers, height in inches, matched labels, multi-select arrays) with
  // empty fields dropped, so nothing is saved or shown as "null" (C-09, C-14)
  const toFields = (fields: Record<string, any>) => coerceFieldData(fields, categories);
  // Stable across renders so MergeUI's initial selection is computed from one object
  const mergeNewData = useMemo(() => toFields(categorizedData), [categorizedData, categories]);

  // One Idempotency-Key for this review: every save attempt (new, merge, Create New)
  // sends it, so a retry after a lost response can't save the person twice (H2-2.4)
  const idempotencyKey = useRef(givenKey ?? newRequestId()).current;

  const save = (fields: Record<string, any>, mergeWithId?: string, expectedVersion?: number,
                decision?: DuplicateDecision) =>
    api.saveIndividual({
      data: toFields(fields),
      merge_with_id: mergeWithId ?? null,
      location: location ?? null,
      transcription: result.transcription,
      expected_version: expectedVersion ?? null,
      idempotency_key: idempotencyKey,
      duplicate_decision: decision ?? null,
    });

  const handleSave = async () => {
    if (isSaving || savingRef.current) return;
    setSaveError(null);
    
    // Validate required fields using categories
    const requiredFields = categories.filter(cat => cat.is_required).map(cat => cat.name);
    const missingFields = requiredFields.filter(field => isEmptyValue(categorizedData[field]));

    if (missingFields.length > 0) {
      Alert.alert(
        'Missing Required Fields',
        `Please fill in: ${missingFields.map(field => fieldLabel(field, categories)).join(', ')}`,
        [{ text: 'OK' }]
      );
      return;
    }

    // Same per-field checks as manual entry, shown next to each field (C-15, C-16)
    const invalid: Record<string, string> = {};
    categories.forEach(category => {
      const message = validateFieldValue(category, categorizedData[category.name]);
      if (message) invalid[category.name] = message;
    });
    if (Object.keys(invalid).length > 0) {
      // Add to the messages already shown: a backend message on a field the worker
      // hasn't touched still applies (editing a field clears its own message)
      setFieldErrors(prev => ({ ...invalid, ...prev }));
      Alert.alert('Validation Error', 'Please fix the errors before saving.');
      return;
    }

    savingRef.current = true;
    setIsSaving(true);

    try {
      // The server checked the fields it extracted. If the worker changed them
      // (a misheard name is the usual case), or the server's check failed, check
      // what will actually be saved (C-05, C-08). The re-check adds to the server's
      // matches, never replaces them: a match the worker has seen stays on offer.
      // Only real, live people count (no mock ids, no pending deletes).
      const fields = toFields(categorizedData);
      let matches = topMatches(result.potential_matches);
      if (recheckDuplicates || result.duplicate_check_failed || !sameFields(fields, toFields(result.categorized_data))) {
        try {
          matches = topMatches(await api.checkDuplicates(fields), result.potential_matches);
        } catch {
          // With a server match still on offer, decide on it; otherwise ask
          if (matches.length === 0 && !(await confirmSaveAsNew())) return;
        }
      }
      setShownMatches(matches);

      const bestMatch = matches[0] ?? null;   // topMatches is best first
      if (bestMatch) {
        setSelectedMatch(bestMatch);
        setShowMergeUI(true);
        return;
      }

      // No meaningful match (< 60% or no matches), save as new
      await save(categorizedData);
      Toast.show({
        type: 'success',
        text1: 'Success',
        text2: 'Data saved successfully!'
      });
      onSave(toFields(categorizedData));
    } catch (error: any) {
      setSaveError(errorMessage(error));
    } finally {
      savingRef.current = false;
      setIsSaving(false);
    }
  };

  const handleMerge = async (mergedData: Record<string, any>, mergeWithId: string, expectedVersion?: number) => {
    try {
      await save(mergedData, mergeWithId, expectedVersion,
        { matched_id: mergeWithId, confidence: selectedMatch?.confidence ?? 0, decision: 'merged' });
      Toast.show({
        type: 'success',
        text1: 'Success',
        text2: 'Data merged successfully!'
      });
      setShowMergeUI(false);
      setSelectedMatch(null);
      onSave(mergedData);
    } catch (error: any) {
      // MergeUI shows a version conflict and reloads the person (H2-2.3)
      if (isVersionConflict(error)) throw error;
      showApiError(error, 'Save failed');
    }
  };

  const handleCreateNew = async (data: Record<string, any>) => {
    try {
      // Create New on the merge screen: a "not the same person" label for the shown match (H2-3.6)
      await save(data, undefined, undefined, selectedMatch
        ? { matched_id: selectedMatch.id, confidence: selectedMatch.confidence, decision: 'saved_new' }
        : undefined);
      Toast.show({
        type: 'success',
        text1: 'Success',
        text2: 'New individual created successfully!'
      });
      setShowMergeUI(false);
      setSelectedMatch(null);
      onSave(data);
    } catch (error: any) {
      showApiError(error, 'Save failed');
    }
  };

  const handleMergeCancel = () => {
    setShowMergeUI(false);
    setSelectedMatch(null);
  };

  const isFieldRequired = (fieldName: string) => {
    return categories.some(cat => cat.name === fieldName && cat.is_required);
  };

  const isFieldMissing = (fieldName: string) => {
    return isFieldRequired(fieldName) && isEmptyValue(categorizedData[fieldName]);
  };

  // Only categories are rendered, so every field has its category
  const renderField = (category: Category) => {
    const fieldName = category.name;
    const value = categorizedData[fieldName];
    const isRequired = isFieldRequired(fieldName);
    const isMissing = isFieldMissing(fieldName);
    const fieldError = isMissing ? null : fieldErrors[fieldName];

    return (
      <View key={fieldName} style={styles.fieldContainer}>
        <Text style={[
          styles.fieldLabel,
          isRequired && styles.requiredLabel,
          (isMissing || !!fieldError) && styles.missingLabel
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
                      fieldName,
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
            (isMissing || !!fieldError) && styles.missingInput
          ]}
          value={typeof value === 'string' ? value : formatFieldValue(value) ?? ''}
          onChangeText={(text) => handleFieldChange(fieldName, text)}
          placeholder={fieldPlaceholder(category)}
          placeholderTextColor="#999"
          keyboardType={fieldKeyboardType(category)}
          multiline={isLongTextCategory(category)}
          numberOfLines={isLongTextCategory(category) ? 4 : 1}
        />

        {isMissing && (
          <Text style={styles.errorText}>This field is required</Text>
        )}
        {!!fieldError && (
          <Text style={styles.errorText}>{fieldError}</Text>
        )}
      </View>
    );
  };

  // Show MergeUI if there's a low confidence match
  if (showMergeUI && selectedMatch) {
    return (
      <MergeUI
        newData={mergeNewData}
        potentialMatch={selectedMatch}
        otherMatches={shownMatches.filter(m => m.id !== selectedMatch.id)}
        onSwitchMatch={setSelectedMatch}
        onMerge={handleMerge}
        onCreateNew={handleCreateNew}
        onCancel={handleMergeCancel}
        categories={categories}
      />
    );
  }

  if (isLoading) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color="#007AFF" />
        <Text style={styles.loadingText}>Loading form fields...</Text>
      </View>
    );
  }

  // What was said; selectable so it can be copied even while the fields won't load
  const transcriptionSection = (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>Transcription</Text>
      <View style={styles.transcriptionContainer}>
        <Text style={styles.transcriptionText} selectable>{result.transcription}</Text>
      </View>
    </View>
  );

  // No fields means no required-field check on Save, so never show a fieldless form
  if (categories.length === 0) {
    return (
      <View style={styles.container}>
        {transcriptionSection}
        <CategoryLoadError error={loadError} onRetry={refreshCategories} onCancel={onCancel} />
      </View>
    );
  }

  return (
    <ScrollView style={styles.container}>
      {transcriptionSection}

      {/* Categorized Data */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Categorized Information</Text>
        <Text style={styles.sectionSubtitle}>
          Review and edit the information extracted from your recording
        </Text>
        
        {/* Essential Information - Name, Height, Weight, Age (already in order) */}
        {(() => {
          const essentialCategories = categories.filter(isEssentialCategory);
          if (essentialCategories.length === 0) return null;
          return (
            <View style={styles.subsection}>
              <Text style={styles.subsectionTitle}>Essential Information</Text>
              {essentialCategories.map(renderField)}
            </View>
          );
        })()}

        {/* Other Information - All non-essential categories */}
        {(() => {
          const otherCategories = categories.filter(cat => !isEssentialCategory(cat));
          if (otherCategories.length === 0) return null;
          return (
            <View style={styles.subsection}>
              <Text style={styles.subsectionTitle}>Other Information</Text>
              {otherCategories.map(renderField)}
            </View>
          );
        })()}
      </View>

      {/* Potential Matches */}
      {(() => {
        // Exactly the list Save decides on (see shownMatches)
        const validMatches = shownMatches;

        return validMatches.length > 0 ? (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Potential Matches</Text>
            <Text style={styles.sectionSubtitle}>
              We found similar individuals in our database
            </Text>
            {validMatches.map((match, index) => {
              // Same colours as MergeUI (one helper, one meaning: C-62)
              const colours = confidenceColor(match.confidence);
              return (
            <View key={index} style={[
              styles.matchContainer,
              { backgroundColor: colours.background, borderLeftColor: colours.accent },
            ]}>
              <Text style={styles.matchName}>{match.name}</Text>
              <Text style={[styles.matchConfidence, { color: colours.text }]}>
                {match.confidence}% match
                {match.confidence >= 60 ? ' (Manual review)' : ' (Too low - no merge UI)'}
              </Text>
            </View>
              );
            })}
        </View>
        ) : null;
      })()}

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
  section: {
    padding: 20,
    borderBottomWidth: 1,
    borderBottomColor: '#e9ecef',
  },
  sectionTitle: {
    fontSize: 20,
    fontWeight: 'bold',
    color: '#333',
    marginBottom: 8,
  },
  subsection: {
    marginBottom: 20,
  },
  subsectionTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: '#555',
    marginBottom: 12,
    marginTop: 8,
  },
  sectionSubtitle: {
    fontSize: 14,
    color: '#666',
    marginBottom: 16,
  },
  transcriptionContainer: {
    backgroundColor: '#f8f9fa',
    padding: 16,
    borderRadius: 8,
    borderLeftWidth: 4,
    borderLeftColor: '#007AFF',
  },
  transcriptionText: {
    fontSize: 16,
    color: '#333',
    lineHeight: 24,
  },
  fieldContainer: {
    marginBottom: 16,
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
  missingLabel: {
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
  missingInput: {
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
  matchContainer: {
    backgroundColor: '#fff3cd',
    padding: 12,
    borderRadius: 8,
    marginBottom: 8,
    borderLeftWidth: 4,
    borderLeftColor: '#ffc107',
  },
  matchName: {
    fontSize: 16,
    fontWeight: '600',
    color: '#856404',
  },
  matchConfidence: {
    fontSize: 14,
    color: '#856404',
    marginTop: 4,
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
    backgroundColor: '#6c757d',
    opacity: 0.6,
  },
  saveButtonText: {
    color: 'white',
    fontSize: 16,
    fontWeight: '600',
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
    fontSize: 16,
  },
  presetOptionsContainer: {
    marginTop: 12,
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: '#f0f0f0',
    borderRadius: 6,
  },
  presetOptionsLabel: {
    fontSize: 14,
    fontWeight: '600',
    color: '#555',
    marginBottom: 8,
  },
  presetOptionsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  presetOptionButton: {
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 6,
    backgroundColor: '#e0e0e0',
    borderWidth: 1,
    borderColor: '#ccc',
  },
  presetOptionText: {
    fontSize: 14,
    color: '#333',
  },
}); 
