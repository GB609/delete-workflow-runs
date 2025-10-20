const core = require("@actions/core");

function csv_string_to_array(listString) {
  if (typeof listString == "string" && listString.length > 0) {
    return listString.trim().split(/[ ]*,[ ]*/);
  }
  return []
}

function generate_conclusion_pattern(core) {
  let delete_run_by_conclusion_pattern = (core.getInput('delete_run_by_conclusion_pattern') || 'ALL').trim();
  if (delete_run_by_conclusion_pattern.toUpperCase() !== "ALL") {
    return csv_string_to_array(delete_run_by_conclusion_pattern.toLowerCase())
  } else {
    return false
  }
}

function setupOctokit(url, token) {
  const { Octokit } = require("@octokit/rest");
  const { throttling } = require("@octokit/plugin-throttling");
  const MyOctokit = Octokit.plugin(throttling);
  return new MyOctokit({
    auth: token,
    baseUrl: url,
    // To avoid "API rate limit exceeded" errors
    throttle: {
      onRateLimit: (retryAfter, options, octokit, retryCount) => {
        octokit.log.warn(`Request quota exhausted for request ${options.method} ${options.url}`);
        if (retryCount < 1) {
          // only retries once
          octokit.log.info(`Retrying after ${retryAfter} seconds!`);
          return true;
        }
      },
      onSecondaryRateLimit: (retryAfter, options, octokit) => {
        // does not retry, only logs a warning
        octokit.log.warn(`SecondaryRateLimit detected for request ${options.method} ${options.url}`);
      },
    },
  });
}

/** Executes the API "Delete a workflow run" for each list entry of workflowRuns.
 * @see https://octokit.github.io/rest.js/v18#actions-delete-workflow-run 
 */
async function executeWorkflowDeletion(octokit, repo, workflowRuns, reason = null) {
  let dry_run = core.getInput('dry_run');
  let wf_counts = {};
  let delete_counts = {};
  let failure_counts = {};
  for (const wfRun of workflowRuns) {
    core.debug(`Deleting '${wfRun.name}' workflow run ${wfRun.id}`);
    wf_counts[wfRun.name] ||= 0;
    delete_counts[wfRun.name] ||= 0;
    failure_counts[wfRun.name] ||= 0;

    wf_counts[wfRun.name]++;
    if (dry_run) {
      console.log(`[dry-run] 🚀 Delete run ${wfRun.id} of '${wfRun.name}' workflow`);
      delete_counts[wfRun.name]++;
      continue;
    }

    try {
      await octokit.actions.deleteWorkflowRun(repo.with({ run_id: wfRun.id }));

      console.log(`🚀 Delete run ${wfRun.id} of '${wfRun.name}' workflow`);
      delete_counts[wfRun.name]++;
    } catch (e) {
      console.error(`🔥 Failed to delete run ${wfRun.id} of '${wfRun.name}' workflow`)
      failure_counts[wfRun.name]++;
    }
  }
  let delete_count = Object.values(delete_counts).reduce((total, current) => total + current, 0);
  Object.entries(delete_counts).forEach(([name, deletes]) => {
    if (deletes > 0) {
      console.log(`✅ ${deletes} runs of '${name}' workflow deleted.`);
      console.summary(
        ' * :white_check_mark: Deleted',
        `${deletes}/${wf_counts[name]}`,
        `runs of ${name}`,
        (failure_counts[name] || 0) > 0 ? ` (:burn: Failed: ${failure_counts[name]})` : '',
        reason != null ? ': ' + reason : ''
      )
    } else if (failure_counts[name] > 0) {
      console.summary(` * :burn: Deleting ${failure_counts[name]} workflow runs of '${name}' completely failed.`);
    }
  })
  return delete_count;
}

async function deleteNoneExistingWorkflowTypes(octokit, repo, workflowDefs, allRuns) {
  // Creates the delete runs array, and adds the runs that don't have a workflow associated with it
  let workflow_ids = workflowDefs.map(w => w.id);
  console.log("💬 Known workflow ids:", workflow_ids);
  let del_runs = allRuns
    .filter(run => !workflow_ids.includes(run.workflow_id))
    .map(run => {
      core.debug(`  Added to del list '${run.name}' workflow run ${run.id}`);
      return run;
    });

  console.log(`💬 ${del_runs.length} workflow run(s) do not match to existing workflows anymore`);
  // is attempting to delete the existing workflow. Means the filtering logic is wrong
  await executeWorkflowDeletion(octokit, repo, del_runs, "Their workflow doesn't exist anymore.");
}

