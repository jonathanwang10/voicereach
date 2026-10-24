// expo-sqlite is native. One shared fake database whose methods are jest.fns; tests
// script getAllAsync / runAsync results and read the SQL they were given. `__db` is
// the database openDatabaseAsync resolves.
const db = {
  execAsync: jest.fn(async () => undefined),
  runAsync: jest.fn(async () => ({ changes: 0, lastInsertRowId: 0 })),
  getAllAsync: jest.fn(async () => []),
  getFirstAsync: jest.fn(async () => null),
  withTransactionAsync: jest.fn(async fn => fn()),
};

module.exports = {
  __db: db,
  openDatabaseAsync: jest.fn(async () => db),
};
