'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ALLOWED_TYPOGRAPHY = new Set(['←', '→', '✓', '★', '+']);
const FORBIDDEN_TEXT_PICTOGRAPHS = new Set(['\u21bb']);
const SOURCE_EXTENSIONS = new Set(['.html', '.js', '.css']);
const EXCLUDED_DIRECTORIES = new Set(['node_modules', 'test', 'scripts']);
const segmenter = new Intl.Segmenter('und', { granularity: 'grapheme' });

const emojiPresentationPattern = /\p{Emoji_Presentation}/u;
const extendedPictographicPattern = /\p{Extended_Pictographic}/u;
const regionalIndicatorPattern = /\p{Regional_Indicator}/u;
const emojiModifierPattern = /\p{Emoji_Modifier}/u;
const emojiControlPattern = /[\u200D\u20E3\uFE0F]/u;

function isForbiddenGrapheme(grapheme) {
  if (ALLOWED_TYPOGRAPHY.has(grapheme)) return false;
  if (FORBIDDEN_TEXT_PICTOGRAPHS.has(grapheme)) return true;
  return emojiPresentationPattern.test(grapheme)
    || extendedPictographicPattern.test(grapheme)
    || regionalIndicatorPattern.test(grapheme)
    || emojiModifierPattern.test(grapheme)
    || emojiControlPattern.test(grapheme);
}

function findForbiddenEmoji(source, file = '<memory>') {
  const findings = [];
  const lines = source.split(/\r?\n/);
  lines.forEach((line, index) => {
    for (const { segment, index: columnIndex } of segmenter.segment(line)) {
      if (!isForbiddenGrapheme(segment)) continue;
      findings.push({
        file,
        line: index + 1,
        column: columnIndex + 1,
        symbol: segment,
      });
    }
  });
  return findings;
}

function listUserFacingSources(root) {
  const files = [];
  function walk(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRECTORIES.has(entry.name)) walk(path.join(current, entry.name));
        continue;
      }
      if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) files.push(path.join(current, entry.name));
    }
  }
  walk(root);
  return files.sort();
}

function scanClientSources(root = path.resolve(__dirname, '..')) {
  return listUserFacingSources(root).flatMap((file) => {
    const relative = path.relative(path.dirname(root), file);
    return findForbiddenEmoji(fs.readFileSync(file, 'utf8'), relative);
  });
}

function printFindings(findings) {
  for (const finding of findings) {
    process.stderr.write(
      `${finding.file}:${finding.line}:${finding.column} forbidden UI symbol ${JSON.stringify(finding.symbol)}\n`,
    );
  }
}

function runCli() {
  if (process.argv.includes('--mutation-proof')) {
    const mutation = `status ${String.fromCodePoint(0x1F4A5)}`;
    const findings = findForbiddenEmoji(mutation, 'mutation-proof.html');
    printFindings(findings);
    process.exitCode = findings.length ? 1 : 0;
    return;
  }

  const findings = scanClientSources();
  if (findings.length) {
    printFindings(findings);
    process.exitCode = 1;
    return;
  }
  process.stdout.write('No forbidden emoji-like symbols found in user-facing client sources.\n');
}

if (require.main === module) runCli();

module.exports = {
  ALLOWED_TYPOGRAPHY,
  findForbiddenEmoji,
  isForbiddenGrapheme,
  listUserFacingSources,
  scanClientSources,
};
