import React from 'react';
import { render, fireEvent, waitFor, act } from '@testing-library/react-native';

jest.mock('../../services/api', () => ({ api: { getIndividualProfile: jest.fn() } }));
jest.mock('react-native-toast-message', () => ({ __esModule: true, default: { show: jest.fn() } }));

import { StyleSheet } from 'react-native';
import { MergeUI } from '../MergeUI';
import { confidenceColor } from '../../utils/duplicateMatches';
import { api } from '../../services/api';
import Toast from 'react-native-toast-message';

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

  // C-62: same colour meaning as the voice review list (strong match = green)
  it('colours a strong match green and a medium match yellow, like voice review', () => {
    const colourOf = (confidence: number) => {
      const { getByText } = render(
        <MergeUI newData={mockNewData} potentialMatch={{ ...mockPotentialMatch, confidence }}
          existingData={mockExistingData} onMerge={mockOnMerge} onCreateNew={mockOnCreateNew} onCancel={mockOnCancel} />
      );
      return StyleSheet.flatten(getByText(`${confidence}%`).props.style).color;
    };
    expect(colourOf(97)).toBe(confidenceColor(97).text);
    expect(confidenceColor(97).text).toBe('#155724'); // dark green
    expect(colourOf(85)).toBe(confidenceColor(85).text);
    expect(confidenceColor(85).text).toBe('#856404'); // dark yellow
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

  // C-13: a double tap must not create two people or log two interactions
  it('a double tap on Create New calls onCreateNew once while it is in flight', async () => {
    let finish: () => void = () => {};
    const onCreateNew = jest.fn(() => new Promise<void>(r => { finish = r; }));
    const { getByText } = render(
      <MergeUI newData={mockNewData} potentialMatch={mockPotentialMatch} existingData={mockExistingData}
        onMerge={mockOnMerge} onCreateNew={onCreateNew} onCancel={mockOnCancel} />
    );
    fireEvent.press(getByText('Create New'));
    fireEvent.press(getByText('Create New'));
    fireEvent.press(getByText('Merge'));
    expect(onCreateNew).toHaveBeenCalledTimes(1);
    expect(mockOnMerge).not.toHaveBeenCalled();
    await act(async () => finish());
  });

  it('a double tap on Merge calls onMerge once, and the buttons work again after it settles', async () => {
    let finish: () => void = () => {};
    const onMerge = jest.fn(() => new Promise<void>(r => { finish = r; }));
    const { getByText } = render(
      <MergeUI newData={mockNewData} potentialMatch={mockPotentialMatch} existingData={mockExistingData}
        onMerge={onMerge} onCreateNew={mockOnCreateNew} onCancel={mockOnCancel} />
    );
    fireEvent.press(getByText('Merge'));
    fireEvent.press(getByText('Merge'));
    expect(onMerge).toHaveBeenCalledTimes(1);
    await act(async () => finish());
    // e.g. the save failed and the parent showed the error: the worker can retry
    fireEvent.press(getByText('Merge'));
    expect(onMerge).toHaveBeenCalledTimes(2);
  });

  // C-19: when the matched person can't be loaded, the recording can still be saved
  it('offers Create New when the matched person cannot be loaded', async () => {
    (api.getIndividualProfile as jest.Mock).mockRejectedValueOnce(new Error('404'));
    const { findByText, getByText } = render(
      <MergeUI newData={mockNewData} potentialMatch={mockPotentialMatch}
        onMerge={mockOnMerge} onCreateNew={mockOnCreateNew} onCancel={mockOnCancel} />
    );
    await findByText('Unable to Load Data');
    fireEvent.press(getByText('Create New'));
    expect(mockOnCreateNew).toHaveBeenCalledWith(mockNewData);
  });

  // C-64: the selection is built from the loaded person, so existing-only fields survive
  it('waits for the matched person to load, then keeps their existing-only fields on Merge', async () => {
    let load: (profile: any) => void = () => {};
    (api.getIndividualProfile as jest.Mock).mockReturnValueOnce(new Promise(r => { load = r; }));
    const { findByText, queryByText, getByText } = render(
      <MergeUI newData={mockNewData} potentialMatch={mockPotentialMatch}
        onMerge={mockOnMerge} onCreateNew={mockOnCreateNew} onCancel={mockOnCancel} />
    );
    expect(queryByText('Merge')).toBeNull();
    expect(getByText('Loading individual data for comparison...')).toBeTruthy();
    await act(async () => load({ data: { name: 'John Smith', medical_conditions: ['Diabetes'] } }));
    fireEvent.press(await findByText('Merge'));
    expect(api.getIndividualProfile).toHaveBeenCalledWith(mockPotentialMatch.id);
    expect(mockOnMerge).toHaveBeenCalledWith(
      { ...mockNewData, medical_conditions: ['Diabetes'] },
      mockPotentialMatch.id
    );
  });

  // fix round 1: a rejecting handler is reported once, never left unhandled
  it('shows one error toast when onMerge rejects, and the buttons work again', async () => {
    const onMerge = jest.fn(async () => { throw new Error('Server error. Please try again.'); });
    const { getByText } = render(
      <MergeUI newData={mockNewData} potentialMatch={mockPotentialMatch} existingData={mockExistingData}
        onMerge={onMerge} onCreateNew={mockOnCreateNew} onCancel={mockOnCancel} />
    );
    await act(async () => { fireEvent.press(getByText('Merge')); });
    expect(Toast.show).toHaveBeenCalledTimes(1);
    fireEvent.press(getByText('Create New'));
    expect(mockOnCreateNew).toHaveBeenCalledTimes(1);
  });
});
