//! Guard-rail tests: every `require!`/constraint the program checks that
//! `lifecycle.rs` doesn't already exercise. Each test drives the real
//! compiled binary and asserts the exact `EtfError` the program returns.

use everything_etf::constants::{
    MAX_ASSETS, MAX_CREATION_FEE_COIN, MAX_MINT_FEE_BPS, MAX_PROTOCOL_SHARE_BPS, MIN_ASSETS,
    MIN_CREATION_BURN_BPS,
};
use everything_etf::errors::EtfError;
use everything_etf::state::FeeRecipient;
use tests_e2e::*;

// ---------------------------------------------------------------------------
// initialize_config / initialize_coin
// ---------------------------------------------------------------------------

#[test]
fn initialize_config_rejects_protocol_share_above_cap() {
    let mut env = Env::bare();
    let res = env.initialize_config(0, MAX_PROTOCOL_SHARE_BPS + 1);
    assert_etf_error(res, EtfError::ProtocolShareAboveCap);
}

#[test]
fn initialize_config_accepts_share_at_exactly_the_cap() {
    let mut env = Env::bare();
    env.initialize_config(0, MAX_PROTOCOL_SHARE_BPS)
        .expect("the cap itself must be allowed, only above it rejected");
}

#[test]
fn initialize_coin_rejects_burn_share_below_floor() {
    let mut env = Env::bare();
    env.initialize_config(0, 1_000).unwrap();
    let res = env.initialize_coin(1_000, MIN_CREATION_BURN_BPS - 1);
    assert_etf_error(res, EtfError::BurnShareBelowFloor);
}

#[test]
fn initialize_coin_rejects_creation_fee_above_cap() {
    let mut env = Env::bare();
    env.initialize_config(0, 1_000).unwrap();
    let res = env.initialize_coin(MAX_CREATION_FEE_COIN + 1, MIN_CREATION_BURN_BPS);
    assert_etf_error(res, EtfError::CreationFeeAboveCap);
}

// ---------------------------------------------------------------------------
// update_authority
// ---------------------------------------------------------------------------

#[test]
fn update_authority_rotates_and_moves_the_privilege() {
    let mut env = Env::new();
    let old = env.authority.insecure_clone();
    let new = solana_keypair::Keypair::new();
    env.svm
        .airdrop(&solana_signer::Signer::pubkey(&new), 100 * SOL)
        .unwrap();

    env.update_authority(&old, &new, true)
        .expect("rotation with both signatures should succeed");
    assert_eq!(env.config_account().authority, pubkey_of(&new));

    // The privilege has actually moved: the old key can no longer change terms.
    let treasury = pubkey_of(&env.treasury);
    let res = env.update_protocol_terms(treasury, 0, 500);
    assert_etf_error(res, EtfError::Unauthorized);

    // ...and the new one can. `update_protocol_terms` signs as env.authority,
    // so point that at the new key before calling it.
    env.authority = new.insecure_clone();
    env.update_protocol_terms(treasury, 0, 500)
        .expect("the new authority should now be able to change terms");
    assert_eq!(env.config_account().protocol_share_bps, 500);
}

/// The whole point of making `new_authority` a `Signer`: an address that
/// can't sign can't be installed, so a typo'd pubkey can't permanently lock
/// the protocol out of its own admin role.
#[test]
fn update_authority_rejects_an_incoming_key_that_does_not_sign() {
    let mut env = Env::new();
    let old = env.authority.insecure_clone();
    let typo = solana_keypair::Keypair::new(); // stands in for a wrong pubkey

    let res = env.update_authority(&old, &typo, false);
    assert!(
        res.is_err(),
        "rotation must fail without the incoming authority's signature"
    );
    // Unchanged, so the protocol is still controllable.
    assert_eq!(env.config_account().authority, pubkey_of(&old));
}

