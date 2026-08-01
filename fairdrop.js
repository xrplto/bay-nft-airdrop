#!/usr/bin/env node
'use strict';
// fairdrop — provably-fair proportional NFT distribution on the XRP Ledger.
// Zero dependencies (Node 18+). Everything is derived from PUBLIC chain data
// and a PUBLIC, pre-committed randomness beacon, so anyone can reproduce and
// verify every byte of the plan without trusting the operator.
//
//   snapshot      pin a ledger, sweep issuer+taxon ownership from any node
//   plan          derive the seed from the beacon ledger hash, build the plan
//   commit        print the commitment (memo payload) to anchor on-chain
//   verify        re-derive EVERYTHING independently and check the plan
//   audit-offers  after execution: check on-chain offers match the plan
//
// ALGORITHM (fairdrop-v2), fully deterministic given (snapshot, beacon):
//   1. holders = all owners of live (unburned) NFTs of issuer+taxon at the
//      snapshot ledger, minus the distributor and the exclude list, as
//      [address, count] sorted by address (ASCII). pool = the distributor's
//      NFT ids, sorted. Both are canonically ordered — plan output depends
//      only on snapshot CONTENT, never on database or node enumeration order.
//   2. AMOUNTS ARE PURE HOLDING-PERCENTAGE MATH — NO RANDOMNESS. Exact quota_i
//      = pool * holdings_i / totalHoldings, computed in exact integer
//      arithmetic (BigInt — no float anywhere in the allocation). Every holder
//      is guaranteed floor(quota_i); the remaining seats go to the LARGEST
//      fractional remainders (whoever is mathematically closest to the next
//      whole NFT). Exact remainder ties break by holdings (desc), then by
//      address (ascending) — documented, reproducible, no draw.
//   3. seed = SHA-256(UTF-8 of the beacon ledger's hash, uppercase hex).
//      randomness = SHA-256 counter stream: block_i = SHA-256(seed || BE64(i)),
//      each block yields 4 doubles (each 8 bytes -> top 53 bits / 2^53).
//      The seed decides ONLY which specific NFT ids each recipient gets
//      (so nobody can cherry-pick rare pieces) — never how many.
//   4. The pool is Fisher-Yates shuffled with the stream and dealt
//      sequentially in canonical holder order.
//   rand consumption order: pool shuffle (poolLen-1 draws). Nothing else draws.
//
// Canonical JSON (hashed forms): UTF-8, object keys sorted, no whitespace.

const crypto = require('crypto');
const fs = require('fs');

const VERSION = 'fairdrop-v2';
const DEFAULT_NODE = 'https://s1.ripple.com:51234/';

// ---------------------------------------------------------------- utilities
function sha256hex(data) { return crypto.createHash('sha256').update(data).digest('hex'); }

function canonicalJson(v) {
    if (v === null || typeof v !== 'object') return JSON.stringify(v);
    if (Array.isArray(v)) return '[' + v.map(canonicalJson).join(',') + ']';
    return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canonicalJson(v[k])).join(',') + '}';
}

function parseArgs(argv) {
    const out = { _: [] };
    for (let i = 0; i < argv.length; i++) {
        if (argv[i].startsWith('--')) {
            const k = argv[i].slice(2);
            if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) out[k] = argv[++i];
            else out[k] = true;
        } else out._.push(argv[i]);
    }
    return out;
}

async function rpc(node, method, params) {
    for (let attempt = 1; ; attempt++) {
        try {
            const res = await fetch(node, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ method, params: [params] }),
                signal: AbortSignal.timeout(30000),
            });
            if (!res.ok) throw new Error(`http ${res.status}`);
            const r = (await res.json()).result || {};
            if (r.status === 'error' && ['slowDown', 'tooBusy', 'noNetwork', 'internal'].includes(r.error)) throw new Error(r.error);
            return r;
        } catch (e) {
            if (attempt >= 6) throw e;
            await new Promise(r => setTimeout(r, 1000 * attempt));
        }
    }
}

// -------------------------------------------------- deterministic randomness
// SHA-256 counter stream — crypto-grade, trivially reimplementable anywhere.
function randStream(seedHex) {
    const seed = Buffer.from(seedHex, 'hex');
    if (seed.length !== 32) throw new Error('seed must be 32 bytes hex');
    let counter = 0n, buf = null, off = 32;
    return function rand() {
        if (off >= 32) {
            const ctr = Buffer.alloc(8);
            ctr.writeBigUInt64BE(counter++);
            buf = crypto.createHash('sha256').update(seed).update(ctr).digest();
            off = 0;
        }
        const v = buf.readBigUInt64BE(off); off += 8;
        return Number(v >> 11n) / 9007199254740992; // 53-bit mantissa / 2^53
    };
}

