/** Generate deterministic test-only en-XA messages while preserving ICU syntax and identifiers. */

const fs = require('node:fs');
const path = require('node:path');

const { parse, TYPE } = require('@formatjs/icu-messageformat-parser');

const projectRoot = path.resolve(__dirname, '../..');
const canonicalPath = path.join(projectRoot, 'src', 'i18n', 'messages', 'en-US.json');
const outputPath = path.join(projectRoot, 'src', 'i18n', 'generated', 'en-XA.json');
const ACCENTS = new Map(
  Object.entries({
    A: 'Å', B: 'Ɓ', C: 'Ç', D: 'Ð', E: 'É', F: 'Ƒ', G: 'Ĝ', H: 'Ħ', I: 'Î', J: 'Ĵ',
    K: 'Ķ', L: 'Ŀ', M: 'Ṁ', N: 'Ñ', O: 'Ö', P: 'Þ', Q: 'Ǫ', R: 'Ŕ', S: 'Š', T: 'Ŧ',
    U: 'Û', V: 'Ṽ', W: 'Ŵ', X: 'Ẋ', Y: 'Ý', Z: 'Ž',
    a: 'å', b: 'ƀ', c: 'ç', d: 'ð', e: 'é', f: 'ƒ', g: 'ĝ', h: 'ħ', i: 'î', j: 'ĵ',
    k: 'ķ', l: 'ŀ', m: 'ṁ', n: 'ñ', o: 'ö', p: 'þ', q: 'ǫ', r: 'ŕ', s: 'š', t: 'ŧ',
    u: 'û', v: 'ṽ', w: 'ŵ', x: 'ẋ', y: 'ý', z: 'ž',
  }),
);

/** Expand and accent only literal prose; ICU arguments, tags, and branch syntax stay untouched. */
function pseudoLiteral(value) {
  return [...value]
    .map((character) => {
      const accented = ACCENTS.get(character) ?? character;
      return /[aeiouAEIOU]/.test(character) ? `${accented}${accented}` : accented;
    })
    .join('');
}

/** Collect every nested ICU literal location so raw source slices retain ICU apostrophe escaping. */
function collectLiteralRanges(elements, ranges) {
  for (const element of elements) {
    if (element.type === TYPE.literal && element.location) {
      ranges.push({
        start: element.location.start.offset,
        end: element.location.end.offset,
      });
    }
    if (element.type === TYPE.tag) collectLiteralRanges(element.children, ranges);
    if (element.type === TYPE.select || element.type === TYPE.plural) {
      for (const option of Object.values(element.options)) {
        collectLiteralRanges(option.value, ranges);
      }
    }
  }
}

/** Transform one ICU message and reparse it to fail immediately if generation changes its grammar. */
function pseudoMessage(message) {
  const ranges = [];
  collectLiteralRanges(parse(message, { captureLocation: true }), ranges);
  let transformed = message;
  for (const range of ranges.sort((left, right) => right.start - left.start)) {
    const rawLiteral = message.slice(range.start, range.end);
    transformed = `${transformed.slice(0, range.start)}${pseudoLiteral(rawLiteral)}${transformed.slice(range.end)}`;
  }
  const wrapped = `⟦${transformed}⟧`;
  parse(wrapped, { requiresOtherClause: true });
  return wrapped;
}

/** Read the canonical catalog and return the deterministic serialized pseudo-locale artifact. */
function generateArtifact() {
  const canonical = JSON.parse(fs.readFileSync(canonicalPath, 'utf8'));
  const generated = Object.fromEntries(
    Object.keys(canonical)
      .sort()
      .map((messageId) => [messageId, pseudoMessage(canonical[messageId])]),
  );
  return {
    messageCount: Object.keys(generated).length,
    serialized: `${JSON.stringify(generated, null, 2)}\n`,
  };
}

/** Write the pseudo artifact or verify that the checked-in copy is current. */
function main() {
  const artifact = generateArtifact();
  if (process.argv.includes('--check')) {
    const existing = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, 'utf8') : '';
    if (existing !== artifact.serialized) {
      process.stderr.write('en-XA pseudo catalog is stale; run npm run i18n:pseudo\n');
      process.exitCode = 1;
      return;
    }
    process.stdout.write(`verified ${artifact.messageCount} en-XA messages\n`);
    return;
  }
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, artifact.serialized, 'utf8');
  process.stdout.write(`generated ${artifact.messageCount} en-XA messages\n`);
}

if (require.main === module) main();

module.exports = { generateArtifact, pseudoMessage };
