//! End-to-end run of the whole protocol against the real, compiled program
//! binary (target/deploy/everything_etf.so), executed inside litesvm.
//!
//! This is the "see it in action" test: protocol setup, $EETF genesis, a
//! basket launch that burns $EETF, seeding, in-kind mint/redeem at NAV,
//! streaming-fee accrual, and manager/protocol fee claims — plus a few
//! guard rails (fee caps, frozen-mint rejection, slippage).

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
        .create_basket(&assets.mints, manager_coin, 50, 50, 200)
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

    // 0.5% mint fee: Alice nets 99.5, the other 0.5 basket tokens sit in escrow.
    assert_eq!(env.token_balance(alice_basket_acc), 99_500_000_000);
    assert_eq!(env.token_balance(basket.fee_escrow), 500_000_000);
    let b = env.basket_account(basket.key);
    assert_eq!(b.manager_fees_accrued + b.protocol_fees_accrued, 500_000_000);
    // 10% protocol share, snapshotted from config at creation.
    assert_eq!(b.protocol_fees_accrued, 50_000_000);
    assert_eq!(b.manager_fees_accrued, 450_000_000);

    // Each vault grew by 10% (Alice deposited 1/10th of the existing NAV, since
    // mint amount is computed pre-fee against pre-mint supply).
    for (vault, seed) in basket.vaults.iter().zip(seed_amounts.iter()) {
        let expected = seed + seed / 10;
        assert_eq!(env.token_balance(*vault), expected, "vault {vault}");
    }

    // Streaming fee: warp a full year forward and accrue permissionlessly.
    env.accrue_fees(&basket).unwrap();
    let supply_with_fee = env.mint_supply(basket.mint);
    env.warp_seconds(365 * 24 * 60 * 60);
    env.accrue_fees(&basket).unwrap();
    let supply_after_year = env.mint_supply(basket.mint);
    assert!(
        supply_after_year > supply_with_fee,
        "a year of 2% streaming fee should have minted new basket tokens"
    );
    // ~2% annual streaming fee against ~1,099.5 supply.
    let minted = supply_after_year - supply_with_fee;
    let share = minted as f64 / supply_after_year as f64;
    assert!((share - 0.02).abs() < 0.001, "share was {share}");

    // Manager claims accrued fees: 25% basket tokens, 75% in-kind underlyings.
    let b = env.basket_account(basket.key);
    let manager_claim = b.manager_fees_accrued;
    assert!(manager_claim > 0);
    let manager = env.manager.insecure_clone();
    env.claim_fees(
        &basket,
        &manager,
        FeeRecipient::Manager,
        manager_basket_acc,
        &assets.manager_accounts,
    )
    .expect("manager claim should succeed");
    let b_after = env.basket_account(basket.key);
    assert_eq!(b_after.manager_fees_accrued, 0);

    // Protocol claims too, paid to the treasury's basket-token account.
    let treasury_basket_acc = env.create_token_account(basket.mint, pubkey_of(&env.treasury));
    let treasury_asset_accs: Vec<_> = assets
        .mints
        .iter()
        .map(|m| env.create_token_account(*m, pubkey_of(&env.treasury)))
        .collect();
    let authority = env.authority.insecure_clone();
    let protocol_claim = env.basket_account(basket.key).protocol_fees_accrued;
    assert!(protocol_claim > 0);
    env.claim_fees(
        &basket,
        &authority,
        FeeRecipient::Protocol,
        treasury_basket_acc,
        &treasury_asset_accs,
    )
    .expect("protocol claim should succeed");
    assert_eq!(env.basket_account(basket.key).protocol_fees_accrued, 0);
    assert!(env.token_balance(treasury_basket_acc) > 0);

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

    // Manager lowers fees; raising them back is rejected.
    env.lower_fees(&basket, 10, 10, 100)
        .expect("lowering fees should succeed");
    assert_eq!(env.basket_account(basket.key).mint_fee_bps, 10);
    let raise = env.lower_fees(&basket, 20, 10, 100);
    assert_etf_error(raise, EtfError::FeeIncreaseNotAllowed);
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

    // MAX_MINT_FEE_BPS is 100 (1%).
    let res = env.create_basket(&assets.mints, manager_coin, 101, 0, 0);
    assert_etf_error(res, EtfError::FeeAboveCap);
}

#[test]
fn mint_respects_slippage_guard() {
    let mut env = Env::new();
    let assets = env.with_three_assets();
    let manager_coin = env.fund_coin(pubkey_of(&env.manager), 200_000 * 1_000_000_000);
    let (basket, _) = env
        .create_basket(&assets.mints, manager_coin, 50, 50, 0)
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
