import React from 'react';
import { render, fireEvent, waitFor } from '@testing-library/react-native';
import { MergeUI } from '../MergeUI';

describe('MergeUI', () => {
  const mockNewData = {
    name: 'John Doe',
    age: 45,
    height: 72,
    weight: 180,
  };

  const mockExistingData = {
    name: 'John Smith',
    age: 44,
    height: 71,
    weight: 175,
    medical_conditions: 'Diabetes',
  };

  const mockPotentialMatch = {
    id: '550e8400-e29b-41d4-a716-446655440000',
    confidence: 85,
    name: 'John Smith',
  };

  const mockOnMerge = jest.fn();
  const mockOnCreateNew = jest.fn();
  const mockOnCancel = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders correctly with confidence score', () => {
    const { getByText } = render(
      <MergeUI
        newData={mockNewData}
        potentialMatch={mockPotentialMatch}
        existingData={mockExistingData}
        onMerge={mockOnMerge}
        onCreateNew={mockOnCreateNew}
        onCancel={mockOnCancel}
      />
    );

    expect(getByText('Potential Duplicate Found')).toBeTruthy();
    expect(getByText('85%')).toBeTruthy();
    expect(getByText('We found a similar individual: John Smith')).toBeTruthy();
  });

  it('shows field comparison for all fields', () => {
    const { getByText } = render(
      <MergeUI
        newData={mockNewData}
        potentialMatch={mockPotentialMatch}
        existingData={mockExistingData}
        onMerge={mockOnMerge}
        onCreateNew={mockOnCreateNew}
        onCancel={mockOnCancel}
      />
    );

    expect(getByText('Name')).toBeTruthy();
    expect(getByText('Age')).toBeTruthy();
    expect(getByText('Height')).toBeTruthy();
    expect(getByText('Weight')).toBeTruthy();
    expect(getByText('Medical conditions')).toBeTruthy();
  });

  it('calls onCancel when cancel button is pressed', () => {
    const { getByText } = render(
      <MergeUI
        newData={mockNewData}
        potentialMatch={mockPotentialMatch}
        existingData={mockExistingData}
        onMerge={mockOnMerge}
        onCreateNew={mockOnCreateNew}
        onCancel={mockOnCancel}
      />
    );

    const cancelButton = getByText('Cancel');
    fireEvent.press(cancelButton);
    expect(mockOnCancel).toHaveBeenCalled();
  });

  it('calls onCreateNew when create new button is pressed', () => {
    const { getByText } = render(
      <MergeUI
        newData={mockNewData}
        potentialMatch={mockPotentialMatch}
        existingData={mockExistingData}
        onMerge={mockOnMerge}
        onCreateNew={mockOnCreateNew}
        onCancel={mockOnCancel}
      />
    );

    const createNewButton = getByText('Create New');
    fireEvent.press(createNewButton);
    expect(mockOnCreateNew).toHaveBeenCalledWith(mockNewData);
  });

  it('calls onMerge with merged data when merge button is pressed', () => {
    const { getByText } = render(
      <MergeUI
        newData={mockNewData}
        potentialMatch={mockPotentialMatch}
        existingData={mockExistingData}
        onMerge={mockOnMerge}
        onCreateNew={mockOnCreateNew}
        onCancel={mockOnCancel}
      />
    );

    const mergeButton = getByText('Merge');
    fireEvent.press(mergeButton);
    
    // The merge target travels separately; the field data holds only fields (C-09/T7)
    expect(mockOnMerge).toHaveBeenCalledWith(
      {
        name: 'John Doe',
        age: 45,
        height: 72,
        weight: 180,
        medical_conditions: 'Diabetes',
      },
      '550e8400-e29b-41d4-a716-446655440000'
    );
  });

  it('shows confidence color based on confidence level', () => {
    const { getByText } = render(
      <MergeUI
        newData={mockNewData}
        potentialMatch={{ ...mockPotentialMatch, confidence: 90 }}
        existingData={mockExistingData}
        onMerge={mockOnMerge}
        onCreateNew={mockOnCreateNew}
        onCancel={mockOnCancel}
      />
    );

    const confidenceText = getByText('90%');
    expect(confidenceText).toBeTruthy();
  });

  it('shows lists joined and empty values as a dash, never "null"', () => {
    const { getByText, queryByText, getAllByText } = render(
      <MergeUI
        newData={{ name: 'John Doe', medical_conditions: ['Diabetes', 'Mental Health'], notes: null }}
        potentialMatch={mockPotentialMatch}
        existingData={{ name: 'John Smith', medical_conditions: ['Diabetes'], notes: '' }}
        onMerge={mockOnMerge}
        onCreateNew={mockOnCreateNew}
        onCancel={mockOnCancel}
      />
    );
    expect(getByText('Diabetes, Mental Health')).toBeTruthy();
    expect(queryByText('null')).toBeNull();
    expect(getAllByText('—').length).toBeGreaterThan(0);
  });
});