#[test]
fn update_authority_rejects_a_non_authority_caller() {
    let mut env = Env::new();
    let impostor = env.alice.insecure_clone();
    let new = solana_keypair::Keypair::new();

    let res = env.update_authority(&impostor, &new, true);
    assert_etf_error(res, EtfError::Unauthorized);
    assert_eq!(env.config_account().authority, pubkey_of(&env.authority));
}

#[test]
fn update_authority_rejects_rotating_to_the_same_key() {
    let mut env = Env::new();
    let same = env.authority.insecure_clone();
    let res = env.update_authority(&same, &same, true);
    assert_etf_error(res, EtfError::AuthorityUnchanged);
}

// ---------------------------------------------------------------------------
// update_protocol_terms / update_coin_terms
// ---------------------------------------------------------------------------

#[test]
fn update_protocol_terms_rejects_share_above_cap() {
    let mut env = Env::new();
    let treasury = pubkey_of(&env.treasury);
    let res = env.update_protocol_terms(treasury, 0, MAX_PROTOCOL_SHARE_BPS + 1);
    assert_etf_error(res, EtfError::ProtocolShareAboveCap);
}

#[test]
fn update_protocol_terms_does_not_touch_existing_baskets() {
    let mut env = Env::new();
    let assets = env.with_three_assets();
    let manager_coin = env.fund_coin(pubkey_of(&env.manager), 200_000 * 1_000_000_000);
    let (basket, _) = env.create_basket(&assets.mints, manager_coin, 0, 0, 0).unwrap();
    assert_eq!(env.basket_account(basket.key).protocol_share_bps, 1_000);

    let treasury = pubkey_of(&env.treasury);
    env.update_protocol_terms(treasury, 0, 2_000).unwrap();
    assert_eq!(env.config_account().protocol_share_bps, 2_000);
    // The basket created under the old 10% share keeps it forever.
    assert_eq!(env.basket_account(basket.key).protocol_share_bps, 1_000);
}

#[test]
fn update_coin_terms_rejects_burn_share_below_floor() {
    let mut env = Env::new();
    let dev_treasury = pubkey_of(&env.dev_treasury);
    let res = env.update_coin_terms(dev_treasury, 0, MIN_CREATION_BURN_BPS - 1);
    assert_etf_error(res, EtfError::BurnShareBelowFloor);
}

#[test]
fn update_coin_terms_rejects_fee_above_cap() {
    let mut env = Env::new();
    let dev_treasury = pubkey_of(&env.dev_treasury);
    let res = env.update_coin_terms(dev_treasury, MAX_CREATION_FEE_COIN + 1, MIN_CREATION_BURN_BPS);
    assert_etf_error(res, EtfError::CreationFeeAboveCap);
}

// ---------------------------------------------------------------------------
// create_basket
// ---------------------------------------------------------------------------

#[test]
fn create_basket_rejects_too_few_assets() {
    let mut env = Env::new();
    let assets = env.with_n_assets(MIN_ASSETS - 1);
    let manager_coin = env.fund_coin(pubkey_of(&env.manager), 200_000 * 1_000_000_000);
    let res = env.create_basket(&assets.mints, manager_coin, 0, 0, 0);
    assert_etf_error(res, EtfError::InvalidAssetCount);
}

#[test]
fn create_basket_rejects_too_many_assets() {
    let mut env = Env::new();
    let manager_coin = env.fund_coin(pubkey_of(&env.manager), 200_000 * 1_000_000_000);
    // The program's own asset-count check runs before it ever reads an asset
    // account, so the *same* mint repeated MAX_ASSETS + 1 times is enough to
    // trip InvalidAssetCount — and keeps this transaction's account list
    // small, well clear of litesvm's unrelated static-account-key limit that
    // a basket's real MAX_ASSETS + 1 *distinct* mints would otherwise hit.
    let one_mint = env.create_mint(9);
    let assets = vec![one_mint; MAX_ASSETS + 1];
    let res = env.create_basket(&assets, manager_coin, 0, 0, 0);
    assert_etf_error(res, EtfError::InvalidAssetCount);
}

