//! Test harness for the Everything ETF program.
//!
//! Loads the real SBF binary into [`litesvm`], an in-process SVM, and drives it
//! with transactions built from the program's own generated client types, so the
//! account lists and instruction data cannot drift from the on-chain code.
//!
//! Two generations of Solana crates coexist here: the program is built against
//! `solana-*` 2.x (via anchor 0.31) while litesvm runs on 3.x. Everything is
//! built with anchor's 2.x types and converted once, in [`conv`].

use std::path::PathBuf;

use anchor_lang::prelude::Pubkey;
use anchor_lang::solana_program::instruction::Instruction as AnchorIx;
use anchor_lang::solana_program::{bpf_loader_upgradeable, system_instruction};
use anchor_lang::{InstructionData, ToAccountMetas};
use anchor_spl::associated_token::get_associated_token_address;
use anchor_spl::token::spl_token;

use litesvm::types::{FailedTransactionMetadata, TransactionMetadata};
use litesvm::LiteSVM;
use solana_address::Address;
use solana_clock::Clock;
use solana_instruction::{AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_message::Message;
use solana_signer::Signer;
use solana_transaction::Transaction;

use everything_etf::constants::*;
use everything_etf::state::{Basket, CoinConfig, Config, FeeRecipient};

// The generated client modules live at the crate root, alongside `#[program]`.
pub use everything_etf::{accounts as etf_accounts, instruction as etf_ix};

pub const MINT_LEN: u64 = 82;
pub const TOKEN_ACCOUNT_LEN: u64 = 165;
/// Comfortably above the rent-exempt minimum for both of the above.
pub const ACCOUNT_RENT: u64 = 10_000_000;
pub const SOL: u64 = 1_000_000_000;

// ---------------------------------------------------------------------------
// 2.x <-> 3.x conversions
// ---------------------------------------------------------------------------

pub fn addr(p: Pubkey) -> Address {
    Address::new_from_array(p.to_bytes())
}

pub fn pk(a: Address) -> Pubkey {
    Pubkey::new_from_array(a.to_bytes())
}

/// A keypair's pubkey, as anchor's (2.x) `Pubkey` type.
pub fn pubkey_of(kp: &Keypair) -> Pubkey {
    pk(kp.pubkey())
}

/// Converts an instruction built with anchor's `solana-*` 2.x types into the
/// 3.x type litesvm consumes.
pub fn conv(ix: AnchorIx) -> Instruction {
    Instruction {
        program_id: addr(ix.program_id),
        accounts: ix
            .accounts
            .into_iter()
            .map(|m| AccountMeta {
                pubkey: addr(m.pubkey),
                is_signer: m.is_signer,
                is_writable: m.is_writable,
            })
            .collect(),
        data: ix.data,
    }
}

/// Builds a program instruction from the generated accounts struct and args,
/// appending `remaining` account metas.
pub fn etf_instruction<A: ToAccountMetas, D: InstructionData>(
    accounts: A,
    args: D,
    remaining: Vec<anchor_lang::solana_program::instruction::AccountMeta>,
) -> Instruction {
    let mut metas = accounts.to_account_metas(None);
    metas.extend(remaining);
    conv(AnchorIx {
        program_id: everything_etf::ID,
        accounts: metas,
        data: args.data(),
    })
}

pub fn writable(p: Pubkey) -> anchor_lang::solana_program::instruction::AccountMeta {
    anchor_lang::solana_program::instruction::AccountMeta::new(p, false)
}

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

/// A deployed protocol: program loaded, config initialized, $EETF minted.
pub struct Env {
    pub svm: LiteSVM,
    /// Protocol authority (also the program's upgrade authority) and fee payer.
    pub authority: Keypair,
    pub treasury: Keypair,
    pub dev_treasury: Keypair,
    pub genesis_owner: Keypair,
    pub manager: Keypair,
    pub alice: Keypair,

    pub config: Pubkey,
    pub coin_config: Pubkey,
    pub coin_mint: Pubkey,
    pub genesis_account: Pubkey,
    pub burn_vault: Pubkey,
    pub dev_coin_account: Pubkey,
}

fn so_path(name: &str) -> PathBuf {
    let mut p = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    p.pop();
    p.join("target").join("deploy").join(name)
}

fn fixture_path(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("fixtures")
        .join(name)
}

impl Env {
    /// Loads the programs and funds the actors. Nothing protocol-specific yet.
    pub fn bare() -> Self {
        // Mainnet's default compute budget is 200k CU/tx unless a
        // SetComputeUnitLimit instruction raises it; a basket near
        // MAX_ASSETS genuinely needs more (one ATA create per asset adds
        // up), so a real client would need that instruction too. We raise
        // the VM's own ceiling instead of adding the instruction here,
        // since adding it pushes some transactions right up against an
        // unrelated litesvm/agave limit on distinct account keys per
        // message (see `create_basket_accepts_the_boundary_asset_counts`).
        let compute_budget = solana_compute_budget::compute_budget::ComputeBudget {
            compute_unit_limit: 1_400_000,
            // A basket near MAX_ASSETS does one ATA-create CPI chain per
            // asset (each several instructions deep); the default trace
            // length is tuned for ordinary transactions, not ten of these
            // back to back.
            max_instruction_trace_length: 256,
            ..solana_compute_budget::compute_budget::ComputeBudget::new_with_defaults(false, false)
        };
        let mut svm = LiteSVM::new().with_compute_budget(compute_budget);

        svm.add_program_from_file(addr(everything_etf::ID), so_path("everything_etf.so"))
            .expect("build the program first: cargo-build-sbf");
        svm.add_program_from_file(
            addr(anchor_spl::metadata::ID),
            fixture_path("mpl_token_metadata.so"),
        )
        .expect("missing Metaplex fixture");

        let authority = Keypair::new();
        let treasury = Keypair::new();
        let dev_treasury = Keypair::new();
        let genesis_owner = Keypair::new();
        let manager = Keypair::new();
        let alice = Keypair::new();
        for kp in [
            &authority,
            &treasury,
            &dev_treasury,
            &genesis_owner,
            &manager,
            &alice,
        ] {
            svm.airdrop(&kp.pubkey(), 500 * SOL).unwrap();
        }

        // litesvm loads programs with no upgrade authority; `initialize_config`
        // requires the caller to *be* the upgrade authority, so install it.
        set_upgrade_authority(&mut svm, everything_etf::ID, pk(authority.pubkey()));

        let (config, _) = Pubkey::find_program_address(&[CONFIG_SEED], &everything_etf::ID);
        let (coin_config, _) = Pubkey::find_program_address(&[COIN_SEED], &everything_etf::ID);
        let (coin_mint, _) = Pubkey::find_program_address(&[COIN_MINT_SEED], &everything_etf::ID);

        Self {
            svm,
            config,
            coin_config,
            coin_mint,
            genesis_account: get_associated_token_address(&pk(genesis_owner.pubkey()), &coin_mint),
            burn_vault: get_associated_token_address(&coin_config, &coin_mint),
            dev_coin_account: get_associated_token_address(&pk(dev_treasury.pubkey()), &coin_mint),
            authority,
            treasury,
            dev_treasury,
            genesis_owner,
            manager,
            alice,
        }
    }

    /// The full setup most tests want: config + $EETF live, manager funded with
    /// enough $EETF to launch baskets.
    pub fn new() -> Self {
        let mut env = Self::bare();
        env.initialize_config(SOL / 4, 1_000).unwrap();
        env.initialize_coin(100_000 * 1_000_000_000, 7_000).unwrap();
        // `create_basket` requires the dev treasury's $EETF account to
        // already exist; it is not created for you. Use its ATA, matching
        // the address precomputed in `dev_coin_account`.
        let dev_treasury = pk(env.dev_treasury.pubkey());
        env.create_ata(env.coin_mint, dev_treasury);
        env
    }

    // -- plumbing ----------------------------------------------------------

    pub fn send(
        &mut self,
        ixs: &[Instruction],
        signers: &[&Keypair],
    ) -> Result<TransactionMetadata, FailedTransactionMetadata> {
        let payer = signers[0].pubkey();
        let tx = Transaction::new_signed_with_payer(
            ixs,
            Some(&payer),
            signers,
            self.svm.latest_blockhash(),
        );
        let res = self.svm.send_transaction(tx);
        self.svm.expire_blockhash();
        res
    }

    /// Submits a transaction that is deliberately missing one or more required
    /// signatures, so the runtime rejects it rather than the client refusing to
    /// build it. `send` can't express this: `new_signed_with_payer` panics when
    /// a required signer is absent, which is a client-side guard, not the
    /// on-chain behaviour a test wants to assert.
    pub fn send_partially_signed(
        &mut self,
        ixs: &[Instruction],
        signers: &[&Keypair],
    ) -> Result<TransactionMetadata, FailedTransactionMetadata> {
        let payer = signers[0].pubkey();
        let mut tx = Transaction::new_unsigned(Message::new(ixs, Some(&payer)));
        tx.partial_sign(signers, self.svm.latest_blockhash());
        let res = self.svm.send_transaction(tx);
        self.svm.expire_blockhash();
        res
    }

    /// Moves the clock (and slot) forward so streaming fees accrue.
    pub fn warp_seconds(&mut self, secs: i64) {
        let mut clock: Clock = self.svm.get_sysvar();
        clock.unix_timestamp += secs;
        clock.slot += (secs as u64) * 2;
        self.svm.set_sysvar(&clock);
    }

    pub fn now(&self) -> i64 {
        self.svm.get_sysvar::<Clock>().unix_timestamp
    }

    // -- account readers ---------------------------------------------------

    fn anchor_account<T: anchor_lang::AccountDeserialize>(&self, key: Pubkey) -> T {
        let acc = self.svm.get_account(&addr(key)).expect("account not found");
        T::try_deserialize(&mut acc.data.as_slice()).expect("deserialize failed")
    }

    pub fn config_account(&self) -> Config {
        self.anchor_account(self.config)
    }

    pub fn coin_config_account(&self) -> CoinConfig {
        self.anchor_account(self.coin_config)
    }

    pub fn basket_account(&self, basket: Pubkey) -> Basket {
        self.anchor_account(basket)
    }

    pub fn token_balance(&self, account: Pubkey) -> u64 {
        use anchor_lang::solana_program::program_pack::Pack;
        let acc = self
            .svm
            .get_account(&addr(account))
            .expect("token account not found");
        spl_token::state::Account::unpack(&acc.data).unwrap().amount
    }

    pub fn mint_supply(&self, mint: Pubkey) -> u64 {
        use anchor_lang::solana_program::program_pack::Pack;
        let acc = self.svm.get_account(&addr(mint)).expect("mint not found");
        spl_token::state::Mint::unpack(&acc.data).unwrap().supply
    }

    pub fn mint_authority(&self, mint: Pubkey) -> Option<Pubkey> {
        use anchor_lang::solana_program::program_pack::Pack;
        let acc = self.svm.get_account(&addr(mint)).expect("mint not found");
        spl_token::state::Mint::unpack(&acc.data)
            .unwrap()
            .mint_authority
            .into()
    }

    // -- SPL helpers -------------------------------------------------------

    /// Creates a plain SPL mint with no freeze authority (the program rejects
    /// freezable assets).
    pub fn create_mint(&mut self, decimals: u8) -> Pubkey {
        let mint = Keypair::new();
        let mint_pk = pk(mint.pubkey());
        let authority = pk(self.authority.pubkey());
        let ixs = vec![
            conv(system_instruction::create_account(
                &authority,
                &mint_pk,
                ACCOUNT_RENT,
                MINT_LEN,
                &spl_token::ID,
            )),
            conv(
                spl_token::instruction::initialize_mint2(
                    &spl_token::ID,
                    &mint_pk,
                    &authority,
                    None,
                    decimals,
                )
                .unwrap(),
            ),
        ];
        let authority_kp = self.authority.insecure_clone();
        self.send(&ixs, &[&authority_kp, &mint]).unwrap();
        mint_pk
    }

    /// Creates a freezable mint, to prove the program refuses it.
    pub fn create_freezable_mint(&mut self, decimals: u8) -> Pubkey {
        let mint = Keypair::new();
        let mint_pk = pk(mint.pubkey());
        let authority = pk(self.authority.pubkey());
        let ixs = vec![
            conv(system_instruction::create_account(
                &authority,
                &mint_pk,
                ACCOUNT_RENT,
                MINT_LEN,
                &spl_token::ID,
            )),
            conv(
                spl_token::instruction::initialize_mint2(
                    &spl_token::ID,
                    &mint_pk,
                    &authority,
                    Some(&authority),
                    decimals,
                )
                .unwrap(),
            ),
        ];
        let authority_kp = self.authority.insecure_clone();
        self.send(&ixs, &[&authority_kp, &mint]).unwrap();
        mint_pk
    }

    /// A plain (non-ATA) token account. Fine for users; vaults must be ATAs and
    /// are created by the program itself.
    pub fn create_token_account(&mut self, mint: Pubkey, owner: Pubkey) -> Pubkey {
        let account = Keypair::new();
        let account_pk = pk(account.pubkey());
        let authority = pk(self.authority.pubkey());
        let ixs = vec![
            conv(system_instruction::create_account(
                &authority,
                &account_pk,
                ACCOUNT_RENT,
                TOKEN_ACCOUNT_LEN,
                &spl_token::ID,
            )),
            conv(
                spl_token::instruction::initialize_account3(
                    &spl_token::ID,
                    &account_pk,
                    &mint,
                    &owner,
                )
                .unwrap(),
            ),
        ];
        let authority_kp = self.authority.insecure_clone();
        self.send(&ixs, &[&authority_kp, &account]).unwrap();
        account_pk
    }

    /// Creates `owner`'s associated token account for `mint`, at the address
    /// `get_associated_token_address` predicts.
    pub fn create_ata(&mut self, mint: Pubkey, owner: Pubkey) -> Pubkey {
        let payer = pk(self.authority.pubkey());
        let ix = conv(
            spl_associated_token_account::instruction::create_associated_token_account(
                &payer,
                &owner,
                &mint,
                &spl_token::ID,
            ),
        );
        let authority_kp = self.authority.insecure_clone();
        self.send(&[ix], &[&authority_kp]).unwrap();
        get_associated_token_address(&owner, &mint)
    }

    pub fn mint_tokens(&mut self, mint: Pubkey, to: Pubkey, amount: u64) {
        let authority = pk(self.authority.pubkey());
        let ix = conv(
            spl_token::instruction::mint_to(&spl_token::ID, &mint, &to, &authority, &[], amount)
                .unwrap(),
        );
        let authority_kp = self.authority.insecure_clone();
        self.send(&[ix], &[&authority_kp]).unwrap();
    }

    pub fn transfer_tokens(&mut self, from: Pubkey, to: Pubkey, owner: &Keypair, amount: u64) {
        let ix = conv(
            spl_token::instruction::transfer(
                &spl_token::ID,
                &from,
                &to,
                &pk(owner.pubkey()),
                &[],
                amount,
            )
            .unwrap(),
        );
        let owner_kp = owner.insecure_clone();
        self.send(&[ix], &[&owner_kp]).unwrap();
    }

    // -- protocol instructions --------------------------------------------

    pub fn initialize_config(
        &mut self,
        creation_fee_lamports: u64,
        protocol_share_bps: u16,
    ) -> Result<TransactionMetadata, FailedTransactionMetadata> {
        let (program_data, _) = Pubkey::find_program_address(
            &[everything_etf::ID.as_ref()],
            &bpf_loader_upgradeable::ID,
        );
        let ix = etf_instruction(
            etf_accounts::InitializeConfig {
                authority: pk(self.authority.pubkey()),
                config: self.config,
                program: everything_etf::ID,
                program_data,
                system_program: anchor_lang::system_program::ID,
            },
            etf_ix::InitializeConfig {
                treasury: pk(self.treasury.pubkey()),
                creation_fee_lamports,
                protocol_share_bps,
            },
            vec![],
        );
        let authority = self.authority.insecure_clone();
        self.send(&[ix], &[&authority])
    }

    pub fn initialize_coin(
        &mut self,
        creation_fee_coin: u64,
        creation_burn_bps: u16,
    ) -> Result<TransactionMetadata, FailedTransactionMetadata> {
        let ix = etf_instruction(
            etf_accounts::InitializeCoin {
                authority: pk(self.authority.pubkey()),
                config: self.config,
                coin_config: self.coin_config,
                coin_mint: self.coin_mint,
                genesis_owner: pk(self.genesis_owner.pubkey()),
                genesis_account: self.genesis_account,
                burn_vault: self.burn_vault,
                metadata: metadata_pda(self.coin_mint),
                token_metadata_program: anchor_spl::metadata::ID,
                token_program: spl_token::ID,
                associated_token_program: anchor_spl::associated_token::ID,
                system_program: anchor_lang::system_program::ID,
                rent: anchor_lang::solana_program::sysvar::rent::ID,
            },
            etf_ix::InitializeCoin {
                params: everything_etf::instructions::initialize_coin::InitializeCoinParams {
                    name: "Everything ETF".to_string(),
                    symbol: "EETF".to_string(),
                    uri: "https://everything.etf/eetf.json".to_string(),
                    creation_fee_coin,
                    creation_burn_bps,
                    dev_treasury: pk(self.dev_treasury.pubkey()),
                },
            },
            vec![],
        );
        let authority = self.authority.insecure_clone();
        self.send(&[ix], &[&authority])
    }

    /// Gives `owner` an $EETF account funded from the genesis allocation.
    pub fn fund_coin(&mut self, owner: Pubkey, amount: u64) -> Pubkey {
        let account = self.create_token_account(self.coin_mint, owner);
        let genesis = self.genesis_owner.insecure_clone();
        self.transfer_tokens(self.genesis_account, account, &genesis, amount);
        account
    }
}

/// Metaplex metadata PDA for a mint.
pub fn metadata_pda(mint: Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[b"metadata", anchor_spl::metadata::ID.as_ref(), mint.as_ref()],
        &anchor_spl::metadata::ID,
    )
    .0
}

