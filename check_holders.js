#!/usr/bin/env node
'use strict';
// Holder accuracy audit for an NFT collection, read-only.
//
// Ground truth: live XRPL state from s1.ripple.com (Clio `nfts_by_issuer`,
// which returns owner + is_burned per NFT of an issuer/taxon; re-verified
// per-suspect with `nft_info` to filter out mid-sweep trade races).
// Checked against it:
//   1. xrpl_nft.nfts        — our per-NFT owner (`account`) + is_burned
//   2. xrpl_nft.collection_ownership — the nft-richlist output (topHolders/totalOwners)
//
// Usage: node check_holders.js [slug]   (default: bored-apes-xrp-club)
// Exit: 0 = all consistent, 1 = discrepancies found, 2 = setup error.

const { createRequire } = require('module');
let MongoClient;
for (const p of ['/usr/src/api/package.json', '/usr/src/nfttx/package.json', '/usr/src/common/package.json']) {
    try { ({ MongoClient } = createRequire(p)('mongodb')); break; } catch (e) { /* try next */ }
}
if (!MongoClient) { console.error('[holder-audit] no mongodb driver found in api/nfttx/common'); process.exit(2); }

const RPC = 'https://s1.ripple.com:51234/';
// internal tool: needs the xrpl.to MongoDB. Read the URI from the environment —
// never hardcode credentials in this file (it is published).
const MONGO = process.env.MONGO_URI;
if (!MONGO) { console.error('[holder-audit] set MONGO_URI (internal xrpl.to tool)'); process.exit(2); }
const SLUG = process.argv[2] || 'bored-apes-xrp-club';
const REVERIFY_CAP = 1000; // per-suspect nft_info re-checks; beyond this just report first-pass diffs

async function rpc(method, params) {
    for (let attempt = 1; ; attempt++) {
        try {
            const res = await fetch(RPC, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ method, params: [params] }),
                signal: AbortSignal.timeout(30000),
            });
            if (!res.ok) throw new Error(`http ${res.status}`);
            const body = await res.json();
            const r = body.result || {};
            if (r.status === 'error' && ['slowDown', 'tooBusy', 'noNetwork', 'internal'].includes(r.error)) {
                throw new Error(r.error); // transient — retry
            }
            return r; // success, or a definitive error (e.g. objectNotFound) the caller inspects
        } catch (e) {
            if (attempt >= 6) throw e;
            await new Promise(r => setTimeout(r, 1000 * attempt));
        }
    }
}

