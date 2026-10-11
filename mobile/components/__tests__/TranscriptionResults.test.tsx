import React from 'react';
import { render, fireEvent, waitFor } from '@testing-library/react-native';

jest.mock('react-native-toast-message', () => ({ __esModule: true, default: { show: jest.fn() } }));
jest.mock('../../services/api', () => ({
  api: {
    getCategories: jest.fn(async () => [
      { id: '1', name: 'Name', type: 'text', is_required: true, priority: 'high', urgency_weight: 0, auto_trigger: false },
      { id: '2', name: 'Height', type: 'number', is_required: true, priority: 'high', urgency_weight: 0, auto_trigger: false },
      { id: '3', name: 'Weight', type: 'number', is_required: true, priority: 'high', urgency_weight: 0, auto_trigger: false },
      { id: '4', name: 'gender', type: 'single_select', is_required: false, priority: 'medium', urgency_weight: 0, auto_trigger: false,
        options: [{ label: 'Male', value: 0 }, { label: 'Female', value: 0 }] },
      { id: '5', name: 'medical_conditions', type: 'multi_select', is_required: false, priority: 'high', urgency_weight: 0, auto_trigger: false,
        options: ['Diabetes', 'Mental Health'] },
      { id: '6', name: 'behavior', type: 'single_select', is_required: false, priority: 'high', urgency_weight: 40, auto_trigger: true,
        options: [{ label: 'None', value: 0 }, { label: 'Physical', value: 1 }] },
    ]),
    saveIndividual: jest.fn(async () => ({ id: 'x', individual: { id: 'x' } })),
  },
}));

import { TranscriptionResults } from '../TranscriptionResults';
import { api } from '../../services/api';

const baseResult = (overrides: any = {}): any => ({
  transcription: 'hello there',
  categorized_data: { Name: 'Ann', Height: "5'10", Weight: 150 },
  missing_required: [],
  potential_matches: [],
  validation_errors: [],
  ...overrides,
});

beforeEach(() => jest.clearAllMocks());

it('saves a person with no duplicate match as new, using the explicit request shape', async () => {
  const onSave = jest.fn();
  const location = { latitude: 37.78, longitude: -122.41, address: '5th & Market' };
  const { getByText } = render(
    <TranscriptionResults result={baseResult()} onSave={onSave} onCancel={jest.fn()} location={location} />
  );
  await waitFor(() => getByText('Save'));
  fireEvent.press(getByText('Save'));

  await waitFor(() => expect(onSave).toHaveBeenCalled());
  expect(api.saveIndividual).toHaveBeenCalledTimes(1);
  const req = (api.saveIndividual as jest.Mock).mock.calls[0][0];
  expect(req.merge_with_id ?? null).toBeNull(); // saved as new, not merged
  expect(req.transcription).toBe('hello there');
  expect(req.location).toEqual(location);
  expect(req.data).toEqual({ Name: 'Ann', Height: 70, Weight: 150 });
});

it('sends typed numbers as numbers, a bare 6 as feet, and select labels in canonical case', async () => {
  const { getByText, getByDisplayValue, getByPlaceholderText } = render(
    <TranscriptionResults
      result={baseResult({ categorized_data: { Name: 'Ann', Height: 70, Weight: 150 } })}
      onSave={jest.fn()} onCancel={jest.fn()} />
  );
  await waitFor(() => getByText('Save'));
  fireEvent.changeText(getByDisplayValue('70'), '6');
  fireEvent.changeText(getByDisplayValue('150'), '180');
  fireEvent.changeText(getByPlaceholderText('Enter gender'), 'female');
  fireEvent.press(getByText('Save'));

  await waitFor(() => expect(api.saveIndividual).toHaveBeenCalled());
  const req = (api.saveIndividual as jest.Mock).mock.calls[0][0];
  expect(req.data).toEqual({ Name: 'Ann', Height: 72, Weight: 180, gender: 'Female' });
});

it('multi-select quick options toggle list membership instead of replacing the value', async () => {
  const { getByText } = render(
    <TranscriptionResults
      result={baseResult({ categorized_data: { Name: 'Ann', Height: 70, Weight: 150, medical_conditions: ['Diabetes'] } })}
      onSave={jest.fn()} onCancel={jest.fn()} />
  );
  await waitFor(() => getByText('Save'));
  fireEvent.press(getByText('Mental Health'));
  await waitFor(() => getByText('Save'));
  fireEvent.press(getByText('Save'));

  await waitFor(() => expect(api.saveIndividual).toHaveBeenCalled());
  expect((api.saveIndividual as jest.Mock).mock.calls[0][0].data.medical_conditions)
    .toEqual(['Diabetes', 'Mental Health']);
});

it('a cleared optional field is not sent, so it never becomes "null" (C-09)', async () => {
  const { getByText, getByDisplayValue } = render(
    <TranscriptionResults
      result={baseResult({ categorized_data: { Name: 'Ann', Height: 70, Weight: 150, behavior: 'Physical' } })}
      onSave={jest.fn()} onCancel={jest.fn()} />
  );
  await waitFor(() => getByText('Save'));
  fireEvent.changeText(getByDisplayValue('Physical'), '');
  fireEvent.press(getByText('Save'));

  await waitFor(() => expect(api.saveIndividual).toHaveBeenCalled());
  expect((api.saveIndividual as jest.Mock).mock.calls[0][0].data).toEqual({ Name: 'Ann', Height: 70, Weight: 150 });
});

it('shows the backend validation_errors next to their fields (C-16)', async () => {
  const { getByText } = render(
    <TranscriptionResults
      result={baseResult({
        categorized_data: { Name: 'Ann', Height: 70, Weight: 150, gender: 'robot' },
        validation_errors: [{ field: 'gender', message: "Invalid option 'robot'. Must be one of: Male, Female" }],
      })}
      onSave={jest.fn()} onCancel={jest.fn()} />
  );
  await waitFor(() => getByText("Invalid option 'robot'. Must be one of: Male, Female"));
});

it('blocks the save and names the field when a value is invalid', async () => {
  const { getByText, getByDisplayValue, findByText } = render(
    <TranscriptionResults result={baseResult({ categorized_data: { Name: 'Ann', Height: 70, Weight: 150 } })}
      onSave={jest.fn()} onCancel={jest.fn()} />
  );
  await waitFor(() => getByText('Save'));
  fireEvent.changeText(getByDisplayValue('150'), 'heavy');
  fireEvent.press(getByText('Save'));
  await findByText('Weight must be a number');
  expect(api.saveIndividual).not.toHaveBeenCalled();
});

it('shows the save error detail in the form (C-16)', async () => {
  (api.saveIndividual as jest.Mock).mockRejectedValueOnce(
    Object.assign(new Error('weight: Value 400 exceeds maximum of 300'),
      { status: 400, detail: 'weight: Value 400 exceeds maximum of 300', kind: 'http' }));
  const onSave = jest.fn();
  const { getByText, findByText } = render(
    <TranscriptionResults result={baseResult()} onSave={onSave} onCancel={jest.fn()} />
  );
  await waitFor(() => getByText('Save'));
  fireEvent.press(getByText('Save'));
  await findByText('weight: Value 400 exceeds maximum of 300');
  expect(onSave).not.toHaveBeenCalled();
});