/// Rewrites a loader-v3 ProgramData account to name `authority` as the upgrade
/// authority. Layout is bincode: u32 variant tag, u64 slot, Option<Pubkey>.
fn set_upgrade_authority(svm: &mut LiteSVM, program_id: Pubkey, authority: Pubkey) {
    let (program_data, _) =
        Pubkey::find_program_address(&[program_id.as_ref()], &bpf_loader_upgradeable::ID);
    let mut account = svm
        .get_account(&addr(program_data))
        .expect("programdata account");
    account.data[12] = 1; // Option::Some
    account.data[13..45].copy_from_slice(&authority.to_bytes());
    svm.set_account(addr(program_data), account).unwrap();
}

// ---------------------------------------------------------------------------
// Baskets
// ---------------------------------------------------------------------------

/// A launched basket plus every account needed to drive it.
pub struct BasketHandle {
    pub key: Pubkey,
    pub id: u64,
    pub mint: Pubkey,
    pub fee_escrow: Pubkey,
    pub assets: Vec<Pubkey>,
    pub vaults: Vec<Pubkey>,
}

impl BasketHandle {
    /// `[asset_mint, vault]` per asset, as `create_basket` expects.
    pub fn create_remaining(&self) -> Vec<anchor_lang::solana_program::instruction::AccountMeta> {
        self.assets
            .iter()
            .zip(&self.vaults)
            .flat_map(|(m, v)| [writable(*m), writable(*v)])
            .collect()
    }

