import React from 'react';
import { render, fireEvent, waitFor } from '@testing-library/react-native';

jest.mock('react-native-toast-message', () => ({ __esModule: true, default: { show: jest.fn() } }));
jest.mock('../../services/api', () => ({
  api: {
    getCategories: jest.fn(async () => [
      { id: '1', name: 'Name', type: 'text', is_required: true, priority: 'high', danger_weight: 0, auto_trigger: false },
      { id: '2', name: 'Height', type: 'number', is_required: true, priority: 'high', danger_weight: 0, auto_trigger: false },
      { id: '3', name: 'Weight', type: 'number', is_required: true, priority: 'high', danger_weight: 0, auto_trigger: false },
    ]),
    saveIndividual: jest.fn(async () => ({ success: true, id: 'x' })),
  },
}));

import { TranscriptionResults } from '../TranscriptionResults';
import { api } from '../../services/api';

it('saves a person with no duplicate match as new, with transcript and numeric height', async () => {
  const onSave = jest.fn();
  const result: any = {
    transcription: 'hello there',
    categorized_data: { Name: 'Ann', Height: "5'10", Weight: 150 },
    missing_required: [],
    potential_matches: [],
  };
  const { getByText } = render(
    <TranscriptionResults result={result} onSave={onSave} onCancel={jest.fn()} />
  );
  await waitFor(() => getByText('Save'));
  fireEvent.press(getByText('Save'));

  await waitFor(() => expect(onSave).toHaveBeenCalled());
  expect(api.saveIndividual).toHaveBeenCalledTimes(1);
  const payload = (api.saveIndividual as jest.Mock).mock.calls[0][0];
  expect(payload.merge_with_id).toBeUndefined();
  expect(payload.transcription).toBe('hello there');
  expect(payload.Height).toBe(70);
});
