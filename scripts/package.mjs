import { packager } from '@electron/packager';
import {
  flipFuses,
  FuseState,
  FuseVersion,
  FuseV1Options,
  getCurrentFuseWire,
} from '@electron/fuses';
import { copyFile, mkdir, readdir, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
await import('./build.mjs');
await import('./notices.mjs');
// Public four-component Windows version is independent of npm's SemVer format.
const { releaseVersion } = JSON.parse(await readFile('package.json', 'utf8'));
if (typeof releaseVersion !== 'string' || !/^\d+\.\d+\.\d+\.\d+$/.test(releaseVersion))
  throw new Error('releaseVersion must contain four numeric components.');
const allowUnsigned = process.env.COMPANION_ALLOW_UNSIGNED === '1';
const signingConfigured = [
  'WINDOWS_CERTIFICATE_FILE',
  'WINDOWS_SIGNTOOL_PATH',
  'WINDOWS_SIGN_WITH_PARAMS',
  'WINDOWS_SIGN_HOOK_MODULE_PATH',
].some((name) => process.env[name]);
if (!signingConfigured && !allowUnsigned)
  throw new Error(
    'Public packages require Windows code signing. Configure WINDOWS_CERTIFICATE_FILE (and password) or an HSM signing hook. Use COMPANION_ALLOW_UNSIGNED=1 only for local verification.',
  );
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
  asar: { unpack: '**/CompanionFiles.exe' },
  prune: false,
  windowsSign: signingConfigured
    ? {
        hashes: ['sha256'],
        description: 'VRM Companion',
        website: 'https://github.com/Mugen-Ibi/VRM-Companion',
      }
    : undefined,
  afterAsar: [
    async ({ buildPath }) => {
      const executable = path.resolve(buildPath, '..', '..', 'electron.exe');
      await flipFuses(executable, {
        version: FuseVersion.V1,
        strictlyRequireAllFuses: true,
        [FuseV1Options.RunAsNode]: false,
        [FuseV1Options.EnableCookieEncryption]: true,
        [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
        [FuseV1Options.EnableNodeCliInspectArguments]: false,
        [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
        [FuseV1Options.OnlyLoadAppFromAsar]: true,
        [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]: true,
        [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
        [FuseV1Options.WasmTrapHandlers]: true,
      });
    },
  ],
  ignore: [
    /^\/(src|tests|artifacts|\.local|\.git|release|scripts|node_modules)(\/|$)/,
    /^\/native\/windows-files\/Program.cs$/,
  ],
});
for (const directory of paths) {
  const executable = path.join(directory, 'VRM-Companion.exe');
  const wire = await getCurrentFuseWire(executable);
  const expectedFuses = new Map([
    [FuseV1Options.RunAsNode, FuseState.DISABLE],
    [FuseV1Options.EnableCookieEncryption, FuseState.ENABLE],
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable, FuseState.DISABLE],
    [FuseV1Options.EnableNodeCliInspectArguments, FuseState.DISABLE],
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation, FuseState.ENABLE],
    [FuseV1Options.OnlyLoadAppFromAsar, FuseState.ENABLE],
    [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot, FuseState.ENABLE],
    [FuseV1Options.GrantFileProtocolExtraPrivileges, FuseState.DISABLE],
    [FuseV1Options.WasmTrapHandlers, FuseState.ENABLE],
  ]);
  for (const [fuse, state] of expectedFuses)
    if (wire[fuse] !== state)
      throw new Error(`Electron fuse verification failed for ${FuseV1Options[fuse]}.`);
  if (!allowUnsigned) {
    execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        "$invalid = Get-ChildItem -LiteralPath $args[0] -Recurse -File | Where-Object { $_.Extension -in '.exe','.dll','.node' } | Where-Object { (Get-AuthenticodeSignature -LiteralPath $_.FullName).Status -ne 'Valid' }; if ($invalid) { $invalid.FullName; exit 1 }",
        directory,
      ],
      { encoding: 'utf8', windowsHide: true },
    );
  }
  await copyFile('README.md', path.join(directory, 'README.md'));
  await copyFile('THIRD_PARTY_NOTICES.md', path.join(directory, 'THIRD_PARTY_NOTICES.md'));
  await mkdir(path.join(directory, 'docs'), { recursive: true });
  for (const file of await readdir('docs'))
    if (file.endsWith('.md'))
      await copyFile(path.join('docs', file), path.join(directory, 'docs', file));
}
console.log(paths.join('\n'));
