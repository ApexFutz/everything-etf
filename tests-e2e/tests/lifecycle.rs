//! End-to-end run of the whole protocol against the real, compiled program
//! binary (target/deploy/everything_etf.so), executed inside litesvm.
//!
//! This is the "see it in action" test: protocol setup, $EETF genesis, a
//! basket launch that burns $EETF, seeding, in-kind mint/redeem at NAV,
//! streaming-fee accrual, and manager/protocol fee claims — plus a few
//! guard rails (fee caps, frozen-mint rejection, slippage).

use everything_etf::constants::{COIN_TOTAL_SUPPLY, MAX_MINT_FEE_BPS};
use everything_etf::errors::EtfError;
use everything_etf::state::FeeRecipient;
use tests_e2e::*;

#[test]
fn protocol_boots_and_mints_eetf() {
    let env = Env::new();

    let config = env.config_account();
    assert_eq!(config.basket_count, 0);
    assert_eq!(config.protocol_share_bps, 1_000);

    let coin = env.coin_config_account();
    assert_eq!(coin.creation_burn_bps, 7_000);
    assert_eq!(env.mint_supply(env.coin_mint), 1_000_000_000 * 1_000_000_000);
    // The mint authority must be gone forever after genesis.
    assert_eq!(env.mint_authority(env.coin_mint), None);
    assert_eq!(
        env.token_balance(env.genesis_account),
        1_000_000_000 * 1_000_000_000
    );
}

#[test]
fn full_basket_lifecycle() {
    let mut env = Env::new();
    let assets = env.with_three_assets();

    // Fund the manager with enough $EETF to pay the creation fee (100,000 EETF).
    let manager_coin = env.fund_coin(pubkey_of(&env.manager), 200_000 * 1_000_000_000);

    let supply_before = env.mint_supply(env.coin_mint);
    let (basket, meta) = env
        .create_basket(&assets.mints, manager_coin, 0, 0, 0)
        .expect("create_basket should succeed");
    assert!(!meta.logs.is_empty());

    // 70% of the 100,000 EETF fee was burned, 30% went to the dev treasury.
    let supply_after = env.mint_supply(env.coin_mint);
    assert_eq!(supply_before - supply_after, 70_000 * 1_000_000_000);
    assert_eq!(
        env.token_balance(env.dev_coin_account),
        30_000 * 1_000_000_000
    );
    let coin = env.coin_config_account();
    assert_eq!(coin.total_burned, 70_000 * 1_000_000_000);
    assert_eq!(coin.baskets_funded, 1);

    // Seed: manager deposits 1000 units of each asset (adjusted for decimals),
    // receives the starting supply 1:1.
    let manager_basket_acc = env.create_token_account(basket.mint, pubkey_of(&env.manager));
    let seed_amounts: Vec<u64> = [8u8, 9, 6].iter().map(|d| 1_000 * 10u64.pow(*d as u32)).collect();
    env.seed_basket(
        &basket,
        manager_basket_acc,
        &assets.manager_accounts,
        1_000 * 1_000_000_000,
        seed_amounts.clone(),
    )
    .expect("seed_basket should succeed");

    assert_eq!(env.mint_supply(basket.mint), 1_000 * 1_000_000_000);
    for (vault, amt) in basket.vaults.iter().zip(seed_amounts.iter()) {
        assert_eq!(env.token_balance(*vault), *amt);
    }

    // Alice mints 100 basket tokens at NAV (vault:supply is 1:1 so far).
    let alice_basket_acc = env.create_token_account(basket.mint, pubkey_of(&env.alice));
    let alice = env.alice.insecure_clone();
    let max_in: Vec<u64> = seed_amounts.iter().map(|a| a / 10 + 1).collect();
    env.mint_basket(
        &basket,
        &alice,
        alice_basket_acc,
        &assets.alice_accounts,
        100 * 1_000_000_000,
        max_in,
    )
    .expect("mint_basket should succeed");

    // No mint fee: Alice receives every token she paid for, and the escrow stays
    // empty. The launch fee is the only fee in the protocol.
    assert_eq!(env.token_balance(alice_basket_acc), 100_000_000_000);
    assert_eq!(env.token_balance(basket.fee_escrow), 0);
    let b = env.basket_account(basket.key);
    assert_eq!(b.manager_fees_accrued, 0);
    assert_eq!(b.protocol_fees_accrued, 0);

    // Each vault grew by 10% (Alice deposited 1/10th of the existing NAV, since
    // mint amount is computed pre-fee against pre-mint supply).
    for (vault, seed) in basket.vaults.iter().zip(seed_amounts.iter()) {
        let expected = seed + seed / 10;
        assert_eq!(env.token_balance(*vault), expected, "vault {vault}");
    }

    // No streaming fee: a whole year passes, accrual is cranked, and supply does
    // not move. Holding a basket costs nothing, forever.
    env.accrue_fees(&basket).unwrap();
    let supply_before_year = env.mint_supply(basket.mint);
    env.warp_seconds(365 * 24 * 60 * 60);
    env.accrue_fees(&basket).unwrap();
    assert_eq!(
        env.mint_supply(basket.mint),
        supply_before_year,
        "a year of holding must not dilute anyone"
    );
    assert_eq!(env.token_balance(basket.fee_escrow), 0);

    // There is never anything to claim — for the manager or for the protocol.
    // The claim instructions still exist but can only ever report an empty
    // ledger, which is the inert state the zero caps are supposed to produce.
    let manager = env.manager.insecure_clone();
    let res = env.claim_fees(
        &basket,
        &manager,
        FeeRecipient::Manager,
        manager_basket_acc,
        &assets.manager_accounts,
    );
    assert_etf_error(res, EtfError::NothingToClaim);

    let treasury_basket_acc = env.create_token_account(basket.mint, pubkey_of(&env.treasury));
    let treasury_asset_accs: Vec<_> = assets
        .mints
        .iter()
        .map(|m| env.create_token_account(*m, pubkey_of(&env.treasury)))
        .collect();
    let authority = env.authority.insecure_clone();
    let res = env.claim_fees(
        &basket,
        &authority,
        FeeRecipient::Protocol,
        treasury_basket_acc,
        &treasury_asset_accs,
    );
    assert_etf_error(res, EtfError::NothingToClaim);

    // Alice redeems her full basket-token balance back for the underlyings.
    let alice_basket_before = env.token_balance(alice_basket_acc);
    let min_out = vec![0u64; assets.mints.len()];
    env.redeem_basket(
        &basket,
        &alice,
        alice_basket_acc,
        &assets.alice_accounts,
        alice_basket_before,
        min_out,
    )
    .expect("redeem_basket should succeed");
    assert_eq!(env.token_balance(alice_basket_acc), 0);

    // Every fee is already zero, so `lower_fees` can only ever restate zero —
    // and any attempt to put a fee on an existing basket is an increase.
    env.lower_fees(&basket, 0, 0, 0)
        .expect("restating zero should succeed");
    for (m, r, st) in [(1u16, 0u16, 0u16), (0, 1, 0), (0, 0, 1)] {
        let res = env.lower_fees(&basket, m, r, st);
        assert_etf_error(res, EtfError::FeeIncreaseNotAllowed);
    }
    let b = env.basket_account(basket.key);
    assert_eq!((b.mint_fee_bps, b.redeem_fee_bps, b.streaming_fee_bps), (0, 0, 0));
}

