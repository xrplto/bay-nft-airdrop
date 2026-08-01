#!/usr/bin/env node
'use strict';
// Functional / edge-case / tamper-detection E2E suite for fairdrop.
// Complements test_randomization.js (statistical). One command, exits
// non-zero on failure:
//
//   node test_edgecases.js [snapshot.json] [plan.json]
//
// Sections:
//   A. algorithm edges via the shipped exports (single holder, exact quotas,
//      all-lottery, empty pool, duplicate inputs, 200-config property test
//      with exact BigInt floors)
//   B. known-answer tests freezing the spec: canonical JSON bytes/hash and
//      the first draws of the SHA-256 rand stream (any silent change to
//      either breaks these loudly)
//   C. CLI behavior: usage, missing args, corrupted-snapshot refusal
//   D. tamper detection (network: one beacon fetch per verify, resweep off):
//      swapped recipients, tampered transfers WITH recomputed transfersHash,
//      tampered seed — verify must FAIL each
//   E. commit output sanity; verify --commit-tx against a real non-commitment
//      tx must FAIL the memo check
//   F. audit-offers on an unexecuted plan subset must report missing offers

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { sha256hex, canonicalJson, randStream, buildPlan } = require('./fairdrop.js');

const SNAPSHOT = process.argv[2] || 'snapshot.json';
const PLAN = process.argv[3] || 'plan.json';
const FAIRDROP = path.join(__dirname, 'fairdrop.js');

let failures = 0;
function check(name, ok, detail) {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  [' + detail + ']' : ''}`);
    if (!ok) failures++;
}
function run(args) {
    const r = spawnSync('node', [FAIRDROP, ...args], { encoding: 'utf8', timeout: 180000 });
    return { status: r.status, out: (r.stdout || '') + (r.stderr || '') };
}
const seed = s => sha256hex(s);