// ------------------------------------------------------------ the algorithm
// Exact integer math: floor and remainder come from BigInt division, so the
// allocation is provably immune to float rounding at any collection size.
// (quota stays a float for DISPLAY only — it never feeds the allocation.)
function computeRecips(holderCounts, poolSize) {
    const total = holderCounts.reduce((s, h) => s + h.holdings, 0);
    const P = BigInt(poolSize), H = BigInt(total || 1);
    return holderCounts.map(({ address, holdings }) => {
        const num = P * BigInt(holdings);
        const remNum = num % H;
        return {
            address, holdings,
            quota: poolSize * holdings / total,
            alloc: Number(num / H),
            remNum,                            // exact remainder numerator (/total)
            rem: Number(remNum) / total,       // display/tests only
        };
    });
}

// Deterministic largest-remainder award — NO randomness in amounts.
// Seats go to the largest exact fractional remainders; exact ties break by
// holdings (desc), then address (ascending). Mutates recips: winners alloc++.
function awardRemainderSeats(recips, seats) {
    if (seats <= 0) return;
    const elig = recips.filter(r => r.remNum > 0n).sort((a, b) => {
        if (a.remNum !== b.remNum) return a.remNum > b.remNum ? -1 : 1;
        if (a.holdings !== b.holdings) return b.holdings - a.holdings;
        return a.address < b.address ? -1 : 1;
    });
    for (let i = 0; i < seats && i < elig.length; i++) elig[i].alloc++;
}

function assignNfts(pool, recips, rand) {
    const shuffled = [...pool];
    for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    const transfers = [];
    let cursor = 0;
    for (const r of recips) {
        for (let k = 0; k < r.alloc; k++) transfers.push({ nft_id: shuffled[cursor++], to: r.address });
    }
    return transfers;
}

// holders: [{address, holdings}] in ANY order; pool: [nft_id] in ANY order.
// Canonical sorting happens HERE so output depends only on content + seed.
function buildPlan(holders, pool, seedHex) {
    const hc = [...holders].sort((a, b) => (a.address < b.address ? -1 : a.address > b.address ? 1 : 0));
    const p = [...pool].sort();
    if (new Set(hc.map(h => h.address)).size !== hc.length) throw new Error('duplicate holder address');
    if (new Set(p).size !== p.length) throw new Error('duplicate nft in pool');
    const rand = randStream(seedHex);
    const recips = computeRecips(hc, p.length);
    const seats = p.length - recips.reduce((s, r) => s + r.alloc, 0);
    awardRemainderSeats(recips, seats);
    const transfers = assignNfts(p, recips, rand);
    // invariants — a violated one means a broken build, never ship it
    if (transfers.length !== p.length) throw new Error('invariant: transfer count');
    if (recips.reduce((s, r) => s + r.alloc, 0) !== p.length) throw new Error('invariant: allocation sum');
    if (new Set(transfers.map(t => t.nft_id)).size !== p.length) throw new Error('invariant: duplicate nft');
    return { recips, seats, transfers };
}

// ------------------------------------------------------------------ snapshot
function snapshotHashOf(s) {
    return sha256hex(canonicalJson({
        version: s.version, network: s.network, issuer: s.issuer, taxon: s.taxon,
        distributor: s.distributor, exclude: s.exclude, ledgerIndex: s.ledgerIndex,
        holders: s.holders, pool: s.pool,
    }));
}

async function sweepOwnership(node, issuer, taxon, ledgerIndex) {
    const owners = new Map(); // nft_id -> owner (live only)
    let marker;
    do {
        const params = { issuer, nft_taxon: taxon, limit: 100, ledger_index: ledgerIndex };
        if (marker) params.marker = marker;
        const r = await rpc(node, 'nfts_by_issuer', params);
        if (r.status === 'error') throw new Error(`nfts_by_issuer: ${r.error}`);
        for (const n of r.nfts) if (!n.is_burned) owners.set(n.nft_id, n.owner);
        marker = r.marker;
    } while (marker);
    return owners;
}

