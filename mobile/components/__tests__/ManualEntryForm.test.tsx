// C-09, C-14, C-15, C-16 on the manual path: typed values are sent with real types,
// empty fields are not sent, select labels match case-insensitively, and a backend
// rejection is shown in the form.
import React from 'react';
import { Alert } from 'react-native';
import { render, fireEvent, waitFor, act } from '@testing-library/react-native';

jest.mock('react-native-toast-message', () => ({ __esModule: true, default: { show: jest.fn() } }));
jest.mock('../../utils/delayedDelete', () => ({ isPendingDelete: jest.fn(() => false) }));
jest.mock('../../services/api', () => ({
  api: {
    getCategories: jest.fn(async () => [
      { id: '1', name: 'name', type: 'text', is_required: true, priority: 'high', urgency_weight: 0, auto_trigger: false },
      { id: '2', name: 'height', type: 'number', is_required: true, priority: 'medium', urgency_weight: 0, auto_trigger: false },
      { id: '3', name: 'weight', type: 'number', is_required: true, priority: 'medium', urgency_weight: 0, auto_trigger: false },
      { id: '4', name: 'age', type: 'number', is_required: false, priority: 'medium', urgency_weight: 0, auto_trigger: false },
      { id: '5', name: 'gender', type: 'single_select', is_required: false, priority: 'medium', urgency_weight: 0, auto_trigger: false,
        options: [{ label: 'Male', value: 0 }, { label: 'Female', value: 0 }] },
      { id: '6', name: 'medical_conditions', type: 'multi_select', is_required: false, priority: 'high', urgency_weight: 0, auto_trigger: false,
        options: ['Diabetes', 'Mental Health'] },
      { id: '7', name: 'notes', type: 'text', is_required: false, priority: 'low', urgency_weight: 0, auto_trigger: false },
    ]),
    checkDuplicates: jest.fn(async () => []),
    saveIndividual: jest.fn(async () => ({ id: 'x', individual: { id: 'x' } })),
    getIndividualProfile: jest.fn(async () => ({ data: { name: 'Ann Lee' } })),
  },
}));

import Toast from 'react-native-toast-message';
import { ManualEntryForm } from '../ManualEntryForm';
import { api } from '../../services/api';
import { isPendingDelete } from '../../utils/delayedDelete';

const MATCH_ID = '550e8400-e29b-41d4-a716-446655440000';
const outage = Object.assign(new Error('Server error. Please try again.'),
  { status: 500, detail: 'Server error. Please try again.', kind: 'http' });

const spyAlert = () => {
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  const press = (label: string) => {
    const buttons = (alert.mock.calls[alert.mock.calls.length - 1][2] ?? []) as any[];
    buttons.find(b => b.text === label)?.onPress?.();
  };
  return { alert, press };
};

const location = { latitude: 37.78, longitude: -122.41, address: '5th & Market' };

const fillRequired = (screen: any, height = '6') => {
  fireEvent.changeText(screen.getByPlaceholderText('Enter name'), 'Ann');
  fireEvent.changeText(screen.getByPlaceholderText("Enter height (e.g., 5'10 or 70)"), height);
  fireEvent.changeText(screen.getByPlaceholderText('Enter weight'), '180');
};

beforeEach(() => {
  jest.clearAllMocks();
  jest.restoreAllMocks();
  (isPendingDelete as jest.Mock).mockImplementation(() => false);
});

it('sends numbers as numbers, bare feet as inches, a matched label and a multi-select array, and no empty fields', async () => {
  const onSave = jest.fn();
  const screen = render(<ManualEntryForm onSave={onSave} onCancel={jest.fn()} selectedLocation={location} />);
  await waitFor(() => screen.getByText('Save'));
  fillRequired(screen);
  fireEvent.changeText(screen.getByPlaceholderText('Enter gender'), 'male');
  fireEvent.press(screen.getByText('Diabetes'));
  fireEvent.press(screen.getByText('Mental Health'));
  fireEvent.press(screen.getByText('Save'));

  await waitFor(() => expect(api.saveIndividual).toHaveBeenCalled());
  const req = (api.saveIndividual as jest.Mock).mock.calls[0][0];
  expect(req).toEqual({
    data: { name: 'Ann', height: 72, weight: 180, gender: 'Male', medical_conditions: ['Diabetes', 'Mental Health'] },
    location,
  });
  // The duplicate check gets the same typed fields, without GPS
  expect((api.checkDuplicates as jest.Mock).mock.calls[0][0]).toEqual(req.data);
  expect(onSave).toHaveBeenCalled();
});