    /// `[asset_mint, vault, party_account]` per asset, as seed/mint/redeem/claim expect.
    pub fn legs_remaining(
        &self,
        party_accounts: &[Pubkey],
    ) -> Vec<anchor_lang::solana_program::instruction::AccountMeta> {
        self.assets
            .iter()
            .zip(&self.vaults)
            .zip(party_accounts)
            .flat_map(|((m, v), p)| [writable(*m), writable(*v), writable(*p)])
            .collect()
    }
}

impl Env {
    pub fn basket_pdas(&self, id: u64) -> (Pubkey, Pubkey, Pubkey) {
        let (basket, _) =
            Pubkey::find_program_address(&[BASKET_SEED, &id.to_le_bytes()], &everything_etf::ID);
        let (mint, _) = Pubkey::find_program_address(
            &[BASKET_MINT_SEED, basket.as_ref()],
            &everything_etf::ID,
        );
        let fee_escrow = get_associated_token_address(&basket, &mint);
        (basket, mint, fee_escrow)
    }

    pub fn handle_for(&self, id: u64, assets: &[Pubkey]) -> BasketHandle {
        let (key, mint, fee_escrow) = self.basket_pdas(id);
        BasketHandle {
            key,
            id,
            mint,
            fee_escrow,
            assets: assets.to_vec(),
            vaults: assets
                .iter()
                .map(|a| get_associated_token_address(&key, a))
                .collect(),
        }
    }

