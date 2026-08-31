#!/usr/bin/env node
'use strict';
// OPERATOR-side executor for a fairdrop plan. This is deliberately separate
// from fairdrop.js, which stays keyless: everything here signs transactions.
//
//   FAIRDROP_SEED=s... node execute_offers.js --plan plan.json --yes [--node URL] [--limit N]
//   FAIRDROP_SEED=s... node execute_offers.js --commit --snapshot snapshot.json --beacon-ledger N --yes
//   FAIRDROP_SEED=s... node execute_offers.js --cancel-open --plan plan.json --yes
//
// The seed comes ONLY from the FAIRDROP_SEED env var or a gitignored .env next
// to this file — never from an argument, never hardcoded. The derived address
// must be the plan's distributor OR its on-chain RegularKey (checked live
// against account_info) or nothing is submitted.
//
// Default mode creates one destination-locked, zero-cost sell offer per
// planned transfer (NFTokenCreateOffer, Flags tfSellNFToken, Amount "0",
// Destination = recipient). IDEMPOTENT: existing matching offers are skipped
// and already-claimed NFTs are skipped, so a crashed run can simply be re-run.
// --cancel-open removes the plan's still-open offers (post-drop cleanup).

const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');

// xrpl.js is used ONLY for local signing — all network I/O is plain JSON-RPC
let xrpl;
for (const p of ['/usr/src/api/package.json', '/usr/src/telegram-bot/package.json']) {
    try { xrpl = createRequire(p)('xrpl'); break; } catch (e) { /* try next */ }
}
if (!xrpl) { try { xrpl = require('xrpl'); } catch (e) { console.error('[execute] xrpl.js not found'); process.exit(2); } }

const FEE_DROPS = '12'; // house rule: always hardcode 12 drops

// every consequential step logs with a timestamp so a ceremony run leaves a
// complete audit trail on stdout; problems go to stderr as well
const ts = () => new Date().toISOString();
const log = (...a) => console.log(ts(), '[execute]', ...a);
const logErr = (...a) => console.error(ts(), '[execute]', ...a);

function loadEnv() {
    const p = path.join(__dirname, '.env');
    if (!fs.existsSync(p)) return;
    for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
        const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
        if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].trim();
    }
}

// seed prefix decides the algorithm — Wallet.fromSeed defaults to ed25519 and
// silently derives the WRONG address for secp256k1 seeds
function walletFromSeed(seed) {
    const algorithm = seed.startsWith('sEd') ? 'ed25519' : 'ecdsa-secp256k1';
    return xrpl.Wallet.fromSeed(seed, { algorithm });
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
            logErr(`rpc ${method} attempt ${attempt}/6 failed (${e.message}) — retrying`);
            await new Promise(r => setTimeout(r, 1000 * attempt));
        }
    }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// The signer may be the account itself (master key) or the account's on-chain
// RegularKey — the distributor here has lsfDisableMaster set, so ONLY its
// regular key can sign. Verified live against account_info; anything else refuses.
async function assertAuthority(node, wallet, account) {
    const r = await rpc(node, 'account_info', { account, ledger_index: 'validated' });
    if (r.status === 'error') throw new Error(`account_info ${account}: ${r.error}`);
    if (wallet.address === account) {
        // lsfDisableMaster (0x00100000, rippled LedgerFormats.h) — master signature would tefMASTER_DISABLED
        if (((r.account_data.Flags || 0) & 0x00100000) !== 0)
            throw new Error(`master key of ${account} is DISABLED on-chain — sign with its RegularKey seed`);
        return 'master key';
    }
    if (r.account_data.RegularKey === wallet.address) return `on-chain RegularKey ${wallet.address}`;
    throw new Error(`seed derives ${wallet.address} — neither ${account} nor its RegularKey (${r.account_data.RegularKey || 'none set'}) — refusing`);
}

async function validatedLedger(node) {
    const r = await rpc(node, 'ledger', { ledger_index: 'validated' });
    return Number(r.ledger_index || r.ledger.ledger_index);
}

