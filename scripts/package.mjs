import { packager } from '@electron/packager';
import { copyFile, mkdir, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
await import('./build.mjs');
await import('./notices.mjs');
// Public four-component Windows version is independent of npm's SemVer format.
const { releaseVersion } = JSON.parse(await readFile('package.json', 'utf8'));
if (typeof releaseVersion !== 'string' || !/^\d+\.\d+\.\d+\.\d+$/.test(releaseVersion))
  throw new Error('releaseVersion must contain four numeric components.');
const paths = await packager({
  dir: '.',
  out: process.env.COMPANION_PACKAGE_OUT || 'release',
  name: 'VRM-Companion',
  appVersion: releaseVersion,
  buildVersion: releaseVersion,
  platform: 'win32',
  arch: 'x64',
  electronZipDir: process.env.COMPANION_ELECTRON_ZIP_DIR || undefined,
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
