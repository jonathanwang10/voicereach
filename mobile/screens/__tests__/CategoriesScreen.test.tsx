// Categories tab: OD-2 / C-07 (options and weight inputs), R-8 / C-36 (no local-only
// edit or ON/OFF toggles), C-53 (labels keep their casing; required, not a
// hardcoded list, marks essential fields), R-9 / C-44 (export opens the share sheet).
import React from 'react';
import { Alert } from 'react-native';
import { fireEvent, render, waitFor } from '@testing-library/react-native';

jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
jest.mock('../../services/api', () => ({
  api: { createCategory: jest.fn() },
}));
jest.mock('../../utils/csvExport', () => ({
  shareCsvExport: jest.fn(),
}));
const mockRefresh = jest.fn();
const mockCategories = [
  { id: '1', name: 'name', display_name: 'Name', type: 'text', priority: 'high', is_required: true,
    is_preset: true, urgency_weight: 0, auto_trigger: false },
  { id: '2', name: 'age', display_name: 'Age', type: 'number', priority: 'medium', is_required: false,
    is_preset: true, urgency_weight: 0, auto_trigger: false },
  { id: '3', name: 'hiv_status', display_name: 'HIV status', type: 'text', priority: 'low', is_required: false,
    is_preset: false, urgency_weight: 0, auto_trigger: false, is_sensitive: true },
  { id: '4', name: 'housing_priority', display_name: null, type: 'single_select', priority: 'high',
    is_required: false, is_preset: false, urgency_weight: 30, auto_trigger: false,
    options: [{ label: 'High', value: 1 }] },
];
let mockLoadError: string | null = null;
jest.mock('../../contexts/CategoryContext', () => ({
  useCategories: () => ({
    categories: mockLoadError ? [] : mockCategories,
    isLoading: false,
    error: mockLoadError,
    refreshCategories: mockRefresh,
  }),
}));

import CategoriesScreen from '../CategoriesScreen';
import { api } from '../../services/api';
import { shareCsvExport } from '../../utils/csvExport';

let alertSpy: jest.SpyInstance;
beforeEach(() => {
  jest.clearAllMocks();
  mockLoadError = null;
  alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  (api.createCategory as jest.Mock).mockResolvedValue({ id: 'new' });
});

const chooseType = (screen: ReturnType<typeof render>, label: string) => {
  const order = ['text', 'number', 'single-select', 'multi-select', 'date', 'location'];
  for (let i = 0; i < order.indexOf(label); i++) fireEvent.press(screen.getByText(order[i]));
  expect(screen.getByText(label)).toBeTruthy();
};

// C-35: a failed load says so and offers Retry, instead of "0 categories" all session.
describe('category load failure (C-35)', () => {
  it('shows the error with Retry, not an empty list', () => {
    mockLoadError = 'No connection to the server. Check your network and try again.';
    const screen = render(<CategoriesScreen />);
    expect(screen.getByText("Couldn't load categories")).toBeTruthy();
    expect(screen.getByText(/No connection to the server/)).toBeTruthy();
    expect(screen.queryByText(/^0 categories/)).toBeNull();
    expect(screen.queryByText(/0 categories/)).toBeNull(); // nor in the export line
    fireEvent.press(screen.getByText('Retry'));
    expect(mockRefresh).toHaveBeenCalledTimes(1);
  });
});

describe('category list (C-36, C-53)', () => {
  it('has no Edit button and no ON/OFF toggles (categories are create-only)', () => {
    const screen = render(<CategoriesScreen />);
    expect(screen.queryByText('Edit')).toBeNull();
    expect(screen.queryByText('ON')).toBeNull();
    expect(screen.queryByText('OFF')).toBeNull();
    expect(screen.queryByText(/active categor/i)).toBeNull();
  });

  it('shows display names with their casing, else the title-cased key', () => {
    const screen = render(<CategoriesScreen />);
    expect(screen.getByText('HIV status')).toBeTruthy();
    expect(screen.getByText('Housing Priority')).toBeTruthy();
    expect(screen.getByText('Weight: 30')).toBeTruthy();
  });

  it('marks only required categories essential (age is not)', () => {
    const screen = render(<CategoriesScreen />);
    expect(screen.getAllByText('ESSENTIAL')).toHaveLength(1);
  });
});

