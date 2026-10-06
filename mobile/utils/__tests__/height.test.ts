import { parseHeightToInches } from '../height';

test.each([["5'10", 70], ['70', 70], [70, 70], ['6 ft', 72]])('parses %p', (raw, inches) => {
  expect(parseHeightToInches(raw)).toBe(inches);
});
