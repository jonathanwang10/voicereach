import React, { useState, useEffect } from 'react';
import { View, Text, TextInput, StyleSheet, ScrollView, TouchableOpacity, Alert, ActivityIndicator } from 'react-native';
import Toast from 'react-native-toast-message';
import { TranscriptionResult, api } from '../services/api';
import { parseHeightToInches } from '../utils/height';
import { MergeUI } from './MergeUI';

interface Category {
  id: string;
  name: string;
  type: string;
  is_required: boolean;
  options?: any;
  priority: string;
  urgency_weight: number;
  auto_trigger: boolean;
}

interface TranscriptionResultsProps {
  result: TranscriptionResult;
  onSave: (data: Record<string, any>) => void;
  onCancel: () => void;
  location?: {
    latitude: number;
    longitude: number;
    address: string;
  } | null;
}

export const TranscriptionResults: React.FC<TranscriptionResultsProps> = ({
  result,
  onSave,
  onCancel,
  location,
}) => {
  const [categorizedData, setCategorizedData] = useState<Record<string, any>>(result.categorized_data);
  const [isEditing, setIsEditing] = useState(false);
  const [showMergeUI, setShowMergeUI] = useState(false);
  const [selectedMatch, setSelectedMatch] = useState<{
    id: string;
    confidence: number;
    name: string;
  } | null>(null);
  const [categories, setCategories] = useState<Category[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  // Fetch categories from API on component mount
  useEffect(() => {
    fetchCategories();
  }, []);

  const fetchCategories = async () => {
    try {
      setIsLoading(true);
      const response = await api.getCategories();
      
      // Sort categories with essential categories first in specific order
      const sortedCategories = (response || []).sort((a, b) => {
        // Define essential categories order: Name, Height, Weight, Age
        const essentialOrder = ['name', 'height', 'weight', 'age'];
        const aIndex = essentialOrder.indexOf(a.name.toLowerCase());
        const bIndex = essentialOrder.indexOf(b.name.toLowerCase());
        
        // If both are essential categories, sort by their defined order
        if (aIndex !== -1 && bIndex !== -1) {
          return aIndex - bIndex;
        }
        
        // Essential categories always come first
        if (aIndex !== -1) return -1;
        if (bIndex !== -1) return 1;
        
        // For non-essential categories, sort by priority then alphabetically
        const priorityOrder: Record<string, number> = { high: 3, medium: 2, low: 1 };
        const priorityDiff = (priorityOrder[b.priority] || 0) - (priorityOrder[a.priority] || 0);
        if (priorityDiff !== 0) return priorityDiff;
        
        // Finally sort alphabetically by name
        return a.name.localeCompare(b.name);
      });
      
      setCategories(sortedCategories);
    } catch (error: any) {
      console.error('Failed to fetch categories:', error);
      Alert.alert('Error', 'Failed to load form fields. Please try again.');
    } finally {
      setIsLoading(false);
    }
  };

  // Helper to format a category name for display
  const formatCategoryName = (name: string) => {
    return name
      .split('_')
      .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
      .join(' ');
  };

  const handleFieldChange = (fieldName: string, value: any) => {
    setCategorizedData(prev => ({
      ...prev,
      [fieldName]: value,
    }));
  };

  const [isSaving, setIsSaving] = useState(false);

  const toSavePayload = (fields: Record<string, any>) => {
    const payload: Record<string, any> = { ...fields, transcription: result.transcription };
    if (location) payload.location = location;
    const heightKey = Object.keys(payload).find(k => k.trim().toLowerCase() === 'height');
    if (heightKey && payload[heightKey] !== '' && payload[heightKey] != null) {
      const inches = parseHeightToInches(payload[heightKey]);
      if (inches !== null) payload[heightKey] = inches;
    }
    return payload;
  };

  const handleSave = async () => {
    if (isSaving) return;
    
    // Validate required fields using categories
    const requiredFields = categories.filter(cat => cat.is_required).map(cat => cat.name);
    const missingFields = requiredFields.filter(field => 
      !categorizedData[field] || categorizedData[field] === ''
    );

    if (missingFields.length > 0) {
      Alert.alert(
        'Missing Required Fields',
        `Please fill in: ${missingFields.join(', ')}`,
        [{ text: 'OK' }]
      );
      return;
    }

    setIsSaving(true);

    try {
      // Filter out invalid/mock IDs from potential matches
      const validMatches = result.potential_matches?.filter(match => {
        const isValidUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(match.id);
        if (!isValidUUID) {
          console.warn('⚠️ Filtering out invalid ID from potential matches:', match.id);
        }
        return isValidUUID;
      }) || [];

      if (validMatches.length > 0) {
        // Show merge UI for any match found
        const bestMatch = validMatches.reduce((best, current) => 
          current.confidence > best.confidence ? current : best
        );
        
        console.log('🎤 Voice Transcription - Showing merge UI for:', bestMatch.name, `(${bestMatch.confidence}%)`);
        setSelectedMatch(bestMatch);
        setShowMergeUI(true);
        setIsSaving(false);
        return;
      }

      // No meaningful match (< 60% or no matches), save as new
      console.log('🎤 Voice Transcription - No matches found, saving as new individual');
      const saveData = toSavePayload(categorizedData);
      await api.saveIndividual(saveData);
      Toast.show({
        type: 'success',
        text1: 'Success',
        text2: 'Data saved successfully!'
      });
      onSave(saveData);
    } catch (error: any) {
      Alert.alert('Error', error.message || 'An error occurred');
    } finally {
      setIsSaving(false);
    }
  };

  const handleMerge = async (mergedData: Record<string, any>) => {
    try {
      const saveData = toSavePayload(mergedData);
      await api.saveIndividual(saveData);
      Toast.show({
        type: 'success',
        text1: 'Success',
        text2: 'Data merged successfully!'
      });
      setShowMergeUI(false);
      setSelectedMatch(null);
      onSave(mergedData);
    } catch (error: any) {
      Toast.show({
        type: 'error',
        text1: 'Error',
        text2: error.message || 'An error occurred'
      });
    }
  };

  const handleCreateNew = async (data: Record<string, any>) => {
    try {
      const saveData = toSavePayload(data);
      await api.saveIndividual(saveData);
      Toast.show({
        type: 'success',
        text1: 'Success',
        text2: 'New individual created successfully!'
      });
      setShowMergeUI(false);
      setSelectedMatch(null);
      onSave(data);
    } catch (error: any) {
      Toast.show({
        type: 'error',
        text1: 'Error',
        text2: error.message || 'An error occurred'
      });
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
    return isFieldRequired(fieldName) && (!categorizedData[fieldName] || categorizedData[fieldName] === '');
  };

  const renderField = (fieldName: string, value: any) => {
    const category = categories.find(cat => cat.name === fieldName);
    if (!category) {
      // For backward compatibility, render unknown fields as text inputs
      return (
        <View key={fieldName} style={styles.fieldContainer}>
          <Text style={styles.fieldLabel}>
            {formatCategoryName(fieldName)}
          </Text>
          <TextInput
            style={styles.fieldInput}
            value={String(value || '')}
            onChangeText={(text) => handleFieldChange(fieldName, text)}
            placeholder={
              fieldName.toLowerCase().includes('additional information')
                ? "Enter any other relevant information not covered by other categories..."
                : `Enter ${formatCategoryName(fieldName).toLowerCase()}`
            }
            placeholderTextColor="#999"
          />
        </View>
      );
    }
    
    const isRequired = isFieldRequired(fieldName);
    const isMissing = isFieldMissing(fieldName);

    return (
      <View key={fieldName} style={styles.fieldContainer}>
        <Text style={[
          styles.fieldLabel,
          isRequired && styles.requiredLabel,
          isMissing && styles.missingLabel
        ]}>
          {formatCategoryName(fieldName)}
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
                    onPress={() => handleFieldChange(fieldName, optionLabel)}
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
            isMissing && styles.missingInput
          ]}
          value={String(value || '')}
          onChangeText={(text) => handleFieldChange(fieldName, text)}
          placeholder={
            fieldName.trim().toLowerCase() === 'height' 
              ? "Enter height (e.g., 5'10 or 70)" 
              : fieldName.toLowerCase().includes('additional information')
                ? "Enter any other relevant information not covered by other categories..."
                : `Enter ${formatCategoryName(fieldName).toLowerCase()}`
          }
          placeholderTextColor="#999"
          keyboardType={category.type === 'number' && fieldName.trim().toLowerCase() !== 'height' ? 'numeric' : 'default'}
          multiline={category.type === 'text' && (fieldName.toLowerCase().includes('notes') || fieldName.toLowerCase().includes('additional information'))}
          numberOfLines={category.type === 'text' && (fieldName.toLowerCase().includes('notes') || fieldName.toLowerCase().includes('additional information')) ? 4 : 1}
        />

        {isMissing && (
          <Text style={styles.errorText}>This field is required</Text>
        )}
      </View>
    );
  };

  // Show MergeUI if there's a low confidence match
  if (showMergeUI && selectedMatch) {
    console.log('🔄 Opening MergeUI with:', {
      newData: categorizedData,
      selectedMatch: selectedMatch,
      categorizedDataKeys: Object.keys(categorizedData)
    });
    
    return (
      <MergeUI
        newData={categorizedData}
        potentialMatch={selectedMatch}
        onMerge={handleMerge}
        onCreateNew={handleCreateNew}
        onCancel={handleMergeCancel}
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

  return (
    <ScrollView style={styles.container}>
      {/* Transcription Text */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Transcription</Text>
        <View style={styles.transcriptionContainer}>
          <Text style={styles.transcriptionText}>{result.transcription}</Text>
        </View>
      </View>

      {/* Categorized Data */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Categorized Information</Text>
        <Text style={styles.sectionSubtitle}>
          Review and edit the information extracted from your recording
        </Text>
        
        {/* Essential Information - Name, Height, Weight, Age */}
        {(() => {
          const essentialNames = ['name', 'height', 'weight', 'age'];
          const essentialCategories = categories.filter(cat => 
            essentialNames.includes(cat.name.toLowerCase())
          ).sort((a, b) => {
            const aIndex = essentialNames.indexOf(a.name.toLowerCase());
            const bIndex = essentialNames.indexOf(b.name.toLowerCase());
            return aIndex - bIndex;
          });
          
          if (essentialCategories.length === 0) return null;
          return (
            <View style={styles.subsection}>
              <Text style={styles.subsectionTitle}>Essential Information</Text>
              {essentialCategories
                .map(category => renderField(category.name, categorizedData[category.name] || ''))
                .filter(Boolean)}
            </View>
          );
        })()}

        {/* Other Information - All non-essential categories */}
        {(() => {
          const essentialNames = ['name', 'height', 'weight', 'age'];
          const otherCategories = categories.filter(cat => 
            !essentialNames.includes(cat.name.toLowerCase())
          );
          
          if (otherCategories.length === 0) return null;
          return (
            <View style={styles.subsection}>
              <Text style={styles.subsectionTitle}>Other Information</Text>
              {otherCategories
                .map(category => renderField(category.name, categorizedData[category.name] || ''))
                .filter(Boolean)}
            </View>
          );
        })()}
      </View>

      {/* Potential Matches */}
      {(() => {
        // Filter out invalid/mock IDs for display
        const validMatches = result.potential_matches?.filter(match => {
          const isValidUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(match.id);
          return isValidUUID;
        }) || [];

        return validMatches.length > 0 ? (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Potential Matches</Text>
            <Text style={styles.sectionSubtitle}>
              We found similar individuals in our database
            </Text>
            {validMatches.map((match, index) => (
            <View key={index} style={[
              styles.matchContainer,
              match.confidence >= 95 && styles.highConfidenceMatch,
              match.confidence >= 60 && match.confidence < 95 && styles.mediumConfidenceMatch,
              match.confidence < 60 && styles.lowConfidenceMatch
            ]}>
              <Text style={styles.matchName}>{match.name}</Text>
              <Text style={[
                styles.matchConfidence,
                match.confidence >= 95 && styles.highConfidenceText,
                match.confidence >= 60 && match.confidence < 95 && styles.mediumConfidenceText,
                match.confidence < 60 && styles.lowConfidenceText
              ]}>
                {match.confidence}% match
                {match.confidence >= 95 ? ' (Streamlined confirmation)' : 
                 match.confidence >= 60 ? ' (Manual review)' : 
                 ' (Too low - no merge UI)'}
              </Text>
            </View>
          ))}
        </View>
        ) : null;
      })()}

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
  highConfidenceMatch: {
    backgroundColor: '#d4edda',
    borderLeftColor: '#28a745',
  },
  mediumConfidenceMatch: {
    backgroundColor: '#fff3cd',
    borderLeftColor: '#ffc107',
  },
  lowConfidenceMatch: {
    backgroundColor: '#f8d7da',
    borderLeftColor: '#dc3545',
  },
  highConfidenceText: {
    color: '#155724',
  },
  mediumConfidenceText: {
    color: '#856404',
  },
  lowConfidenceText: {
    color: '#721c24',
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
  selectContainer: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 8,
  },
  selectOption: {
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 6,
  },
  selectedOption: {
    backgroundColor: '#e0e0e0',
    borderColor: '#007AFF',
    borderWidth: 1,
  },
  selectOptionText: {
    fontSize: 16,
    color: '#333',
  },
  selectedOptionText: {
    color: '#007AFF',
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
