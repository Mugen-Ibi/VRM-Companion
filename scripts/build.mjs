import { build } from 'esbuild';
import { mkdir, copyFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
await mkdir('dist/renderer', { recursive: true });
await mkdir('native/windows-files/bin', { recursive: true });
if (process.platform === 'win32') {
  const compiler = path.join(
    process.env.WINDIR || 'C:/Windows',
    'Microsoft.NET/Framework64/v4.0.30319/csc.exe',
  );
  execFileSync(
    compiler,
    [
      '/nologo',
      '/optimize+',
      '/platform:x64',
      '/target:exe',
      '/r:System.Web.Extensions.dll',
      `/out:${path.resolve('native/windows-files/bin/CompanionFiles.exe')}`,
      path.resolve('native/windows-files/Program.cs'),
    ],
    { stdio: 'inherit', windowsHide: true },
  );
}
await build({
  entryPoints: ['src/main/index.ts'],
  outfile: 'dist/main/index.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['electron', 'node:sqlite'],
  sourcemap: true,
});
await build({
  entryPoints: ['src/preload/panel.ts', 'src/preload/avatar.ts'],
  outdir: 'dist/preload',
  outExtension: { '.js': '.cjs' },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['electron'],
});
await build({
  entryPoints: ['src/renderer/panel.ts', 'src/renderer/avatar.ts'],
  outdir: 'dist/renderer',
  bundle: true,
  platform: 'browser',
  format: 'esm',
  target: 'chrome140',
  sourcemap: true,
});
for (const name of ['index.html', 'avatar.html', 'styles.css'])
  await copyFile(`src/renderer/${name}`, `dist/renderer/${name}`);
console.log('Built renderer, Electron host, and Windows file adapter.');
