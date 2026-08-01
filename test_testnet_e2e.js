#!/usr/bin/env node
'use strict';
// Full write-path rehearsal of the fairdrop pipeline on XRPL TESTNET.
// Exercises everything mainnet execution will do, with worthless test funds:
//   faucet wallets -> mint a 24-NFT collection -> seed 4 holders (6/3/2/2)
//   -> snapshot -> on-chain commitment memo -> beacon -> plan
//   -> execute offers (partial run first, proving idempotent resume)
//   -> audit-offers (all open) -> verify --commit-tx (ALL PASS)
//   -> wrong-wallet accept MUST fail (tecNO_PERMISSION, destination lock)
//   -> real accepts -> re-audit (claimed) -> cancel-open -> re-audit (missing)
//
// One command, exits non-zero on failure:  node test_testnet_e2e.js
// Wallet state persists in .testnet_state.json (gitignored) for reruns.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { rpc, walletFromSeed, TxSender, validatedLedger, sleep } = require('./execute_offers.js');

const NODE = 'https://clio.altnet.rippletest.net:51234/';
const FAUCET = 'https://faucet.altnet.rippletest.net/accounts';
const TAXON = 7777;
const MINT = 24;
const SEEDING = [6, 3, 2, 2]; // holder holdings; pool = 24-13 = 11 -> exercises floors, remainders AND an exact tie
const STATE = path.join(__dirname, '.testnet_state.json');
const SNAP = path.join(__dirname, 'tn_snapshot.json');
const PLAN = path.join(__dirname, 'tn_plan.json');

