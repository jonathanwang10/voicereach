// A merge whose person someone else saved since the review screen loaded it is a 409
// (the backend's individuals.version guard, H2-2.3). The screens show this message and
// reload the person.
export const VERSION_CONFLICT_MESSAGE = 'This person was changed by someone else. Reload and try again.';

// Duck-typed on `status`, so a test that mocks services/api (and its ApiError) still works.
export const isVersionConflict = (e: unknown): boolean => (e as any)?.status === 409;
