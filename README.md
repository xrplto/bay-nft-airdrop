# fairdrop — provably-fair NFT distribution on the XRP Ledger

Distributes a wallet's NFTs to a collection's current holders, **strictly
proportional to how much each holder owns** — amounts are deterministic
percentage math with no lottery. The only randomness is which specific NFT
ids a recipient gets, seeded by a beacon **nobody — including the operator —
can choose or predict**. Every step is a pure function of public chain data,
so anyone can re-derive the entire result from scratch and check it
byte-for-byte. No trust required.

The verification path (`fairdrop.js` + both test batteries) is
zero-dependency — Node 18+ and any XRPL node with Clio API support (default
`https://s1.ripple.com:51234/`). Only the operator executor
(`execute_offers.js`) needs `xrpl` for local signing (`npm i`).

## How it stays trustless

1. **Public snapshot, pinned to a ledger.** Holder balances and the pool of
   NFTs to distribute are read from chain state at a published ledger index.
   Clio serves historical state, so anyone can rebuild the identical snapshot
   at any later date (`fairdrop verify` does this automatically) — the
   operator cannot fake who held what.
2. **Committed rules, before the randomness exists.** The operator publishes
   this code and the snapshot, then anchors
   `commitment = SHA-256({version, snapshotHash, codeSha256, beaconLedger})`
   in a memo sent from the distributor account **before** ledger
   `beaconLedger` closes. The commitment binds the exact code, the exact
   snapshot, and the exact entropy source in advance.
3. **Randomness from a future ledger hash — scoped to id-assignment only.**
   The seed is `SHA-256(hash of ledger beaconLedger)`. That hash does not
   exist when the commitment is made and is produced by the validator network,
   not the operator. It decides only which specific NFT ids go to each
   recipient; the amounts are deterministic percentage math with no random
   component.
4. **Deterministic algorithm.** Given (snapshot, seed) the plan is fully
   determined — same output on every machine, independent of database or
   node enumeration order. Randomness comes from a SHA-256 counter stream,
   trivially reimplementable in any language.
5. **On-chain execution is checkable.** NFTs move via `NFTokenCreateOffer`
   (free, destination-locked sell offers). `fairdrop audit-offers` checks
   every planned transfer has a matching on-chain offer.

## The allocation algorithm (fairdrop-v2)

**Amounts contain no randomness at all** — they are pure holding-percentage
math, computed in exact integer arithmetic (BigInt, float-proof):

- Exact quota per holder: `pool × holdings / totalHoldings`.
- Every holder is **guaranteed** `floor(quota)`.
- The remaining seats (you cannot send a fraction of an NFT) go to the
  **largest fractional remainders** — whoever is mathematically closest to the
  next whole NFT. Exact remainder ties break by holdings (descending), then by
  address (ascending): documented, reproducible, zero discretion.
- The beacon seed decides ONLY **which specific NFT ids** each recipient gets
  (a seeded Fisher-Yates shuffle) — so the operator cannot cherry-pick rare
  pieces for favorites — never how many.

Full byte-level spec (canonical ordering, seed derivation, rand consumption
order, canonical JSON) is in the header of `fairdrop.js`.
`test_randomization.js` must stay green against any change: it proves the
amounts are seed-independent and equal to an independent exact-math reference,
and that the id-shuffle is statistically uniform.

## Operator walkthrough

```bash
# 1. pin the snapshot (uses the latest validated ledger unless --ledger given)
node fairdrop.js snapshot --issuer rEzbi191M5AjrucxXKZWbR5QeyfpbedBcV \
    --taxon 1 --distributor rESvnQrpWVho8kEiHEVKXMBoiUzdkYVtDL

# 2. publish this repo + snapshot.json, pick a FUTURE ledger index N
#    (e.g. current validated + 1000 ≈ one hour out), then:
node fairdrop.js commit --snapshot snapshot.json --beacon-ledger N
#    -> send the printed memo from the distributor account before N validates.
#       fairdrop never touches keys; sign with whatever controls the wallet.

# 3. after ledger N validates:
node fairdrop.js plan --snapshot snapshot.json --beacon-ledger N
#    -> plan.json (publish it), then create the offers it lists.

# 4. anyone, forever after:
node fairdrop.js verify --snapshot snapshot.json --plan plan.json \
    --node https://s2.ripple.com:51234/ --commit-tx <hash of the memo tx>
node fairdrop.js audit-offers --plan plan.json
```

## Operator execution tooling (keyed — separate from the keyless verifier)

- **`execute_offers.js`** — the only file that signs anything. Seed comes ONLY
  from `FAIRDROP_SEED` (env or gitignored `.env`); it refuses to run unless the
  derived address equals the plan's distributor, and requires `--yes`.
  Idempotent: re-running skips already-created offers and already-claimed NFTs,
  so a crashed run is simply re-run. Modes: create offers (default, chunked
  with validation polling), `--commit` (submits the commitment memo),
  `--cancel-open` (post-drop cleanup; also releases the 0.2 XRP per-offer
  reserve).
- **`test_testnet_e2e.js`** — full write-path rehearsal on XRPL testnet:
  faucet wallets, a 24-NFT collection, holders seeded 6/3/2/2 (deliberately
  producing floors, remainder seats AND an exact tie), commitment memo, beacon,
  execution with a partial run proving idempotent resume, `audit-offers`,
  `verify --commit-tx`, a wrong-wallet accept that must fail with
  `tecNO_PERMISSION` (destination lock), real claims, and cancellation.
  Run this green before any mainnet execution.

## Verifier walkthrough (don't trust us)

Run `verify` with a node the operator doesn't control. It independently:

- resweeps chain state at the pinned ledger and reproduces `snapshotHash`;
- refetches the beacon ledger hash and re-derives the seed;
- re-runs the algorithm and compares `transfersHash` byte-for-byte;
- re-checks the allocation in exact BigInt rational arithmetic (floors, sums,
  seat counts, float-safety, transfer/pool set equality, no self-transfers);
- checks the on-chain commitment memo matches
  `SHA-256({version, snapshotHash, codeSha256, beaconLedger})` and was
  validated **before** the beacon ledger.

`verify` FAILS when no `--commit-tx` is given — an unanchored plan proves
nothing about when its rules were fixed. Passing `--allow-uncommitted`
accepts that explicitly; it still prints as a skipped check, never silently.

Then run the statistical battery yourself (uses the published snapshot,
~10k full plan simulations):

```bash
TRIALS=10000 node test_randomization.js snapshot.json
```

It proves: same seed reproduces the plan; input order can't change it; the
allocation is identical across hundreds of different seeds and equals an
independent exact-arithmetic reference (amounts have no random component);
NFT-id assignment is uniform; different seeds decorrelate. It also runs two
rigged negative controls through the same battery and requires them to be
FLAGGED — so the battery itself demonstrably can fail.

## Honest caveats

- **Ledger-hash grinding:** a participant who gets transactions into the
  beacon ledger can influence (not choose) its hash. For a community drop the
  attack is economically pointless, but for high-stakes draws use a drand
  round (League of Entropy) as the beacon instead — the commit/verify flow is
  identical.
- **Recipients must claim:** XLS-20 cannot force-push NFTs. Transfers are
  zero-cost sell offers locked to each recipient (`Destination`), which the
  recipient accepts. Unclaimed offers can be cancelled later; each open offer
  reserves 0.2 XRP on the distributor until then.
- `check_holders.js` is an internal xrpl.to audit tool (compares our indexer
  DB against live chain state); it needs `MONGO_URI` set and is not part of
  the public verification path.
