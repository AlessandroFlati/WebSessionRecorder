/**
 * Syntax check for every JavaScript file in the project.
 *
 * `node --check <file>` cannot be trusted here: given a path it parses as CommonJS and
 * returns success even when the file is a broken ES module, which let a real syntax
 * error reach the browser. Parsing from stdin with an explicit --input-type does report
 * the error, so each file is parsed both as a module and as a script and is only
 * reported broken when both fail. A valid module fails the script parse (import/export)
 * and a valid classic script passes both, so nothing legitimate is flagged.
 *
 * Run: node tools/check_syntax.js
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const roots = ['src', 'tools'];
const repo = path.resolve(__dirname, '..');

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

function parse(file, type) {
  const source = fs.readFileSync(file);
  const result = spawnSync(process.execPath, ['--input-type=' + type, '--check'], { input: source, encoding: 'utf8' });
  return { ok: result.status === 0, stderr: result.stderr || '' };
}

let broken = 0;
let checked = 0;
for (const root of roots) {
  const dir = path.join(repo, root);
  if (!fs.existsSync(dir)) continue;
  for (const file of walk(dir)) {
    checked++;
    const asModule = parse(file, 'module');
    if (asModule.ok) continue;
    const asScript = parse(file, 'commonjs');
    if (asScript.ok) continue;
    broken++;
    const relative = path.relative(repo, file).replace(/\\/g, '/');
    const message = (asModule.stderr.split('\n').find((l) => /Error/.test(l)) || '').trim();
    const where = (asModule.stderr.match(/\[stdin\]:(\d+)/) || [])[1];
    console.log(`BROKEN ${relative}${where ? ':' + where : ''}  ${message}`);
  }
}

console.log(broken ? `\n${broken} of ${checked} files failed to parse` : `all ${checked} files parse`);
process.exit(broken ? 1 : 0);
