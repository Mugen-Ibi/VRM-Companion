import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
const lock = JSON.parse(await readFile('package-lock.json', 'utf8'));
let output =
  '# Third-party notices\n\nThe application bundles the following npm runtime libraries. Electron and Chromium notices are included beside the executable as LICENSE and LICENSES.chromium.html. User VRM and GGUF files are not distributed with the application.\n';
for (const [location, entry] of Object.entries(lock.packages)) {
  if (!location || entry.dev) continue;
  const pkg = JSON.parse(await readFile(path.join(location, 'package.json'), 'utf8'));
  const files = (await readdir(location)).filter((file) => /^licen[sc]e(?:\.|$)/i.test(file));
  if (!files.length) throw new Error('Missing runtime license: ' + pkg.name);
  output += `\n## ${pkg.name} ${pkg.version}\n\n${pkg.license || entry.license || 'See license text'}\n\n`;
  for (const file of files)
    output += '```text\n' + (await readFile(path.join(location, file), 'utf8')).trim() + '\n```\n';
}
await writeFile('THIRD_PARTY_NOTICES.md', output);
console.log('Generated runtime library notices.');
