// Downloads a VS Code test instance and runs test/suite.cjs inside it with this extension loaded.
import { runTests } from '@vscode/test-electron';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
delete process.env.ELECTRON_RUN_AS_NODE; // set when started from inside VS Code
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'rest-workbench-test-'));

try {
  await runTests({
    extensionDevelopmentPath: root,
    extensionTestsPath: path.join(root, 'test', process.env.SUITE || 'suite.cjs'),
    // short user-data dir: the IPC socket path must stay below 103 characters
    launchArgs: [workspace, '--disable-extensions', '--skip-welcome', '--skip-release-notes', '--user-data-dir', fs.mkdtempSync(path.join(os.tmpdir(), 'rwu-'))],
    extensionTestsEnv: { TEST_WORKSPACE: workspace, DEMO_PORT: process.env.DEMO_PORT ?? '', HTTP_FILE: process.env.HTTP_FILE ?? '', TEST_PORT: process.env.TEST_PORT ?? '', FROM_PORT: process.env.FROM_PORT ?? '' },
  });
} catch (e) {
  console.error('Tests failed', e);
  process.exit(1);
}
