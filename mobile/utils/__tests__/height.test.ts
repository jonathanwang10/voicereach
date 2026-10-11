import { parseHeightToInches } from '../height';

// The backend treats a NUMERIC height as inches; only a bare numeric STRING from 1 to 9
// is feet. The app therefore converts before sending (C-15).
test.each([
  ["5'10", 70],
  ['70', 70],
  [70, 70],
  ['6 ft', 72],
  ['6', 72], // bare 1-9 is feet
  ['5.5', 66], // decimal feet
  ['70.5', 70.5], // decimal inches
  ['5 ft 10', 70],
  ['5 feet 10 inches', 70],
  ['5\'10"', 70],
  ['5′10″', 70],
  ['5, 10', 70],
  ['5.5 feet', 66],
  ['70 in', 70],
  ['6 in', 6], // an explicit inch unit is never feet
  ['178 cm', 70.1],
  ['1.78 m', 70.1],
  [6, 6], // a number is already inches (idempotent with the backend)
])('parses %p as %p inches', (raw, inches) => {
  expect(parseHeightToInches(raw)).toBe(inches);
});

test.each([[''], ['  '], [null], [undefined], ['tall'], ["5'13"], [true]])('%p is not a height', raw => {
  expect(parseHeightToInches(raw)).toBeNull();
});
