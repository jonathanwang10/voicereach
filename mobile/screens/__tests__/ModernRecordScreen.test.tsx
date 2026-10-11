// C-13: no second recording while one is being transcribed, and one success toast per save.
import React from 'react';
import { Text, TouchableOpacity } from 'react-native';
import { render, fireEvent, waitFor, act } from '@testing-library/react-native';

jest.mock('react-native-toast-message', () => ({ __esModule: true, default: { show: jest.fn() } }));
jest.mock('../../contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'u' }, loading: false }) }));
jest.mock('../../services/supabase', () => ({ supabase: {} }));
jest.mock('../../services/api', () => ({ api: { transcribe: jest.fn() } }));
jest.mock('../../components/LocationPicker', () => ({ LocationPicker: () => null }));
jest.mock('../../components/ModernAudioRecorder', () => {
  const React = require('react');
  const { Text, TouchableOpacity } = require('react-native');
  return {
    ModernAudioRecorder: React.forwardRef(({ onRecordingComplete }: any, _ref: any) => (
      <TouchableOpacity onPress={() => onRecordingComplete('file:///clip.m4a')}>
        <Text>Stub Recorder</Text>
      </TouchableOpacity>
    )),
  };
});
jest.mock('../../components/TranscriptionResults', () => {
  const { Text, TouchableOpacity } = require('react-native');
  return {
    TranscriptionResults: ({ onSave }: any) => (
      <TouchableOpacity onPress={() => onSave({ name: 'Ann' })}>
        <Text>Stub Save</Text>
      </TouchableOpacity>
    ),
  };
});
jest.mock('../../components/ManualEntryForm', () => ({ ManualEntryForm: () => null }));

import Toast from 'react-native-toast-message';
import { ModernRecordScreen } from '../ModernRecordScreen';
import { api } from '../../services/api';

beforeEach(() => jest.clearAllMocks());

it('hides the recorder while a recording is being transcribed', async () => {
  let finish: (r: any) => void = () => {};
  (api.transcribe as jest.Mock).mockReturnValue(new Promise(r => { finish = r; }));
  const { getByText, queryByText, findByText } = render(<ModernRecordScreen />);

  fireEvent.press(getByText('Stub Recorder'));
  await waitFor(() => expect(api.transcribe).toHaveBeenCalled());
  expect(queryByText('Stub Recorder')).toBeNull();

  await act(async () => finish({
    transcription: 't', categorized_data: {}, missing_required: [], potential_matches: [], validation_errors: [],
  }));
  await findByText('Stub Save');
});

it('leaves the save toast to the form: the screen adds none', async () => {
  (api.transcribe as jest.Mock).mockResolvedValue({
    transcription: 't', categorized_data: {}, missing_required: [], potential_matches: [], validation_errors: [],
  });
  const { getByText, findByText } = render(<ModernRecordScreen />);
  fireEvent.press(getByText('Stub Recorder'));
  fireEvent.press(await findByText('Stub Save'));

  const saveToasts = (Toast.show as jest.Mock).mock.calls
    .map(c => c[0])
    .filter(t => t.type === 'success' && /saved|recorded/i.test(t.text2 ?? ''));
  expect(saveToasts).toEqual([]);
  // and the screen is back to a fresh recorder
  await findByText('Stub Recorder');
});
