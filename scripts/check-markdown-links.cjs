const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');

/** Explicit list of directories and patterns to exclude from link/anchor validation */
const FROZEN_EVIDENCE_EXCLUSIONS = [
  'docs/experiments',
  'node_modules',
  '.git',
];

function getMarkdownFiles(dir) {
  let results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const rel = path.relative(root, full).replace(/\\/g, '/');
    if (FROZEN_EVIDENCE_EXCLUSIONS.some(ex => rel === ex || rel.startsWith(ex + '/'))) {
      continue;
    }
    if (entry.isDirectory()) {
      results = results.concat(getMarkdownFiles(full));
    } else if (entry.name.endsWith('.md')) {
      results.push(rel);
    }
  }
  return results;
}

function slugifyHeading(text) {
  return text
    .toLowerCase()
    .trim()
    .replace(/<[^>]+>/g, '')
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc}\- ]/gu, '')
    .replace(/\s+/g, '-');
}

function getAnchors(filePath) {
  const fullPath = path.resolve(root, filePath);
  if (!fs.existsSync(fullPath)) return new Set();
  const content = fs.readFileSync(fullPath, 'utf8');
  const anchors = new Set();

  const headingRegex = /^#{1,6}\s+(.+)$/gm;
  let match;
  while ((match = headingRegex.exec(content)) !== null) {
    const headingText = match[1].replace(/#+\s*$/, '').trim();
    anchors.add(slugifyHeading(headingText));
  }

  const tagRegex = /<(?:a|div|span|h[1-6]|p|section)[^>]+(?:id|name)=["']([^"']+)["']/gi;
  while ((match = tagRegex.exec(content)) !== null) {
    anchors.add(match[1].toLowerCase());
  }

  return anchors;
}

function validateMarkdownFile(docPath) {
  const fullPath = path.resolve(root, docPath);
  const content = fs.readFileSync(fullPath, 'utf8');
  const errors = [];

  for (const match of content.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const rawTarget = match[1].trim();
    if (!rawTarget || /^https?:|^mailto:/.test(rawTarget)) continue;

    const [targetRel, anchor] = rawTarget.split('#');
    let resolvedDoc = docPath;

    if (targetRel) {
      const resolved = path.resolve(root, path.dirname(docPath), targetRel);
      if (!fs.existsSync(resolved)) {
        errors.push({
          source: docPath,
          link: rawTarget,
          error: `Target file does not exist: ${targetRel}`,
        });
        continue;
      }
      resolvedDoc = path.relative(root, resolved).replace(/\\/g, '/');
    }

    if (anchor && resolvedDoc.endsWith('.md')) {
      const anchors = getAnchors(resolvedDoc);
      const normalizedAnchor = anchor.toLowerCase();
      if (!anchors.has(normalizedAnchor)) {
        errors.push({
          source: docPath,
          link: rawTarget,
          error: `Anchor #${anchor} not found in target ${resolvedDoc}`,
        });
      }
    }
  }

  return errors;
}

function validateAllMaintainedDocs() {
  const docs = getMarkdownFiles(root);
  const allErrors = [];
  for (const doc of docs) {
    const errs = validateMarkdownFile(doc);
    if (errs.length > 0) allErrors.push(...errs);
  }
  return { docs, allErrors };
}

module.exports = {
  FROZEN_EVIDENCE_EXCLUSIONS,
  getMarkdownFiles,
  slugifyHeading,
  getAnchors,
  validateMarkdownFile,
  validateAllMaintainedDocs,
};

if (require.main === module) {
  const { docs, allErrors } = validateAllMaintainedDocs();
  console.log(`Validated ${docs.length} maintained markdown files.`);
  if (allErrors.length > 0) {
    console.error(`Found ${allErrors.length} link/anchor error(s):`);
    for (const e of allErrors) {
      console.error(`  ${e.source}: [${e.link}] -> ${e.error}`);
    }
    process.exit(1);
  } else {
    console.log('All local markdown links and heading anchors are valid!');
  }
}