async function cmdSnapshot(a) {
    const node = a.node || DEFAULT_NODE;
    const network = a.network || 'xrpl-mainnet';
    const issuer = a.issuer, taxon = Number(a.taxon), distributor = a.distributor;
    if (!issuer || !distributor || Number.isNaN(taxon)) throw new Error('required: --issuer --taxon --distributor');
    const exclude = (a.exclude ? a.exclude.split(',') : []).sort();
    let ledgerIndex = a.ledger ? Number(a.ledger) : null;
    if (!ledgerIndex) {
        const l = await rpc(node, 'ledger', { ledger_index: 'validated' });
        ledgerIndex = Number(l.ledger_index || l.ledger.ledger_index);
    }
    console.log(`[fairdrop] snapshot at validated ledger ${ledgerIndex} via ${node}`);

    // two independent sweeps must agree byte-for-byte (guards pagination glitches)
    const s1 = await sweepOwnership(node, issuer, taxon, ledgerIndex);
    const s2 = await sweepOwnership(node, issuer, taxon, ledgerIndex);
    const c1 = canonicalJson([...s1.entries()].sort()), c2 = canonicalJson([...s2.entries()].sort());
    if (c1 !== c2) throw new Error('two sweeps of the same ledger disagreed — node unstable, retry');

    const holdersMap = new Map();
    const pool = [];
    for (const [id, owner] of s1) {
        if (owner === distributor) pool.push(id);
        else if (!exclude.includes(owner)) holdersMap.set(owner, (holdersMap.get(owner) || 0) + 1);
    }
    const snapshot = {
        version: VERSION, network, issuer, taxon, distributor, exclude,
        ledgerIndex,
        holders: [...holdersMap.entries()].sort((x, y) => (x[0] < y[0] ? -1 : 1)),
        pool: pool.sort(),
    };
    snapshot.snapshotHash = snapshotHashOf(snapshot);
    snapshot.generatedAt = new Date().toISOString();
    snapshot.node = node;
    const out = a.out || 'snapshot.json';
    fs.writeFileSync(out, JSON.stringify(snapshot, null, 2));
    console.log(`[fairdrop] holders=${snapshot.holders.length} pool=${snapshot.pool.length} totalOtherHoldings=${snapshot.holders.reduce((s, h) => s + h[1], 0)}`);
    console.log(`[fairdrop] snapshotHash ${snapshot.snapshotHash}`);
    console.log(`[fairdrop] written ${out}`);
}

// ---------------------------------------------------------------------- plan
async function fetchBeacon(node, ledgerIndex) {
    const r = await rpc(node, 'ledger', { ledger_index: ledgerIndex });
    if (r.status === 'error') throw new Error(`ledger ${ledgerIndex}: ${r.error}`);
    if (r.validated !== true) throw new Error(`ledger ${ledgerIndex} is not validated yet`);
    const hash = (r.ledger_hash || r.ledger.ledger_hash).toUpperCase();
    return { ledgerIndex: Number(ledgerIndex), ledgerHash: hash };
}
const seedFromBeacon = (beacon) => sha256hex(beacon.ledgerHash);

function loadSnapshot(path) {
    const s = JSON.parse(fs.readFileSync(path, 'utf8'));
    if (snapshotHashOf(s) !== s.snapshotHash) throw new Error('snapshot file corrupted: embedded snapshotHash does not match content');
    return s;
}

function planBodyFrom(snapshot, beacon, seedHex) {
    const holders = snapshot.holders.map(([address, holdings]) => ({ address, holdings }));
    const { recips, seats, transfers } = buildPlan(holders, snapshot.pool, seedHex);
    const winners = recips.filter(r => r.alloc > 0)
        .sort((x, y) => y.alloc - x.alloc || (x.address < y.address ? -1 : 1));
    return {
        version: VERSION,
        issuer: snapshot.issuer, taxon: snapshot.taxon, distributor: snapshot.distributor,
        snapshotLedger: snapshot.ledgerIndex, snapshotHash: snapshot.snapshotHash,
        beacon, seedHex,
        poolSize: snapshot.pool.length, seats,
        recipientsTotal: recips.length, recipientsWinning: winners.length,
        allocations: winners.map(({ address, holdings, quota, alloc }) => ({ address, holdings, quota: +quota.toFixed(4), count: alloc })),
        transfers,
        transfersHash: sha256hex(canonicalJson(transfers)),
    };
}