    #[allow(clippy::too_many_arguments)]
    pub fn create_basket(
        &mut self,
        assets: &[Pubkey],
        manager_coin_account: Pubkey,
        mint_fee_bps: u16,
        redeem_fee_bps: u16,
        streaming_fee_bps: u16,
    ) -> Result<(BasketHandle, TransactionMetadata), FailedTransactionMetadata> {
        self.create_basket_named(
            assets,
            manager_coin_account,
            "Equal Weight Three",
            "EW3",
            "https://everything.etf/ew3.json",
            mint_fee_bps,
            redeem_fee_bps,
            streaming_fee_bps,
        )
    }

    /// `assets` may contain duplicates or be out of the [2, 10] range on
    /// purpose, to exercise `create_basket`'s own validation.
    #[allow(clippy::too_many_arguments)]
    pub fn create_basket_named(
        &mut self,
        assets: &[Pubkey],
        manager_coin_account: Pubkey,
        name: &str,
        symbol: &str,
        uri: &str,
        mint_fee_bps: u16,
        redeem_fee_bps: u16,
        streaming_fee_bps: u16,
    ) -> Result<(BasketHandle, TransactionMetadata), FailedTransactionMetadata> {
        let id = self.config_account().basket_count;
        // `handle_for` also computes each asset's vault ATA; with a duplicate
        // asset list that's harmless (just a repeated vault), and account
        // dedup isn't our job to enforce here, the program's is.
        let handle = self.handle_for(id, assets);
        let ix = etf_instruction(
            etf_accounts::CreateBasket {
                manager: pk(self.manager.pubkey()),
                config: self.config,
                treasury: pk(self.treasury.pubkey()),
                basket: handle.key,
                basket_mint: handle.mint,
                fee_escrow: handle.fee_escrow,
                coin_config: self.coin_config,
                coin_mint: self.coin_mint,
                manager_coin_account,
                dev_coin_account: self.dev_coin_account,
                metadata: metadata_pda(handle.mint),
                token_metadata_program: anchor_spl::metadata::ID,
                token_program: spl_token::ID,
                token_2022_program: anchor_spl::token_2022::ID,
                associated_token_program: anchor_spl::associated_token::ID,
                system_program: anchor_lang::system_program::ID,
                rent: anchor_lang::solana_program::sysvar::rent::ID,
            },
            etf_ix::CreateBasket {
                params: everything_etf::instructions::create_basket::CreateBasketParams {
                    name: name.to_string(),
                    symbol: symbol.to_string(),
                    uri: uri.to_string(),
                    mint_fee_bps,
                    redeem_fee_bps,
                    streaming_fee_bps,
                },
            },
            handle.create_remaining(),
        );
        let manager = self.manager.insecure_clone();
        let meta = self.send(&[ix], &[&manager])?;
        Ok((handle, meta))
    }

