import React from 'react';
import { Alert } from 'react-native';
import { render, fireEvent, waitFor, act } from '@testing-library/react-native';

jest.mock('react-native-toast-message', () => ({ __esModule: true, default: { show: jest.fn() } }));
jest.mock('../../utils/delayedDelete', () => ({ isPendingDelete: jest.fn(() => false) }));
jest.mock('../../services/api', () => ({
  api: {
    getCategories: jest.fn(async () => [
      { id: '1', name: 'name', display_name: 'Name', type: 'text', is_required: true, priority: 'high', urgency_weight: 0, auto_trigger: false },
      { id: '2', name: 'height', display_name: 'Height', type: 'number', is_required: true, priority: 'high', urgency_weight: 0, auto_trigger: false },
      { id: '3', name: 'weight', display_name: 'Weight', type: 'number', is_required: true, priority: 'high', urgency_weight: 0, auto_trigger: false },
      { id: '4', name: 'gender', type: 'single_select', is_required: false, priority: 'medium', urgency_weight: 0, auto_trigger: false,
        options: [{ label: 'Male', value: 0 }, { label: 'Female', value: 0 }] },
      { id: '5', name: 'medical_conditions', type: 'multi_select', is_required: false, priority: 'high', urgency_weight: 0, auto_trigger: false,
        options: ['Diabetes', 'Mental Health'] },
      { id: '6', name: 'behavior', type: 'single_select', is_required: false, priority: 'high', urgency_weight: 40, auto_trigger: true,
        options: [{ label: 'None', value: 0 }, { label: 'Physical', value: 1 }] },
    ]),
    saveIndividual: jest.fn(async () => ({ id: 'x', individual: { id: 'x' } })),
    checkDuplicates: jest.fn(async () => []),
    getIndividualProfile: jest.fn(async () => ({ data: { name: 'Anne Lee' } })),
  },
}));

import Toast from 'react-native-toast-message';
import { TranscriptionResults } from '../TranscriptionResults';
import { api } from '../../services/api';
import { isPendingDelete } from '../../utils/delayedDelete';

const MATCH_ID = '550e8400-e29b-41d4-a716-446655440000';
const outage = Object.assign(new Error('Server error. Please try again.'),
  { status: 500, detail: 'Server error. Please try again.', kind: 'http' });

// Captures Alert.alert calls; `press(label)` taps that button of the last alert
const spyAlert = () => {
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  const press = (label: string) => {
    const buttons = (alert.mock.calls[alert.mock.calls.length - 1][2] ?? []) as any[];
    buttons.find(b => b.text === label)?.onPress?.();
  };
  return { alert, press };
};

const baseResult = (overrides: any = {}): any => ({
  transcription: 'hello there',
  categorized_data: { name: 'Ann', height: "5'10", weight: 150 },
  missing_required: [],
  potential_matches: [],
  validation_errors: [],
  ...overrides,
});

beforeEach(() => {
  jest.clearAllMocks();
  jest.restoreAllMocks();
  (isPendingDelete as jest.Mock).mockImplementation(() => false);
});

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
  expect(req.data).toEqual({ name: 'Ann', height: 70, weight: 150 });
});

it('sends typed numbers as numbers, a bare 6 as feet, and select labels in canonical case', async () => {
  const { getByText, getByDisplayValue, getByPlaceholderText } = render(
    <TranscriptionResults
      result={baseResult({ categorized_data: { name: 'Ann', height: 70, weight: 150 } })}
      onSave={jest.fn()} onCancel={jest.fn()} />
  );
  await waitFor(() => getByText('Save'));
  fireEvent.changeText(getByDisplayValue('70'), '6');
  fireEvent.changeText(getByDisplayValue('150'), '180');
  fireEvent.changeText(getByPlaceholderText('Enter gender'), 'female');
  fireEvent.press(getByText('Save'));

  await waitFor(() => expect(api.saveIndividual).toHaveBeenCalled());
  const req = (api.saveIndividual as jest.Mock).mock.calls[0][0];
  expect(req.data).toEqual({ name: 'Ann', height: 72, weight: 180, gender: 'Female' });
});

