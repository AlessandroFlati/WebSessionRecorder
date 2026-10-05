/**
 * Checks the settings helpers.
 *
 * `matchesAny` decides whether recording starts by itself, so it is worth being sure about:
 * too loose and the recorder arms on pages nobody meant it to, too strict and the feature
 * quietly never fires. The patterns are typed by hand, so one that will not compile must be
 * skipped rather than throw during a navigation.
 *
 * Run: node tools/test_settings.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '../src/common/constants.js'), 'utf8');

let failures = 0;
function check(name, condition, detail) {
  if (condition) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.log(`  FAIL ${name}${detail ? ' :: ' + detail : ''}`);
  }
}

// an ES module read as text, evaluated with its exports collected
const exported = {};
vm.runInNewContext(source.replace(/export (function|const) /g, '$1 ') + '\n' +
  'exported.matchesAny = matchesAny; exported.hostOf = hostOf; exported.formatBytes = formatBytes; exported.DEFAULT_SETTINGS = DEFAULT_SETTINGS;',
  { exported, URL });
const { matchesAny, hostOf, formatBytes, DEFAULT_SETTINGS } = exported;

console.log('auto-record is off until it is asked for');
check('off by default', DEFAULT_SETTINGS.autoRecord === false);
check('and has nothing to match', DEFAULT_SETTINGS.autoRecordPatterns.length === 0);
check('an empty list matches nothing', !matchesAny('https://example.com/', []));
check('so does a list of blanks', !matchesAny('https://example.com/', ['', '   ']));

console.log('\nmatching');
check('an exact url', matchesAny('https://example.com/app', ['https://example.com/app']));
check('a path wildcard', matchesAny('https://example.com/app/x/y', ['https://example.com/app/*']));
check('a scheme and host wildcard', matchesAny('http://a.example.org/app/z', ['*://*.example.org/app/*']));
check('case is ignored in the host', matchesAny('https://EXAMPLE.com/app', ['https://example.com/*']));

console.log('\nnot matching');
check('a different host', !matchesAny('https://evil.com/app', ['https://example.com/*']));
check('a host that merely ends the same way',
  !matchesAny('https://notexample.com/app', ['https://example.com/*']));
check('a prefix without the wildcard', !matchesAny('https://example.com/app/x', ['https://example.com/app']));
check('a pattern is anchored at both ends', !matchesAny('https://example.com/app/x', ['example.com/app']));

console.log('\nawkward input');
check('a pattern that cannot compile is skipped, not thrown',
  matchesAny('https://example.com/app', ['[unclosed', 'https://example.com/*']));
check('a missing url is simply no match', !matchesAny(null, ['https://example.com/*']));
check('a non-list is no match', !matchesAny('https://example.com/', null));
check('a dot is a dot, not any character',
  !matchesAny('https://exampleXcom/app', ['https://example.com/*']));

console.log('\nlabels');
check('a host comes out of a url', hostOf('https://example.com/a/b') === 'example.com');
check('nonsense gives null rather than throwing', hostOf('not a url') === null);
check('bytes read sensibly', formatBytes(1536) === '1.5 KB' && formatBytes(0) === '0 B',
  `${formatBytes(1536)} / ${formatBytes(0)}`);

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