(async () => {
    const t0 = Date.now();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fairdrop-test-'));

    // ---- A. algorithm edges ----------------------------------------------
    {
        const p1 = buildPlan([{ address: 'rAAA', holdings: 3 }], ['N1', 'N2', 'N3', 'N4', 'N5'], seed('a'));
        check('A: single holder receives the whole pool',
            p1.transfers.length === 5 && p1.transfers.every(t => t.to === 'rAAA'));

        const p2 = buildPlan([{ address: 'rA', holdings: 5 }, { address: 'rB', holdings: 5 }],
            Array.from({ length: 10 }, (_, i) => 'N' + i), seed('b'));
        const c2 = new Map();
        for (const t of p2.transfers) c2.set(t.to, (c2.get(t.to) || 0) + 1);
        check('A: exact-integer quotas -> floors only, zero lottery seats',
            p2.seats === 0 && c2.get('rA') === 5 && c2.get('rB') === 5);

        // 5 equal holders, 3 nfts: all remainders tie exactly -> deterministic
        // tie-break (address ascending) must pick rH0, rH1, rH2 — no lottery
        const p3 = buildPlan(Array.from({ length: 5 }, (_, i) => ({ address: 'rH' + i, holdings: 1 })),
            ['N0', 'N1', 'N2'], seed('c'));
        const c3 = new Map();
        for (const t of p3.transfers) c3.set(t.to, (c3.get(t.to) || 0) + 1);
        check('A: exact remainder tie -> deterministic address-order winners, 1 each',
            p3.seats === 3 && p3.transfers.length === 3 &&
            c3.get('rH0') === 1 && c3.get('rH1') === 1 && c3.get('rH2') === 1 && !c3.has('rH3') && !c3.has('rH4'));

        const p4 = buildPlan([{ address: 'rA', holdings: 1 }], [], seed('d'));
        check('A: empty pool -> empty plan, no crash', p4.transfers.length === 0 && p4.seats === 0);

        let threw = false;
        try { buildPlan([{ address: 'rA', holdings: 1 }, { address: 'rA', holdings: 2 }], ['N1'], seed('e')); } catch (e) { threw = true; }
        check('A: duplicate holder address throws', threw);
        threw = false;
        try { buildPlan([{ address: 'rA', holdings: 1 }], ['N1', 'N1'], seed('f')); } catch (e) { threw = true; }
        check('A: duplicate nft in pool throws', threw);

        // property test: 200 random configs, invariants + exact BigInt floors
        let bad = null;
        const prand = randStream(seed('property-gen'));
        for (let k = 0; k < 200 && !bad; k++) {
            const nH = 1 + Math.floor(prand() * 40);
            const holders = Array.from({ length: nH }, (_, i) =>
                ({ address: 'rP' + String(i).padStart(3, '0'), holdings: 1 + Math.floor(prand() * 50) }));
            const nP = 1 + Math.floor(prand() * 60);
            const pool = Array.from({ length: nP }, (_, i) => 'NFT' + String(i).padStart(3, '0'));
            const { recips, transfers } = buildPlan(holders, pool, seed('prop' + k));
            const total = BigInt(holders.reduce((s, h) => s + h.holdings, 0));
            const per = new Map();
            for (const t of transfers) per.set(t.to, (per.get(t.to) || 0) + 1);
            if (transfers.length !== nP) { bad = `cfg${k}: transfer count`; break; }
            if (new Set(transfers.map(t => t.nft_id)).size !== nP) { bad = `cfg${k}: dup nft`; break; }
            if (recips.reduce((s, r) => s + r.alloc, 0) !== nP) { bad = `cfg${k}: alloc sum`; break; }
            for (const r of recips) {
                const fl = (BigInt(nP) * BigInt(r.holdings)) / total;
                if (BigInt(r.alloc) !== fl && BigInt(r.alloc) !== fl + 1n) { bad = `cfg${k}: ${r.address} alloc=${r.alloc} floor=${fl}`; break; }
                if ((per.get(r.address) || 0) !== r.alloc) { bad = `cfg${k}: deal mismatch`; break; }
            }
        }
        check('A: 200-config property test (invariants + exact floors)', bad === null, bad || undefined);
    }

    // ---- B. known-answer tests (spec freeze) ------------------------------
    {
        const cj = canonicalJson({ b: 1, a: [2, { d: 3, c: 4 }], e: 'x' });
        check('B: canonical JSON bytes are frozen', cj === '{"a":[2,{"c":4,"d":3}],"b":1,"e":"x"}', cj);
        check('B: canonical JSON hash is frozen',
            sha256hex(cj) === 'c66029fe8a75066f2e443136147e022e57cc2db3796590170f3429ffb45d17f9');
        const r = randStream('55c744acf7fdf6977dba5157fa97544d293f6dacd7685d316f6fe2273225f57a');
        const draws = [r(), r(), r(), r(), r()].map(x => x.toFixed(17)).join(',');
        check('B: SHA-256 rand stream first draws are frozen',
            draws === '0.86104864027314820,0.55642965397490352,0.67836335517016833,0.95712446700077070,0.72534712687357239', draws);
        let threw = false;
        try { randStream('abcd'); } catch (e) { threw = true; }
        check('B: randStream rejects a non-32-byte seed', threw);
    }

    // ---- C. CLI behavior --------------------------------------------------
    {
        const u = run([]);
        check('C: no command -> usage, exit 2', u.status === 2 && u.out.includes('usage:'));
        const m = run(['snapshot', '--issuer', 'rX']);
        check('C: snapshot with missing args -> clean error, exit 2', m.status === 2 && m.out.includes('required'));
        const snap = JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8'));
        const corrupted = JSON.parse(JSON.stringify(snap));
        corrupted.holders[0][1] += 1; // inflate a holding, keep stale hash
        const cPath = path.join(tmp, 'corrupt_snapshot.json');
        fs.writeFileSync(cPath, JSON.stringify(corrupted));
        const p = run(['plan', '--snapshot', cPath, '--beacon-ledger', '999999999']);
        check('C: plan refuses a tampered snapshot (hash mismatch), exit 2',
            p.status === 2 && p.out.includes('corrupted'));
        const v = run(['verify', '--snapshot', cPath, '--plan', PLAN, '--no-resweep']);
        check('C: verify refuses a tampered snapshot, exit 2', v.status === 2 && v.out.includes('corrupted'));
    }

    // ---- D. tamper detection on the plan (verify must FAIL) ---------------
    {
        const plan = JSON.parse(fs.readFileSync(PLAN, 'utf8'));

        const t1 = JSON.parse(JSON.stringify(plan));
        const a = 0, b = t1.transfers.length - 1;
        [t1.transfers[a].to, t1.transfers[b].to] = [t1.transfers[b].to, t1.transfers[a].to];
        const p1 = path.join(tmp, 'tampered1.json');
        fs.writeFileSync(p1, JSON.stringify(t1));
        const r1 = run(['verify', '--snapshot', SNAPSHOT, '--plan', p1, '--no-resweep']);
        check('D: swapped recipients -> verify FAILs', r1.status === 1 && /FAIL/.test(r1.out));

        // attacker also recomputes transfersHash over the tampered list:
        // reproduce-from-seed must still catch it
        const t2 = JSON.parse(JSON.stringify(t1));
        t2.transfersHash = sha256hex(canonicalJson(t2.transfers));
        const p2 = path.join(tmp, 'tampered2.json');
        fs.writeFileSync(p2, JSON.stringify(t2));
        const r2 = run(['verify', '--snapshot', SNAPSHOT, '--plan', p2, '--no-resweep']);
        check('D: tampered transfers with recomputed hash -> verify still FAILs',
            r2.status === 1 && r2.out.includes('FAIL  transfers reproduce exactly'));

        const t3 = JSON.parse(JSON.stringify(plan));
        t3.seedHex = sha256hex('not-the-beacon');
        const p3 = path.join(tmp, 'tampered3.json');
        fs.writeFileSync(p3, JSON.stringify(t3));
        const r3 = run(['verify', '--snapshot', SNAPSHOT, '--plan', p3, '--no-resweep']);
        check('D: tampered seed -> verify FAILs the seed derivation check',
            r3.status === 1 && r3.out.includes('FAIL  seed == SHA-256(beacon ledger hash)'));
    }

    // ---- E. commit + commitment-tx negative -------------------------------
    {
        const snap = JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8'));
        const c = run(['commit', '--snapshot', SNAPSHOT, '--beacon-ledger', String(snap.ledgerIndex + 100000)]);
        const memoType = Buffer.from('fairdrop/v1').toString('hex').toUpperCase();
        check('E: commit prints commitment + correct MemoType hex, exit 0',
            c.status === 0 && c.out.includes('commitment') && c.out.includes(memoType));
        const hex = (c.out.match(/commitment\s+([0-9a-f]{64})/) || [])[1];
        check('E: commitment is a 64-char sha256 hex', !!hex);

        // a real validated tx (collection mint) that is NOT a commitment:
        // account matches the distributor but the memo check must FAIL
        const plan = JSON.parse(fs.readFileSync(PLAN, 'utf8'));
        const r = run(['verify', '--snapshot', SNAPSHOT, '--plan', PLAN, '--no-resweep',
            '--commit-tx', 'DEBCFCDAA63908C7079D9EF870CCE1488DDCA956010A831D31F408D4AB7D7C8C']);
        check('E: verify --commit-tx rejects a tx without the commitment memo',
            r.status === 1 && r.out.includes('FAIL  commitment memo matches'), undefined);
        check('E: ...while the rest of the plan still verifies',
            r.out.includes('PASS  transfers reproduce exactly'));
    }

    // ---- F. audit-offers on an unexecuted plan ----------------------------
    {
        const plan = JSON.parse(fs.readFileSync(PLAN, 'utf8'));
        const sub = { ...plan, transfers: plan.transfers.slice(0, 10) };
        const sPath = path.join(tmp, 'subset_plan.json');
        fs.writeFileSync(sPath, JSON.stringify(sub));
        const r = run(['audit-offers', '--plan', sPath]);
        const m = r.out.match(/offers matching plan: (\d+)\/10[\s\S]*already claimed\s*: (\d+)[\s\S]*missing offers\s*: (\d+)[\s\S]*wrong-destination\s*: (\d+)/);
        const sums = m ? Number(m[1]) + Number(m[2]) + Number(m[3]) + Number(m[4]) : -1;
        check('F: audit-offers accounts for every transfer and flags the unexecuted plan',
            r.status === 1 && sums === 10, m ? `ok=${m[1]} claimed=${m[2]} missing=${m[3]} wrong=${m[4]}` : 'no summary parsed');
    }

    fs.rmSync(tmp, { recursive: true, force: true });
    console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    process.exit(failures ? 1 : 0);
})().catch(e => { console.error('[edge-test]', e); process.exit(2); });
