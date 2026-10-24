// Release config drift checks (H2-8.6): the Maestro flows stay in step with app.json
// and with the testIDs in the source.
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '..');
const MAESTRO = path.join(ROOT, '.maestro');
const SOURCE_DIRS = ['components', 'screens', 'navigation', 'App.tsx'];

const read = (f: string) => fs.readFileSync(path.join(MAESTRO, f), 'utf8');

function sourceFiles(entry: string): string[] {
  const full = path.join(ROOT, entry);
  if (fs.statSync(full).isFile()) return [full];
  return fs.readdirSync(full, { withFileTypes: true }).flatMap(d =>
    d.name === '__tests__' ? [] : d.isDirectory() ? sourceFiles(path.join(entry, d.name))
      : /\.tsx?$/.test(d.name) ? [path.join(full, d.name)] : []);
}

const SOURCE = SOURCE_DIRS.flatMap(sourceFiles).map(f => fs.readFileSync(f, 'utf8')).join('\n');

// testID="x" (or a prop ending in TestID), or a template testID={`x-${...}`} for "x-0"
function sourceHasTestId(id: string): boolean {
  const literal = new RegExp(`[A-Za-z]*(testID|TestID)=["'{]+${id.replace(/[-]/g, '\\-')}["'}]`);
  if (literal.test(SOURCE)) return true;
  const prefix = id.replace(/\d+$/, '');
  return prefix !== id && SOURCE.includes(`testID={\`${prefix}\${`);
}

describe('Maestro flows', () => {
  const flows = fs.existsSync(MAESTRO) ? fs.readdirSync(MAESTRO).filter(f => f.endsWith('.yaml')) : [];

  it('has the five flows', () => expect(flows).toHaveLength(5));

  it('every flow targets the app.json bundle id', () => {
    const id = require('../app.json').expo.ios.bundleIdentifier;
    flows.forEach(f => expect(read(f)).toMatch(new RegExp(`^appId: ${id.replace(/\./g, '\\.')}$`, 'm')));
  });

  it('every id a flow taps exists as a testID in the source', () => {
    const ids = [...new Set(flows.flatMap(f => [...read(f).matchAll(/id: "([^"]+)"/g)].map(m => m[1])))];
    expect(ids.length).toBeGreaterThan(0);
    ids.forEach(id => expect([id, sourceHasTestId(id)]).toEqual([id, true]));
  });

  it('the drift check catches a missing testID', () => {
    expect(sourceHasTestId('no-such-test-id')).toBe(false);
  });
});
