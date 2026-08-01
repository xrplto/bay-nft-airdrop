#!/usr/bin/env node
'use strict';
// E2E audit of fairdrop-v2 randomization scope. Tests the SHIPPED functions
// (require('./fairdrop.js') — not a copy) against the real holder snapshot.
// Zero dependencies, one command, exits non-zero on failure:
//
//   node fairdrop.js snapshot --issuer .. --taxon .. --distributor ..
//   [TRIALS=n] node test_randomization.js [snapshot.json]
//
// fairdrop-v2 contract: AMOUNTS are pure deterministic holding-percentage math
// (largest remainder, ties by holdings then address) — the beacon seed decides
// ONLY which specific NFT ids a recipient gets. The battery proves both sides:
//   1. determinism  — same seed 3x => byte-identical plan; input order irrelevant
//   2. amounts      — allocation is IDENTICAL across many different seeds, and
//                     equals an independent exact-BigInt reference of the rule
//   3. prng         — SHA-256 counter stream: mean / 100-bin chi-square / lag-1
//   4. assignment   — which specific NFT a recipient receives is uniform over
//                     the pool (chi-square for the top recipient + first-dealt)
//   5. avalanche    — different seeds give uncorrelated id-assignments
//   6. negative controls — a rigged allocation and an unshuffled dealer pushed
//                     through the SAME battery MUST be flagged (proves the
//                     harness can fail)

const fs = require('fs');
const { sha256hex, randStream, computeRecips, buildPlan, snapshotHashOf } = require('./fairdrop.js');

const SNAPSHOT = process.argv[2] || 'snapshot.json';
const TRIALS = Number(process.env.TRIALS) || 10000;
const CTRL_TRIALS = 2000;
const trialSeed = t => sha256hex(`fairdrop-battery|${t}`);

let failures = 0;
function check(name, ok, detail) {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  [' + detail + ']' : ''}`);
    if (!ok) failures++;
}

// independent exact reference of the v2 allocation rule (BigInt, no shared code)
function referenceAllocation(holders, poolSize) {
    const P = BigInt(poolSize), H = BigInt(holders.reduce((s, h) => s + h.holdings, 0));
    const rows = holders.map(({ address, holdings }) => {
        const num = P * BigInt(holdings);
        return { address, holdings, fl: num / H, remNum: num % H };
    });
    const seats = Number(P - rows.reduce((s, r) => s + r.fl, 0n));
    const out = new Map(rows.map(r => [r.address, Number(r.fl)]));
    rows.filter(r => r.remNum > 0n).sort((a, b) => {
        if (a.remNum !== b.remNum) return a.remNum > b.remNum ? -1 : 1;
        if (a.holdings !== b.holdings) return b.holdings - a.holdings;
        return a.address < b.address ? -1 : 1;
    }).slice(0, seats).forEach(r => out.set(r.address, out.get(r.address) + 1));
    return out;
}
const allocKey = m => JSON.stringify([...m.entries()].sort());