async function cmdPlan(a) {
    const node = a.node || DEFAULT_NODE;
    const snapshot = loadSnapshot(a.snapshot || 'snapshot.json');
    // An empty pool used to yield a valid-looking plan with zero transfers — nothing to distribute is
    // an operator mistake (wrong distributor, wrong taxon), not a plan.
    if (!snapshot.pool.length) throw new Error('snapshot pool is empty — the distributor holds no NFTs of this issuer+taxon, nothing to distribute');
    if (!snapshot.holders.length) throw new Error('snapshot has no holders — nobody to distribute to');
    if (!a['beacon-ledger']) throw new Error('required: --beacon-ledger N (the pre-committed FUTURE ledger index)');
    const beacon = await fetchBeacon(node, Number(a['beacon-ledger']));
    if (beacon.ledgerIndex <= snapshot.ledgerIndex) throw new Error('beacon ledger must come AFTER the snapshot ledger');
    const seedHex = seedFromBeacon(beacon);
    const plan = planBodyFrom(snapshot, beacon, seedHex);
    plan.codeSha256 = sha256hex(fs.readFileSync(__filename));
    plan.generatedAt = new Date().toISOString();
    const out = a.out || 'plan.json';
    fs.writeFileSync(out, JSON.stringify(plan, null, 2));
    console.log(`[fairdrop] beacon ledger ${beacon.ledgerIndex} hash ${beacon.ledgerHash}`);
    console.log(`[fairdrop] seed ${seedHex}`);
    console.log(`[fairdrop] ${plan.poolSize} nfts -> ${plan.recipientsWinning}/${plan.recipientsTotal} holders (whole shares=${plan.poolSize - plan.seats}, largest-remainder seats=${plan.seats})`);
    console.log(`[fairdrop] transfersHash ${plan.transfersHash}`);
    console.log(`[fairdrop] written ${out}`);
}

// -------------------------------------------------------------------- commit
function commitmentOf(snapshotHash, codeSha256, beaconLedger) {
    return sha256hex(canonicalJson({ version: VERSION, snapshotHash, codeSha256, beaconLedger }));
}

async function cmdCommit(a) {
    const snapshot = loadSnapshot(a.snapshot || 'snapshot.json');
    if (!a['beacon-ledger']) throw new Error('required: --beacon-ledger N (a FUTURE ledger index, not validated yet)');
    const beaconLedger = Number(a['beacon-ledger']);
    const codeSha256 = sha256hex(fs.readFileSync(__filename));
    const commitment = commitmentOf(snapshot.snapshotHash, codeSha256, beaconLedger);
    console.log(`[fairdrop] snapshotHash ${snapshot.snapshotHash}`);
    console.log(`[fairdrop] codeSha256   ${codeSha256}`);
    console.log(`[fairdrop] beaconLedger ${beaconLedger}`);
    console.log(`[fairdrop] commitment   ${commitment}`);
    console.log(`
Anchor this commitment on-chain BEFORE ledger ${beaconLedger} validates:
send any minimal transaction (e.g. an AccountSet) FROM the distributor account
${snapshot.distributor} carrying this memo:

  "Memos": [{ "Memo": {
    "MemoType": "${Buffer.from('fairdrop/v1').toString('hex').toUpperCase()}",
    "MemoData": "${commitment.toUpperCase()}"
  }}]

The tool never touches keys — sign with whatever wallet controls the account.
Afterwards, verifiers pass the transaction hash as --commit-tx.`);
}