    pub fn seed_basket(
        &mut self,
        b: &BasketHandle,
        manager_basket_account: Pubkey,
        manager_asset_accounts: &[Pubkey],
        initial_supply: u64,
        amounts: Vec<u64>,
    ) -> Result<TransactionMetadata, FailedTransactionMetadata> {
        let ix = etf_instruction(
            etf_accounts::SeedBasket {
                manager: pk(self.manager.pubkey()),
                basket: b.key,
                basket_mint: b.mint,
                manager_basket_account,
                token_program: spl_token::ID,
                token_2022_program: anchor_spl::token_2022::ID,
            },
            etf_ix::SeedBasket {
                initial_supply,
                amounts,
            },
            b.legs_remaining(manager_asset_accounts),
        );
        let manager = self.manager.insecure_clone();
        self.send(&[ix], &[&manager])
    }

    pub fn mint_basket(
        &mut self,
        b: &BasketHandle,
        user: &Keypair,
        user_basket_account: Pubkey,
        user_asset_accounts: &[Pubkey],
        amount: u64,
        max_amounts_in: Vec<u64>,
    ) -> Result<TransactionMetadata, FailedTransactionMetadata> {
        let ix = etf_instruction(
            etf_accounts::MintBasket {
                user: pk(user.pubkey()),
                basket: b.key,
                basket_mint: b.mint,
                fee_escrow: b.fee_escrow,
                user_basket_account,
                token_program: spl_token::ID,
                token_2022_program: anchor_spl::token_2022::ID,
            },
            etf_ix::MintBasket {
                amount,
                max_amounts_in,
            },
            b.legs_remaining(user_asset_accounts),
        );
        let user = user.insecure_clone();
        self.send(&[ix], &[&user])
    }

