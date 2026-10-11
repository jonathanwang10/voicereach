// C-09, C-14, C-15, C-16 on the manual path: typed values are sent with real types,
// empty fields are not sent, select labels match case-insensitively, and a backend
// rejection is shown in the form.
import React from 'react';
import { render, fireEvent, waitFor } from '@testing-library/react-native';

jest.mock('react-native-toast-message', () => ({ __esModule: true, default: { show: jest.fn() } }));
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
  },
}));

import { ManualEntryForm } from '../ManualEntryForm';
import { api } from '../../services/api';

const location = { latitude: 37.78, longitude: -122.41, address: '5th & Market' };

const fillRequired = (screen: any, height = '6') => {
  fireEvent.changeText(screen.getByPlaceholderText('Enter name'), 'Ann');
  fireEvent.changeText(screen.getByPlaceholderText("Enter height (e.g., 5'10 or 70)"), height);
  fireEvent.changeText(screen.getByPlaceholderText('Enter weight'), '180');
};

beforeEach(() => jest.clearAllMocks());

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