// -------------------------------------------------------------------- verify
async function cmdVerify(a) {
    const node = a.node || DEFAULT_NODE;
    let failures = 0;
    const check = (name, ok, detail) => {
        console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  [' + detail + ']' : ''}`);
        if (!ok) failures++;
    };

    const snapshot = loadSnapshot(a.snapshot || 'snapshot.json'); // throws if content/hash mismatch
    check('snapshot content matches its embedded snapshotHash', true);
    const plan = JSON.parse(fs.readFileSync(a.plan || 'plan.json', 'utf8'));
    check('plan references this snapshot', plan.snapshotHash === snapshot.snapshotHash);

    // Excluded addresses are the one input a verifier CANNOT re-derive from chain: the resweep applies
    // snapshot.exclude while rebuilding, so an excluded holder is absent from both sides and every other
    // check still passes. Left silent, `ALL PASS` would endorse a plan that quietly cut holders out —
    // in testing, excluding all-but-one holder handed that address 100% of the pool and still printed
    // ALL PASS. So the list is always shown, and a non-empty one FAILS unless explicitly accepted.
    if (snapshot.exclude.length) {
        console.log(`[fairdrop] snapshot EXCLUDES ${snapshot.exclude.length} address(es) from the distribution:`);
        for (const addr of snapshot.exclude.slice(0, 20)) console.log(`             ${addr}`);
        if (snapshot.exclude.length > 20) console.log(`             ... and ${snapshot.exclude.length - 20} more`);
        check('no addresses excluded from the distribution', !!a['allow-exclusions'],
            a['allow-exclusions'] ? 'accepted via --allow-exclusions' : 'rerun with --allow-exclusions if these exclusions are intended and published');
    } else {
        check('no addresses excluded from the distribution', true);
    }

    // 1. independently rebuild the snapshot from chain at the pinned ledger
    if (!a['no-resweep']) {
        console.log(`[fairdrop] resweeping ledger ${snapshot.ledgerIndex} from ${node} ...`);
        const owners = await sweepOwnership(node, snapshot.issuer, snapshot.taxon, snapshot.ledgerIndex);
        const holdersMap = new Map();
        const pool = [];
        for (const [id, owner] of owners) {
            if (owner === snapshot.distributor) pool.push(id);
            else if (!snapshot.exclude.includes(owner)) holdersMap.set(owner, (holdersMap.get(owner) || 0) + 1);
        }
        const rebuilt = snapshotHashOf({
            version: snapshot.version, network: snapshot.network, issuer: snapshot.issuer,
            taxon: snapshot.taxon, distributor: snapshot.distributor, exclude: snapshot.exclude,
            ledgerIndex: snapshot.ledgerIndex,
            holders: [...holdersMap.entries()].sort((x, y) => (x[0] < y[0] ? -1 : 1)),
            pool: pool.sort(),
        });
        check('snapshot reproducible from chain at pinned ledger', rebuilt === snapshot.snapshotHash, `rebuilt=${rebuilt.slice(0, 16)}...`);
    } else console.log('[fairdrop] resweep SKIPPED (--no-resweep) — snapshot taken on trust');

    // 2. beacon + seed
    const beacon = await fetchBeacon(node, plan.beacon.ledgerIndex);
    check('beacon ledger hash matches this node', beacon.ledgerHash === plan.beacon.ledgerHash.toUpperCase());
    check('beacon ledger is after snapshot ledger', plan.beacon.ledgerIndex > snapshot.ledgerIndex);
    const seedHex = seedFromBeacon(beacon);
    check('seed == SHA-256(beacon ledger hash)', seedHex === plan.seedHex);

    // 3. re-run the algorithm; the result must be byte-identical.
    // Hash the plan's ACTUAL transfers list — never trust its stored hash
    // field (a tamper could edit one and not the other).
    const rebuilt = planBodyFrom(snapshot, beacon, seedHex);
    const actualHash = sha256hex(canonicalJson(plan.transfers));
    check('plan.transfersHash matches its own transfers list', actualHash === plan.transfersHash,
        `actual=${actualHash.slice(0, 16)}...`);
    check('transfers reproduce exactly from the seed', rebuilt.transfersHash === actualHash,
        `rebuilt=${rebuilt.transfersHash.slice(0, 16)}...`);
    check('allocations reproduce exactly', canonicalJson(rebuilt.allocations) === canonicalJson(plan.allocations));
    const myCode = sha256hex(fs.readFileSync(__filename));
    check('running the same code version as the plan', myCode === plan.codeSha256,
        myCode === plan.codeSha256 ? undefined : `mine=${myCode.slice(0, 16)}... plan=${String(plan.codeSha256).slice(0, 16)}...`);

    // 4. exact allocation math, BigInt rationals — independent of the float path
    const P = BigInt(snapshot.pool.length);
    const H = BigInt(snapshot.holders.reduce((s, h) => s + h[1], 0));
    const alloc = new Map(plan.allocations.map(x => [x.address, x]));
    let sumFloor = 0n, sumRemNum = 0n, sumCount = 0n, plusOnes = 0n;
    let badCount = 0, floatFloorMismatch = 0, seatZeroRem = 0, badQuota = 0;
    for (const [address, h] of snapshot.holders) {
        const num = P * BigInt(h);
        const fl = num / H, remNum = num % H;
        sumFloor += fl; sumRemNum += remNum;
        const count = BigInt(alloc.get(address)?.count ?? 0);
        sumCount += count;
        if (count !== fl && count !== fl + 1n) badCount++;
        if (count === fl + 1n) { plusOnes++; if (remNum === 0n) seatZeroRem++; }
        if (BigInt(Math.floor(snapshot.pool.length * h / Number(H))) !== fl) floatFloorMismatch++;
        const q = alloc.get(address)?.quota;
        if (q !== undefined && Math.abs(q - Number(num) / Number(H)) > 5e-5) badQuota++;
    }
    check('every count is exact floor(quota) or floor+1', badCount === 0, `${badCount} bad`);
    check('sum(counts) == pool exactly', sumCount === P);
    check('rounding seats == pool - sum(floors) exactly', plusOnes === P - sumFloor);
    check('sum of exact remainders == seats exactly', sumRemNum === (P - sumFloor) * H);
    check('float floor == exact floor for every holder', floatFloorMismatch === 0);
    check('no seat went to a zero-remainder holder', seatZeroRem === 0);
    check('stored quotas match exact values (4dp)', badQuota === 0);

    // independent recompute of the DETERMINISTIC allocation: seats must go to
    // the largest exact remainders (ties: holdings desc, then address asc)
    {
        const rows = snapshot.holders.map(([address, h]) => {
            const num = P * BigInt(h);
            return { address, h, fl: num / H, remNum: num % H };
        });
        const seatsN = Number(P - rows.reduce((s, r) => s + r.fl, 0n));
        const elig = rows.filter(r => r.remNum > 0n).sort((a, b) => {
            if (a.remNum !== b.remNum) return a.remNum > b.remNum ? -1 : 1;
            if (a.h !== b.h) return b.h - a.h;
            return a.address < b.address ? -1 : 1;
        });
        const expected = new Map(rows.map(r => [r.address, Number(r.fl)]));
        for (let i = 0; i < seatsN && i < elig.length; i++) {
            expected.set(elig[i].address, expected.get(elig[i].address) + 1);
        }
        let wrong = 0;
        for (const [address, exp] of expected) {
            if ((alloc.get(address)?.count ?? 0) !== exp) wrong++;
        }
        check('allocation == deterministic largest-remainder rule exactly', wrong === 0, `${wrong} mismatched holders`);
    }

    // 5. transfers integrity vs snapshot
    const ids = plan.transfers.map(t => t.nft_id);
    const poolSet = new Set(snapshot.pool);
    const holderSet = new Set(snapshot.holders.map(h => h[0]));
    check('transfer count == pool', ids.length === snapshot.pool.length);
    check('no duplicate nft in transfers', new Set(ids).size === ids.length);
    check('every transferred nft is in the snapshot pool', ids.every(id => poolSet.has(id)));
    check('no self-transfer / no transfer to excluded', plan.transfers.every(t => t.to !== snapshot.distributor && !snapshot.exclude.includes(t.to)));
    check('every recipient is a snapshot holder', plan.transfers.every(t => holderSet.has(t.to)));
    const perAddr = new Map();
    for (const t of plan.transfers) perAddr.set(t.to, (perAddr.get(t.to) || 0) + 1);
    let mismatch = 0;
    for (const [addr, n] of perAddr) if ((alloc.get(addr)?.count ?? 0) !== n) mismatch++;
    for (const [addr, x] of alloc) if (!perAddr.has(addr) && x.count > 0) mismatch++;
    check('per-recipient transfer counts == allocation counts', mismatch === 0);

    // 6. optional on-chain commitment
    if (a['commit-tx']) {
        const tx = await rpc(node, 'tx', { transaction: a['commit-tx'] });
        const okTx = tx.status !== 'error' && (tx.validated === true || tx.meta);
        check('commitment tx found and validated', okTx);
        if (okTx) {
            const t = tx.tx_json || tx;
            const commitment = commitmentOf(snapshot.snapshotHash, plan.codeSha256, plan.beacon.ledgerIndex).toUpperCase();
            const memoHit = (t.Memos || []).some(m => (m.Memo?.MemoData || '').toUpperCase() === commitment);
            check('commitment tx sent by distributor', t.Account === snapshot.distributor);
            check('commitment memo matches sha256(snapshot,code,beaconLedger)', memoHit);
            const txLedger = tx.ledger_index || t.ledger_index;
            check('commitment validated BEFORE beacon ledger', Number(txLedger) < plan.beacon.ledgerIndex,
                `commit@${txLedger} beacon@${plan.beacon.ledgerIndex}`);
        }
    } else console.log('[fairdrop] no --commit-tx given — commitment anchoring not checked');

    console.log(`\n${failures === 0 ? 'ALL PASS — plan is fully reproducible from public data' : failures + ' FAILURE(S)'}`);
    process.exit(failures ? 1 : 0);
}

