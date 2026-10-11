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
    is_preset: false, urgency_weight: 0, auto_trigger: false },
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
