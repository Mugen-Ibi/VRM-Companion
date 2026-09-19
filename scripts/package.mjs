import { packager } from '@electron/packager';
import { copyFile, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
await import('./build.mjs');
await import('./notices.mjs');
const paths = await packager({
  dir: '.',
  out: 'release',
  name: 'VRM-Companion',
  platform: 'win32',
  arch: 'x64',
  overwrite: true,
  asar: false,
  prune: false,
  ignore: [
    /^\/(src|tests|artifacts|\.local|\.git|release|scripts|node_modules)(\/|$)/,
    /^\/native\/windows-files\/Program.cs$/,
  ],
});
for (const directory of paths) {
  await copyFile('README.md', path.join(directory, 'README.md'));
  await copyFile('THIRD_PARTY_NOTICES.md', path.join(directory, 'THIRD_PARTY_NOTICES.md'));
  await mkdir(path.join(directory, 'docs'), { recursive: true });
  for (const file of await readdir('docs'))
    if (file.endsWith('.md'))
      await copyFile(path.join('docs', file), path.join(directory, 'docs', file));
}
console.log(paths.join('\n'));