describe('add category form (C-07, OD-2)', () => {
  it('creates a single-select category with options and a weight', async () => {
    const screen = render(<CategoriesScreen />);
    fireEvent.changeText(screen.getByPlaceholderText('Category name'), ' Mood ');
    chooseType(screen, 'single-select');
    fireEvent.changeText(screen.getByPlaceholderText(/Calm, Agitated=0\.5/), 'Calm, Agitated=0.5, Violent=1');
    fireEvent.changeText(screen.getByPlaceholderText('0-100'), '35');
    fireEvent.press(screen.getByText('Add Category'));
    await waitFor(() => expect(api.createCategory).toHaveBeenCalled());
    expect((api.createCategory as jest.Mock).mock.calls[0][0]).toEqual({
      name: 'Mood', type: 'single_select', is_required: false, priority: 'medium',
      urgency_weight: 35, auto_trigger: false,
      options: [{ label: 'Calm', value: 0 }, { label: 'Agitated', value: 0.5 }, { label: 'Violent', value: 1 }],
      number_scale_max: null,
      is_sensitive: false,
    });
    await waitFor(() => expect(mockRefresh).toHaveBeenCalled());
  });

  it('creates a multi-select category with string options and no weight input', async () => {
    const screen = render(<CategoriesScreen />);
    fireEvent.changeText(screen.getByPlaceholderText('Category name'), 'Pets');
    chooseType(screen, 'multi-select');
    expect(screen.queryByPlaceholderText('0-100')).toBeNull();
    fireEvent.changeText(screen.getByPlaceholderText(/Dog, Cat/), 'Dog, Cat');
    fireEvent.press(screen.getByText('Add Category'));
    await waitFor(() => expect(api.createCategory).toHaveBeenCalled());
    const payload = (api.createCategory as jest.Mock).mock.calls[0][0];
    expect(payload.options).toEqual(['Dog', 'Cat']);
    expect(payload.urgency_weight).toBe(0);
  });

  it('shows the weight input for number categories and hides the options box', () => {
    const screen = render(<CategoriesScreen />);
    chooseType(screen, 'number');
    expect(screen.getByPlaceholderText('0-100')).toBeTruthy();
    expect(screen.queryByPlaceholderText(/comma/i)).toBeNull();
  });

  it('blocks a select category without options, before calling the API', () => {
    const screen = render(<CategoriesScreen />);
    fireEvent.changeText(screen.getByPlaceholderText('Category name'), 'Mood');
    chooseType(screen, 'single-select');
    fireEvent.press(screen.getByText('Add Category'));
    expect(api.createCategory).not.toHaveBeenCalled();
    expect(alertSpy).toHaveBeenCalledWith('Error', expect.stringMatching(/at least one option/i));
  });

  // H2-2.8
  it('shows Scale max only for number categories and sends it', async () => {
    const screen = render(<CategoriesScreen />);
    fireEvent.changeText(screen.getByPlaceholderText('Category name'), 'Days without food');
    chooseType(screen, 'number');
    expect(screen.getByText('Scale max (optional)')).toBeTruthy();
    fireEvent.changeText(screen.getByPlaceholderText('300'), '10');
    fireEvent.press(screen.getByText('Add Category'));
    await waitFor(() => expect(api.createCategory).toHaveBeenCalled());
    expect(api.createCategory).toHaveBeenCalledWith(expect.objectContaining({ number_scale_max: 10 }));
  });

  it('hides Scale max for single-select', () => {
    const screen = render(<CategoriesScreen />);
    chooseType(screen, 'single-select');
    expect(screen.queryByText('Scale max (optional)')).toBeNull();
    expect(screen.queryByPlaceholderText('300')).toBeNull();
  });

  it('blocks a scale max of 0 before calling the API', () => {
    const screen = render(<CategoriesScreen />);
    fireEvent.changeText(screen.getByPlaceholderText('Category name'), 'Days');
    chooseType(screen, 'number');
    fireEvent.changeText(screen.getByPlaceholderText('300'), '0');
    fireEvent.press(screen.getByText('Add Category'));
    expect(api.createCategory).not.toHaveBeenCalled();
    expect(alertSpy).toHaveBeenCalledWith('Error', 'Scale max must be a number greater than 0');
  });

  // H2-3.8
  it('a sensitive-looking name turns Sensitive on and hides the urgency weight', () => {
    const screen = render(<CategoriesScreen />);
    chooseType(screen, 'number');
    fireEvent.changeText(screen.getByPlaceholderText('Category name'), 'HIV viral load');
    expect(screen.getByText('Sensitive field: ON')).toBeTruthy();
    expect(screen.getByText("Detected from the name. Sensitive fields can't affect urgency.")).toBeTruthy();
    expect(screen.queryByPlaceholderText('0-100')).toBeNull();
  });

  it('the Sensitive toggle sends is_sensitive with no weight', async () => {
    const screen = render(<CategoriesScreen />);
    fireEvent.changeText(screen.getByPlaceholderText('Category name'), 'Mood');
    chooseType(screen, 'number');
    fireEvent.changeText(screen.getByPlaceholderText('0-100'), '35');
    fireEvent.press(screen.getByText('Sensitive field: OFF'));
    fireEvent.press(screen.getByText('Add Category'));
    await waitFor(() => expect(api.createCategory).toHaveBeenCalled());
    expect(api.createCategory).toHaveBeenCalledWith(expect.objectContaining({ is_sensitive: true, urgency_weight: 0 }));
  });

  it('lists a Sensitive badge for sensitive categories', () => {
    const screen = render(<CategoriesScreen />);
    expect(screen.getByText('Sensitive')).toBeTruthy();
  });

  it('blocks a name with no letters or digits', () => {
    const screen = render(<CategoriesScreen />);
    fireEvent.changeText(screen.getByPlaceholderText('Category name'), '  --- ');
    fireEvent.press(screen.getByText('Add Category'));
    expect(api.createCategory).not.toHaveBeenCalled();
  });
});

describe('export (C-44, R-9)', () => {
  it('opens the share sheet through shareCsvExport, with no "ready for download" alert', async () => {
    (shareCsvExport as jest.Mock).mockResolvedValue(undefined);
    const screen = render(<CategoriesScreen />);
    fireEvent.press(screen.getByText('Export CSV'));
    await waitFor(() => expect(shareCsvExport).toHaveBeenCalled());
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it('says when the export fails', async () => {
    (shareCsvExport as jest.Mock).mockRejectedValue(new Error('Sharing is not available on this device'));
    const screen = render(<CategoriesScreen />);
    fireEvent.press(screen.getByText('Export CSV'));
    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith('Export Failed', expect.any(String)));
  });
});
