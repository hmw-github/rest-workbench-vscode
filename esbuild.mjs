// Bundles the extension into one CommonJS file. The .http parser, variable resolver and curl
// runner are imported from the desktop app (../rest-workbench/src) so both behave identically.
import * as esbuild from 'esbuild';

const ctx = await esbuild.context({
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['vscode'],
  sourcemap: true,
  logLevel: 'info',
});
if (process.argv.includes('--watch')) await ctx.watch();
else {
  await ctx.rebuild();
  await ctx.dispose();
}