(async () => {
    const t0 = Date.now();
    const client = new MongoClient(MONGO);
    await client.connect();
    const dbNft = client.db('xrpl_nft');

    const col = await dbNft.collection('collection').findOne(
        { slug: SLUG }, { projection: { name: 1, account: 1, issuer: 1, taxon: 1, items: 1 } });
    if (!col) { console.error(`[holder-audit] collection not found: ${SLUG}`); process.exit(2); }
    const issuer = col.account || col.issuer;
    const taxon = Number(col.taxon);
    if (!issuer || Array.isArray(col.taxon)) {
        console.error('[holder-audit] multi-taxon/issuer-only collections not supported by this audit');
        process.exit(2);
    }
    console.log(`[holder-audit] ${col.name} (${SLUG}) issuer=${issuer} taxon=${taxon} items=${col.items}`);

    // ---- 1. Our per-NFT owners --------------------------------------------
    const ours = new Map(); // nft_id -> {owner, burned}
    for await (const d of dbNft.collection('nfts')
        .find({ cid: col._id }, { projection: { account: 1, is_burned: 1 } })) {
        ours.set(d._id, { owner: d.account, burned: !!d.is_burned });
    }
    console.log(`[holder-audit] db: ${ours.size} nfts loaded from xrpl_nft.nfts`);

    // Fault injection (CORRUPT_ID=<nft_id>): fakes a wrong db owner at BOTH db
    // read points so the audit provably goes red end-to-end. Never touches the db.
    const FAULT_OWNER = 'rFAULTINJECTIONxxxxxxxxxxxxxxxxxx';
    if (process.env.CORRUPT_ID && ours.has(process.env.CORRUPT_ID)) {
        ours.get(process.env.CORRUPT_ID).owner = FAULT_OWNER;
        console.log(`[holder-audit] FAULT INJECTED on ${process.env.CORRUPT_ID}`);
    }

    // ---- 2. Our richlist doc ----------------------------------------------
    const rl = await dbNft.collection('collection_ownership').findOne({ collectionId: col._id });
    if (rl) console.log(`[holder-audit] richlist doc updatedAt=${rl.updatedAt?.toISOString?.() || rl.updatedAt}`);
    else console.log('[holder-audit] WARNING: no collection_ownership doc for this collection');

    // ---- 3. Chain sweep ----------------------------------------------------
    const chain = new Map(); // nft_id -> {owner, burned}
    let marker, pages = 0, ledgerIndex;
    do {
        const params = { issuer, nft_taxon: taxon, limit: 100 };
        if (marker) params.marker = marker;
        const r = await rpc('nfts_by_issuer', params);
        if (r.status === 'error') throw new Error(`nfts_by_issuer: ${r.error}`);
        ledgerIndex = r.ledger_index || ledgerIndex;
        for (const n of r.nfts) chain.set(n.nft_id, { owner: n.owner, burned: !!n.is_burned });
        marker = r.marker;
        if (++pages % 20 === 0) console.log(`[holder-audit] chain sweep: ${chain.size} nfts (${pages} pages)`);
    } while (marker);
    const chainLive = [...chain.values()].filter(c => !c.burned).length;
    console.log(`[holder-audit] chain: ${chain.size} nfts (${chainLive} live, ${chain.size - chainLive} burned) at ledger ${ledgerIndex}, ${pages} pages`);

    // ---- 4. Per-NFT diff, first pass --------------------------------------
    const suspects = [];
    for (const [id, c] of chain) {
        const o = ours.get(id);
        if (!o) { if (!c.burned) suspects.push({ id, kind: 'missing_in_db' }); continue; }
        if (c.burned !== o.burned) { suspects.push({ id, kind: 'burn_drift' }); continue; }
        if (!c.burned && o.owner !== c.owner) suspects.push({ id, kind: 'owner_mismatch' });
    }
    for (const [id] of ours) if (!chain.has(id)) suspects.push({ id, kind: 'not_on_chain' });
    console.log(`[holder-audit] first pass: ${suspects.length} suspect nfts`);

    // ---- 5. Re-verify suspects (fresh nft_info + fresh db read) -----------
    // A trade landing mid-sweep makes a false mismatch; both sides re-read
    // at the same moment must still disagree to count.
    const confirmed = [];
    const recheck = suspects.slice(0, REVERIFY_CAP);
    for (const s of recheck) {
        const [info, doc] = await Promise.all([
            rpc('nft_info', { nft_id: s.id }),
            dbNft.collection('nfts').findOne({ _id: s.id }, { projection: { account: 1, is_burned: 1 } }),
        ]);
        if (doc && s.id === process.env.CORRUPT_ID) doc.account = FAULT_OWNER;
        const onChain = info.status !== 'error';
        const cOwner = onChain ? info.owner : null;
        const cBurned = onChain ? !!info.is_burned : null;
        const dOwner = doc ? doc.account : null;
        const dBurned = doc ? !!doc.is_burned : null;
        let kind = null;
        if (!doc && onChain && !cBurned) kind = 'missing_in_db';
        else if (doc && !onChain) kind = 'not_on_chain';
        else if (doc && onChain && cBurned !== dBurned) kind = 'burn_drift';
        else if (doc && onChain && !cBurned && dOwner !== cOwner) kind = 'owner_mismatch';
        if (kind) confirmed.push({ id: s.id, kind, db: { owner: dOwner, burned: dBurned }, chain: { owner: cOwner, burned: cBurned } });
    }
    if (suspects.length > REVERIFY_CAP) {
        console.log(`[holder-audit] WARNING: ${suspects.length - REVERIFY_CAP} suspects beyond re-verify cap reported unverified`);
        for (const s of suspects.slice(REVERIFY_CAP)) confirmed.push({ ...s, unverified: true });
    }

    // ---- 6. Richlist vs chain ---------------------------------------------
    const chainHolders = new Map(); // addr -> count, live nfts only
    for (const c of chain.values()) if (!c.burned) chainHolders.set(c.owner, (chainHolders.get(c.owner) || 0) + 1);
    const chainTop = [...chainHolders.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));

    const richlistIssues = [];
    let rlSummary = null;
    if (rl?.current) {
        const cur = rl.current;
        const top = cur.topHolders || [];
        rlSummary = {
            docTotalOwners: cur.totalOwners, chainTotalOwners: chainHolders.size,
            docTotalNFTs: cur.totalNFTs, chainLiveNFTs: chainLive,
            topHoldersLen: top.length,
        };
        for (const h of top) {
            const actual = chainHolders.get(h.address) || 0;
            if (actual !== h.count) richlistIssues.push({ address: h.address, richlist: h.count, chain: actual });
        }
        // chain top holders the doc's topHolders list should contain but doesn't
        const listed = new Set(top.map(h => h.address));
        const minListed = top.length ? Math.min(...top.map(h => h.count)) : 0;
        for (const [addr, cnt] of chainTop) {
            if (cnt > minListed && !listed.has(addr)) richlistIssues.push({ address: addr, richlist: 0, chain: cnt, note: 'absent from topHolders' });
        }
    }

    // ---- 7. Report ---------------------------------------------------------
    const byKind = {};
    for (const c of confirmed) byKind[c.kind] = (byKind[c.kind] || 0) + 1;

    console.log('\n================ HOLDER AUDIT REPORT ================');
    console.log(`collection : ${col.name} (${SLUG})`);
    console.log(`chain      : ledger ${ledgerIndex}, ${chain.size} minted-and-tracked, ${chainLive} live, ${chain.size - chainLive} burned`);
    console.log(`db nfts    : ${ours.size} docs (${[...ours.values()].filter(o => o.burned).length} marked burned)`);
    console.log(`\n-- per-NFT ownership (xrpl_nft.nfts vs chain) --`);
    if (!confirmed.length) console.log('CLEAN: every NFT owner in db matches chain');
    else {
        for (const [k, v] of Object.entries(byKind)) console.log(`  ${k.padEnd(16)} ${v}`);
        for (const c of confirmed.slice(0, 50)) {
            console.log(`  ${c.kind.padEnd(16)} ${c.id} db=${c.db ? `${c.db.owner}${c.db.burned ? '(burned)' : ''}` : '-'} chain=${c.chain ? `${c.chain.owner || '-'}${c.chain.burned ? '(burned)' : ''}` : 'absent'}${c.unverified ? ' [unverified]' : ''}`);
        }
        if (confirmed.length > 50) console.log(`  ... ${confirmed.length - 50} more (see JSON)`);
    }
    console.log(`\n-- richlist (collection_ownership vs chain) --`);
    if (!rl) console.log('MISSING: no richlist doc');
    else {
        console.log(`  totalOwners: doc=${rlSummary.docTotalOwners} chain=${rlSummary.chainTotalOwners}`);
        console.log(`  totalNFTs  : doc=${rlSummary.docTotalNFTs} chain(live)=${rlSummary.chainLiveNFTs}`);
        if (!richlistIssues.length) console.log(`  CLEAN: all ${rlSummary.topHoldersLen} topHolders counts match chain exactly`);
        else {
            console.log(`  ${richlistIssues.length} holder-count discrepancies (doc updatedAt=${rl.updatedAt?.toISOString?.() || rl.updatedAt}):`);
            for (const i of richlistIssues.slice(0, 30)) {
                console.log(`  ${i.address.padEnd(35)} richlist=${String(i.richlist).padStart(5)} chain=${String(i.chain).padStart(5)} diff=${i.chain - i.richlist}${i.note ? ' ' + i.note : ''}`);
            }
            if (richlistIssues.length > 30) console.log(`  ... ${richlistIssues.length - 30} more (see JSON)`);
        }
    }
    console.log(`\ntop 10 holders per chain:`);
    for (const [addr, cnt] of chainTop.slice(0, 10)) console.log(`  ${addr.padEnd(35)} ${cnt}`);

    const outPath = `${__dirname}/holder_audit_${SLUG}.json`;
    require('fs').writeFileSync(outPath, JSON.stringify({
        slug: SLUG, issuer, taxon, ledgerIndex, ranAt: new Date().toISOString(),
        chainTotal: chain.size, chainLive, dbTotal: ours.size,
        perNftDiscrepancies: confirmed, richlistSummary: rlSummary, richlistIssues,
        chainTopHolders: chainTop.slice(0, 100).map(([address, count]) => ({ address, count })),
    }, null, 2));
    console.log(`\nfull detail: ${outPath}`);
    console.log(`done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

    await client.close();
    process.exit(confirmed.length || richlistIssues.length ? 1 : 0);
})().catch(e => { console.error('[holder-audit]', e); process.exit(2); });
