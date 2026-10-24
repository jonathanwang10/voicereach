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

describe('EAS build profiles (H2-8.7)', () => {
  const easPath = path.join(ROOT, 'eas.json');
  const eas = () => JSON.parse(fs.readFileSync(easPath, 'utf8'));

  it('has development, preview and production profiles', () =>
    expect(Object.keys(eas().build).sort()).toEqual(['development', 'preview', 'production']));

  it('development is a simulator debug build and needs no expo-dev-client', () => {
    expect(eas().build.development).toMatchObject({
      distribution: 'internal', ios: { simulator: true, buildConfiguration: 'Debug' } });
    expect(eas().build.development.developmentClient).toBeUndefined();
  });

  it('preview is an internal release build; production auto-increments', () => {
    expect(eas().build.preview).toMatchObject({ distribution: 'internal', ios: { buildConfiguration: 'Release' } });
    expect(eas().build.production).toMatchObject({ autoIncrement: true });
    expect(eas().cli).toMatchObject({ appVersionSource: 'remote' });
  });
});