// -------------------------------------------------------------- audit-offers
// A transfer is SATISFIED when the recipient already owns the NFT (claimed)
// or a matching destination-locked zero-cost offer is open. Owner is checked
// FIRST — an accepted offer disappears from the books and must not read as
// "missing".
async function cmdAuditOffers(a) {
    const node = a.node || DEFAULT_NODE;
    const plan = JSON.parse(fs.readFileSync(a.plan || 'plan.json', 'utf8'));
    const results = { claimed: 0, ok: 0, missing: [], wrong: [] };
    let done = 0;
    const queue = [...plan.transfers];
    async function worker() {
        for (;;) {
            const t = queue.shift();
            if (!t) return;
            const info = await rpc(node, 'nft_info', { nft_id: t.nft_id });
            if (info.status !== 'error' && info.owner === t.to) {
                results.claimed++;
                if (++done % 100 === 0) console.log(`[fairdrop] ... ${done}/${plan.transfers.length}`);
                continue;
            }
            // Follow the marker: nft_sell_offers is paginated, and a token carrying offer spam can push
            // OUR destination-locked offer onto a later page. Reading page 1 only reported a live,
            // correct transfer as "missing" (verified in testing behind 5 spam offers).
            const offers = [];
            let marker;
            do {
                const params = { nft_id: t.nft_id, limit: 400 };
                if (marker) params.marker = marker;
                const r = await rpc(node, 'nft_sell_offers', params);
                if (r.status === 'error') break;          // no offers at all -> classified missing below
                offers.push(...(r.offers || []));
                marker = r.marker;
            } while (marker);
            const hit = offers.find(o => o.owner === plan.distributor && o.amount === '0'
                && (o.flags & 1) === 1 && o.destination === t.to);
            if (hit) results.ok++;
            else if (offers.some(o => o.owner === plan.distributor)) results.wrong.push(t);
            else results.missing.push(t);
            if (++done % 100 === 0) console.log(`[fairdrop] ... ${done}/${plan.transfers.length}`);
        }
    }
    await Promise.all(Array.from({ length: 8 }, worker));
    console.log(`\noffers matching plan: ${results.ok}/${plan.transfers.length}`);
    console.log(`already claimed     : ${results.claimed}`);
    console.log(`missing offers      : ${results.missing.length}`);
    console.log(`wrong-destination   : ${results.wrong.length}`);
    for (const t of [...results.wrong, ...results.missing].slice(0, 20)) console.log(`  ${t.nft_id} -> ${t.to}`);
    process.exit(results.missing.length || results.wrong.length ? 1 : 0);
}

// ---------------------------------------------------------------------- cli
module.exports = { VERSION, sha256hex, canonicalJson, randStream, computeRecips, awardRemainderSeats, assignNfts, buildPlan, snapshotHashOf, seedFromBeacon, commitmentOf };

if (require.main === module) {
    const [cmd, ...rest] = process.argv.slice(2);
    const a = parseArgs(rest);
    const cmds = { snapshot: cmdSnapshot, plan: cmdPlan, commit: cmdCommit, verify: cmdVerify, 'audit-offers': cmdAuditOffers };
    if (!cmds[cmd]) {
        console.log(`usage: node fairdrop.js <command>

  snapshot      --issuer r.. --taxon N --distributor r.. [--ledger L] [--exclude a,b] [--node URL] [--out f]
  plan          --snapshot f --beacon-ledger N [--node URL] [--out f]
  commit        --snapshot f --beacon-ledger N
  verify        --snapshot f --plan f [--node URL] [--commit-tx HASH] [--no-resweep] [--allow-exclusions]
  audit-offers  --plan f [--node URL]

default node: ${DEFAULT_NODE}`);
        process.exit(2);
    }
    cmds[cmd](a).catch(e => { console.error('[fairdrop]', e.message || e); process.exit(2); });
}