let failures = 0;
function check(name, ok, detail) {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  [' + detail + ']' : ''}`);
    if (!ok) failures++;
}
function run(file, args, env) {
    const r = spawnSync('node', [path.join(__dirname, file), ...args],
        { encoding: 'utf8', timeout: 600000, env: { ...process.env, ...env } });
    return { status: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

async function faucet(destination) {
    for (let attempt = 1; attempt <= 5; attempt++) {
        try {
            const res = await fetch(FAUCET, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(destination ? { destination } : {}),
                signal: AbortSignal.timeout(30000),
            });
            const j = await res.json();
            if (!res.ok) throw new Error(JSON.stringify(j).slice(0, 120));
            return { address: j.account?.classicAddress || j.account?.address, seed: j.seed || j.account?.secret || j.secret };
        } catch (e) {
            if (attempt === 5) throw e;
            await sleep(4000 * attempt); // faucet rate-limits rapid requests
        }
    }
}

async function balance(addr) {
    const r = await rpc(NODE, 'account_info', { account: addr, ledger_index: 'validated' });
    return r.status === 'error' ? 0 : Number(r.account_data.Balance) / 1e6;
}

// Clio indexes NFT offers a beat AFTER the creating tx validates — a lookup
// straight after sendBatch can miss a live offer. Retry until visible.
async function findSellOffer(nftId, owner, destination) {
    for (let attempt = 0; attempt < 10; attempt++) {
        const so = await rpc(NODE, 'nft_sell_offers', { nft_id: nftId });
        const off = (so.offers || []).find(o => o.owner === owner && o.destination === destination);
        if (off) return off;
        await sleep(2000);
    }
    return null;
}

(async () => {
    const t0 = Date.now();

    // ---- wallets ----------------------------------------------------------
    let st = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : {};
    if (!st.distributor || !(await balance(st.distributor.address))) {
        console.log('[tn] creating wallets via faucet (paced)...');
        st = { distributor: await faucet(), holders: [] };
        for (let i = 0; i < SEEDING.length; i++) { await sleep(3000); st.holders.push(await faucet()); }
        fs.writeFileSync(STATE, JSON.stringify(st, null, 2));
        await sleep(6000); // let funding validate
    }
    const dist = walletFromSeed(st.distributor.seed);
    const holders = st.holders.map(h => walletFromSeed(h.seed));
    check('wallets funded', (await balance(dist.address)) >= 20,
        `distributor=${dist.address} bal=${await balance(dist.address)}`);
    console.log('[tn] holders: ' + holders.map(h => h.address).join(' '));

    const distSender = new TxSender(NODE, dist);

    // ---- mint -------------------------------------------------------------
    let nfts = st.nfts || [];
    if (nfts.length < MINT) {
        console.log(`[tn] minting ${MINT - nfts.length} NFTs (taxon ${TAXON})...`);
        while (nfts.length < MINT) {
            const n = Math.min(8, MINT - nfts.length);
            const res = await distSender.sendBatch(Array.from({ length: n }, () => ({
                TransactionType: 'NFTokenMint', NFTokenTaxon: TAXON, Flags: 8, // tfTransferable
            })));
            for (const r of res) {
                if (r.result === 'tesSUCCESS' && r.meta?.nftoken_id) nfts.push(r.meta.nftoken_id);
                else check('mint tx', false, `${r.result}`);
            }
            console.log(`[tn] minted ${nfts.length}/${MINT}`);
        }
        st.nfts = nfts;
        fs.writeFileSync(STATE, JSON.stringify(st, null, 2));
    }
    check(`minted ${MINT} NFTs`, nfts.length === MINT);

    // ---- seed holders (6/3/2/2 via destination-locked offers + accepts) ---
    const seeded = st.seeded || {};
    let cursor = 0;
    for (let i = 0; i < holders.length; i++) {
        const want = SEEDING[i], holder = holders[i];
        const ids = nfts.slice(cursor, cursor + want);
        cursor += want;
        if (seeded[holder.address]) continue;
        console.log(`[tn] seeding ${holder.address} with ${want} NFTs...`);
        const offRes = await distSender.sendBatch(ids.map(id => ({
            TransactionType: 'NFTokenCreateOffer', NFTokenID: id, Amount: '0', Flags: 1, Destination: holder.address,
        })));
        const hSender = new TxSender(NODE, holder);
        let accepted = 0;
        for (const id of ids) {
            const off = await findSellOffer(id, dist.address, holder.address);
            if (!off) { check('seed offer exists', false, id); continue; }
            const [acc] = await hSender.sendBatch([{ TransactionType: 'NFTokenAcceptOffer', NFTokenSellOffer: off.nft_offer_index }]);
            if (acc.result === 'tesSUCCESS') accepted++;
            else check('seed accept', false, `${id}: ${acc.result}`);
        }
        if (accepted === ids.length) { // only mark seeded when EVERY accept landed
            seeded[holder.address] = ids;
            st.seeded = seeded;
            fs.writeFileSync(STATE, JSON.stringify(st, null, 2));
        }
    }
    check('holders seeded 6/3/2/2', Object.keys(seeded).length === holders.length);
    await sleep(4000);

    // ---- snapshot ---------------------------------------------------------
    const snapRun = run('fairdrop.js', ['snapshot', '--issuer', dist.address, '--taxon', String(TAXON),
        '--distributor', dist.address, '--network', 'xrpl-testnet', '--node', NODE, '--out', SNAP]);
    check('snapshot from testnet Clio', snapRun.status === 0 && snapRun.out.includes('holders=4 pool=11'),
        (snapRun.out.match(/holders=\d+ pool=\d+[^\n]*/) || [snapRun.out.slice(-200)])[0]);

    // ---- commit + beacon --------------------------------------------------
    const beacon = await validatedLedger(NODE) + 25;
    const commitRun = run('execute_offers.js', ['--commit', '--snapshot', SNAP, '--beacon-ledger', String(beacon),
        '--node', NODE, '--yes'], { FAIRDROP_SEED: st.distributor.seed });
    const commitTx = (commitRun.out.match(/commit tx ([A-F0-9]{64})/) || [])[1];
    check('commitment memo submitted before beacon', commitRun.status === 0 && !!commitTx, commitTx);
    console.log(`[tn] waiting for beacon ledger ${beacon}...`);
    while (await validatedLedger(NODE) < beacon) await sleep(3000);

    // ---- plan -------------------------------------------------------------
    const planRun = run('fairdrop.js', ['plan', '--snapshot', SNAP, '--beacon-ledger', String(beacon),
        '--node', NODE, '--out', PLAN]);
    check('plan built from beacon', planRun.status === 0, (planRun.out.match(/nfts -> [^\n]*/) || [''])[0]);
    const plan = JSON.parse(fs.readFileSync(PLAN, 'utf8'));
    // expected deterministic allocation: quotas 66/13, 33/13, 22/13, 22/13 ->
    // floors 5,2,1,1 + 2 remainder seats to the tied 22/13 pair -> 5,2,2,2
    const got = new Map(plan.allocations.map(x => [x.address, x.count]));
    const expect = [[holders[0], 5], [holders[1], 2], [holders[2], 2], [holders[3], 2]];
    check('allocation matches hand-computed largest-remainder (5/2/2/2, incl. exact tie)',
        expect.every(([w, n]) => got.get(w.address) === n) && plan.transfers.length === 11,
        [...got.values()].join('/'));

    // ---- execute: partial run first, then full (idempotent resume) --------
    const p1 = run('execute_offers.js', ['--plan', PLAN, '--node', NODE, '--limit', '4', '--yes'],
        { FAIRDROP_SEED: st.distributor.seed });
    check('partial execution (4 offers)', p1.status === 0 && /created=4/.test(p1.out),
        (p1.out.match(/created=\d+[^\n]*/) || [p1.out.slice(-150)])[0]);
    const p2 = run('execute_offers.js', ['--plan', PLAN, '--node', NODE, '--yes'],
        { FAIRDROP_SEED: st.distributor.seed });
    check('resume skips the 4 existing, creates the rest', p2.status === 0 && /already-offered=4/.test(p2.out) && /created=7/.test(p2.out),
        (p2.out.match(/created=\d+[^\n]*/) || [p2.out.slice(-150)])[0]);

    // ---- audit + full verify with commitment ------------------------------
    const a1 = run('fairdrop.js', ['audit-offers', '--plan', PLAN, '--node', NODE]);
    check('audit-offers: all 11 offers open', a1.status === 0 && /offers matching plan: 11\/11/.test(a1.out),
        (a1.out.match(/offers matching plan[^\n]*/) || [''])[0]);
    const v1 = run('fairdrop.js', ['verify', '--snapshot', SNAP, '--plan', PLAN, '--node', NODE, '--commit-tx', commitTx]);
    check('verify incl. on-chain commitment: ALL PASS', v1.status === 0 && /ALL PASS/.test(v1.out) && !/FAIL/.test(v1.out),
        (v1.out.match(/FAIL[^\n]*/) || ['clean'])[0]);

    // ---- destination lock: wrong wallet MUST NOT be able to accept --------
    const victimTransfer = plan.transfers.find(t => t.to === holders[0].address);
    const off = await findSellOffer(victimTransfer.nft_id, dist.address, holders[0].address);
    const thief = new TxSender(NODE, holders[1]);
    const [steal] = await thief.sendBatch([{ TransactionType: 'NFTokenAcceptOffer', NFTokenSellOffer: off.nft_offer_index }]);
    check('wrong wallet cannot accept a destination-locked offer', steal.result === 'tecNO_PERMISSION', steal.result);

    // ---- real claims, then re-audit ---------------------------------------
    const mine = plan.transfers.filter(t => t.to === holders[0].address).slice(0, 2);
    const claimer = new TxSender(NODE, holders[0]);
    for (const t of mine) {
        const o = await findSellOffer(t.nft_id, dist.address, holders[0].address);
        const [acc] = await claimer.sendBatch([{ TransactionType: 'NFTokenAcceptOffer', NFTokenSellOffer: o.nft_offer_index }]);
        check('recipient accepts own offer', acc.result === 'tesSUCCESS', `${t.nft_id.slice(-8)}: ${acc.result}`);
    }
    await sleep(3000);
    const a2 = run('fairdrop.js', ['audit-offers', '--plan', PLAN, '--node', NODE]);
    check('re-audit counts claims: 9 open + 2 claimed, still satisfied',
        a2.status === 0 && /offers matching plan: 9\/11/.test(a2.out) && /already claimed     : 2/.test(a2.out),
        (a2.out.match(/offers matching plan[\s\S]*?wrong-destination[^\n]*/) || [''])[0].replace(/\n/g, ' | '));

    // ---- cleanup: cancel remaining open offers, audit goes red ------------
    const c1 = run('execute_offers.js', ['--cancel-open', '--plan', PLAN, '--node', NODE, '--yes'],
        { FAIRDROP_SEED: st.distributor.seed });
    check('cancel-open removes the 9 remaining offers', c1.status === 0 && /cancelling 9 open/.test(c1.out),
        (c1.out.match(/cancelling \d+[^\n]*/) || [c1.out.slice(-120)])[0]);
    const a3 = run('fairdrop.js', ['audit-offers', '--plan', PLAN, '--node', NODE]);
    check('post-cancel audit flags 9 missing (exit 1)', a3.status === 1 && /missing offers      : 9/.test(a3.out));

    console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    process.exit(failures ? 1 : 0);
})().catch(e => { console.error('[tn]', e); process.exit(2); });