it('tapping a selected multi-select option again removes it', async () => {
  const screen = render(<ManualEntryForm onSave={jest.fn()} onCancel={jest.fn()} />);
  await waitFor(() => screen.getByText('Save'));
  fillRequired(screen);
  fireEvent.press(screen.getByText('Diabetes'));
  fireEvent.press(screen.getByText('Mental Health'));
  fireEvent.press(screen.getByText('Diabetes'));
  fireEvent.press(screen.getByText('Save'));

  await waitFor(() => expect(api.saveIndividual).toHaveBeenCalled());
  expect((api.saveIndividual as jest.Mock).mock.calls[0][0].data.medical_conditions).toEqual(['Mental Health']);
});

it('rejects an unknown select option next to the field instead of sending it', async () => {
  const screen = render(<ManualEntryForm onSave={jest.fn()} onCancel={jest.fn()} />);
  await waitFor(() => screen.getByText('Save'));
  fillRequired(screen);
  fireEvent.changeText(screen.getByPlaceholderText('Enter gender'), 'robot');
  fireEvent.press(screen.getByText('Save'));
  await screen.findByText('Please select a valid gender');
  expect(api.saveIndividual).not.toHaveBeenCalled();
});

it('shows the backend save error in the form (C-16)', async () => {
  (api.saveIndividual as jest.Mock).mockRejectedValueOnce(
    Object.assign(new Error('weight: Value 400 exceeds maximum of 300'),
      { status: 400, detail: 'weight: Value 400 exceeds maximum of 300', kind: 'http' }));
  const onSave = jest.fn();
  const screen = render(<ManualEntryForm onSave={onSave} onCancel={jest.fn()} />);
  await waitFor(() => screen.getByText('Save'));
  fillRequired(screen);
  fireEvent.press(screen.getByText('Save'));
  await screen.findByText('weight: Value 400 exceeds maximum of 300');
  expect(onSave).not.toHaveBeenCalled();
});

// --- C-08: a failed duplicate check asks first; it never silently saves as new ----------

it('asks before saving as new when the duplicate check fails, and saves on "Save as new"', async () => {
  const { alert, press } = spyAlert();
  (api.checkDuplicates as jest.Mock).mockRejectedValueOnce(outage);
  const onSave = jest.fn();
  const screen = render(<ManualEntryForm onSave={onSave} onCancel={jest.fn()} />);
  await waitFor(() => screen.getByText('Save'));
  fillRequired(screen);
  fireEvent.press(screen.getByText('Save'));

  await waitFor(() => expect(alert).toHaveBeenCalledWith(
    'Duplicate check unavailable', 'Save as new anyway?', expect.any(Array), expect.anything()));
  expect(api.saveIndividual).not.toHaveBeenCalled();
  press('Save as new');
  await waitFor(() => expect(onSave).toHaveBeenCalled());
  expect(api.saveIndividual).toHaveBeenCalledTimes(1);
});

it('keeps the form and saves nothing when the worker cancels after a failed check', async () => {
  const { alert, press } = spyAlert();
  (api.checkDuplicates as jest.Mock).mockRejectedValueOnce(outage);
  const screen = render(<ManualEntryForm onSave={jest.fn()} onCancel={jest.fn()} />);
  await waitFor(() => screen.getByText('Save'));
  fillRequired(screen);
  fireEvent.press(screen.getByText('Save'));
  await waitFor(() => expect(alert).toHaveBeenCalled());
  press('Cancel');
  await waitFor(() => screen.getByText('Save'));
  expect(api.saveIndividual).not.toHaveBeenCalled();
  expect(screen.getByDisplayValue('Ann')).toBeTruthy();
});