#[test]
fn create_basket_accepts_the_boundary_asset_counts() {
    let mut env = Env::new();
    let manager_coin = env.fund_coin(pubkey_of(&env.manager), 1_000_000 * 1_000_000_000);

    let min_assets = env.with_n_assets(MIN_ASSETS);
    env.create_basket(&min_assets.mints, manager_coin, 0, 0, 0)
        .expect("MIN_ASSETS must be accepted");

    let max_assets = env.with_n_assets(MAX_ASSETS);
    env.create_basket(&max_assets.mints, manager_coin, 0, 0, 0)
        .expect("MAX_ASSETS must be accepted");
}

#[test]
fn create_basket_rejects_duplicate_assets() {
    let mut env = Env::new();
    let assets = env.with_three_assets();
    let manager_coin = env.fund_coin(pubkey_of(&env.manager), 200_000 * 1_000_000_000);
    let dup = [assets.mints[0], assets.mints[0], assets.mints[1]];
    let res = env.create_basket(&dup, manager_coin, 0, 0, 0);
    assert_etf_error(res, EtfError::DuplicateAsset);
}

/// The launch form doesn't ask for a metadata URI, so it sends an empty one —
/// this pins down that both the program and the Metaplex CPI accept that.
#[test]
fn create_basket_accepts_an_empty_uri() {
    let mut env = Env::new();
    let assets = env.with_three_assets();
    let manager_coin = env.fund_coin(pubkey_of(&env.manager), 200_000 * 1_000_000_000);
    env.create_basket_named(&assets.mints, manager_coin, "Frog Basket", "FROG", "", 50, 50, 200)
        .expect("an empty metadata URI should be accepted");
}

#[test]
fn create_basket_rejects_metadata_too_long() {
    let mut env = Env::new();
    let assets = env.with_three_assets();
    let manager_coin = env.fund_coin(pubkey_of(&env.manager), 200_000 * 1_000_000_000);
    let long_name = "x".repeat(everything_etf::constants::MAX_NAME_LEN + 1);
    let res = env.create_basket_named(
        &assets.mints,
        manager_coin,
        &long_name,
        "SYM",
        "https://x",
        0,
        0,
        0,
    );
    assert_etf_error(res, EtfError::MetadataTooLong);
}

#[test]
fn create_basket_rejects_redeem_fee_above_cap() {
    let mut env = Env::new();
    let assets = env.with_three_assets();
    let manager_coin = env.fund_coin(pubkey_of(&env.manager), 200_000 * 1_000_000_000);
    let res = env.create_basket(&assets.mints, manager_coin, 0, MAX_MINT_FEE_BPS + 1, 0);
    assert_etf_error(res, EtfError::FeeAboveCap);
}

#[test]
fn create_basket_fails_without_enough_eetf_for_the_fee() {
    let mut env = Env::new();
    let assets = env.with_three_assets();
    // Fund with less than the 100,000 EETF creation fee.
    let manager_coin = env.fund_coin(pubkey_of(&env.manager), 1_000 * 1_000_000_000);
    let res = env.create_basket(&assets.mints, manager_coin, 0, 0, 0);
    // SPL token's own insufficient-funds check, surfaced as a raw instruction
    // error rather than one of our custom codes.
    assert!(res.is_err(), "expected the burn CPI to fail for insufficient balance");
}

// ---------------------------------------------------------------------------
// seed_basket
// ---------------------------------------------------------------------------

