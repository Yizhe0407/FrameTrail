import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const sourceRoots = ['components', 'entrypoints', 'lib'];
const sourceExtensions = new Set(['.ts', '.tsx']);
const ignoredDirectories = new Set(['node_modules', '.output', 'test-results']);
const importPattern = /(?:import|export)\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/g;

async function collectFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (ignoredDirectories.has(entry.name)) continue;
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await collectFiles(fullPath));
    else if (sourceExtensions.has(path.extname(entry.name))) files.push(fullPath);
  }
  return files;
}

function normalized(file) {
  return path.relative(root, file).split(path.sep).join('/');
}

function classify(file) {
  const relative = normalized(file);
  if (relative.startsWith('lib/shared/')) return 'shared-lib';
  if (relative.startsWith('components/ui/')) return 'ui-component';
  if (relative === 'lib/storage/models.ts') return 'storage-models';
  return 'other';
}

function boundaryViolation(from, specifier) {
  if (!specifier.startsWith('@/')) return null;
  const target = specifier.slice(2);
  switch (classify(from)) {
    case 'shared-lib':
      return target.startsWith('lib/shared/') ? null : 'lib/shared may only import lib/shared modules via @/ aliases';
    case 'ui-component':
      return target.startsWith('components/ui/') || target.startsWith('components/shared/') || target.startsWith('lib/shared/')
        ? null
        : 'components/ui may not depend on feature components or lib domains';
    case 'storage-models':
      return target.startsWith('lib/storage/') || target.startsWith('lib/guide/')
        ? 'storage/models must stay independent of repositories, database, and guide services'
        : null;
    default:
      return null;
  }
}

const files = (await Promise.all(sourceRoots.map((directory) => collectFiles(path.join(root, directory))))).flat();
const knownFiles = new Set(files);
function resolveAlias(specifier) {
  if (!specifier.startsWith('@/')) return null;
  const base = path.join(root, specifier.slice(2));
  return [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts'), path.join(base, 'index.tsx')]
    .find((candidate) => knownFiles.has(candidate)) ?? null;
}

const graph = new Map(files.map((file) => [file, []]));
const violations = [];
for (const file of files) {
  const source = await readFile(file, 'utf8');
  for (const match of source.matchAll(importPattern)) {
    const specifier = match[1];
    const violation = boundaryViolation(file, specifier);
    if (violation) violations.push(`${normalized(file)} -> ${specifier}: ${violation}`);
    const resolved = resolveAlias(specifier);
    if (resolved) graph.get(file).push(resolved);
  }
}

const visiting = new Set();
const visited = new Set();
const stack = [];
const cycles = new Set();
function visit(file) {
  if (visiting.has(file)) {
    const start = stack.indexOf(file);
    cycles.add([...stack.slice(start), file].map(normalized).join(' -> '));
    return;
  }
  if (visited.has(file)) return;
  visiting.add(file);
  stack.push(file);
  for (const dependency of graph.get(file) ?? []) visit(dependency);
  stack.pop();
  visiting.delete(file);
  visited.add(file);
}
for (const file of files) visit(file);

if (violations.length || cycles.size) {
  const sections = [];
  if (violations.length) sections.push(`Import-boundary violations:\n${violations.map((line) => `- ${line}`).join('\n')}`);
  if (cycles.size) sections.push(`Dependency cycles:\n${[...cycles].map((line) => `- ${line}`).join('\n')}`);
  throw new Error(sections.join('\n\n'));
}

console.log(`Module boundaries are valid; scanned ${files.length} source modules with 0 dependency cycles.`);
