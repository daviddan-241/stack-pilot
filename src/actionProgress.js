export function summarizeGitHubActionProgress(jobs = [], runStatus = 'unknown', runConclusion = '') {
  let totalSteps = 0;
  let completedSteps = 0;
  let runningSteps = 0;
  let queuedSteps = 0;
  const transitions = [];

  for (const job of Array.isArray(jobs) ? jobs : []) {
    const jobName = String(job?.name || 'unnamed job');
    transitions.push({
      key: `job:${jobName}`,
      label: `GitHub job “${jobName}”`,
      status: String(job?.status || 'unknown'),
      conclusion: String(job?.conclusion || ''),
    });
    for (const step of Array.isArray(job?.steps) ? job.steps : []) {
      const name = String(step?.name || `step ${step?.number || '?'}`);
      const number = step?.number ?? name;
      const status = String(step?.status || 'unknown');
      const conclusion = String(step?.conclusion || '');
      totalSteps += 1;
      if (status === 'completed') completedSteps += 1;
      else if (status === 'in_progress') runningSteps += 1;
      else if (status === 'queued') queuedSteps += 1;
      transitions.push({
        key: `step:${jobName}:${number}`,
        label: `Action step “${name}”`,
        status,
        conclusion,
      });
    }
  }

  const detail = totalSteps
    ? `GitHub Actions steps: ${completedSteps}/${totalSteps} completed${runningSteps ? ` · ${runningSteps} running` : ''}${queuedSteps ? ` · ${queuedSteps} queued` : ''}.`
    : `GitHub Actions run status: ${runStatus || 'unknown'}${runConclusion ? ` · ${runConclusion}` : ''}.`;
  return { totalSteps, completedSteps, runningSteps, queuedSteps, detail, transitions };
}