#[test]
fn seed_basket_rejects_double_seeding() {
    let mut env = Env::new();
    let assets = env.with_three_assets();
    let manager_coin = env.fund_coin(pubkey_of(&env.manager), 200_000 * 1_000_000_000);
    let (basket, _) = env.create_basket(&assets.mints, manager_coin, 0, 0, 0).unwrap();

    let manager_basket_acc = env.create_token_account(basket.mint, pubkey_of(&env.manager));
    let amounts = vec![1_000 * 1_000_000_000u64; 3];
    env.seed_basket(&basket, manager_basket_acc, &assets.manager_accounts, 1_000 * 1_000_000_000, amounts.clone())
        .expect("first seed should succeed");

    let res = env.seed_basket(&basket, manager_basket_acc, &assets.manager_accounts, 1, amounts);
    assert_etf_error(res, EtfError::AlreadySeeded);
}

#[test]
fn seed_basket_rejects_amount_list_mismatch() {
    let mut env = Env::new();
    let assets = env.with_three_assets();
    let manager_coin = env.fund_coin(pubkey_of(&env.manager), 200_000 * 1_000_000_000);
    let (basket, _) = env.create_basket(&assets.mints, manager_coin, 0, 0, 0).unwrap();

    let manager_basket_acc = env.create_token_account(basket.mint, pubkey_of(&env.manager));
    // Only two amounts for a three-asset basket.
    let res = env.seed_basket(
        &basket,
        manager_basket_acc,
        &assets.manager_accounts,
        1_000 * 1_000_000_000,
        vec![1_000_000_000, 1_000_000_000],
    );
    assert_etf_error(res, EtfError::AmountListMismatch);
}

#[test]
fn seed_basket_rejects_zero_initial_supply() {
    let mut env = Env::new();
    let assets = env.with_three_assets();
    let manager_coin = env.fund_coin(pubkey_of(&env.manager), 200_000 * 1_000_000_000);
    let (basket, _) = env.create_basket(&assets.mints, manager_coin, 0, 0, 0).unwrap();

    let manager_basket_acc = env.create_token_account(basket.mint, pubkey_of(&env.manager));
    let res = env.seed_basket(
        &basket,
        manager_basket_acc,
        &assets.manager_accounts,
        0,
        vec![1_000_000_000; 3],
    );
    assert_etf_error(res, EtfError::ZeroAmount);
}

// ---------------------------------------------------------------------------
// mint_basket / redeem_basket before seeding
// ---------------------------------------------------------------------------

#[test]
fn mint_basket_rejects_unseeded_basket() {
    let mut env = Env::new();
    let assets = env.with_three_assets();
    let manager_coin = env.fund_coin(pubkey_of(&env.manager), 200_000 * 1_000_000_000);
    let (basket, _) = env.create_basket(&assets.mints, manager_coin, 0, 0, 0).unwrap();

    let alice_basket_acc = env.create_token_account(basket.mint, pubkey_of(&env.alice));
    let alice = env.alice.insecure_clone();
    let res = env.mint_basket(
        &basket,
        &alice,
        alice_basket_acc,
        &assets.alice_accounts,
        1_000_000_000,
        vec![u64::MAX; 3],
    );
    assert_etf_error(res, EtfError::NotSeeded);
}

#[test]
fn redeem_basket_rejects_unseeded_basket() {
    let mut env = Env::new();
    let assets = env.with_three_assets();
    let manager_coin = env.fund_coin(pubkey_of(&env.manager), 200_000 * 1_000_000_000);
    let (basket, _) = env.create_basket(&assets.mints, manager_coin, 0, 0, 0).unwrap();

    let alice_basket_acc = env.create_token_account(basket.mint, pubkey_of(&env.alice));
    let alice = env.alice.insecure_clone();
    let res = env.redeem_basket(
        &basket,
        &alice,
        alice_basket_acc,
        &assets.alice_accounts,
        1,
        vec![0; 3],
    );
    assert_etf_error(res, EtfError::NotSeeded);
}

