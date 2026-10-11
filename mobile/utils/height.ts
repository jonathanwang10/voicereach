// Height parsing for the app, matching backend field_registry.parse_height_inches.
//
// The backend treats a NUMERIC height as inches and only a bare numeric STRING from
// 1 to 9 as feet, so the app converts here and always sends inches as a number.
// - a number is already inches (values from /api/transcribe are normalised);
// - a bare numeric string: 1-9 (including decimals like "5.5") is feet, else inches;
// - "5'10", "5′10″", "5 ft 10", "5 feet 10 inches", "5.5 feet", "5, 10";
// - "70 in", "70 inches" (an explicit inch unit is never feet);
// - "178 cm", "1.78 m".
// Returns inches rounded to 0.1, or null if the text is not a height.

const round1 = (n: number) => Math.round(n * 10) / 10;
const bareHeight = (n: number) => (n >= 1 && n < 10 ? n * 12 : n);

const NUM = '(\\d+(?:\\.\\d+)?)';
const FEET_INCHES = new RegExp(`^${NUM}\\s*(?:'|ft|feet|foot)\\s*,?\\s*(?:${NUM}\\s*(?:"|in|inch|inches)?)?$`);
const FEET_COMMA_INCHES = new RegExp(`^(\\d)\\s*,\\s*${NUM}$`);
const INCHES = new RegExp(`^${NUM}\\s*(?:"|in|inch|inches)$`);
const CM = new RegExp(`^${NUM}\\s*(?:cm|centimeters?|centimetres?)$`);
const METERS = new RegExp(`^${NUM}\\s*(?:m|meters?|metres?)$`);

export const parseHeightToInches = (raw: any): number | null => {
  if (typeof raw === 'number') return Number.isFinite(raw) ? round1(raw) : null;
  if (typeof raw !== 'string') return null;
  const value = raw
    .trim()
    .toLowerCase()
    .replace(/[′’‘]/g, "'")
    .replace(/[″”“]/g, '"');
  if (value.length === 0) return null;

  if (/^\d+(?:\.\d+)?$/.test(value)) return round1(bareHeight(parseFloat(value)));

  const feetInches = value.match(FEET_INCHES) || value.match(FEET_COMMA_INCHES);
  if (feetInches) {
    const inches = feetInches[2] ? parseFloat(feetInches[2]) : 0;
    if (inches >= 12) return null; // "5'13" is a typo, not 5 feet
    return round1(parseFloat(feetInches[1]) * 12 + inches);
  }

  const inches = value.match(INCHES);
  if (inches) return round1(parseFloat(inches[1]));

  const cm = value.match(CM);
  if (cm) return round1(parseFloat(cm[1]) / 2.54);

  const meters = value.match(METERS);
  if (meters) return round1((parseFloat(meters[1]) * 100) / 2.54);

  return null;
};

export const inchesToFeetInchesString = (inchesTotal: number): string => {
  const feet = Math.floor(inchesTotal / 12);
  const inches = Math.round(inchesTotal % 12);
  return `${feet}'${inches}`;
};

export const normalizeHeightToStandardString = (raw: any): string | null => {
  const inches = parseHeightToInches(raw);
  if (inches === null) return null;
  return inchesToFeetInchesString(inches);
};