// --- C-13: a saved form is cleared, so it can't be saved twice; one toast ----------------

it('clears the form after a successful save and shows one success toast', async () => {
  const screen = render(<ManualEntryForm onSave={jest.fn()} onCancel={jest.fn()} />);
  await waitFor(() => screen.getByText('Save'));
  fillRequired(screen);
  fireEvent.press(screen.getByText('Save'));
  await waitFor(() => expect(api.saveIndividual).toHaveBeenCalled());
  await waitFor(() => expect(screen.queryByDisplayValue('Ann')).toBeNull());
  expect(screen.queryByDisplayValue('180')).toBeNull();
  expect(Toast.show).toHaveBeenCalledTimes(1);
});

// --- carried from Task 4: never merge into someone whose delete is pending --------------

it('does not offer a match whose delayed delete is pending', async () => {
  (isPendingDelete as jest.Mock).mockImplementation((id: string) => id === MATCH_ID);
  (api.checkDuplicates as jest.Mock).mockResolvedValueOnce([{ id: MATCH_ID, name: 'Ann', confidence: 97 }]);
  const screen = render(<ManualEntryForm onSave={jest.fn()} onCancel={jest.fn()} />);
  await waitFor(() => screen.getByText('Save'));
  fillRequired(screen);
  fireEvent.press(screen.getByText('Save'));
  await waitFor(() => expect(api.saveIndividual).toHaveBeenCalled());
  expect(screen.queryByText('Potential Duplicate Found')).toBeNull();
  expect((api.saveIndividual as jest.Mock).mock.calls[0][0].merge_with_id).toBeUndefined();
});

it('offers a live match for merging', async () => {
  (api.checkDuplicates as jest.Mock).mockResolvedValueOnce([{ id: MATCH_ID, name: 'Ann Lee', confidence: 90 }]);
  const screen = render(<ManualEntryForm onSave={jest.fn()} onCancel={jest.fn()} />);
  await waitFor(() => screen.getByText('Save'));
  fillRequired(screen);
  fireEvent.press(screen.getByText('Save'));
  await screen.findByText('Potential Duplicate Found');
  expect(api.saveIndividual).not.toHaveBeenCalled();
});

// --- carried from Task 7: the save error goes away on edit -----------------------------

it('clears the save error as soon as the worker edits a field', async () => {
  (api.saveIndividual as jest.Mock).mockRejectedValueOnce(
    Object.assign(new Error('weight: Value 400 exceeds maximum of 300'),
      { status: 400, detail: 'weight: Value 400 exceeds maximum of 300', kind: 'http' }));
  const screen = render(<ManualEntryForm onSave={jest.fn()} onCancel={jest.fn()} />);
  await waitFor(() => screen.getByText('Save'));
  fillRequired(screen);
  fireEvent.press(screen.getByText('Save'));
  await screen.findByText('weight: Value 400 exceeds maximum of 300');
  fireEvent.changeText(screen.getByPlaceholderText('Enter weight'), '200');
  expect(screen.queryByText('weight: Value 400 exceeds maximum of 300')).toBeNull();
});

// --- fix round 1: a double tap on Save checks and saves once ---------------------------

it('two taps on Save before a re-render check and save once', async () => {
  const screen = render(<ManualEntryForm onSave={jest.fn()} onCancel={jest.fn()} />);
  await waitFor(() => screen.getByText('Save'));
  fillRequired(screen);
  const save = screen.getByText('Save');
  await act(async () => { fireEvent.press(save); fireEvent.press(save); });
  await waitFor(() => expect(api.saveIndividual).toHaveBeenCalled());
  expect(api.checkDuplicates).toHaveBeenCalledTimes(1);
  expect(api.saveIndividual).toHaveBeenCalledTimes(1);
});
