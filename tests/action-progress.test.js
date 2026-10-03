import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeGitHubActionProgress } from '../src/actionProgress.js';

test('GitHub operation summary exposes actual job and step states without crediting queued work', () => {
  const summary = summarizeGitHubActionProgress([
    {
      name: 'verify', status: 'in_progress', conclusion: null,
      steps: [
        { number: 1, name: 'Checkout', status: 'completed', conclusion: 'success' },
        { number: 2, name: 'Install', status: 'in_progress', conclusion: null },
        { number: 3, name: 'Test', status: 'queued', conclusion: null },
      ],
    },
  ], 'in_progress');
  assert.equal(summary.totalSteps, 3);
  assert.equal(summary.completedSteps, 1);
  assert.equal(summary.runningSteps, 1);
  assert.equal(summary.queuedSteps, 1);
  assert.match(summary.detail, /1\/3 completed · 1 running · 1 queued/);
  assert.deepEqual(summary.transitions.map((item) => item.key), ['job:verify', 'step:verify:1', 'step:verify:2', 'step:verify:3']);
});

test('GitHub summary clearly reports a terminal run when no job-step metadata is available', () => {
  const summary = summarizeGitHubActionProgress([], 'completed', 'failure');
  assert.equal(summary.totalSteps, 0);
  assert.equal(summary.detail, 'GitHub Actions run status: completed · failure.');
});