/** Encapsulates the properties 'owner' and 'repo' commonly used across all octokit APIs */
class Repository {
  constructor(repository) {
    const splitRepository = repository.split('/');
    if (splitRepository.length !== 2 || !splitRepository[0] || !splitRepository[1]) {
      throw new Error(`Invalid repository '${repository}'. Expected format {owner}/{repo}.`);
    }
    this.owner = splitRepository[0];
    this.repo = splitRepository[1];
  }

  /** Returns a copy of this with additional properties as contained in addConfig */
  with(addConfig) { return Object.assign({}, this, addConfig) }
}

async function run() {
  console.summary = function(...message) {
    core.summary.addRaw(message.filter(m => m.length > 0).join(' '), true);
    core.summary.write();
  }

  try {
    // Fetch all the inputs
    const token = core.getInput('token');
    const url = core.getInput('baseUrl');
    const repo = new Repository(core.getInput('repository'));
    const retain_days = Number(core.getInput('retain_days'));
    const keep_minimum_runs = Number(core.getInput('keep_minimum_runs'));
    const minimum_ignore_deleted = core.getInput('minimum_ignore_deleted_branches');
    const minimum_run_is_branch_specific = core.getInput('branch_specific_minimum_runs');
    const minimum_run_is_flow_specific = core.getInput('workflow_specific_minimum_runs');
    const delete_workflow_pattern = csv_string_to_array(core.getInput('delete_workflow_pattern'));
    const delete_workflow_by_state_pattern = core.getInput('delete_workflow_by_state_pattern');
    const delete_run_by_conclusion_pattern = generate_conclusion_pattern(core);
    const branch_filter_patterns = JSON.parse(core.getInput('branch_filter'));
    const check_branch_existence = core.getInput("check_branch_existence");
    const check_branch_existence_exceptions = csv_string_to_array(core.getInput("check_branch_existence_exceptions"));
    const check_pullrequest_exist = core.getInput("check_pullrequest_exist");

    const octokit = setupOctokit(url, token);

    let workflows = await octokit.paginate("GET /repos/:owner/:repo/actions/workflows", repo);

    // Gets all workflow runs for the repository
    // see https://docs.github.com/en/rest/actions/workflow-runs?apiVersion=2022-11-28#list-workflow-runs-for-a-repository
    let all_runs = await octokit.paginate('GET /repos/:owner/:repo/actions/runs', repo);
    console.log(`💬 found total number of ${all_runs.length} runs across all workflows`);

    await deleteNoneExistingWorkflowTypes(octokit, repo, workflows, all_runs);

    if (delete_workflow_pattern.length > 0) {
      console.log(`💬 workflows containing '${delete_workflow_pattern}' will be targeted`);
      workflows = workflows.filter(
        ({ name, path }) => {
          const filename = path.replace(".github/workflows/", '');
          return delete_workflow_pattern.includes(filename) || delete_workflow_pattern.includes(name);
        }
      );
    }

    if (delete_workflow_by_state_pattern && delete_workflow_by_state_pattern.toUpperCase() !== "ALL") {
      console.log(`💬 workflows containing state '${delete_workflow_by_state_pattern}' will be targeted`);
      let patternFilter = delete_workflow_by_state_pattern.split(",").map(x => x.trim());
      workflows = workflows.filter(({ state }) => patternFilter.includes(state));
    }

    let branches = await octokit.paginate("GET /repos/:owner/:repo/branches", repo);

    let existingBranchNames = branches.map(a => a.name).filter(branch => !check_branch_existence_exceptions.includes(branch));
    let allowedBranches = new RegExp(`^(${branch_filter_patterns.join('|')})$`);

    console.log(`💬 found total of ${workflows.length} workflow(s)`);
    for (const workflow of workflows) {
      core.debug(`Workflow: ${workflow.name} ${workflow.id} ${workflow.state}`);
      let del_runs = {};
      //count the number of kept runs, for correctly handling keep_minimum...
      let kept_runs = {};
      // Execute the API "List workflow runs for a repository", see 'https://octokit.github.io/rest.js/v18#actions-list-workflow-runs-for-repo'
      const runs = await octokit
        .paginate("GET /repos/:owner/:repo/actions/workflows/:workflow_id/runs", repo.with({ workflow_id: workflow.id }));

      console.log(`Found a total of ${runs.length} runs for workflow '${workflow.name}'`)

      for (const run of runs) {
        core.debug(`Run: '${workflow.name}' workflow run ${run.id} (status=${run.status})`);

        if (!allowedBranches.test(run.head_branch)) {
          console.log(` Skipping '${workflow.name}' workflow run ${run.id} because branch '${run.head_branch}' doesn't match '${allowedBranches.toString()}'.`);
          continue;
        }

        if (run.status !== "completed") {
          console.log(`👻 Skipped '${workflow.name}' workflow run ${run.id}: it is in '${run.status}' state`);
          continue;
        }

        if (check_pullrequest_exist && run.pull_requests.length > 0) {
          console.log(` Skipping '${workflow.name}' workflow run ${run.id} because PR is attached.`);
          continue;
        }

        let branchExists = existingBranchNames.includes(run.head_branch);
        if (check_branch_existence && branchExists) {
          console.log(` Skipping '${workflow.name}' workflow run ${run.id} because branch '${run.head_branch}' is still active.`);
          continue;
        }

        if (delete_run_by_conclusion_pattern && !delete_run_by_conclusion_pattern.includes(run.conclusion)) {
          core.debug(`  Skipping '${workflow.name}' workflow run ${run.id} because conclusion was ${run.conclusion}`);
          continue;
        }
        run._branchExists = branchExists;
        const created_at = new Date(run.created_at);
        const current = new Date();
        const ELAPSE_ms = current.getTime() - created_at.getTime();
        const ELAPSE_days = ELAPSE_ms / (1000 * 3600 * 24);
        let branchName = minimum_run_is_branch_specific ? run.head_branch || 'ALL_BRANCHES' : 'ALL_BRANCHES';
        branchName += minimum_run_is_flow_specific ? `:${workflow.name}` : '';
        kept_runs[branchName] ||= 0;

        if (ELAPSE_days >= retain_days) {
          core.debug(`  Added to del list (${branchName}): '${workflow.name}' workflow run ${run.id}`);
          let targetList = del_runs[branchName] ||= [];
          targetList.push(run);
        } else {
          kept_runs[branchName]++;
          console.log(`👻 Skipped '${workflow.name}' workflow run ${run.id}: created at ${run.created_at} because ${ELAPSE_days.toFixed(2)}d < ${retain_days}d`);
        }
      }
      core.debug(`Delete list for '${workflow.name}' is ${del_runs.length} items`);
      for (let [branchName, wf_runs] of Object.entries(del_runs)) {

        if (kept_runs[branchName] < keep_minimum_runs) {
          let skip_runs = [];
          wf_runs = wf_runs.sort((a, b) => { return a.id - b.id; });
          
          if (minimum_ignore_deleted) {
            skip_runs = wf_runs.filter(run => run._branchExists)
          } else {
            skip_runs = wf_runs;
          }
          let delete_candidates_tokeep = keep_minimum_runs - kept_runs[branchName];
          skip_runs = skip_runs.slice(-delete_candidates_tokeep);
          wf_runs = wf_runs.filter(run => !skip_runs.includes(run))
          for (let skipped_run of skip_runs) {
            console.log(`👻 Skipped '${workflow.name}' workflow run ${skipped_run.id}: created at ${skipped_run.created_at} because of keep_minimum_runs=${keep_minimum_runs}`);
          }
        }
        console.log(`💬 Deleting ${wf_runs.length} runs for '${workflow.name}' workflow on '${branchName}'`);
        await executeWorkflowDeletion(octokit, repo, wf_runs, `from branch '${branchName.split(":")[0]}'`);
      }
    }
  }
  catch (error) {
    core.setFailed(error.message);
  }
}

run();