/// `CoinConfig.total_burned` must equal exactly the $EETF that has left the
/// supply — no more, no less — after a run that burns coins *and* basket tokens
/// through every path that burns anything.
///
/// This is the invariant `utils::burn_coin` exists to hold, and it's worth a
/// behavioural test rather than trusting the doc comment, because the counter
/// is the only on-chain evidence that supply actually shrank. It fails in
/// both directions that matter: a future $EETF sink that burns without
/// incrementing the counter under-reports, and a basket-token burn
/// (`redeem_basket`, `claim_fees`) that wrongly increments it over-reports.
#[test]
fn total_burned_accounts_for_every_coin_that_left_the_supply() {
    let mut env = Env::new();
    let assets = env.with_three_assets();
    let manager_coin = env.fund_coin(pubkey_of(&env.manager), 200_000 * 1_000_000_000);

    let check = |env: &Env, label: &str| {
        let gone = COIN_TOTAL_SUPPLY - env.mint_supply(env.coin_mint);
        assert_eq!(
            env.coin_config_account().total_burned, gone,
            "total_burned diverged from the missing supply after {label}"
        );
    };
    check(&env, "genesis");

    // 1. A basket launch burns coins through the create_basket leg.
    let (basket, _) = env
        .create_basket(&assets.mints, manager_coin, 0, 0, 0)
        .unwrap();
    check(&env, "create_basket");

    let manager_basket_acc = env.create_token_account(basket.mint, pubkey_of(&env.manager));
    env.seed_basket(
        &basket,
        manager_basket_acc,
        &assets.manager_accounts,
        1_000 * 1_000_000_000,
        vec![1_000 * 1_000_000_000; 3],
    )
    .unwrap();

    // 2. Minting, then redeeming, burns *basket* tokens. The coin counter must
    //    not move for any of it.
    let alice = env.alice.insecure_clone();
    let alice_basket_acc = env.create_token_account(basket.mint, pubkey_of(&env.alice));
    env.mint_basket(
        &basket,
        &alice,
        alice_basket_acc,
        &assets.alice_accounts,
        100 * 1_000_000_000,
        vec![u64::MAX; 3],
    )
    .unwrap();
    check(&env, "mint_basket");

    // 3. Time passes and accrual is cranked. With zero fees this mints nothing,
    //    but it still must not touch the coin counter.
    env.warp_seconds(90 * 24 * 60 * 60);
    env.accrue_fees(&basket).unwrap();
    check(&env, "accrue_fees");

    let alice_balance = env.token_balance(alice_basket_acc);
    env.redeem_basket(
        &basket,
        &alice,
        alice_basket_acc,
        &assets.alice_accounts,
        alice_balance,
        vec![0u64; 3],
    )
    .unwrap();
    check(&env, "redeem_basket");

    // 4. And the burn vault, which burns coins through the other leg.
    let dev_coin_acc = env.dev_coin_account;
    let dev = env.dev_treasury.insecure_clone();
    let dev_balance = env.token_balance(dev_coin_acc);
    assert!(dev_balance > 0, "the creation fee should have paid the dev treasury");
    env.transfer_tokens(dev_coin_acc, env.burn_vault, &dev, dev_balance);
    env.crank_burn(&alice).unwrap();
    check(&env, "crank_burn");

    // Sanity: the run actually burned something, so the assertions above
    // weren't comparing zero to zero.
    assert!(env.coin_config_account().total_burned > 0);
}