#[test]
fn mint_and_redeem_reject_zero_amount() {
    let mut env = Env::new();
    let assets = env.with_three_assets();
    let manager_coin = env.fund_coin(pubkey_of(&env.manager), 200_000 * 1_000_000_000);
    let (basket, _) = env.create_basket(&assets.mints, manager_coin, 0, 0, 0).unwrap();

    let manager_basket_acc = env.create_token_account(basket.mint, pubkey_of(&env.manager));
    env.seed_basket(
        &basket,
        manager_basket_acc,
        &assets.manager_accounts,
        1_000 * 1_000_000_000,
        vec![1_000 * 1_000_000_000; 3],
    )
    .unwrap();

    let alice_basket_acc = env.create_token_account(basket.mint, pubkey_of(&env.alice));
    let alice = env.alice.insecure_clone();

    let res = env.mint_basket(&basket, &alice, alice_basket_acc, &assets.alice_accounts, 0, vec![0; 3]);
    assert_etf_error(res, EtfError::ZeroAmount);

    let res = env.redeem_basket(&basket, &alice, alice_basket_acc, &assets.alice_accounts, 0, vec![0; 3]);
    assert_etf_error(res, EtfError::ZeroAmount);
}

// ---------------------------------------------------------------------------
// redeem_basket slippage + claim_fees
// ---------------------------------------------------------------------------

#[test]
fn redeem_basket_respects_slippage_guard() {
    let mut env = Env::new();
    let assets = env.with_three_assets();
    let manager_coin = env.fund_coin(pubkey_of(&env.manager), 200_000 * 1_000_000_000);
    let (basket, _) = env.create_basket(&assets.mints, manager_coin, 0, 0, 0).unwrap();

    let manager_basket_acc = env.create_token_account(basket.mint, pubkey_of(&env.manager));
    env.seed_basket(
        &basket,
        manager_basket_acc,
        &assets.manager_accounts,
        1_000 * 1_000_000_000,
        vec![1_000 * 1_000_000_000; 3],
    )
    .unwrap();

    // Manager redeems a small amount but demands an impossibly high payout.
    let res = env.redeem_basket(
        &basket,
        &env.manager.insecure_clone(),
        manager_basket_acc,
        &assets.manager_accounts,
        1_000_000_000,
        vec![u64::MAX; 3],
    );
    assert_etf_error(res, EtfError::SlippageOut);
}

#[test]
fn claim_fees_rejects_when_nothing_accrued() {
    let mut env = Env::new();
    let assets = env.with_three_assets();
    let manager_coin = env.fund_coin(pubkey_of(&env.manager), 200_000 * 1_000_000_000);
    // Zero every fee so nothing ever accrues.
    let (basket, _) = env.create_basket(&assets.mints, manager_coin, 0, 0, 0).unwrap();

    let manager_basket_acc = env.create_token_account(basket.mint, pubkey_of(&env.manager));
    env.seed_basket(
        &basket,
        manager_basket_acc,
        &assets.manager_accounts,
        1_000 * 1_000_000_000,
        vec![1_000 * 1_000_000_000; 3],
    )
    .unwrap();

    let manager = env.manager.insecure_clone();
    let res = env.claim_fees(
        &basket,
        &manager,
        FeeRecipient::Manager,
        manager_basket_acc,
        &assets.manager_accounts,
    );
    assert_etf_error(res, EtfError::NothingToClaim);
}

