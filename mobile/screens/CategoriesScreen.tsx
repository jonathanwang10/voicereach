import React, { useState } from 'react';
import {
  buildCategoryPayload,
  categoryLabel,
  validateCategoryForm,
  CategoryType,
} from '../utils/categoryPayload';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  Alert,
  ActivityIndicator,
  TextInput,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { api } from '../services/api';
import { errorMessage } from '../utils/errorHandler';
import { shareCsvExport } from '../utils/csvExport';
import { useCategories } from '../contexts/CategoryContext';

// Categories are create-only (PRD): there is no edit, delete or on/off switch,
// because nothing on the server would honour it.
export default function CategoriesScreen() {
  const { categories, isLoading, error: loadError, refreshCategories } = useCategories();

  // "single_select" -> "Single Select" (for the type line)
  const formatTypeName = (type: string): string =>
    type
      .split('_')
      .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
      .join(' ');

  const [isExporting, setIsExporting] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [newCategoryName, setNewCategoryName] = useState('');
  const [newCategoryType, setNewCategoryType] = useState<CategoryType>('text');
  const [newCategoryPriority, setNewCategoryPriority] = useState<'high' | 'medium' | 'low'>('medium');
  const [newCategoryWeight, setNewCategoryWeight] = useState('');
  const [newCategoryAutoTrigger, setNewCategoryAutoTrigger] = useState(false);
  const [newCategoryOptionsText, setNewCategoryOptionsText] = useState('');

  const isSelectType = newCategoryType === 'single_select' || newCategoryType === 'multi_select';
  const isWeightedType = newCategoryType === 'number' || newCategoryType === 'single_select';

  // Writes the CSV to a cache file and opens the share sheet (R-9); the sheet is
  // the feedback, so success needs no alert.
  const handleExportCSV = async () => {
    try {
      setIsExporting(true);
      await shareCsvExport();
    } catch (error) {
      Alert.alert('Export Failed', errorMessage(error));
    } finally {
      setIsExporting(false);
    }
  };

  const addNewCategory = async () => {
    if (isCreating) return;
    const form = {
      name: newCategoryName,
      type: newCategoryType,
      priority: newCategoryPriority,
      optionsText: newCategoryOptionsText,
      weight: newCategoryWeight,
      autoTrigger: newCategoryAutoTrigger,
    };
    // Same rules as the backend's CreateCategoryRequest
    const problem = validateCategoryForm(form);
    if (problem) {
      Alert.alert('Error', problem);
      return;
    }

    try {
      setIsCreating(true);
      await api.createCategory(buildCategoryPayload(form));
      await refreshCategories();

      // Reset form
      setNewCategoryName('');
      setNewCategoryType('text');
      setNewCategoryPriority('medium');
      setNewCategoryWeight('');
      setNewCategoryAutoTrigger(false);
      setNewCategoryOptionsText('');

      Alert.alert('Success', 'Category created successfully!');
    } catch (error: any) {
      Alert.alert('Error', `Failed to create category: ${errorMessage(error)}`);
    } finally {
      setIsCreating(false);
    }
  };

  const getPriorityDistribution = () => {
    const high = categories.filter(cat => cat.priority === 'high').length;
    const medium = categories.filter(cat => cat.priority === 'medium').length;
    const low = categories.filter(cat => cat.priority === 'low').length;
    return { high, medium, low };
  };

  if (isLoading) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color="#007AFF" />
        <Text style={styles.loadingText}>Loading categories...</Text>
      </View>
    );
  }

  return (
    <ScrollView style={styles.container} keyboardShouldPersistTaps="handled">
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.title}>Categories</Text>
        <Text style={styles.subtitle}>
          Manage data collection fields and export data
        </Text>
      </View>

      {/* Export Section */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Data Export</Text>
        <TouchableOpacity 
          style={[styles.exportButton, isExporting && styles.exportButtonDisabled]}
          onPress={handleExportCSV}
          disabled={isExporting}
        >
          {isExporting ? (
            <ActivityIndicator size="small" color="#fff" />
          ) : (
            <Ionicons name="download" size={20} color="#fff" />
          )}
          <Text style={styles.exportButtonText}>
            {isExporting ? 'Exporting...' : 'Export CSV'}
          </Text>
        </TouchableOpacity>
        <Text style={styles.exportInfo}>
          Exports all individuals, one column for each of the {categories.length} categories
        </Text>
      </View>

      {/* Categories List */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Categories</Text>
        {/* A failed load says so with Retry, instead of "0 categories" all session (C-35) */}
        {loadError && (
          <View style={styles.loadError}>
            <Text style={styles.loadErrorTitle}>Couldn't load categories</Text>
            <Text style={styles.infoText}>{loadError}</Text>
            <TouchableOpacity style={[styles.addButton, styles.retryButton]} onPress={refreshCategories}>
              <Text style={styles.addButtonText}>Retry</Text>
            </TouchableOpacity>
          </View>
        )}
        {(categories.length > 0 || !loadError) && (() => {
          const priorityDist = getPriorityDistribution();
          return (
            <Text style={styles.categoryCount}>
              {categories.length} categories (High: {priorityDist.high}, Medium: {priorityDist.medium}, Low: {priorityDist.low})
            </Text>
          );
        })()}
        
        {categories.map(category => (
          <View key={category.id} style={styles.categoryItem}>
            <View style={styles.categoryInfo}>
              <Text style={styles.categoryName}>{categoryLabel(category)}</Text>
              <Text style={styles.categoryType}>{formatTypeName(category.type)}</Text>
              <Text style={styles.categoryPriority}>Priority: {category.priority}</Text>
              {category.is_required && (
                <Text style={styles.requiredBadge}>Required</Text>
              )}
              {(category.type === 'number' || category.type === 'single_select') && (category.urgency_weight ?? 0) > 0 && (
                <Text style={styles.dangerWeightBadge}>Weight: {category.urgency_weight}</Text>
              )}
            </View>
            {category.is_required && (
              <View style={styles.categoryActions}>
                <View style={[styles.toggleButton, styles.essentialToggleButton]}>
                  <Text style={[styles.toggleText, styles.essentialToggleText]}>
                    ESSENTIAL
                  </Text>
                </View>
              </View>
            )}
          </View>
        ))}
      </View>

      {/* Add New Category */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Add New Category</Text>
        
        <View style={styles.inputRow}>
          <TextInput
            style={styles.textInput}
            placeholder="Category name"
            value={newCategoryName}
            onChangeText={setNewCategoryName}
            maxLength={50}
          />
          <TouchableOpacity style={styles.typeButton} onPress={() => {
            const types: CategoryType[] = ['text', 'number', 'single_select', 'multi_select', 'date', 'location'];
            const currentIndex = types.indexOf(newCategoryType);
            const nextIndex = (currentIndex + 1) % types.length;
            setNewCategoryType(types[nextIndex]);
          }}>
            <Text style={styles.typeButtonText}>{newCategoryType.replace('_', '-')}</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.priorityButton} onPress={() => {
            const priorities: Array<'high' | 'medium' | 'low'> = ['high', 'medium', 'low'];
            const currentIndex = priorities.indexOf(newCategoryPriority);
            const nextIndex = (currentIndex + 1) % priorities.length;
            setNewCategoryPriority(priorities[nextIndex]);
          }}>
            <Text style={styles.priorityButtonText}>{newCategoryPriority}</Text>
          </TouchableOpacity>
        </View>

        {isSelectType && (
          <View style={styles.inputRow}>
            <TextInput
              style={styles.textInput}
              placeholder={newCategoryType === 'single_select'
                ? 'Options, comma-separated: Calm, Agitated=0.5 (value 0-1, default 0)'
                : 'Options, comma-separated: Dog, Cat'}
              value={newCategoryOptionsText}
              onChangeText={setNewCategoryOptionsText}
              autoCapitalize="none"
              multiline
            />
          </View>
        )}
        
        {isWeightedType && (
          <View style={styles.dangerWeightContainer}>
            <Text style={styles.dangerWeightLabel}>Urgency Weight (0-100)</Text>
            <TextInput
              style={styles.textInput}
              placeholder="0-100"
              value={newCategoryWeight}
              onChangeText={setNewCategoryWeight}
              keyboardType="numeric"
              maxLength={5}
            />
            <TouchableOpacity 
              style={[styles.autoTriggerButton, newCategoryAutoTrigger && styles.autoTriggerButtonActive]}
              onPress={() => setNewCategoryAutoTrigger(!newCategoryAutoTrigger)}
            >
              <Text style={styles.autoTriggerText}>
                Auto-Trigger Urgency: {newCategoryAutoTrigger ? 'ON' : 'OFF'}
              </Text>
            </TouchableOpacity>
          </View>
        )}
        
        <TouchableOpacity 
          style={[styles.addButton, isCreating && styles.exportButtonDisabled]}
          onPress={addNewCategory}
          disabled={isCreating}
        >
          <Ionicons name="add" size={20} color="#fff" />
          <Text style={styles.addButtonText}>Add Category</Text>
        </TouchableOpacity>
      </View>

      {/* Export Info */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Export Information</Text>
        <Text style={styles.infoText}>
          • CSV includes all individuals in the database{'\n'}
          • Every category is a column{'\n'}
          • Urgency score and Last Seen (latest interaction) included{'\n'}
          • Multi-select values are comma-separated{'\n'}
          • Opens the share sheet: you choose where the file goes{'\n'}
          • File is named with current date and time
        </Text>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F9FAFB',
  },
  header: {
    padding: 20,
    alignItems: 'center',
  },
  title: {
    fontSize: 28,
    fontWeight: 'bold',
    color: '#111827',
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 16,
    color: '#6B7280',
    textAlign: 'center',
  },
  section: {
    backgroundColor: '#fff',
    margin: 20,
    borderRadius: 12,
    padding: 20,
    shadowColor: '#000',
    shadowOffset: {
      width: 0,
      height: 1,
    },
    shadowOpacity: 0.1,
    shadowRadius: 2,
    elevation: 2,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: '#374151',
    marginBottom: 12,
  },
  exportButton: {
    backgroundColor: '#007AFF',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 16,
    borderRadius: 8,
    marginBottom: 8,
  },
  exportButtonDisabled: {
    backgroundColor: '#9CA3AF',
  },
  exportButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
    marginLeft: 8,
  },
  exportInfo: {
    fontSize: 14,
    color: '#6B7280',
    textAlign: 'center',
  },
  categoryCount: {
    fontSize: 14,
    color: '#6B7280',
    marginBottom: 16,
  },
  categoryItem: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#F3F4F6',
  },
  categoryInfo: {
    flex: 1,
  },
  categoryName: {
    fontSize: 16,
    fontWeight: '500',
    color: '#111827',
  },
  categoryType: {
    fontSize: 14,
    color: '#6B7280',
    marginTop: 2,
  },
  categoryPriority: {
    fontSize: 12,
    color: '#6B7280',
    marginTop: 2,
  },
  dangerWeightBadge: {
    fontSize: 10,
    color: '#DC2626',
    backgroundColor: '#FEE2E2',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    marginTop: 2,
  },
  requiredBadge: {
    fontSize: 12,
    color: '#EF4444',
    fontWeight: '500',
    marginTop: 4,
  },
  toggleButton: {
    backgroundColor: '#F3F4F6',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
  },
  essentialToggleButton: {
    backgroundColor: '#10B981',
  },
  toggleText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#6B7280',
  },
  essentialToggleText: {
    color: '#fff',
  },
  inputRow: {
    flexDirection: 'row',
    marginBottom: 16,
  },
  textInput: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#D1D5DB',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontSize: 16,
    color: '#111827',
    backgroundColor: '#fff',
    marginRight: 8,
  },
  typeButton: {
    backgroundColor: '#F3F4F6',
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 8,
    justifyContent: 'center',
  },
  typeButtonText: {
    fontSize: 14,
    fontWeight: '500',
    color: '#374151',
  },
  priorityButton: {
    backgroundColor: '#E5E7EB',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 6,
    marginLeft: 8,
  },
  priorityButtonText: {
    fontSize: 12,
    color: '#374151',
    fontWeight: '500',
  },
      dangerWeightContainer: {
    marginTop: 10,
    padding: 10,
    backgroundColor: '#F9FAFB',
    borderRadius: 8,
  },
      dangerWeightLabel: {
    fontSize: 14,
    fontWeight: '500',
    color: '#374151',
    marginBottom: 5,
  },
  autoTriggerButton: {
    marginTop: 10,
    padding: 8,
    backgroundColor: '#F3F4F6',
    borderRadius: 6,
    alignItems: 'center',
  },
  autoTriggerButtonActive: {
    backgroundColor: '#DC2626',
  },
  autoTriggerText: {
    fontSize: 12,
    color: '#374151',
  },
  addButton: {
    backgroundColor: '#10B981',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 12,
    borderRadius: 8,
  },
  addButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
    marginLeft: 8,
  },
  infoText: {
    fontSize: 14,
    color: '#6B7280',
    lineHeight: 20,
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
  categoryActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  loadError: {
    marginBottom: 16,
  },
  loadErrorTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: '#EF4444',
    marginBottom: 4,
  },
  retryButton: {
    marginTop: 12,
  },
}); 