    pub fn redeem_basket(
        &mut self,
        b: &BasketHandle,
        user: &Keypair,
        user_basket_account: Pubkey,
        user_asset_accounts: &[Pubkey],
        amount: u64,
        min_amounts_out: Vec<u64>,
    ) -> Result<TransactionMetadata, FailedTransactionMetadata> {
        let ix = etf_instruction(
            etf_accounts::RedeemBasket {
                user: pk(user.pubkey()),
                basket: b.key,
                basket_mint: b.mint,
                fee_escrow: b.fee_escrow,
                user_basket_account,
                token_program: spl_token::ID,
                token_2022_program: anchor_spl::token_2022::ID,
            },
            etf_ix::RedeemBasket {
                amount,
                min_amounts_out,
            },
            b.legs_remaining(user_asset_accounts),
        );
        let user = user.insecure_clone();
        self.send(&[ix], &[&user])
    }

    pub fn accrue_fees(
        &mut self,
        b: &BasketHandle,
    ) -> Result<TransactionMetadata, FailedTransactionMetadata> {
        let ix = etf_instruction(
            etf_accounts::AccrueFees {
                basket: b.key,
                basket_mint: b.mint,
                fee_escrow: b.fee_escrow,
                token_program: spl_token::ID,
            },
            etf_ix::AccrueFees {},
            vec![],
        );
        // Permissionless, so anybody can pay: use a bystander.
        let cranker = self.alice.insecure_clone();
        self.send(&[ix], &[&cranker])
    }

