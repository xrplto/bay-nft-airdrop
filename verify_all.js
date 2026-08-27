#!/usr/bin/env node
'use strict';
// One-command complete verification of a published fairdrop plan.
// Zero dependencies, zero arguments needed — put this file in a folder with
// fairdrop.js, snapshot.json, plan.json, test_randomization.js and
// test_edgecases.js (all published together) and run:
//
//   node verify_all.js [--node https://your.node:51234/] [--commit-tx HASH] [--allow-uncommitted]
//
// Stages (each also runnable on its own):
//   1. fairdrop.js verify      — resweep chain at the snapshot ledger, recheck
//                                beacon + seed, exact-math the amounts,
//                                byte-compare all transfers
//   2. test_randomization.js   — amounts identical across 10,000 seeds and
//                                equal to an exact reference; id-shuffle
//                                statistically uniform; rigged controls flagged
//   3. test_edgecases.js       — tampered snapshots/plans must be rejected
//
// Exit 0 = everything verified. Non-zero = at least one stage failed.

const { spawnSync } = require('child_process');
const path = require('path');

const args = process.argv.slice(2);
const opt = (name, dflt) => {
    const i = args.indexOf(name);
    return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const node = opt('--node', 'https://s2.ripple.com:51234/');
const commitTx = opt('--commit-tx', null);
const allowUncommitted = args.includes('--allow-uncommitted');
const here = f => path.join(__dirname, f);

const stages = [
    ['1/3 chain reproduction (fairdrop.js verify)',
        [here('fairdrop.js'), 'verify', '--snapshot', here('snapshot.json'), '--plan', here('plan.json'),
            '--node', node, ...(commitTx ? ['--commit-tx', commitTx] : []),
            ...(allowUncommitted ? ['--allow-uncommitted'] : [])]],
    ['2/3 randomization battery (test_randomization.js)',
        [here('test_randomization.js'), here('snapshot.json')]],
    ['3/3 tamper suite (test_edgecases.js)',
        [here('test_edgecases.js'), here('snapshot.json'), here('plan.json')]],
];

let failed = 0;
for (const [name, cmd] of stages) {
    console.log('\n============================================================');
    console.log('== ' + name);
    console.log('============================================================');
    const r = spawnSync(process.execPath, cmd, { stdio: 'inherit', timeout: 900000 });
    if (r.status !== 0) { failed++; console.log('** stage FAILED **'); }
}

console.log('\n############################################################');
console.log(failed === 0
    ? '## VERIFIED: every check passed — the plan is exactly what the'
    + '\n## published data says it is, reproduced from public chain state.'
    : `## FAILED: ${failed} of ${stages.length} stages did not pass — do NOT trust this plan.`);
console.log('############################################################');
process.exit(failed ? 1 : 0);
