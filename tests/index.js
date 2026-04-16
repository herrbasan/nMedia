/**
 * Test entry point
 * Run with: npm test
 */

import { runTests } from './runner.js';

const testFiles = [
  'processors.test.js',
];

await runTests(testFiles);