    pub fn claim_fees(
        &mut self,
        b: &BasketHandle,
        claimer: &Keypair,
        recipient: FeeRecipient,
        payout_basket_account: Pubkey,
        payout_asset_accounts: &[Pubkey],
    ) -> Result<TransactionMetadata, FailedTransactionMetadata> {
        let ix = etf_instruction(
            etf_accounts::ClaimFees {
                claimer: pk(claimer.pubkey()),
                config: self.config,
                basket: b.key,
                basket_mint: b.mint,
                fee_escrow: b.fee_escrow,
                payout_basket_account,
                token_program: spl_token::ID,
                token_2022_program: anchor_spl::token_2022::ID,
            },
            etf_ix::ClaimFees { recipient },
            b.legs_remaining(payout_asset_accounts),
        );
        let claimer = claimer.insecure_clone();
        self.send(&[ix], &[&claimer])
    }

    pub fn lower_fees(
        &mut self,
        b: &BasketHandle,
        mint_fee_bps: u16,
        redeem_fee_bps: u16,
        streaming_fee_bps: u16,
    ) -> Result<TransactionMetadata, FailedTransactionMetadata> {
        let ix = etf_instruction(
            etf_accounts::LowerFees {
                manager: pk(self.manager.pubkey()),
                basket: b.key,
                basket_mint: b.mint,
                fee_escrow: b.fee_escrow,
                token_program: spl_token::ID,
            },
            etf_ix::LowerFees {
                mint_fee_bps,
                redeem_fee_bps,
                streaming_fee_bps,
            },
            vec![],
        );
        let manager = self.manager.insecure_clone();
        self.send(&[ix], &[&manager])
    }

    /// Like `lower_fees`, but signed by (and attributed to) an arbitrary
    /// keypair instead of the real manager, to exercise the `has_one` guard.
    pub fn lower_fees_as(
        &mut self,
        b: &BasketHandle,
        signer: &Keypair,
        mint_fee_bps: u16,
        redeem_fee_bps: u16,
        streaming_fee_bps: u16,
    ) -> Result<TransactionMetadata, FailedTransactionMetadata> {
        let ix = etf_instruction(
            etf_accounts::LowerFees {
                manager: pk(signer.pubkey()),
                basket: b.key,
                basket_mint: b.mint,
                fee_escrow: b.fee_escrow,
                token_program: spl_token::ID,
            },
            etf_ix::LowerFees {
                mint_fee_bps,
                redeem_fee_bps,
                streaming_fee_bps,
            },
            vec![],
        );
        let signer = signer.insecure_clone();
        self.send(&[ix], &[&signer])
    }

    pub fn update_protocol_terms(
        &mut self,
        treasury: Pubkey,
        creation_fee_lamports: u64,
        protocol_share_bps: u16,
    ) -> Result<TransactionMetadata, FailedTransactionMetadata> {
        let ix = etf_instruction(
            etf_accounts::UpdateProtocolTerms {
                authority: pk(self.authority.pubkey()),
                config: self.config,
            },
            etf_ix::UpdateProtocolTerms {
                treasury,
                creation_fee_lamports,
                protocol_share_bps,
            },
            vec![],
        );
        let authority = self.authority.insecure_clone();
        self.send(&[ix], &[&authority])
    }

    /// Rotates the protocol authority. Both parties sign, as the program
    /// requires; `signing_authority` lets a test pose as the wrong current
    /// authority, and `new_authority_signs` lets it omit the incoming
    /// party's signature.
    pub fn update_authority(
        &mut self,
        signing_authority: &Keypair,
        new_authority: &Keypair,
        new_authority_signs: bool,
    ) -> Result<TransactionMetadata, FailedTransactionMetadata> {
        let ix = etf_instruction(
            etf_accounts::UpdateAuthority {
                authority: pk(signing_authority.pubkey()),
                new_authority: pk(new_authority.pubkey()),
                config: self.config,
            },
            etf_ix::UpdateAuthority {},
            vec![],
        );
        let current = signing_authority.insecure_clone();
        let incoming = new_authority.insecure_clone();
        if new_authority_signs {
            self.send(&[ix], &[&current, &incoming])
        } else {
            // Deliberately under-signed, so the runtime rejects it rather than
            // the client refusing to build it.
            self.send_partially_signed(&[ix], &[&current])
        }
    }

