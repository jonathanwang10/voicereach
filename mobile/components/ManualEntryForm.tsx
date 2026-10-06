import React, { useState, useEffect } from 'react';
import { View, Text, TextInput, StyleSheet, ScrollView, TouchableOpacity, Alert, ActivityIndicator } from 'react-native';
import Toast from 'react-native-toast-message';
import { api } from '../services/api';
import { parseHeightToInches } from '../utils/height';
import { MergeUI } from './MergeUI';

interface Category {
  id: string;
  name: string;
  type: string;
  is_required: boolean;
  options?: any;
  priority: string;
  danger_weight: number;
  auto_trigger: boolean;
}

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
  const [formData, setFormData] = useState<Record<string, any>>({
    name: '',
    height: '',
    weight: '',
    gender: '',
    substance_abuse_history: '',
    age: '',
    location: '',
    notes: '',
  });

  const [errors, setErrors] = useState<Record<string, string>>({});
  const [categories, setCategories] = useState<Category[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [showMergeUI, setShowMergeUI] = useState(false);
  const [pendingData, setPendingData] = useState<Record<string, any>>({});
  const [selectedMatch, setSelectedMatch] = useState<{
    id: string;
    confidence: number;
    name: string;
  } | null>(null);

  // Fetch categories from API on component mount
  useEffect(() => {
    fetchCategories();
  }, []);

  const fetchCategories = async () => {
    try {
      setIsLoading(true);
      const response = await api.getCategories();
      console.log('📋 Manual Entry - Fetched categories:', response);
      console.log('📋 Manual Entry - Categories count:', response?.length || 0);
      
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
      console.log('📋 Manual Entry - Sorted categories:', sortedCategories?.map(c => c.name) || []);
      
      // Initialize form data with empty values for all categories
      const initialData: Record<string, any> = {};
      sortedCategories?.forEach((cat: Category) => {
        initialData[cat.name] = '';
      });
      setFormData(initialData);
      console.log('📋 Manual Entry - Initial form data keys:', Object.keys(initialData));
      
    } catch (error) {
      console.error('Failed to fetch categories:', error);
      Alert.alert('Error', 'Failed to load form fields. Please try again.');
    } finally {
      setIsLoading(false);
    }
  };

  // Parse height strings like 5'10, 5 ft 10 in, 70, 70in, 1.78m (optional) into inches
  // height utils moved to ../utils/height

  // Helper to format a category name for display
  const prettyLabel = (name: string) => {
    return name
      .split('_')
      .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
      .join(' ');
  };

  // Helper to normalize category names for comparison
  const normalizeKey = (name: string) => name.trim().toLowerCase().replace(/\s+|_/g, '');

  const handleFieldChange = (fieldName: string, value: string | string[]) => {
    setFormData(prev => ({
      ...prev,
      [fieldName]: value,
    }));

    // Clear error when user starts typing
    if (errors[fieldName]) {
      setErrors(prev => ({
        ...prev,
        [fieldName]: '',
      }));
    }
  };

  const validateField = (category: Category, value: any): string => {
    const label = prettyLabel(category.name);
    
    // Debug logging for name field specifically
    if (category.name.toLowerCase() === 'name') {
      console.log(`📋 Manual Entry - Validating Name field:`, {
        categoryName: category.name,
        isRequired: category.is_required,
        value: value,
        valueType: typeof value,
        valueLength: value?.length,
        isEmpty: (value === undefined || value === null || value === '')
      });
    }
    
    // Required check based on category config
    if (category.is_required && (value === undefined || value === null || value === '')) {
      console.log(`📋 Manual Entry - Field ${category.name} failed required validation`);
      return `${label} is required`;
    }

    // Number validation (with special handling for height)
    if (category.type === 'number' && value !== undefined && value !== null && value !== '') {
      const key = category.name.trim().toLowerCase();
      let numValue: number;
      if (key === 'height') {
        const parsed = parseHeightToInches(value);
        if (parsed === null) {
          return `${label} must be in inches or x'y format`;
        }
        numValue = parsed;
      } else {
        numValue = Number(value);
      }
      if (Number.isNaN(numValue) || numValue < 0) {
        return `${label} must be a positive number`;
      }
      if ((key === 'height' || key === 'weight') && numValue > 300) {
        return `${label} must be 300 or less`;
      }
      if (key === 'age' && numValue > 120) {
        return `${label} must be 120 or less`;
      }
    }

    // Select validation
    if (category.type === 'select' && Array.isArray(category.options) && value) {
      if (!category.options.includes(value)) {
        return `Please select a valid ${label.toLowerCase()}`;
      }
    }

    return '';
  };

  const validateForm = (): boolean => {
    const newErrors: Record<string, string> = {};
    let isValid = true;

    // Validate all fields
    categories.forEach(category => {
      const error = validateField(category, formData[category.name]);
      if (error) {
        newErrors[category.name] = error;
        isValid = false;
      }
    });

    setErrors(newErrors);
    return isValid;
  };

  const handleSave = async () => {
    if (isSaving) return;
    
    console.log('📋 Manual Entry - Starting save process...');
    console.log('📋 Manual Entry - Current form data:', formData);
    
    const validationResult = validateForm();
    console.log('📋 Manual Entry - Validation result:', validationResult);
    console.log('📋 Manual Entry - Current errors:', errors);
    
    if (validationResult) {
      setIsSaving(true);
      
      try {
        console.log('📋 Manual Entry - Form data before cleaning:', formData);
        console.log('📋 Manual Entry - Form data keys:', Object.keys(formData));
        console.log('📋 Manual Entry - Name value in formData:', JSON.stringify(formData.Name));
        console.log('📋 Manual Entry - Name type:', typeof formData.Name);
        console.log('📋 Manual Entry - Name length:', formData.Name?.length);
        
        // Name field debug confirmed working - formData.Name contains the correct value
        
        // Convert empty strings to null for optional fields, but keep essential fields as empty strings
        const essentialFields = ['Name', 'Height', 'Weight', 'Age'];
        const cleanData = Object.keys(formData).reduce((acc, key) => {
          if (essentialFields.includes(key)) {
            // Keep essential fields even if empty (don't convert to null)
            acc[key] = formData[key] || '';
          } else {
            // Convert empty strings to null for optional fields
            acc[key] = formData[key] === '' ? null : formData[key];
          }
          return acc;
        }, {} as Record<string, any>);
        
        console.log('📋 Manual Entry - Clean data after processing:', cleanData);

        // Convert height to inches (number) for backend validation
        const heightKey = Object.keys(cleanData).find(k => k.trim().toLowerCase() === 'height');
        if (heightKey && cleanData[heightKey] !== undefined && cleanData[heightKey] !== null && cleanData[heightKey] !== '') {
          const heightInInches = parseHeightToInches(cleanData[heightKey]);
          if (heightInInches !== null) {
            cleanData[heightKey] = heightInInches; // Send as number, not string
          }
        }

        // Add location data if available
        if (selectedLocation) {
          cleanData.location = {
            latitude: selectedLocation.latitude,
            longitude: selectedLocation.longitude,
            address: selectedLocation.address || 'Unknown Address',
          };
        }

        console.log('📋 Manual Entry - Final clean data being sent to API:', cleanData);
        console.log('📋 Manual Entry - Data keys:', Object.keys(cleanData));
        console.log('📋 Manual Entry - Name field value:', cleanData.Name || cleanData.name);
        console.log('📋 Manual Entry - Location data:', cleanData.location);

        // Check for potential duplicates using sophisticated matching
        console.log('📋 Manual Entry - Checking for duplicates...');
        const potentialMatches = await api.checkDuplicates(cleanData);
        console.log('📋 Manual Entry - Found', potentialMatches.length, 'potential matches');
        
        if (potentialMatches.length > 0) {
          console.log('📋 Manual Entry - Matches:', potentialMatches.map(m => `${m.name} (${m.confidence}%)`));
        }
        
        // Filter out invalid/mock IDs from potential matches
        const validMatches = potentialMatches.filter(match => {
          const isValidUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(match.id);
          if (!isValidUUID) {
            console.warn('⚠️ Filtering out invalid ID from potential matches:', match.id);
          }
          return isValidUUID;
        });
        
        if (validMatches.length > 0) {
          // Show merge UI for any match found
          const bestMatch = validMatches.reduce((best, current) => 
            current.confidence > best.confidence ? current : best
          );
          
          console.log('📋 Manual Entry - Showing merge UI for:', bestMatch.name, `(${bestMatch.confidence}%)`);
          setSelectedMatch(bestMatch);
          setPendingData(cleanData);
          setShowMergeUI(true);
          setIsSaving(false);
          return;
        }

        // No meaningful match, save as new
        console.log('📋 Manual Entry - No duplicates detected, saving individual...');
        const saveResult = await api.saveIndividual(cleanData);
        console.log('📋 Manual Entry - Save result:', saveResult);
        Toast.show({
          type: 'success',
          text1: 'Success',
          text2: 'Data saved successfully!'
        });
        onSave(cleanData);
        
      } catch (error: any) {
        Alert.alert('Error', error.message || 'An error occurred');
      } finally {
        setIsSaving(false);
      }
    } else {
      Alert.alert('Validation Error', 'Please fix the errors before saving.');
    }
  };


  const withLocation = (data: Record<string, any>) => {
    if (data.location || !selectedLocation) return data;
    return {
      ...data,
      location: {
        latitude: selectedLocation.latitude,
        longitude: selectedLocation.longitude,
        address: selectedLocation.address || 'Unknown Address',
      },
    };
  };

  const handleMerge = async (mergedData: Record<string, any>) => {
    try {
      await api.saveIndividual(withLocation(mergedData));
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
      await api.saveIndividual(withLocation(data));
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
          {prettyLabel(category.name)}
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
                    onPress={() => handleFieldChange(category.name, optionLabel)}
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
          value={String(value || '')}
          onChangeText={(text) => handleFieldChange(category.name, text)}
          placeholder={
            category.name.trim().toLowerCase() === 'height' 
              ? "Enter height (e.g., 5'10 or 70)" 
              : category.name.toLowerCase().includes('additional information')
                ? "Enter any other relevant information not covered by other categories..."
                : `Enter ${category.name.toLowerCase()}`
          }
          placeholderTextColor="#999"
          keyboardType={category.type === 'number' && category.name.trim().toLowerCase() !== 'height' ? 'numeric' : 'default'}
          multiline={category.type === 'text' && (category.name.toLowerCase().includes('notes') || category.name.toLowerCase().includes('additional information'))}
          numberOfLines={category.type === 'text' && (category.name.toLowerCase().includes('notes') || category.name.toLowerCase().includes('additional information')) ? 4 : 1}
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
    return (
      <View style={styles.errorContainer}>
        <Text style={styles.errorTitle}>No Categories Found</Text>
        <Text style={styles.errorText}>
          No form fields are configured. Please contact an administrator.
        </Text>
        <TouchableOpacity style={styles.retryButton} onPress={fetchCategories}>
          <Text style={styles.retryButtonText}>Retry</Text>
        </TouchableOpacity>
      </View>
    );
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
          const essentialNames = ['name', 'height', 'weight', 'age'];
          const otherCategories = categories.filter(cat => 
            !essentialNames.includes(cat.name.toLowerCase())
          );
          
          if (otherCategories.length === 0) return null;
          return (
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Other Information</Text>
              {otherCategories.map(category => renderField(category))}
            </View>
          );
        })()}
      </View>

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
  selectContainer: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  selectOption: {
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 8,
    paddingHorizontal: 16,
    paddingVertical: 8,
    backgroundColor: '#fff',
  },
  selectedOption: {
    borderColor: '#007AFF',
    backgroundColor: '#007AFF',
  },
  selectOptionText: {
    fontSize: 14,
    color: '#333',
  },
  selectedOptionText: {
    color: '#fff',
    fontWeight: '600',
  },
  errorText: {
    color: '#dc3545',
    fontSize: 12,
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
