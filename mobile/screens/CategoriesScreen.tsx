import React, { useState, useEffect } from 'react';
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
import { useCategories } from '../contexts/CategoryContext';

interface Category {
  id: string;
  name: string;
  type: 'text' | 'number' | 'single_select' | 'multi_select' | 'date' | 'location';
  is_required: boolean;
  priority: 'high' | 'medium' | 'low';
  urgency_weight?: number; // 0-100, only for number/single_select
  auto_trigger?: boolean; // only for number/single_select
  options?: string[] | Array<{label: string, value: number}>;
  active?: boolean; // For local UI state, not from API
}

export default function CategoriesScreen() {
  const { categories, isLoading, toggleCategoryActive, refreshCategories, updateCategoryLocal } = useCategories();



  // Helper function to format category names for display
  const formatCategoryName = (name: string): string => {
    return name
      .split('_')
      .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
      .join(' ');
  };

  // Helper function to check if a category is essential (cannot be toggled off)
  const isEssentialCategory = (categoryName: string): boolean => {
    const essentialCategories = ['name', 'height', 'weight', 'age'];
    return essentialCategories.includes(categoryName.toLowerCase());
  };

  // Helper function to check if a category can be edited
  const isEditableCategory = (categoryName: string): boolean => {
    const nonEditableCategories = ['name', 'height', 'weight', 'age', 'additional information'];
    return !nonEditableCategories.includes(categoryName.toLowerCase());
  };

  const [isExporting, setIsExporting] = useState(false);
  const [newCategoryName, setNewCategoryName] = useState('');
  const [newCategoryType, setNewCategoryType] = useState<'text' | 'number' | 'single_select' | 'multi_select' | 'date' | 'location'>('text');
  const [newCategoryPriority, setNewCategoryPriority] = useState<'high' | 'medium' | 'low'>('medium');
  const [newCategoryDangerWeight, setNewCategoryDangerWeight] = useState(0);
  const [newCategoryAutoTrigger, setNewCategoryAutoTrigger] = useState(false);
  const [newCategoryOptions, setNewCategoryOptions] = useState<string[]>([]);
  
  // Edit category state
  const [editingCategoryId, setEditingCategoryId] = useState<string | null>(null);
  const [editCategoryName, setEditCategoryName] = useState('');
  const [editCategoryPriority, setEditCategoryPriority] = useState<'high' | 'medium' | 'low'>('medium');

  const handleExportCSV = async () => {
    try {
      setIsExporting(true);
      
      // Use real API to export CSV
      const csvUrl = await api.exportCSV();
      
      Alert.alert(
        'Export Successful',
        'CSV file has been generated and is ready for download.',
        [
          {
            text: 'Download',
            onPress: () => {
              // In a real app, you would trigger a download here
              console.log('CSV Export completed:', csvUrl);
            }
          },
          {
            text: 'OK',
            style: 'cancel'
          }
        ]
      );
      
    } catch (error) {
      console.error('Export error:', error);
      Alert.alert('Export Failed', 'Failed to export CSV. Please try again.');
    } finally {
      setIsExporting(false);
    }
  };

  const validateNewCategory = () => {
    if (!newCategoryName.trim()) {
      Alert.alert('Error', 'Category name is required');
      return false;
    }

    if (newCategoryType === 'single_select' && (!newCategoryOptions || newCategoryOptions.length === 0)) {
      Alert.alert('Error', 'Single-select categories require options');
      return false;
    }

    if (newCategoryType === 'multi_select' && (!newCategoryOptions || newCategoryOptions.length === 0)) {
      Alert.alert('Error', 'Multi-select categories require options');
      return false;
    }

    return true;
  };

  const addNewCategory = async () => {
    if (!validateNewCategory()) return;

    try {
      // Prepare category data for API
      const categoryData = {
        name: newCategoryName.trim(),
        type: newCategoryType,
        is_required: false,
        priority: newCategoryPriority,
        // Temporarily comment out fields that might not exist in database
        // urgency_weight: (newCategoryType === 'number' || newCategoryType === 'single_select') ? newCategoryDangerWeight : 0,
        // auto_trigger: (newCategoryType === 'number' || newCategoryType === 'single_select') ? newCategoryAutoTrigger : false,
        options: (newCategoryType === 'single_select' || newCategoryType === 'multi_select') ? newCategoryOptions : null,
      };

      console.log('📋 Creating new category:', categoryData);

      // Save to database via API
      const response = await api.createCategory(categoryData);
      console.log('📋 Category created successfully:', response);

      // Refresh categories from context
      await refreshCategories();
      
      // Reset form
      setNewCategoryName('');
      setNewCategoryType('text');
      setNewCategoryPriority('medium');
      setNewCategoryDangerWeight(0);
      setNewCategoryAutoTrigger(false);
      setNewCategoryOptions([]);

      Alert.alert('Success', 'Category created successfully!');
      
      // Optionally refresh the categories list to ensure consistency
      // fetchCategories();
    } catch (error: any) {
      console.error('❌ Failed to create category:', error);
      Alert.alert(
        'Error', 
        `Failed to create category: ${error.message || 'Unknown error'}`
      );
    }
  };

  const getActiveCategoriesCount = () => {
    return categories.filter(cat => cat.active).length;
  };

  const getPriorityDistribution = () => {
    const active = categories.filter(cat => cat.active);
    const high = active.filter(cat => cat.priority === 'high').length;
    const medium = active.filter(cat => cat.priority === 'medium').length;
    const low = active.filter(cat => cat.priority === 'low').length;
    return { high, medium, low };
  };

  const startEditCategory = (category: Category) => {
    setEditingCategoryId(category.id);
    setEditCategoryName(category.name);
    setEditCategoryPriority(category.priority);
  };

  const cancelEditCategory = () => {
    setEditingCategoryId(null);
    setEditCategoryName('');
    setEditCategoryPriority('medium');
  };

  const saveEditCategory = () => {
    if (!editCategoryName.trim()) {
      Alert.alert('Error', 'Category name cannot be empty');
      return;
    }

    // Check for duplicate names (excluding the current category being edited)
    const duplicateExists = categories.some(cat => 
      cat.id !== editingCategoryId && 
      cat.name.toLowerCase() === editCategoryName.trim().toLowerCase()
    );

    if (duplicateExists) {
      Alert.alert('Error', 'A category with this name already exists');
      return;
    }

    updateCategoryLocal(editingCategoryId!, { name: editCategoryName.trim(), priority: editCategoryPriority });

    Alert.alert('Success', 'Category updated successfully');
    cancelEditCategory();
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
    <ScrollView style={styles.container}>
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
          Exports all individuals with {getActiveCategoriesCount()} active categories
        </Text>
      </View>

      {/* Categories List */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Active Categories</Text>
        {(() => {
          const priorityDist = getPriorityDistribution();
          return (
            <Text style={styles.categoryCount}>
              {getActiveCategoriesCount()} active categories (High: {priorityDist.high}, Medium: {priorityDist.medium}, Low: {priorityDist.low})
            </Text>
          );
        })()}
        
        {categories.map(category => (
          <View key={category.id} style={styles.categoryItem}>
            {editingCategoryId === category.id ? (
              // Edit mode
              <View style={styles.editCategoryContainer}>
                <View style={styles.editInputRow}>
                  <Text style={styles.editLabel}>Name:</Text>
                  <TextInput
                    style={styles.editInput}
                    value={editCategoryName}
                    onChangeText={setEditCategoryName}
                    placeholder="Category name"
                  />
                </View>
                <View style={styles.editInputRow}>
                  <Text style={styles.editLabel}>Priority:</Text>
                  <View style={styles.prioritySelector}>
                    {['high', 'medium', 'low'].map((priority) => (
                      <TouchableOpacity
                        key={priority}
                        style={[
                          styles.priorityOption,
                          editCategoryPriority === priority && styles.priorityOptionSelected
                        ]}
                        onPress={() => setEditCategoryPriority(priority as 'high' | 'medium' | 'low')}
                      >
                        <Text style={[
                          styles.priorityOptionText,
                          editCategoryPriority === priority && styles.priorityOptionTextSelected
                        ]}>
                          {priority}
                        </Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                </View>
                <View style={styles.editButtonRow}>
                  <TouchableOpacity
                    style={styles.cancelEditButton}
                    onPress={cancelEditCategory}
                  >
                    <Text style={styles.cancelEditButtonText}>Cancel</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.saveEditButton}
                    onPress={saveEditCategory}
                  >
                    <Text style={styles.saveEditButtonText}>Save</Text>
                  </TouchableOpacity>
                </View>
              </View>
            ) : (
              // View mode
              <>
                <View style={styles.categoryInfo}>
                  <Text style={styles.categoryName}>{formatCategoryName(category.name)}</Text>
                  <Text style={styles.categoryType}>{formatCategoryName(category.type)}</Text>
                  <Text style={styles.categoryPriority}>Priority: {category.priority}</Text>
                  {category.is_required && (
                    <Text style={styles.requiredBadge}>Required</Text>
                  )}
                  {(category.type === 'number' || category.type === 'single_select') && category.urgency_weight !== undefined && (
                    <Text style={styles.dangerWeightBadge}>Weight: {category.urgency_weight}</Text>
                  )}
                </View>
                <View style={styles.categoryActions}>
                  {isEditableCategory(category.name) && (
                    <TouchableOpacity
                      style={styles.editButton}
                      onPress={() => startEditCategory(category)}
                    >
                      <Text style={styles.editButtonText}>Edit</Text>
                    </TouchableOpacity>
                  )}
                  {isEssentialCategory(category.name) ? (
                    <View style={[styles.toggleButton, styles.essentialToggleButton]}>
                      <Text style={[styles.toggleText, styles.essentialToggleText]}>
                        ESSENTIAL
                      </Text>
                    </View>
                  ) : (
                    <TouchableOpacity
                      style={[styles.toggleButton, category.active && styles.toggleButtonActive]}
                      onPress={() => toggleCategoryActive(category.id)}
                    >
                      <Text style={[styles.toggleText, category.active && styles.toggleTextActive]}>
                        {category.active ? 'ON' : 'OFF'}
                      </Text>
                    </TouchableOpacity>
                  )}
                </View>
              </>
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
          />
          <TouchableOpacity style={styles.typeButton} onPress={() => {
            const types: Array<'text' | 'number' | 'single_select' | 'multi_select' | 'date' | 'location'> = 
              ['text', 'number', 'single_select', 'multi_select', 'date', 'location'];
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
        
        {(newCategoryType === 'number' || newCategoryType === 'single_select') && (
                  <View style={styles.dangerWeightContainer}>
          <Text style={styles.dangerWeightLabel}>Danger Weight: {newCategoryDangerWeight}</Text>
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
          style={styles.addButton}
          onPress={addNewCategory}
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
          • All active categories are included as columns{'\n'}
          • Urgency scores and last interaction dates included{'\n'}
          • Multi-select values are comma-separated{'\n'}
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
  toggleButtonActive: {
    backgroundColor: '#007AFF',
  },
  essentialToggleButton: {
    backgroundColor: '#10B981',
  },
  toggleText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#6B7280',
  },
  toggleTextActive: {
    color: '#fff',
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
  editButton: {
    backgroundColor: '#3B82F6',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 6,
  },
  editButtonText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '600',
  },
  editCategoryContainer: {
    flex: 1,
    padding: 12,
    backgroundColor: '#F8F9FA',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#3B82F6',
  },
  editInputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 12,
  },
  editLabel: {
    fontSize: 14,
    fontWeight: '600',
    color: '#374151',
    width: 60,
  },
  editInput: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#D1D5DB',
    borderRadius: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: '#fff',
    fontSize: 14,
  },
  prioritySelector: {
    flexDirection: 'row',
    flex: 1,
    gap: 8,
  },
  priorityOption: {
    flex: 1,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderWidth: 1,
    borderColor: '#D1D5DB',
    borderRadius: 6,
    backgroundColor: '#fff',
    alignItems: 'center',
  },
  priorityOptionSelected: {
    backgroundColor: '#3B82F6',
    borderColor: '#3B82F6',
  },
  priorityOptionText: {
    fontSize: 12,
    color: '#374151',
    fontWeight: '500',
  },
  priorityOptionTextSelected: {
    color: '#fff',
  },
  editButtonRow: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 8,
  },
  cancelEditButton: {
    flex: 1,
    backgroundColor: '#6B7280',
    paddingVertical: 10,
    borderRadius: 6,
    alignItems: 'center',
  },
  cancelEditButtonText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },
  saveEditButton: {
    flex: 1,
    backgroundColor: '#10B981',
    paddingVertical: 10,
    borderRadius: 6,
    alignItems: 'center',
  },
  saveEditButtonText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },
}); 