#[test]
fn burn_vault_cranks_permissionlessly() {
    let mut env = Env::new();
    let dev_coin_acc = env.dev_coin_account;
    let dev = env.dev_treasury.insecure_clone();

    let assets = env.with_three_assets();
    let manager_coin = env.fund_coin(pubkey_of(&env.manager), 200_000 * 1_000_000_000);
    env.create_basket(&assets.mints, manager_coin, 0, 0, 0).unwrap();
    // Dev treasury now holds 30,000 EETF from the creation fee; send it to the
    // burn vault and crank it from an unrelated account (Alice).
    env.transfer_tokens(dev_coin_acc, env.burn_vault, &dev, 30_000 * 1_000_000_000);
    assert_eq!(env.token_balance(env.burn_vault), 30_000 * 1_000_000_000);

    let supply_before = env.mint_supply(env.coin_mint);
    let alice = env.alice.insecure_clone();
    env.crank_burn(&alice).expect("anyone can crank the burn");
    assert_eq!(env.token_balance(env.burn_vault), 0);
    assert_eq!(supply_before - env.mint_supply(env.coin_mint), 30_000 * 1_000_000_000);
    assert_eq!(env.coin_config_account().total_burned, 100_000 * 1_000_000_000);
}

#[test]
fn rejects_freezable_assets() {
    let mut env = Env::new();
    let manager_coin = env.fund_coin(pubkey_of(&env.manager), 200_000 * 1_000_000_000);
    let good = env.create_mint(9);
    let bad = env.create_freezable_mint(9); // has a freeze authority
    let third = env.create_mint(6);

    let res = env.create_basket(&[good, bad, third], manager_coin, 0, 0, 0);
    assert_etf_error(res, EtfError::FreezeAuthorityNotAllowed);
}

#[test]
fn rejects_fees_above_hard_caps() {
    let mut env = Env::new();
    let manager_coin = env.fund_coin(pubkey_of(&env.manager), 200_000 * 1_000_000_000);
    let assets = env.with_three_assets();

    let res = env.create_basket(&assets.mints, manager_coin, MAX_MINT_FEE_BPS + 1, 0, 0);
    assert_etf_error(res, EtfError::FeeAboveCap);
}

#[test]
fn mint_respects_slippage_guard() {
    let mut env = Env::new();
    let assets = env.with_three_assets();
    let manager_coin = env.fund_coin(pubkey_of(&env.manager), 200_000 * 1_000_000_000);
    let (basket, _) = env
        .create_basket(&assets.mints, manager_coin, 0, 0, 0)
        .unwrap();

    let manager_basket_acc = env.create_token_account(basket.mint, pubkey_of(&env.manager));
    let seed_amounts: Vec<u64> = [8u8, 9, 6].iter().map(|d| 1_000 * 10u64.pow(*d as u32)).collect();
    env.seed_basket(
        &basket,
        manager_basket_acc,
        &assets.manager_accounts,
        1_000 * 1_000_000_000,
        seed_amounts,
    )
    .unwrap();

    let alice_basket_acc = env.create_token_account(basket.mint, pubkey_of(&env.alice));
    let alice = env.alice.insecure_clone();
    // max_amounts_in of zero can never be satisfied for a non-zero mint.
    let res = env.mint_basket(
        &basket,
        &alice,
        alice_basket_acc,
        &assets.alice_accounts,
        100 * 1_000_000_000,
        vec![0, 0, 0],
    );
    assert_etf_error(res, EtfError::SlippageIn);
}