#[test]
fn claim_fees_rejects_wrong_claimer() {
    let mut env = Env::new();
    let assets = env.with_three_assets();
    let manager_coin = env.fund_coin(pubkey_of(&env.manager), 200_000 * 1_000_000_000);
    let (basket, _) = env.create_basket(&assets.mints, manager_coin, 50, 50, 0).unwrap();

    let manager_basket_acc = env.create_token_account(basket.mint, pubkey_of(&env.manager));
    env.seed_basket(
        &basket,
        manager_basket_acc,
        &assets.manager_accounts,
        1_000 * 1_000_000_000,
        vec![1_000 * 1_000_000_000; 3],
    )
    .unwrap();

    // Mint something so a fee actually accrues.
    let alice_basket_acc = env.create_token_account(basket.mint, pubkey_of(&env.alice));
    let alice = env.alice.insecure_clone();
    env.mint_basket(
        &basket,
        &alice,
        alice_basket_acc,
        &assets.alice_accounts,
        100 * 1_000_000_000,
        vec![u64::MAX; 3],
    )
    .unwrap();

    // Alice is neither the manager nor the protocol authority.
    let res = env.claim_fees(
        &basket,
        &alice,
        FeeRecipient::Manager,
        alice_basket_acc,
        &assets.alice_accounts,
    );
    assert_etf_error(res, EtfError::Unauthorized);

    let res = env.claim_fees(
        &basket,
        &alice,
        FeeRecipient::Protocol,
        alice_basket_acc,
        &assets.alice_accounts,
    );
    assert_etf_error(res, EtfError::Unauthorized);
}

// ---------------------------------------------------------------------------
// lower_fees authorization
// ---------------------------------------------------------------------------

#[test]
fn lower_fees_rejects_non_manager() {
    let mut env = Env::new();
    let assets = env.with_three_assets();
    let manager_coin = env.fund_coin(pubkey_of(&env.manager), 200_000 * 1_000_000_000);
    let (basket, _) = env.create_basket(&assets.mints, manager_coin, 50, 50, 100).unwrap();

    let alice = env.alice.insecure_clone();
    let res = env.lower_fees_as(&basket, &alice, 10, 10, 10);
    assert_etf_error(res, EtfError::Unauthorized);
}

#[test]
fn lower_fees_rejects_any_single_increase() {
    let mut env = Env::new();
    let assets = env.with_three_assets();
    let manager_coin = env.fund_coin(pubkey_of(&env.manager), 200_000 * 1_000_000_000);
    let (basket, _) = env.create_basket(&assets.mints, manager_coin, 50, 50, 100).unwrap();

    // Lowering mint/redeem but raising streaming must fail as a whole.
    let res = env.lower_fees(&basket, 10, 10, 101);
    assert_etf_error(res, EtfError::FeeIncreaseNotAllowed);
    // Nothing should have been written on the rejected call.
    let b = env.basket_account(basket.key);
    assert_eq!((b.mint_fee_bps, b.redeem_fee_bps, b.streaming_fee_bps), (50, 50, 100));
}

// ---------------------------------------------------------------------------
// crank_burn
// ---------------------------------------------------------------------------

#[test]
fn crank_burn_rejects_an_empty_vault() {
    let mut env = Env::new();
    let alice = env.alice.insecure_clone();
    let res = env.crank_burn(&alice);
    assert_etf_error(res, EtfError::NothingToBurn);
}

// ---------------------------------------------------------------------------
// accrue_fees is idempotent / permissionless
// ---------------------------------------------------------------------------

#[test]
fn accrue_fees_twice_in_the_same_instant_mints_nothing_the_second_time() {
    let mut env = Env::new();
    let assets = env.with_three_assets();
    let manager_coin = env.fund_coin(pubkey_of(&env.manager), 200_000 * 1_000_000_000);
    let (basket, _) = env.create_basket(&assets.mints, manager_coin, 0, 0, 200).unwrap();

    let manager_basket_acc = env.create_token_account(basket.mint, pubkey_of(&env.manager));
    env.seed_basket(
        &basket,
        manager_basket_acc,
        &assets.manager_accounts,
        1_000 * 1_000_000_000,
        vec![1_000 * 1_000_000_000; 3],
    )
    .unwrap();

    env.warp_seconds(1_000);
    env.accrue_fees(&basket).unwrap();
    let supply_after_first = env.mint_supply(basket.mint);

    // No time has passed since; a second accrual must be a no-op.
    env.accrue_fees(&basket).unwrap();
    assert_eq!(env.mint_supply(basket.mint), supply_after_first);
}
