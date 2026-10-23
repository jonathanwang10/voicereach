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
    // No categories passed: the key title-cased, as everywhere else (categoryLabel)
    expect(getByText('Medical Conditions')).toBeTruthy();
  });

  // Minor 1: a field is labelled with its category's display_name.
  it('labels fields with the category display_name', () => {
    const { getByText, queryByText } = render(
      <MergeUI
        newData={{ ...mockNewData, hiv_status: 'Unknown' }}
        potentialMatch={mockPotentialMatch}
        existingData={mockExistingData}
        categories={[
          { name: 'hiv_status', display_name: 'HIV status', type: 'text' },
          { name: 'medical_conditions', display_name: 'Medical Conditions', type: 'multi_select' },
        ]}
        onMerge={mockOnMerge}
        onCreateNew={mockOnCreateNew}
        onCancel={mockOnCancel}
      />
    );
    expect(getByText('HIV status')).toBeTruthy();
    expect(queryByText('Hiv status')).toBeNull();
    expect(getByText('Medical Conditions')).toBeTruthy();
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

  // --- version pass-through and the 409 reload (H2-2.3) ---
  const MSG = 'This person was changed by someone else. Reload and try again.';
  const conflict = () => Object.assign(new Error(MSG), { status: 409, detail: MSG, kind: 'http' });

  it('passes the loaded version to onMerge', async () => {
    (api.getIndividualProfile as jest.Mock).mockResolvedValueOnce({ data: mockExistingData, version: 3 });
    const onMerge = jest.fn();
    const { findByText } = render(
      <MergeUI newData={mockNewData} potentialMatch={mockPotentialMatch}
        onMerge={onMerge} onCreateNew={mockOnCreateNew} onCancel={mockOnCancel} />
    );
    { const button = await findByText('Merge'); await act(async () => { fireEvent.press(button); }); }
    expect(onMerge).toHaveBeenCalledWith(expect.any(Object), mockPotentialMatch.id, 3);
  });

  it('on a 409 shows the message once and reloads the person, then merges with the new version', async () => {
    (api.getIndividualProfile as jest.Mock)
      .mockResolvedValueOnce({ data: mockExistingData, version: 3 })
      .mockResolvedValueOnce({ data: { ...mockExistingData, medical_conditions: 'Asthma' }, version: 4 });
    const onMerge = jest.fn().mockRejectedValueOnce(conflict()).mockResolvedValue(undefined);
    const { findByText } = render(
      <MergeUI newData={mockNewData} potentialMatch={mockPotentialMatch}
        onMerge={onMerge} onCreateNew={mockOnCreateNew} onCancel={mockOnCancel} />
    );
    { const button = await findByText('Merge'); await act(async () => { fireEvent.press(button); }); }
    expect(Toast.show).toHaveBeenCalledTimes(1);
    expect(Toast.show).toHaveBeenCalledWith(expect.objectContaining({ text2: MSG }));
    expect(await findByText('Asthma')).toBeTruthy();
    expect(api.getIndividualProfile).toHaveBeenCalledTimes(2);
    { const button = await findByText('Merge'); await act(async () => { fireEvent.press(button); }); }
    expect(onMerge).toHaveBeenLastCalledWith(expect.any(Object), mockPotentialMatch.id, 4);
  });

  it('resets the field choices after a conflict reload', async () => {
    (api.getIndividualProfile as jest.Mock)
      .mockResolvedValueOnce({ data: mockExistingData, version: 3 })
      .mockResolvedValueOnce({ data: mockExistingData, version: 4 });
    const onMerge = jest.fn().mockRejectedValueOnce(conflict()).mockResolvedValue(undefined);
    const { findByText, getByText } = render(
      <MergeUI newData={mockNewData} potentialMatch={mockPotentialMatch}
        onMerge={onMerge} onCreateNew={mockOnCreateNew} onCancel={mockOnCancel} />
    );
    fireEvent.press(await findByText('175'));                          // pick Existing for the weight
    await act(async () => { fireEvent.press(getByText('Merge')); });
    expect(onMerge.mock.calls[0][0].weight).toBe(175);
    { const button = await findByText('Merge'); await act(async () => { fireEvent.press(button); }); }
    expect(onMerge.mock.calls[1][0].weight).toBe(180);                // back to the default (new)
  });

  // --- other possible matches (H2-3.5) ---
  it('lists other possible matches and switches to the chosen one', () => {
    const other = { id: '550e8400-e29b-41d4-a716-446655440001', name: 'Jon B', confidence: 70 };
    const onSwitch = jest.fn();
    const { getByText, queryByText } = render(<MergeUI newData={mockNewData} potentialMatch={mockPotentialMatch}
      existingData={mockExistingData} otherMatches={[other]} onSwitchMatch={onSwitch}
      onMerge={mockOnMerge} onCreateNew={mockOnCreateNew} onCancel={mockOnCancel} />);
    expect(queryByText('Jon B · 70%')).toBeNull();
    fireEvent.press(getByText('Other possible matches (1)'));
    fireEvent.press(getByText('Jon B · 70%'));
    expect(onSwitch).toHaveBeenCalledWith(other);
    expect(queryByText('Jon B · 70%')).toBeNull();     // the list closes
  });

  it('shows no "Other possible matches" without other matches', () => {
    const { queryByText } = render(<MergeUI newData={mockNewData} potentialMatch={mockPotentialMatch}
      existingData={mockExistingData} onMerge={mockOnMerge} onCreateNew={mockOnCreateNew} onCancel={mockOnCancel} />);
    expect(queryByText(/Other possible matches/)).toBeNull();
  });
});