// Signs and submits a batch of transactions with consecutive sequences, then
// polls each to validation. Returns [{tx, hash, result}] — result is the final
// meta TransactionResult, or 'SUBMIT_FAILED:<code>' / 'EXPIRED'.
class TxSender {
    constructor(node, wallet, account) { this.node = node; this.wallet = wallet; this.account = account || wallet.address; this.seq = null; }
    async syncSeq() {
        const r = await rpc(this.node, 'account_info', { account: this.account, ledger_index: 'validated' });
        if (r.status === 'error') throw new Error(`account_info ${this.account}: ${r.error}`);
        this.seq = r.account_data.Sequence;
        log(`sequence synced from validated ledger: ${this.seq}`);
    }
    async sendBatch(txs) {
        if (this.seq === null) await this.syncSeq();
        const lls = await validatedLedger(this.node) + 60;
        const out = [];
        for (const tx of txs) {
            const full = { ...tx, Account: this.account, Fee: FEE_DROPS, Sequence: this.seq++, LastLedgerSequence: lls };
            const { tx_blob, hash } = this.wallet.sign(full);
            const sub = await rpc(this.node, 'submit', { tx_blob });
            const code = sub.engine_result || sub.error || 'unknown';
            const what = [tx.TransactionType, tx.NFTokenID && `nft…${tx.NFTokenID.slice(-8)}`,
                tx.Destination && `-> ${tx.Destination}`].filter(Boolean).join(' ');
            (/^tes/.test(code) ? log : logErr)(`submit seq=${full.Sequence} ${what}: ${code} (${hash})`);
            // tefALREADY/tefPAST_SEQ on our own blob = rpc() retried a submit
            // whose first copy already landed — the tx IS in flight; poll it.
            const inFlight = sub.status !== 'error'
                && (/^(tes|ter|tec)/.test(code) || code === 'tefALREADY' || code === 'tefPAST_SEQ');
            if (!inFlight) {
                out.push({ tx: full, hash, result: `SUBMIT_FAILED:${code}` });
                // A rejected submission never consumed the sequence. Do NOT
                // resync from validated state here: earlier txs of this batch
                // aren't validated yet, so a resync rewinds BELOW them and
                // every remaining tx collides with tefPAST_SEQ.
                this.seq--;
            } else out.push({ tx: full, hash, result: null, lls });
        }
        // poll to validation
        for (const o of out) {
            if (o.result) continue;
            for (;;) {
                const r = await rpc(this.node, 'tx', { transaction: o.hash });
                if (r.status !== 'error' && (r.validated === true || r.meta)) {
                    o.result = (r.meta && (r.meta.TransactionResult || r.meta)) || 'unknown';
                    o.meta = r.meta;
                    o.ledgerIndex = r.ledger_index;
                    (o.result === 'tesSUCCESS' ? log : logErr)(`validated ${o.hash} in ledger ${r.ledger_index}: ${o.result}`);
                    break;
                }
                if (await validatedLedger(this.node) > o.lls + 2) {
                    o.result = 'EXPIRED';
                    logErr(`EXPIRED ${o.hash} — not validated by ledger ${o.lls}; resyncing sequence`);
                    await this.syncSeq(); break;
                }
                await sleep(1500);
            }
        }
        return out;
    }
}

// all open sell offers owned by `account`, keyed by NFTokenID
async function ownSellOffers(node, account) {
    const map = new Map();
    let marker;
    do {
        const params = { account, type: 'nft_offer', limit: 400, ledger_index: 'validated' };
        if (marker) params.marker = marker;
        const r = await rpc(node, 'account_objects', params);
        // never degrade to "no offers" on error — offers mode would then create
        // duplicates and cancel-open would report success having cancelled nothing
        if (r.status === 'error') throw new Error(`account_objects ${account}: ${r.error}`);
        for (const o of r.account_objects || []) {
            if ((o.Flags & 1) !== 1) continue; // sell offers only
            if (!map.has(o.NFTokenID)) map.set(o.NFTokenID, []);
            map.get(o.NFTokenID).push(o);
        }
        marker = r.marker;
    } while (marker);
    return map;
}

async function nftOwner(node, nftId) {
    const r = await rpc(node, 'nft_info', { nft_id: nftId });
    return r.status === 'error' ? null : r.owner;
}

// ------------------------------------------------------------------- modes
async function modeOffers(a, node, wallet) {
    const plan = JSON.parse(fs.readFileSync(a.plan || 'plan.json', 'utf8'));
    log(`signing for ${plan.distributor} via ${await assertAuthority(node, wallet, plan.distributor)}`);
    const limit = a.limit ? Number(a.limit) : Infinity;
    log('pre-scan (read-only): sweeping existing offers + current owners...');
    const existing = await ownSellOffers(node, plan.distributor);
    log(`pre-scan: distributor has open sell offers on ${existing.size} NFTs`);
    const pending = [], skippedOffer = [], skippedClaimed = [];
    let scanned = 0;
    for (const t of plan.transfers) {
        if (++scanned % 100 === 0) log(`pre-scan ${scanned}/${plan.transfers.length}...`);
        const offers = existing.get(t.nft_id) || [];
        if (offers.some(o => o.Destination === t.to && o.Amount === '0')) { skippedOffer.push(t); continue; }
        if ((await nftOwner(node, t.nft_id)) === t.to) { skippedClaimed.push(t); continue; }
        if (pending.length < limit) pending.push(t);
    }
    log(`plan=${plan.transfers.length} already-offered=${skippedOffer.length} already-claimed=${skippedClaimed.length} to-create=${pending.length}`);
    const sender = new TxSender(node, wallet, plan.distributor);
    let ok = 0; const failed = [];
    for (let i = 0; i < pending.length; i += 8) {
        const batch = pending.slice(i, i + 8).map(t => ({
            TransactionType: 'NFTokenCreateOffer', NFTokenID: t.nft_id, Amount: '0',
            Flags: 1, Destination: t.to, // tfSellNFToken; zero-cost, locked to recipient
        }));
        const res = await sender.sendBatch(batch);
        for (const r of res) {
            if (r.result === 'tesSUCCESS') ok++;
            else failed.push({ nft: r.tx.NFTokenID, result: r.result });
        }
        log(`progress: ${Math.min(i + 8, pending.length)}/${pending.length} processed (${ok} ok)`);
    }
    console.log(`\ncreated=${ok} skipped(offer)=${skippedOffer.length} skipped(claimed)=${skippedClaimed.length} failed=${failed.length}`);
    for (const f of failed.slice(0, 20)) console.log(`  FAILED ${f.nft}: ${f.result}`);
    process.exit(failed.length ? 1 : 0);
}

