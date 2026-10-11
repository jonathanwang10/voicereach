// R-14 (C-50): the app never logs case data, and its debug logs stay out of release builds.
// iOS release builds still write console output to the unified log, readable from any
// Mac the phone is plugged into. A source scan, so a new log can't slip in later:
//   1. every console.* call is guarded on the same line: `if (__DEV__) console.warn(...)`
//      or `__DEV__ && console.warn(...)`;
//   2. no console.* call passes a data-bearing variable (names, transcripts, GPS, URIs,
//      search terms, results...), even in development. Error objects are fine.
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '..');
const SKIP_DIRS = new Set(['node_modules', 'ios', 'android', '__tests__', 'test', '.expo', 'dist', 'coverage']);
const SOURCE = /\.(ts|tsx|js|jsx)$/;

// Words (from identifiers, split on camelCase) that mean "this is case data".
const DATA_WORDS = new Set([
  'transcript', 'transcription', 'transcribed', 'uri', 'url', 'location', 'coords', 'latitude', 'longitude',
  'address', 'gps', 'individual', 'individuals', 'person', 'people', 'data', 'result', 'results',
  'query', 'search', 'question', 'text', 'csv', 'name', 'form', 'field', 'fields', 'categorized',
  'match', 'matches', 'body', 'payload', 'response', 'value', 'values', 'message', 'messages',
]);

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) out.push(...sourceFiles(path.join(dir, entry.name)));
    } else if (SOURCE.test(entry.name) && !/\.test\./.test(entry.name) && !entry.name.endsWith('.d.ts')) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

// The text between the call's parentheses (starting at the index of its '(').
function callArgs(src: string, open: number): string {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')' && --depth === 0) return src.slice(open + 1, i);
  }
  return src.slice(open + 1);
}

// Identifiers in the arguments, ignoring string literal text but keeping ${...} expressions.
function argWords(args: string): string[] {
  const code = args
    .replace(/`(?:[^`\\]|\\.)*`/g, t => (t.match(/\$\{[^}]*\}/g) || []).join(' '))
    .replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"/g, '');
  // Error details are fine: `error.message` names the error, not the person.
  const withoutErrors = code.replace(/\b(e|err|error)\.message\b/g, '$1');
  const identifiers = withoutErrors.match(/[A-Za-z_$][\w$]*/g) || [];
  return identifiers.flatMap(id => id.split(/(?=[A-Z])|_/).map(w => w.toLowerCase()).filter(Boolean));
}

export function findLogProblems(src: string, file: string): string[] {
  const problems: string[] = [];
  const re = /\bconsole\.(log|info|warn|error|debug|trace)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const lineNo = src.slice(0, m.index).split('\n').length;
    const lineStart = src.lastIndexOf('\n', m.index) + 1;
    const before = src.slice(lineStart, m.index);
    if (!before.includes('__DEV__')) problems.push(`${file}:${lineNo} console.${m[1]} is not guarded by __DEV__`);
    const data = argWords(callArgs(src, m.index + m[0].length - 1)).filter(w => DATA_WORDS.has(w));
    if (data.length) problems.push(`${file}:${lineNo} console.${m[1]} logs data (${[...new Set(data)].join(', ')})`);
  }
  return problems;
}

describe('the scanner itself', () => {
  it.each([
    ["if (__DEV__) console.warn('Failed to start recording:', error);", 0],
    ["if (__DEV__ && (e as Error)?.message !== 'cancelled') console.warn('Playback failed:', e);", 0],
    ["__DEV__ && console.error(`Auto-login failed: ${error.message}`);", 0],
    ["if (__DEV__) console.warn('Location capture failed, continuing without location:', err);", 0],
    ["console.error('Upload error:', error);", 1],
    ["if (__DEV__) console.log('Recording completed:', uri, location);", 1],
    ["if (__DEV__) console.log(`Searching for ${searchQuery}`);", 1],
    ["console.log('Transcription:', result.transcription);", 2],
    ["if (__DEV__) console.log('Saved',\n  individual.name);", 1],
  ])('%s -> %i problem(s)', (src, n) => {
    expect(findLogProblems(src as string, 'x.ts')).toHaveLength(n as number);
  });
});

describe('app source', () => {
  it('finds the source files', () => {
    const files = sourceFiles(ROOT).map(f => path.relative(ROOT, f));
    expect(files).toEqual(expect.arrayContaining(['App.tsx', 'services/api.ts', 'screens/ModernVoiceAssistantScreen.tsx']));
  });

  it('has no unguarded or data-bearing console calls', () => {
    const problems = sourceFiles(ROOT).flatMap(f => findLogProblems(fs.readFileSync(f, 'utf8'), path.relative(ROOT, f)));
    expect(problems).toEqual([]);
  });
});