it('multi-select quick options toggle list membership instead of replacing the value', async () => {
  const { getByText } = render(
    <TranscriptionResults
      result={baseResult({ categorized_data: { name: 'Ann', height: 70, weight: 150, medical_conditions: ['Diabetes'] } })}
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
      result={baseResult({ categorized_data: { name: 'Ann', height: 70, weight: 150, behavior: 'Physical' } })}
      onSave={jest.fn()} onCancel={jest.fn()} />
  );
  await waitFor(() => getByText('Save'));
  fireEvent.changeText(getByDisplayValue('Physical'), '');
  fireEvent.press(getByText('Save'));

  await waitFor(() => expect(api.saveIndividual).toHaveBeenCalled());
  expect((api.saveIndividual as jest.Mock).mock.calls[0][0].data).toEqual({ name: 'Ann', height: 70, weight: 150 });
});

it('shows the backend validation_errors next to their fields (C-16)', async () => {
  const { getByText } = render(
    <TranscriptionResults
      result={baseResult({
        categorized_data: { name: 'Ann', height: 70, weight: 150, gender: 'robot' },
        validation_errors: [{ field: 'gender', message: "Invalid option 'robot'. Must be one of: Male, Female" }],
      })}
      onSave={jest.fn()} onCancel={jest.fn()} />
  );
  await waitFor(() => getByText("Invalid option 'robot'. Must be one of: Male, Female"));
});