    pub fn update_coin_terms(
        &mut self,
        dev_treasury: Pubkey,
        creation_fee_coin: u64,
        creation_burn_bps: u16,
    ) -> Result<TransactionMetadata, FailedTransactionMetadata> {
        let ix = etf_instruction(
            etf_accounts::UpdateCoinTerms {
                authority: pk(self.authority.pubkey()),
                config: self.config,
                coin_config: self.coin_config,
            },
            etf_ix::UpdateCoinTerms {
                dev_treasury,
                creation_fee_coin,
                creation_burn_bps,
            },
            vec![],
        );
        let authority = self.authority.insecure_clone();
        self.send(&[ix], &[&authority])
    }

    pub fn crank_burn(
        &mut self,
        cranker: &Keypair,
    ) -> Result<TransactionMetadata, FailedTransactionMetadata> {
        let ix = etf_instruction(
            etf_accounts::CrankBurn {
                cranker: pk(cranker.pubkey()),
                coin_config: self.coin_config,
                coin_mint: self.coin_mint,
                burn_vault: self.burn_vault,
                token_program: spl_token::ID,
            },
            etf_ix::CrankBurn {},
            vec![],
        );
        let cranker = cranker.insecure_clone();
        self.send(&[ix], &[&cranker])
    }
}

/// Convenience: a three-asset world with the manager and Alice funded.
pub struct Assets {
    pub mints: Vec<Pubkey>,
    pub manager_accounts: Vec<Pubkey>,
    pub alice_accounts: Vec<Pubkey>,
}

impl Env {
    /// Three underlying assets with different decimals, as a real basket would
    /// have, each funded for the manager and Alice.
    pub fn with_three_assets(&mut self) -> Assets {
        self.with_n_assets(3)
    }

    /// `n` underlying assets (9 decimals each), funded for the manager and
    /// Alice. Used to probe the [MIN_ASSETS, MAX_ASSETS] boundary.
    pub fn with_n_assets(&mut self, n: usize) -> Assets {
        let mut mints = Vec::new();
        let mut manager_accounts = Vec::new();
        let mut alice_accounts = Vec::new();
        let manager = pk(self.manager.pubkey());
        let alice = pk(self.alice.pubkey());
        for _ in 0..n {
            let mint = self.create_mint(9);
            let unit = 1_000_000_000u64;
            let m_acc = self.create_token_account(mint, manager);
            let a_acc = self.create_token_account(mint, alice);
            self.mint_tokens(mint, m_acc, 1_000_000 * unit);
            self.mint_tokens(mint, a_acc, 1_000_000 * unit);
            mints.push(mint);
            manager_accounts.push(m_acc);
            alice_accounts.push(a_acc);
        }
        Assets {
            mints,
            manager_accounts,
            alice_accounts,
        }
    }
}

/// Extracts the anchor error code from a failed transaction, if there is one.
pub fn anchor_error_code(err: &FailedTransactionMetadata) -> Option<u32> {
    use solana_instruction_error::InstructionError;
    use solana_transaction_error::TransactionError;
    match &err.err {
        TransactionError::InstructionError(_, ie) => match ie {
            InstructionError::Custom(code) => Some(*code),
            _ => None,
        },
        _ => None,
    }
}

/// Asserts the transaction failed with a specific `EtfError`.
pub fn assert_etf_error<T>(
    res: Result<T, FailedTransactionMetadata>,
    expected: everything_etf::errors::EtfError,
) {
    let err = match res {
        Ok(_) => panic!("expected the transaction to fail"),
        Err(e) => e,
    };
    let code = anchor_error_code(&err)
        .unwrap_or_else(|| panic!("expected a custom program error, got {:?}", err.err));
    let want = expected as u32 + anchor_lang::error::ERROR_CODE_OFFSET;
    assert_eq!(
        code, want,
        "expected {:?} ({}), got code {}. logs:\n{}",
        expected,
        want,
        code,
        err.meta.logs.join("\n")
    );
}