(() => {
    const t0 = Date.now();
    const snap = JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8'));
    if (snapshotHashOf(snap) !== snap.snapshotHash) { console.error('snapshot hash mismatch'); process.exit(2); }
    const holders = snap.holders.map(([address, holdings]) => ({ address, holdings }));
    const pool = snap.pool;
    console.log(`[rand-test] pool=${pool.length}, recipients=${holders.length}, trials=${TRIALS}\n`);

    const reference = referenceAllocation(holders, pool.length);
    const refKey = allocKey(reference);

    // ---- 1. determinism ---------------------------------------------------
    const s42 = sha256hex('det-42'), s43 = sha256hex('det-43');
    const d1 = JSON.stringify(buildPlan(holders, pool, s42).transfers);
    const d2 = JSON.stringify(buildPlan(holders, pool, s42).transfers);
    const d3 = JSON.stringify(buildPlan(holders, pool, s42).transfers);
    check('determinism: same seed 3x => identical plan', d1 === d2 && d2 === d3);
    check('determinism: different seed => different id-assignment', d1 !== JSON.stringify(buildPlan(holders, pool, s43).transfers));
    check('canonical: input order does not affect the plan',
        d1 === JSON.stringify(buildPlan([...holders].reverse(), [...pool].reverse(), s42).transfers));

    // ---- 2. amounts: deterministic + equal to the exact reference ---------
    {
        const counts = t => {
            const m = new Map();
            for (const r of buildPlan(holders, pool, trialSeed(1000000 + t)).recips) if (r.alloc > 0) m.set(r.address, r.alloc);
            return m;
        };
        const first = counts(0);
        const firstFull = new Map(holders.map(h => [h.address, 0]));
        first.forEach((v, k) => firstFull.set(k, v));
        check('amounts: allocation equals exact largest-remainder reference', allocKey(firstFull) === refKey);
        let stable = true;
        for (let t = 1; t <= 200 && stable; t++) stable = allocKey(counts(t)) === allocKey(first);
        check('amounts: allocation IDENTICAL across 200 different seeds (no lottery)', stable);
    }

    // ---- 3. prng ----------------------------------------------------------
    {
        const r = randStream(sha256hex('prng-check')), N = 1e6, B = 100, bins = new Array(B).fill(0);
        let sum = 0, lag = 0, prev = null;
        for (let i = 0; i < N; i++) {
            const x = r();
            sum += x; bins[Math.min(B - 1, Math.floor(x * B))]++;
            if (prev !== null) lag += (prev - 0.5) * (x - 0.5);
            prev = x;
        }
        const mean = sum / N;
        const chi = bins.reduce((s, b) => s + (b - N / B) ** 2 / (N / B), 0);
        const chiZ = (chi - (B - 1)) / Math.sqrt(2 * (B - 1));
        const lag1 = (lag / (N - 1)) / (1 / 12);
        check('prng: mean ~ 0.5', Math.abs(mean - 0.5) < 0.0015, `mean=${mean.toFixed(5)}`);
        check('prng: 100-bin uniformity', Math.abs(chiZ) < 4.5, `chi2 z=${chiZ.toFixed(2)}`);
        check('prng: lag-1 serial correlation ~ 0', Math.abs(lag1) < 0.005, `r=${lag1.toFixed(5)}`);
    }

    // ---- 4+5. id-assignment randomness over TRIALS seeds ------------------
    let focalAddr = null, focalAlloc = 0;
    reference.forEach((v, k) => { if (v > focalAlloc) { focalAlloc = v; focalAddr = k; } });
    const sortedPool = [...pool].sort();
    const nftIndex = new Map(sortedPool.map((id, i) => [id, i]));
    const focalCounts = new Float64Array(pool.length);
    const pos0 = new Float64Array(pool.length);
    let focalTotal = 0, overlapSum = 0, overlapPairs = 0, prevMap = null;
    for (let t = 0; t < TRIALS; t++) {
        const { transfers } = buildPlan(holders, pool, trialSeed(t));
        pos0[nftIndex.get(transfers[0].nft_id)]++;
        const map = new Map();
        for (const tr of transfers) {
            map.set(tr.nft_id, tr.to);
            if (tr.to === focalAddr) { focalCounts[nftIndex.get(tr.nft_id)]++; focalTotal++; }
        }
        if (prevMap) {
            let same = 0;
            for (const [id, to] of map) if (prevMap.get(id) === to) same++;
            overlapSum += same / pool.length; overlapPairs++;
        }
        prevMap = map;
        if ((t + 1) % 2500 === 0) console.log(`[rand-test] ... ${t + 1}/${TRIALS} trials`);
    }
    {
        const exp = focalTotal / pool.length;
        const chi = focalCounts.reduce((s, c) => s + (c - exp) ** 2 / exp, 0);
        const z = (chi - (pool.length - 1)) / Math.sqrt(2 * (pool.length - 1));
        check('assignment: per-NFT uniform for top recipient', Math.abs(z) < 4.5, `chi2 z=${z.toFixed(2)} over ${focalTotal} receipts`);
        const exp0 = TRIALS / pool.length;
        const chi0 = pos0.reduce((s, c) => s + (c - exp0) ** 2 / exp0, 0);
        const z0 = (chi0 - (pool.length - 1)) / Math.sqrt(2 * (pool.length - 1));
        check('assignment: first-dealt NFT uniform over pool', Math.abs(z0) < 4.5, `chi2 z=${z0.toFixed(2)}`);
    }
    {
        let expOverlap = 0;
        reference.forEach(v => { expOverlap += (v / pool.length) ** 2; });
        const meanOv = overlapSum / overlapPairs;
        check('avalanche: different seeds give uncorrelated id-assignments',
            meanOv > expOverlap * 0.5 && meanOv < expOverlap * 2,
            `mean overlap=${meanOv.toFixed(4)} expected~${expOverlap.toFixed(4)}`);
    }

    // ---- 6. negative controls — the battery itself must be able to go red --
    {
        // rigged allocation: seats to the SMALLEST remainders instead
        const rigged = (() => {
            const recips = computeRecips([...holders].sort((a, b) => (a.address < b.address ? -1 : 1)), pool.length);
            const seats = pool.length - recips.reduce((s, r) => s + r.alloc, 0);
            recips.filter(r => r.remNum > 0n)
                .sort((a, b) => (a.remNum < b.remNum ? -1 : 1))
                .slice(0, seats).forEach(r => r.alloc++);
            const m = new Map(holders.map(h => [h.address, 0]));
            recips.forEach(r => m.set(r.address, r.alloc));
            return m;
        })();
        check('negative control: rigged allocation IS flagged', allocKey(rigged) !== refKey);

        const pos0Rig = new Float64Array(pool.length);
        for (let t = 0; t < CTRL_TRIALS; t++) pos0Rig[0]++; // unshuffled dealer: first card always pool[0]
        const exp0 = CTRL_TRIALS / pool.length;
        const chi0 = pos0Rig.reduce((s, c) => s + (c - exp0) ** 2 / exp0, 0);
        const z0 = (chi0 - (pool.length - 1)) / Math.sqrt(2 * (pool.length - 1));
        check('negative control: unshuffled dealer IS flagged', Math.abs(z0) >= 4.5, `chi2 z=${z0.toFixed(1)}`);
    }

    console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'} in ${((Date.now() - t0) / 1000).toFixed(1)}s (${TRIALS} trials)`);
    process.exit(failures ? 1 : 0);
})();