it('blocks the save and names the field when a value is invalid', async () => {
  const { getByText, getByDisplayValue, findByText } = render(
    <TranscriptionResults result={baseResult({ categorized_data: { name: 'Ann', height: 70, weight: 150 } })}
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

// --- C-05: what the worker corrected is what gets checked -----------------------------

it('re-checks duplicates when the worker corrects the name, and offers the match it finds', async () => {
  (api.checkDuplicates as jest.Mock).mockResolvedValueOnce([{ id: MATCH_ID, name: 'Anne Lee', confidence: 90 }]);
  const { getByText, getByDisplayValue, findByText } = render(
    <TranscriptionResults result={baseResult({ categorized_data: { name: 'Ann', height: 70, weight: 150 } })}
      onSave={jest.fn()} onCancel={jest.fn()} />
  );
  await waitFor(() => getByText('Save'));
  fireEvent.changeText(getByDisplayValue('Ann'), 'Anne Lee');
  fireEvent.press(getByText('Save'));

  await findByText('Potential Duplicate Found');
  expect(api.checkDuplicates).toHaveBeenCalledWith({ name: 'Anne Lee', height: 70, weight: 150 });
  expect(api.saveIndividual).not.toHaveBeenCalled();
});

it('does not re-check unedited data: the transcribe result already holds the check', async () => {
  const { getByText } = render(
    <TranscriptionResults result={baseResult()} onSave={jest.fn()} onCancel={jest.fn()} />
  );
  await waitFor(() => getByText('Save'));
  fireEvent.press(getByText('Save'));
  await waitFor(() => expect(api.saveIndividual).toHaveBeenCalled());
  expect(api.checkDuplicates).not.toHaveBeenCalled();
});

it('re-checks unedited data when the server says its duplicate check failed', async () => {
  const { getByText } = render(
    <TranscriptionResults result={baseResult({ duplicate_check_failed: true })} onSave={jest.fn()} onCancel={jest.fn()} />
  );
  await waitFor(() => getByText('Save'));
  fireEvent.press(getByText('Save'));
  await waitFor(() => expect(api.saveIndividual).toHaveBeenCalled());
  expect(api.checkDuplicates).toHaveBeenCalledTimes(1);
});

// --- C-08: a failed check asks; it never silently saves as new -------------------------

it('asks before saving as new when the duplicate check fails, and saves on "Save as new"', async () => {
  const { alert, press } = spyAlert();
  (api.checkDuplicates as jest.Mock).mockRejectedValueOnce(outage);
  const onSave = jest.fn();
  const { getByText } = render(
    <TranscriptionResults result={baseResult({ duplicate_check_failed: true })} onSave={onSave} onCancel={jest.fn()} />
  );
  await waitFor(() => getByText('Save'));
  fireEvent.press(getByText('Save'));

  await waitFor(() => expect(alert).toHaveBeenCalledWith(
    'Duplicate check unavailable', 'Save as new anyway?', expect.any(Array), expect.anything()));
  expect(api.saveIndividual).not.toHaveBeenCalled();
  press('Save as new');
  await waitFor(() => expect(onSave).toHaveBeenCalled());
  expect(api.saveIndividual).toHaveBeenCalledTimes(1);
});

it('does not save when the worker cancels after a failed duplicate check', async () => {
  const { alert, press } = spyAlert();
  (api.checkDuplicates as jest.Mock).mockRejectedValueOnce(outage);
  const { getByText } = render(
    <TranscriptionResults result={baseResult({ duplicate_check_failed: true })} onSave={jest.fn()} onCancel={jest.fn()} />
  );
  await waitFor(() => getByText('Save'));
  fireEvent.press(getByText('Save'));
  await waitFor(() => expect(alert).toHaveBeenCalled());
  press('Cancel');
  await waitFor(() => expect(getByText('Save')).toBeTruthy());
  expect(api.saveIndividual).not.toHaveBeenCalled();
});

// --- carried from Task 4: never merge into someone whose delete is pending --------------

it('does not offer a match whose delayed delete is pending', async () => {
  (isPendingDelete as jest.Mock).mockImplementation((id: string) => id === MATCH_ID);
  const { getByText, queryByText } = render(
    <TranscriptionResults
      result={baseResult({ potential_matches: [{ id: MATCH_ID, name: 'Ann', confidence: 97 }] })}
      onSave={jest.fn()} onCancel={jest.fn()} />
  );
  await waitFor(() => getByText('Save'));
  fireEvent.press(getByText('Save'));
  await waitFor(() => expect(api.saveIndividual).toHaveBeenCalled());
  expect(queryByText('Potential Duplicate Found')).toBeNull();
  expect((api.saveIndividual as jest.Mock).mock.calls[0][0].merge_with_id ?? null).toBeNull();
});

// --- C-13: one success toast ----------------------------------------------------------

it('shows exactly one success toast for a save', async () => {
  const { getByText } = render(
    <TranscriptionResults result={baseResult()} onSave={jest.fn()} onCancel={jest.fn()} />
  );
  await waitFor(() => getByText('Save'));
  fireEvent.press(getByText('Save'));
  await waitFor(() => expect(api.saveIndividual).toHaveBeenCalled());
  expect(Toast.show).toHaveBeenCalledTimes(1);
});

// --- carried from Task 7: field and save errors ----------------------------------------

it('keeps the backend messages on untouched fields when Save adds client ones', async () => {
  spyAlert();
  const backendMsg = "Invalid option 'robot'. Must be one of: Male, Female";
  const { getByText, getByDisplayValue, findByText } = render(
    <TranscriptionResults
      result={baseResult({
        categorized_data: { name: 'Ann', height: 70, weight: 150, gender: 'robot' },
        validation_errors: [{ field: 'gender', message: backendMsg }],
      })}
      onSave={jest.fn()} onCancel={jest.fn()} />
  );
  await waitFor(() => getByText('Save'));
  fireEvent.changeText(getByDisplayValue('150'), 'heavy');
  fireEvent.press(getByText('Save'));
  await findByText('Weight must be a number');
  expect(getByText(backendMsg)).toBeTruthy();
  expect(api.saveIndividual).not.toHaveBeenCalled();
});

it('clears the save error as soon as the worker edits a field', async () => {
  (api.saveIndividual as jest.Mock).mockRejectedValueOnce(
    Object.assign(new Error('weight: Value 400 exceeds maximum of 300'),
      { status: 400, detail: 'weight: Value 400 exceeds maximum of 300', kind: 'http' }));
  const { getByText, getByDisplayValue, findByText, queryByText } = render(
    <TranscriptionResults result={baseResult({ categorized_data: { name: 'Ann', height: 70, weight: 150 } })}
      onSave={jest.fn()} onCancel={jest.fn()} />
  );
  await waitFor(() => getByText('Save'));
  fireEvent.press(getByText('Save'));
  await findByText('weight: Value 400 exceeds maximum of 300');
  fireEvent.changeText(getByDisplayValue('Ann'), 'Ann B');
  expect(queryByText('weight: Value 400 exceeds maximum of 300')).toBeNull();
});

// --- fix round 1: the re-check adds to what the worker sees; it never discards it -------

const OTHER_ID = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
const serverJohn = { id: MATCH_ID, name: 'John', confidence: 90 };

it('keeps the shown server match when the re-check of an edited name finds nothing', async () => {
  (api.checkDuplicates as jest.Mock).mockResolvedValueOnce([]);
  const { getByText, getByDisplayValue, findByText } = render(
    <TranscriptionResults
      result={baseResult({ categorized_data: { name: 'John', height: 70, weight: 150 }, potential_matches: [serverJohn] })}
      onSave={jest.fn()} onCancel={jest.fn()} />
  );
  await waitFor(() => getByText('Save'));
  expect(getByText(/90% match/)).toBeTruthy();
  fireEvent.changeText(getByDisplayValue('John'), 'Jon');
  fireEvent.press(getByText('Save'));

  await findByText('Potential Duplicate Found');
  expect(api.checkDuplicates).toHaveBeenCalledTimes(1);
  expect(api.saveIndividual).not.toHaveBeenCalled();
});

it('shows exactly the matches it decided on: the union, de-duplicated at the highest confidence', async () => {
  (api.checkDuplicates as jest.Mock).mockResolvedValueOnce([
    { id: MATCH_ID, name: 'John', confidence: 95 },
    { id: OTHER_ID, name: 'Jon B', confidence: 70 },
  ]);
  const { getByText, getByDisplayValue, findByText, queryByText, getAllByText } = render(
    <TranscriptionResults
      result={baseResult({ categorized_data: { name: 'John', height: 70, weight: 150 }, potential_matches: [serverJohn] })}
      onSave={jest.fn()} onCancel={jest.fn()} />
  );
  await waitFor(() => getByText('Save'));
  fireEvent.changeText(getByDisplayValue('John'), 'Jon');
  fireEvent.press(getByText('Save'));
  await findByText('Potential Duplicate Found');
  expect(getByText('John')).toBeTruthy(); // the best match is the one offered
  fireEvent.press(getByText('Cancel'));

  await findByText(/95% match/);
  expect(getByText(/70% match/)).toBeTruthy();
  expect(queryByText(/90% match/)).toBeNull();
  expect(getAllByText(/% match/)).toHaveLength(2);
});

it('decides on the shown server match without asking when the re-check fails', async () => {
  const { alert } = spyAlert();
  (api.checkDuplicates as jest.Mock).mockRejectedValueOnce(outage);
  const { getByText, getByDisplayValue, findByText } = render(
    <TranscriptionResults
      result={baseResult({ categorized_data: { name: 'John', height: 70, weight: 150 }, potential_matches: [serverJohn] })}
      onSave={jest.fn()} onCancel={jest.fn()} />
  );
  await waitFor(() => getByText('Save'));
  fireEvent.changeText(getByDisplayValue('John'), 'Jon');
  fireEvent.press(getByText('Save'));
  await findByText('Potential Duplicate Found');
  expect(alert).not.toHaveBeenCalled();
  expect(api.saveIndividual).not.toHaveBeenCalled();
});

it('no longer labels a high-confidence match "Streamlined confirmation"', async () => {
  const { getByText, queryByText } = render(
    <TranscriptionResults result={baseResult({ potential_matches: [{ ...serverJohn, confidence: 97 }] })}
      onSave={jest.fn()} onCancel={jest.fn()} />
  );
  await waitFor(() => getByText(/97% match/));
  expect(queryByText(/Streamlined/)).toBeNull();
});

it('two taps on Save before a re-render save once', async () => {
  const { getByText } = render(
    <TranscriptionResults result={baseResult()} onSave={jest.fn()} onCancel={jest.fn()} />
  );
  await waitFor(() => getByText('Save'));
  const save = getByText('Save');
  await act(async () => { fireEvent.press(save); fireEvent.press(save); });
  await waitFor(() => expect(api.saveIndividual).toHaveBeenCalled());
  expect(api.saveIndividual).toHaveBeenCalledTimes(1);
});

it('two taps on Save run one re-check', async () => {
  const { getByText } = render(
    <TranscriptionResults result={baseResult({ duplicate_check_failed: true })} onSave={jest.fn()} onCancel={jest.fn()} />
  );
  await waitFor(() => getByText('Save'));
  const save = getByText('Save');
  await act(async () => { fireEvent.press(save); fireEvent.press(save); });
  await waitFor(() => expect(api.saveIndividual).toHaveBeenCalled());
  expect(api.checkDuplicates).toHaveBeenCalledTimes(1);
  expect(api.saveIndividual).toHaveBeenCalledTimes(1);
});

it('a failed merge save shows one error toast (the parent catches; MergeUI adds none)', async () => {
  (api.saveIndividual as jest.Mock).mockRejectedValueOnce(outage);
  const { getByText, findByText } = render(
    <TranscriptionResults result={baseResult({ potential_matches: [serverJohn] })} onSave={jest.fn()} onCancel={jest.fn()} />
  );
  await waitFor(() => getByText('Save'));
  fireEvent.press(getByText('Save'));
  fireEvent.press(await findByText('Merge'));
  await waitFor(() => expect(api.saveIndividual).toHaveBeenCalled());
  await waitFor(() => expect(Toast.show).toHaveBeenCalled());
  expect(Toast.show).toHaveBeenCalledTimes(1);
});

// C-35: a failed category load offers Retry instead of a fieldless form whose Save
// skips the required-field check.
describe('category load failure (C-35)', () => {
  it('shows the error with Retry and no Save; Retry loads the fields', async () => {
    (api.getCategories as jest.Mock).mockRejectedValueOnce(outage);
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    const screen = render(<TranscriptionResults result={baseResult()} onSave={jest.fn()} onCancel={jest.fn()} />);
    await waitFor(() => screen.getByText("Couldn't load form fields"));
    expect(screen.getByText('Server error. Please try again.')).toBeTruthy();
    expect(screen.queryByText('Save')).toBeNull();
    expect(alert).not.toHaveBeenCalled();

    fireEvent.press(screen.getByText('Retry'));
    await waitFor(() => screen.getByText('Save'));
    expect(screen.getByDisplayValue('Ann')).toBeTruthy();
  });

  // Fix round 1: what was said stays readable (and copyable) during the outage
  it('keeps the transcription on screen above the retry block', async () => {
    (api.getCategories as jest.Mock).mockRejectedValueOnce(outage);
    const screen = render(<TranscriptionResults result={baseResult()} onSave={jest.fn()} onCancel={jest.fn()} />);
    await waitFor(() => screen.getByText('Retry'));
    expect(screen.getByText('hello there').props.selectable).toBe(true);
  });

  it('Cancel on the retry screen leaves the review', async () => {
    (api.getCategories as jest.Mock).mockRejectedValueOnce(outage);
    const onCancel = jest.fn();
    const screen = render(<TranscriptionResults result={baseResult()} onSave={jest.fn()} onCancel={onCancel} />);
    await waitFor(() => screen.getByText('Retry'));
    fireEvent.press(screen.getByText('Cancel'));
    expect(onCancel).toHaveBeenCalled();
  });
});

// Carried item: labels come from display_name ("HIV status", not "Hiv Status"), and
// additional_information is a multiline box (the old check looked for a space).
describe('field labels and long text', () => {
  const extraCategories = [
    { id: '1', name: 'name', display_name: 'Name', type: 'text', is_required: true, priority: 'high', urgency_weight: 0, auto_trigger: false },
    { id: '7', name: 'hiv_status', display_name: 'HIV status', type: 'text', is_required: false, priority: 'high', urgency_weight: 0, auto_trigger: false },
    { id: '8', name: 'additional_information', display_name: null, type: 'text', is_required: false, priority: 'low', urgency_weight: 0, auto_trigger: false },
  ];

  it('uses display_name, else the title-cased key', async () => {
    (api.getCategories as jest.Mock).mockResolvedValueOnce(extraCategories);
    const screen = render(
      <TranscriptionResults result={baseResult({ categorized_data: { name: 'Ann' } })} onSave={jest.fn()} onCancel={jest.fn()} />);
    await waitFor(() => screen.getByText('Save'));
    expect(screen.getByText('HIV status')).toBeTruthy();
    expect(screen.queryByText('Hiv Status')).toBeNull();
    expect(screen.getByText('Additional Information')).toBeTruthy();
  });

  it('additional_information is multiline with its own placeholder', async () => {
    (api.getCategories as jest.Mock).mockResolvedValueOnce(extraCategories);
    const screen = render(
      <TranscriptionResults result={baseResult({ categorized_data: { name: 'Ann' } })} onSave={jest.fn()} onCancel={jest.fn()} />);
    await waitFor(() => screen.getByText('Save'));
    const input = screen.getByPlaceholderText(/other relevant information/);
    expect(input.props.multiline).toBe(true);
  });
});

// C-62 guard (not a regression test: this screen's colours were already right; the
// inverted ones were MergeUI's, see MergeUI.test). Keeps both screens on one helper.
it('guard: colours a strong match with the shared confidence colours', async () => {
  const screen = render(
    <TranscriptionResults
      result={baseResult({ potential_matches: [{ id: MATCH_ID, name: 'Anne Lee', confidence: 97 }] })}
      onSave={jest.fn()} onCancel={jest.fn()} />);
  await waitFor(() => screen.getByText('Anne Lee'));
  const { StyleSheet } = require('react-native');
  const { confidenceColor } = require('../../utils/duplicateMatches');
  expect(StyleSheet.flatten(screen.getByText(/97% match/).props.style).color).toBe(confidenceColor(97).text);
});