async function modeCommit(a, node, wallet) {
    const fair = require('./fairdrop.js');
    const snap = JSON.parse(fs.readFileSync(a.snapshot || 'snapshot.json', 'utf8'));
    if (fair.snapshotHashOf(snap) !== snap.snapshotHash) throw new Error('snapshot corrupted');
    log(`signing for ${snap.distributor} via ${await assertAuthority(node, wallet, snap.distributor)}`);
    const beaconLedger = Number(a['beacon-ledger']);
    if (!beaconLedger) throw new Error('required: --beacon-ledger N (a FUTURE ledger index)');
    const nowLedger = await validatedLedger(node);
    if (beaconLedger <= nowLedger)
        throw new Error(`beacon ledger ${beaconLedger} is not in the future (validated is ${nowLedger}) — pick a later one`);
    log(`beacon margin: ${beaconLedger - nowLedger} ledgers (~${Math.round((beaconLedger - nowLedger) * 4 / 60)} min) — the memo must validate before that`);
    const codeSha256 = fair.sha256hex(fs.readFileSync(path.join(__dirname, 'fairdrop.js')));
    const commitment = fair.commitmentOf(snap.snapshotHash, codeSha256, beaconLedger);
    log(`commitment ${commitment} (beacon ledger ${beaconLedger})`);
    const sender = new TxSender(node, wallet, snap.distributor);
    const [r] = await sender.sendBatch([{
        TransactionType: 'AccountSet',
        Memos: [{ Memo: {
            MemoType: Buffer.from('fairdrop/v1').toString('hex').toUpperCase(),
            MemoData: commitment.toUpperCase(),
        } }],
    }]);
    log(`commit tx ${r.hash} -> ${r.result}`);
    if (r.result === 'tesSUCCESS' && r.ledgerIndex)
        log(`commitment ANCHORED in ledger ${r.ledgerIndex} — ${beaconLedger - r.ledgerIndex} ledgers before the beacon. Save this tx hash for verify --commit-tx.`);
    process.exit(r.result === 'tesSUCCESS' ? 0 : 1);
}

async function modeCancelOpen(a, node, wallet) {
    const plan = JSON.parse(fs.readFileSync(a.plan || 'plan.json', 'utf8'));
    log(`signing for ${plan.distributor} via ${await assertAuthority(node, wallet, plan.distributor)}`);
    const wanted = new Map(plan.transfers.map(t => [t.nft_id, t.to]));
    const existing = await ownSellOffers(node, plan.distributor);
    const ids = [];
    for (const [nftId, offers] of existing) {
        for (const o of offers) {
            if (wanted.get(nftId) === o.Destination && o.Amount === '0') ids.push(o.index);
        }
    }
    log(`cancelling ${ids.length} open plan offers`);
    const sender = new TxSender(node, wallet, plan.distributor);
    let failed = 0;
    for (let i = 0; i < ids.length; i += 200) { // NFTokenCancelOffer caps at 500 ids/tx
        const [r] = await sender.sendBatch([{ TransactionType: 'NFTokenCancelOffer', NFTokenOffers: ids.slice(i, i + 200) }]);
        if (r.result !== 'tesSUCCESS') { failed++; logErr(`cancel batch ${i / 200 + 1} FAILED: ${r.result}`); }
        else log(`cancel batch ${i / 200 + 1}: ${Math.min(i + 200, ids.length)}/${ids.length} done`);
    }
    process.exit(failed ? 1 : 0);
}

// --------------------------------------------------------------------- cli
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

module.exports = { rpc, walletFromSeed, assertAuthority, TxSender, ownSellOffers, nftOwner, validatedLedger, sleep };

if (require.main === module) (async () => {
    loadEnv();
    const a = parseArgs(process.argv.slice(2));
    const node = a.node || 'https://s1.ripple.com:51234/';
    const seed = process.env.FAIRDROP_SEED;
    if (!seed) { logErr('set FAIRDROP_SEED (env or gitignored .env)'); process.exit(2); }
    const wallet = walletFromSeed(seed);
    const mode = a.commit ? 'commit' : a['cancel-open'] ? 'cancel-open' : 'offers';
    log(`mode=${mode} wallet=${wallet.address} node=${node}`);
    if (!a.yes) { logErr('this SUBMITS transactions — re-run with --yes to proceed'); process.exit(2); }
    if (mode === 'commit') await modeCommit(a, node, wallet);
    else if (mode === 'cancel-open') await modeCancelOpen(a, node, wallet);
    else await modeOffers(a, node, wallet);
})().catch(e => { logErr(e.message || e); process.exit(2); });
