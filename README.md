# Liquid Reserve

Source code behind [liquidreserve.xyz](https://liquidreserve.xyz): the smart contracts on Elysium
(chain 99901) and HyperEVM (chain 999), their tests, the bot that runs the routine steps, and the
website.

This repository exists so that anyone can check that the contracts on the two chains were built
from the code here. The section [Check it yourself](#check-it-yourself) says how.

> **Unaudited.** No independent security review has been done on any contract in this repository.
> They are live and hold real funds. Do not put in more than you can afford to lose. Nothing here
> is a promise of any return, and nothing here is investment advice.

## What it is

- **$liquid** (token name "Liquid Reserve") is a coin launched on the Ascend launchpad on Elysium on
  2026-11-15. The coin's contract, its trading pool and its fee split belong to Ascend. They are not
  part of this repository.
- **The reserve.** A share of the coin's trading fees, and a share of the fees the vaults below
  collect, is converted into kHYPE (Kinetiq's staked HYPE) and deposited in
  [`LockedReserve`](src/LockedReserve.sol). That contract has no owner and no withdraw function.
  It records what was deposited. Only value above that record can leave, and only to one address
  fixed when the contract was created.
- **The drop.** About a tenth of each fee buys $liquid. It is sent to one wallet, the bot's, until
  that wallet holds 5% of the supply that has not been burned. After that the $liquid bought is sent
  to Ascend's burn address. The drop sits in an ordinary wallet. It is not locked in a contract.
- **Liquidity vaults.** Each vault holds liquidity in one Uniswap v4 pool, collects the trading fees
  and adds them back to the position. Depositors keep 80% of the fees. The other 20% is split between
  the creator and the reserve. Deposits can be paused by the owner. Withdrawals cannot.
- **Staking vaults.** liquidHYPE is a vault over kHYPE on Elysium. liquidKNTQ is a vault over sKNTQ
  (Kinetiq's staked KNTQ) on HyperEVM, with a queue on Elysium that carries deposits across the
  bridge in batches. Each takes 20% of the yield its holdings earn as a fee. When this was written
  (November 2026) sKNTQ's rate was not rising, so liquidKNTQ was earning nothing.
- **Reward pools.** Holders of liquidHYPE or liquidKNTQ can deposit it in a pool that hands out
  $liquid bought with part of the reserve's yield.

### How a fee moves

1. Fees arrive at the fee inbox: the coin's fee share from Ascend, and the fee share of the vaults
   and of liquidHYPE.
2. [`FeeSplitter`](src/FeeSplitter.sol) passes them to [`InflowAllocator`](src/InflowAllocator.sol).
3. The allocator's split is fixed in its code: 40% to kHYPE, 40% to KNTQ, 20% to USDC. It buys through
   whichever swapper [`SwapConfig`](src/SwapConfig.sol) names, at no worse than the price the oracle
   named there gives, less a slippage limit.
4. Since 2026-11-25 `SwapConfig` names [`HypeOnlyRouter`](src/adapters/HypeOnlyRouter.sol) as both.
   It turns the KNTQ part into kHYPE and deposits it in the reserve, and hands every other request to
   the real swapper and oracle. One exception: a fee that arrives as KNTQ still sends its own 40% to
   HyperEVM, where it is staked as sKNTQ and locked in the second reserve there.
5. The USDC part waits in a holding contract. [`DropFeeder`](src/DropFeeder.sol) spends half of it on
   kHYPE for the reserve and half on $liquid for the drop, or for the burn address once the drop is
   full.
6. What the reserve earns above its deposits is collected by `harvest`. A fifth goes to the creator.
   [`YieldDirector`](src/YieldDirector.sol) divides the rest by shares between: back into the reserve,
   the drop, and the two reward pools.

Almost every step is a function anyone may call. The bot only calls them on a schedule.

## Who can change what

Read from the chain on 2026-11-25. Check the current state yourself: these can change.

| Who | Address | What it can do |
|---|---|---|
| Owner wallet | `0x822aA88543b9da39c4c3D856857379E17526C1E8` | On each vault: set the range widths, name the keeper, set the deposit cap, pause deposits, all within limits fixed in the code. On the staking vaults: pause deposits, set the cap. On the KNTQ queue: pause deposits, name the keeper. On the yield director: change the shares between the listed destinations, at once. On the timelock: it is the only address that may propose and carry out operations. |
| Timelock, 48 hours | `0xa9e0FEAf8032c669803F68af7e93370D86e03c7F` | Owns `SwapConfig` (which swapper and oracle the fee path uses; the slippage limit, at most 3%), the swapper's routes, the oracle's feeds, routes and keeper list, `DropFeeder` (which wallet is the drop; a successor) and the yield director's list of destinations and its manager. Every change waits 48 hours on-chain before it can be carried out. |
| Bot wallet | `0x0461663d46DA68264966a0670335E3ecf0b96F3C` | Keeper of the vaults: it may re-centre a vault's ranges (the vault refuses if the price has moved from the one the bot states, and enforces a 15-minute gap). Keeper of the oracle: it may take a price reading while a feed is fresh. Keeper of the KNTQ queue. It also holds the drop's $liquid. |
| Creator wallet | `0x9324605c9C707b2F805CCF2AC099fCA5d561DC37` | Receives the creator's share. No powers. |
| Nobody | | `LockedReserve`, `FeeSplitter`, `InflowAllocator`, `HypeOnlyRouter`, `RewardPool`, both zaps and the price helper have no owner. |

Neither the owner, the timelock nor the bot can take deposits out of a vault, pause withdrawals, or
withdraw what the reserve holds.

## Known weak points

- **No audit.** See the top of this page.
- **One key.** The owner wallet is an ordinary wallet controlled by a single key, not a
  multi-signature wallet, and it alone drives the timelock. The 48-hour delay is the only brake on
  what the timelock can change.
- **The bot's wallet is a hot wallet.** Its key is stored with the hosting service that runs the bot.
  Whoever holds that key controls the drop's $liquid and the keeper roles above.
- **Small pools.** The fee path prices its purchases against 30-minute averages of Uniswap v4 pools
  on Elysium. Those pools are small, so their prices are cheap to move. For wANTx and wNVDAx the only
  price source is the vault's own pool. What is exposed is the fee passing through at that moment,
  not what the reserve already holds.
- **kHYPE's value is read from a pool.** Bridged kHYPE has no exchange rate on Elysium, so the reserve
  and the liquidHYPE vault measure yield from the averaged price of the kHYPE/HYPE pool. The code caps
  how fast that measure may grow in a year (25% for the reserve, 5% for the liquidHYPE fee).
- **A recent contract sits in the path of every fee.** `HypeOnlyRouter` has been in that path only
  since 2026-11-25.
- **Vaults that are alone in their pool** (wANTx-USDC, wNVDAx-USDC) end up holding one token after a
  price move, and while such a pool is empty anyone can set its price through
  [`EmptyPoolPrice`](src/vaults/EmptyPoolPrice.sol).
- **Tokenised stocks are other people's tokens.** wANTx and wNVDAx are wrapped xStocks issued by a
  third party. Liquid Reserve is not connected to the issuer or to the companies named, and the issuer
  restricts where its tokens are offered. Read the issuer's terms.
- **The bridge.** Moving tokens from Elysium to HyperEVM takes a day or more.
- **The website and the bot run on hosting services.** This repository cannot prove which code they
  run at a given moment. The contracts are what hold funds, and those can be checked.

## Deployed contracts

All 53 were exact matches on [Sourcify](https://sourcify.dev) on 2026-11-25. Each address below links
to its Sourcify page. The same list, for programs, is
[`deployments/addresses.json`](deployments/addresses.json).

### Reserve and fee path, Elysium (99901)

| What | Address | Contract | Status |
|---|---|---|---|
| Locked reserve (kHYPE) | [`0xeAd849357Ba8Dbc5A6F205AA0036Bd3d677b0D61`](https://repo.sourcify.dev/99901/0xeAd849357Ba8Dbc5A6F205AA0036Bd3d677b0D61) | [`LockedReserve`](src/LockedReserve.sol) | In use |
| Fee inbox (vault fees and the coin's fee share arrive here) | [`0x2AfD3850794b84205667CE2826b09FA5bf1c3a5c`](https://repo.sourcify.dev/99901/0x2AfD3850794b84205667CE2826b09FA5bf1c3a5c) | [`FeeInbox`](src/FeeInbox.sol) | In use |
| Fee splitter | [`0x635321eE277e3aa3DDd62a2A63681dcB4fFC7E4e`](https://repo.sourcify.dev/99901/0x635321eE277e3aa3DDd62a2A63681dcB4fFC7E4e) | [`FeeSplitter`](src/FeeSplitter.sol) | In use |
| Inflow allocator | [`0xB7c3865FfF8e88276a1D57D31869A2b0a839356f`](https://repo.sourcify.dev/99901/0xB7c3865FfF8e88276a1D57D31869A2b0a839356f) | [`InflowAllocator`](src/InflowAllocator.sol) | In use |
| HYPE-only router | [`0x4A90a0F30fC1a1862D54327FdC15cf348aa978E1`](https://repo.sourcify.dev/99901/0x4A90a0F30fC1a1862D54327FdC15cf348aa978E1) | [`HypeOnlyRouter`](src/adapters/HypeOnlyRouter.sol) | In use |
| Drop feeder | [`0x2089dC3D846e5c0C06Cc6E9B35Abf22AB925600f`](https://repo.sourcify.dev/99901/0x2089dC3D846e5c0C06Cc6E9B35Abf22AB925600f) | [`DropFeeder`](src/DropFeeder.sol) | In use |
| Swap settings | [`0xe885e7D7Fda7e481Fe7466C4adB93b0C3045FF87`](https://repo.sourcify.dev/99901/0xe885e7D7Fda7e481Fe7466C4adB93b0C3045FF87) | [`SwapConfig`](src/SwapConfig.sol) | In use |
| Swapper | [`0xC728E5B5eF36dbbEE5920c8956EB1c145B8badE4`](https://repo.sourcify.dev/99901/0xC728E5B5eF36dbbEE5920c8956EB1c145B8badE4) | [`UniswapV4Swapper`](src/adapters/UniswapV4Swapper.sol) | In use |
| Price oracle (30-minute averages) | [`0x51670e163023CC3fa63d857A655A430321Fc1f56`](https://repo.sourcify.dev/99901/0x51670e163023CC3fa63d857A655A430321Fc1f56) | [`V4TwapOracle`](src/adapters/V4TwapOracle.sol) | In use |
| kHYPE rate for the reserve | [`0xcd08e24b11f4bD4e2F609964692A7E78BC09e708`](https://repo.sourcify.dev/99901/0xcd08e24b11f4bD4e2F609964692A7E78BC09e708) | [`TwapRateProvider`](src/adapters/TwapRateProvider.sol) | In use |
| Timelock (48 hours) | [`0xa9e0FEAf8032c669803F68af7e93370D86e03c7F`](https://repo.sourcify.dev/99901/0xa9e0FEAf8032c669803F68af7e93370D86e03c7F) | [`TimelockController`](lib/openzeppelin-contracts/contracts/governance/TimelockController.sol) | In use |
| Holding contract: creatorWait | [`0x0a3293Ee6D333A6Da9e0e09A9129b490193Bb1B4`](https://repo.sourcify.dev/99901/0x0a3293Ee6D333A6Da9e0e09A9129b490193Bb1B4) | [`FeeInbox`](src/FeeInbox.sol) | In use |
| Holding contract: liquidWait | [`0x358B0d6eA642689C1C0f5424d36adB8B09DBcecB`](https://repo.sourcify.dev/99901/0x358B0d6eA642689C1C0f5424d36adB8B09DBcecB) | [`FeeInbox`](src/FeeInbox.sol) | In use |
| Holding contract: yieldWait | [`0xb99d0AFf4f65AC80c268a3050f72a107329909eE`](https://repo.sourcify.dev/99901/0xb99d0AFf4f65AC80c268a3050f72a107329909eE) | [`FeeInbox`](src/FeeInbox.sol) | In use |
| Yield splitter (YieldSplit) | [`0x5b1429a97818E68aF558CcD84cbDab5756520675`](https://repo.sourcify.dev/99901/0x5b1429a97818E68aF558CcD84cbDab5756520675) | [`FeeSplitter`](src/FeeSplitter.sol) | In use |
| Holding contract: YieldRest | [`0x14938d73fdCF459c07fB749dbA21DE76e4519938`](https://repo.sourcify.dev/99901/0x14938d73fdCF459c07fB749dbA21DE76e4519938) | [`FeeInbox`](src/FeeInbox.sol) | In use |
| Yield director | [`0x4dBDb5E2cC1D666cBc159e317f458F34cAEEF928`](https://repo.sourcify.dev/99901/0x4dBDb5E2cC1D666cBc159e317f458F34cAEEF928) | [`YieldDirector`](src/YieldDirector.sol) | In use |
| Vault fee splitter (VaultFeeSplit) | [`0xB92c756347de468d7086a97EF112801b3371a408`](https://repo.sourcify.dev/99901/0xB92c756347de468d7086a97EF112801b3371a408) | [`FeeSplitter`](src/FeeSplitter.sol) | In use |
| Bridge out (KNTQ to HyperEVM) | [`0x0423ba7C14b3B0c986b1B6858598439A251Cc7d4`](https://repo.sourcify.dev/99901/0x0423ba7C14b3B0c986b1B6858598439A251Cc7d4) | [`BridgeOut`](src/bridge/BridgeOut.sol) | In use |
| Launch contract A | [`0xf6030669549B2C1403E184F93abEDf50A50Ab6f9`](https://repo.sourcify.dev/99901/0xf6030669549B2C1403E184F93abEDf50A50Ab6f9) | [`ReserveLaunchA`](src/launch/ReserveLaunch.sol) | Launch only |
| Launch contract B | [`0x1cE0523510933B1c4389d25c83802ad999B95C4E`](https://repo.sourcify.dev/99901/0x1cE0523510933B1c4389d25c83802ad999B95C4E) | [`ReserveLaunchB`](src/launch/ReserveLaunch.sol) | Launch only |

### Vaults, Elysium (99901)

| What | Address | Contract | Status |
|---|---|---|---|
| HYPE-USDC vault | [`0x05D6A15d864A633DF9efC082aCFf7a2AB1e44911`](https://repo.sourcify.dev/99901/0x05D6A15d864A633DF9efC082aCFf7a2AB1e44911) | [`LiquidityVaultV2`](src/vaults/LiquidityVaultV2.sol) | In use |
| HYPE-KNTQ vault | [`0xB7A3cFE218363E158A748aDfcb1A5a5FeD41c686`](https://repo.sourcify.dev/99901/0xB7A3cFE218363E158A748aDfcb1A5a5FeD41c686) | [`LiquidityVaultV2`](src/vaults/LiquidityVaultV2.sol) | In use |
| HYPE-$liquid vault (2% pool) | [`0xF49AAD222D3b9937371701e411c97018285E6691`](https://repo.sourcify.dev/99901/0xF49AAD222D3b9937371701e411c97018285E6691) | [`LiquidityVaultV3`](src/vaults/LiquidityVaultV3.sol) | In use |
| wANTx-USDC vault ("ANTx-USDC" on the site) | [`0xD14C956837b124483707170fa2775160B66FDA2E`](https://repo.sourcify.dev/99901/0xD14C956837b124483707170fa2775160B66FDA2E) | [`LiquidityVaultV2`](src/vaults/LiquidityVaultV2.sol) | In use |
| wNVDAx-USDC vault ("NVDAx-USDC" on the site) | [`0x19c4acb31d505650Fb0D4A96D77fc11C0d38aEd1`](https://repo.sourcify.dev/99901/0x19c4acb31d505650Fb0D4A96D77fc11C0d38aEd1) | [`LiquidityVaultV2`](src/vaults/LiquidityVaultV2.sol) | In use |
| One-token deposits (first zap) | [`0x4161ec401b91653495CfE888714C51fE01988678`](https://repo.sourcify.dev/99901/0x4161ec401b91653495CfE888714C51fE01988678) | [`VaultZap`](src/vaults/VaultZap.sol) | In use |
| One-token deposits (second zap) | [`0x5F000684c94D02ba23Cd965eaAAF2D92fA40E352`](https://repo.sourcify.dev/99901/0x5F000684c94D02ba23Cd965eaAAF2D92fA40E352) | [`VaultZapV2`](src/vaults/VaultZapV2.sol) | In use |
| Price helper for an empty pool | [`0x26D7857d548EBADE54212BB5482f5770ae9d2548`](https://repo.sourcify.dev/99901/0x26D7857d548EBADE54212BB5482f5770ae9d2548) | [`EmptyPoolPrice`](src/vaults/EmptyPoolPrice.sol) | In use |
| HYPE-$liquid vault (0.5% pool) | [`0x820cD36941BFd2F0FD4A30b3293f22ea687092A1`](https://repo.sourcify.dev/99901/0x820cD36941BFd2F0FD4A30b3293f22ea687092A1) | [`LiquidityVaultV3`](src/vaults/LiquidityVaultV3.sol) | Retired |
| HYPE-USDC vault, first version | [`0xdaaac4cc69E28CD1a4A1A8F97db464375E52E298`](https://repo.sourcify.dev/99901/0xdaaac4cc69E28CD1a4A1A8F97db464375E52E298) | [`LiquidityVault`](src/vaults/LiquidityVault.sol) | Retired |
| HYPE-KNTQ vault, first version | [`0xE78475C23691e7Fa65131C176C0D3bD5a146aDCf`](https://repo.sourcify.dev/99901/0xE78475C23691e7Fa65131C176C0D3bD5a146aDCf) | [`LiquidityVault`](src/vaults/LiquidityVault.sol) | Retired |
| HYPE-$liquid vault (2% pool), first version | [`0xB424e3dBf7483913D9824e86d70990D11CC07ce3`](https://repo.sourcify.dev/99901/0xB424e3dBf7483913D9824e86d70990D11CC07ce3) | [`LiquidityVault`](src/vaults/LiquidityVault.sol) | Retired |
| HYPE-$liquid vault (0.5% pool), first version | [`0x9BDCa4A12cdbc1D74B01F1b870d12166C8A0c9e2`](https://repo.sourcify.dev/99901/0x9BDCa4A12cdbc1D74B01F1b870d12166C8A0c9e2) | [`LiquidityVault`](src/vaults/LiquidityVault.sol) | Retired |
| Launch contract of the first 0.5% vault (also its `realign`) | [`0xE699e8bea731851CdC7c012611512022B2313012`](https://repo.sourcify.dev/99901/0xE699e8bea731851CdC7c012611512022B2313012) | [`LiquidVaultLaunch2`](src/launch/LiquidVaultLaunch2.sol) | Retired |
| Launcher of the first two vaults | [`0x970F124364aDeDbcA02AF70Ff7CC5171d34B58Ea`](https://repo.sourcify.dev/99901/0x970F124364aDeDbcA02AF70Ff7CC5171d34B58Ea) | [`VaultLauncher`](src/vaults/VaultLauncher.sol) | Launch only |
| Launch contract of the first HYPE-$liquid vault | [`0xDe414f53f762cDAc89276dBD1151f810DA9C79C2`](https://repo.sourcify.dev/99901/0xDe414f53f762cDAc89276dBD1151f810DA9C79C2) | [`LiquidVaultLaunch`](src/launch/LiquidVaultLaunch.sol) | Launch only |

### Staking, Elysium (99901)

| What | Address | Contract | Status |
|---|---|---|---|
| HYPE staking vault (liquidHYPE) | [`0x5B550c1DAd656B688Da2422baBb11470f5f419B0`](https://repo.sourcify.dev/99901/0x5B550c1DAd656B688Da2422baBb11470f5f419B0) | [`HypeStakingVault`](src/staking/HypeStakingVault.sol) | In use |
| Reward pool for liquidHYPE | [`0x334dC48dC636dD4f84D94c1d01F37490DCcC6A59`](https://repo.sourcify.dev/99901/0x334dC48dC636dD4f84D94c1d01F37490DCcC6A59) | [`RewardPool`](src/staking/RewardPool.sol) | In use |
| Reward pool for liquidKNTQ | [`0xf37fa9E2826b394E8484854523aBc5102f150A44`](https://repo.sourcify.dev/99901/0xf37fa9E2826b394E8484854523aBc5102f150A44) | [`RewardPool`](src/staking/RewardPool.sol) | In use |
| KNTQ staking queue | [`0x14e2EdfBc51c94dba6b858c6B3dF5b2227A5E74C`](https://repo.sourcify.dev/99901/0x14e2EdfBc51c94dba6b858c6B3dF5b2227A5E74C) | [`KntqStakeQueue`](src/staking/KntqStakeQueue.sol) | In use |
| Per-batch box used by the queue | [`0xdD42ca8F3550153bCCC22855D9DE47724FcC9443`](https://repo.sourcify.dev/99901/0xdD42ca8F3550153bCCC22855D9DE47724FcC9443) | [`StakeBox`](src/staking/KntqStakeQueue.sol) | In use |

### HyperEVM (999)

| What | Address | Contract | Status |
|---|---|---|---|
| Locked reserve (sKNTQ) | [`0x394f6103B88D4DEB3A9686991C0dE24F968094A6`](https://repo.sourcify.dev/999/0x394f6103B88D4DEB3A9686991C0dE24F968094A6) | [`LockedReserve`](src/LockedReserve.sol) | In use |
| Stake and lock | [`0x06C9A2581BD8EA1ace6ada407F4289c932C7e060`](https://repo.sourcify.dev/999/0x06C9A2581BD8EA1ace6ada407F4289c932C7e060) | [`StakeAndLock`](src/hyperevm/StakeAndLock.sol) | In use |
| Yield unstake bridge | [`0x38Cc13C526834b73290AD1ae59335D628DF3ac47`](https://repo.sourcify.dev/999/0x38Cc13C526834b73290AD1ae59335D628DF3ac47) | [`YieldUnstakeBridge`](src/hyperevm/YieldUnstakeBridge.sol) | In use |
| sKNTQ rate for the reserve | [`0xe342EEdE2b7b79024A122bE515D38ec8B346FF27`](https://repo.sourcify.dev/999/0xe342EEdE2b7b79024A122bE515D38ec8B346FF27) | [`ERC4626RateProvider`](src/adapters/ERC4626RateProvider.sol) | In use |
| KNTQ staking vault (liquidKNTQ) | [`0x3DE32a31484240d01f8d114bcCC570d90bc95AAb`](https://repo.sourcify.dev/999/0x3DE32a31484240d01f8d114bcCC570d90bc95AAb) | [`KntqVault`](src/staking/KntqVault.sol) | In use |
| sKNTQ lock (staking fees into the reserve) | [`0x9cce7DD4402688849A68A03D4A64c704e92301c7`](https://repo.sourcify.dev/999/0x9cce7DD4402688849A68A03D4A64c704e92301c7) | [`SkntqLock`](src/staking/KntqStakingVault.sol) | In use |
| KNTQ staking fee splitter | [`0x2c86d01601D2295E66AdE98749963f0a8a311CfF`](https://repo.sourcify.dev/999/0x2c86d01601D2295E66AdE98749963f0a8a311CfF) | [`FeeSplitter`](src/FeeSplitter.sol) | In use |
| Per-batch agent factory | [`0x7c21642E662d7aC55685BA56480fE8eb681ebd63`](https://repo.sourcify.dev/999/0x7c21642E662d7aC55685BA56480fE8eb681ebd63) | [`KntqAgentFactory`](src/staking/KntqStakeBridge.sol) | In use |
| Per-batch agent used by the factory | [`0x3bc9BDe628601aaF960b0B55aB2B3Ca6B2422cE7`](https://repo.sourcify.dev/999/0x3bc9BDe628601aaF960b0B55aB2B3Ca6B2422cE7) | [`KntqStakeAgent`](src/staking/KntqStakeBridge.sol) | In use |
| Launch contract H1 | [`0x3fC483DdC75898F646aDe604a5b68598DA91F46c`](https://repo.sourcify.dev/999/0x3fC483DdC75898F646aDe604a5b68598DA91F46c) | [`ReserveLaunchH1`](src/launch/ReserveLaunch.sol) | Launch only |
| Launch contract H2 | [`0x1906B8643CecD4f1508DCeC8F784400a4794A8a5`](https://repo.sourcify.dev/999/0x1906B8643CecD4f1508DCeC8F784400a4794A8a5) | [`ReserveLaunchH2`](src/launch/ReserveLaunch.sol) | Launch only |

"Retired" means the site no longer lists it for new deposits. Its code still runs, and anyone who
still has a deposit there can withdraw. "Launch only" contracts created and wired up other contracts
in one transaction and do nothing afterwards.

Not deployed, although the source is here: `CreatorPayout`, `YieldRouter`, `LiquidReserveStaking`,
`KinetiqRateProvider`, and the `KntqStakingVault` contract inside
[`src/staking/KntqStakingVault.sol`](src/staking/KntqStakingVault.sol) (an earlier version of the KNTQ
vault). They belong to the first design and are still used by tests.

## Check it yourself

**One contract, in a browser.** Open its address link above. Sourcify shows the source files it
holds for that address and whether they compile to exactly the code on the chain ("exact match").

**All of them against this repository.** This compares every source file Sourcify holds for every
address with the file of the same path here, byte for byte (1,534 files). It only reads.

```bash
python3 script/check-sourcify.py
```

**Without relying on Sourcify.** Build the code here and compare it with the code on the chain:

```bash
forge inspect src/LockedReserve.sol:LockedReserve deployedBytecode
cast code 0xeAd849357Ba8Dbc5A6F205AA0036Bd3d677b0D61 --rpc-url https://rpc.elysium.kinetiq.xyz
```

The two are the same length and differ only where values fixed at creation (token addresses and the
like) are written into the code. Those places are listed under `immutableReferences` in
`out/LockedReserve.sol/LockedReserve.json` after a build.

**The exact compiler input.** `deployments/<chain>/<Contract>.standard-input.json` is the input the
deployed code was compiled from (solc 0.8.26, optimizer 200 runs, EVM version cancun). Feed it to
`solc --standard-json` to rebuild without Foundry. Seven contracts of the KNTQ staking system have no
copy here (`KntqStakeQueue`, `StakeBox`, `KntqVault`, `SkntqLock`, `KntqAgentFactory`,
`KntqStakeAgent`, and the HyperEVM `FeeSplitter`, which uses the same source as Elysium's). Sourcify
holds theirs. `KntqVault` is built with `FOUNDRY_PROFILE=kntqvault` (optimizer 1 run).

The source files of deployed contracts are frozen. A changed contract would be a new deployment at a
new address.

The other `*-data.json` files in [`deployments/`](deployments/) record the exact transactions that
were sent at each launch and each timelock step.

## Build and test

Needs [Foundry](https://getfoundry.sh) (built and tested with forge 1.9.0). The libraries under
`lib/` are git submodules pinned to fixed versions: forge-std v1.9.4, OpenZeppelin Contracts v5.1.0,
Uniswap v4-core v4.0.0.

```bash
git clone --recurse-submodules https://github.com/packrvnner/liquid-reserve
cd liquid-reserve
forge build
forge test
```

`forge test` runs 213 tests on your own machine and skips the rest.

The skipped ones run against copies of the live chains, read through the public endpoints in
[`foundry.toml`](foundry.toml). They are slow, because those endpoints limit how fast they answer.

```bash
ELYSIUM_FORK=true HYPEREVM_FORK=true forge test --match-path "test/fork/*"
```

When these were run on 2026-11-25, all 116 passed: none failed and none was skipped.

Many of these suites were written to rehearse a launch or an owner step before it was sent. Once
that step has happened on the real chain, today's chain no longer has the rehearsal's starting
point. So those rehearsals read the chain as it stood one block before the real step. The block
number and the date of the step are written in the test file:

- `PreLaunchElysiumTest`, `DropFeederForkTest`, `YieldDirectorForkTest`, `AntxVaultForkTest` and
  `NvdaVaultForkTest`, as whole suites.
- Two tests of `LiquidVault2ForkTest`, and one test each in `HypeOnlyRouterForkTest` and
  `AscendRehearsalHypePairTest`.

This needs Elysium's public endpoint to keep answering for old blocks, which it did on that day.

Every other test reads the chains as they are when you run it, so its result moves with prices and
with how much sits in the pools. A failure there deserves a look before it is taken as a fault in a
contract.

## The bot

The routine steps (collecting fees, moving them along the path above, re-centring vault ranges,
taking price readings, carrying KNTQ staking batches across the bridge) are sent by a bot.

- The code that runs is in [`keeper/hosted/`](keeper/hosted/). It runs as scheduled functions on a
  hosting service, every few minutes. [`keeper/src/`](keeper/src/) is an earlier version made to run
  on one's own machine. It is not what runs today.
- **The bot's key is not in this repository.** It is stored as a secret with the hosting service and
  read by the code as `KEEPER_PRIVATE_KEY`. The keys that do appear in test files are the publicly
  known test keys that ship with Foundry's local test chain. They control nothing real.
- What the bot's wallet may do is listed under [Who can change what](#who-can-change-what).
- If the bot stops, nothing is lost. Fees wait where they are until it, or anyone else, calls the
  next step. Vault ranges stay where they were.

## The website

[`site/`](site/) is the source of liquidreserve.xyz: plain HTML, CSS and JavaScript with no build
step. [`site/deployment.json`](site/deployment.json) holds the addresses it reads. The key in
[`site/js/vaultchart.js`](site/js/vaultchart.js) is the public key of the hosted service behind the
charts. Every visitor's browser receives it. It is not a wallet key.

## What this repository does not cover

- Other people's contracts that this system depends on: Ascend's (the $liquid coin, its pool, its fee
  split, its burn address), Kinetiq's (kHYPE, sKNTQ, KNTQ), Uniswap v4's pool manager, the bridge
  between Elysium and HyperEVM, the xStocks tokens, and Hyperliquid's market data.
- The live state. Balances, caps, shares and who the keeper is are read from the chain, not from here.
- The future. What the owner and the timelock are able to change is listed above.
- Any kind of audit or guarantee.

## What is in each folder

| Folder | What |
|---|---|
| [`src/`](src/) | The contracts |
| [`test/`](test/) | Tests: unit, fuzz and invariant tests, and suites that run against copies of the live chains |
| [`script/`](script/) | Scripts that built each launch transaction and rehearsed it on a copy of the chain, and `check-sourcify.py` |
| [`deployments/`](deployments/) | Addresses, frozen compiler inputs, and the transactions that were sent |
| [`keeper/`](keeper/) | The bot |
| [`site/`](site/) | The website |
| `lib/` | Third-party libraries, as git submodules |

## License

The code in this repository is under the MIT license: see [`LICENSE`](LICENSE). It comes with no
warranty of any kind.

Not covered by it: the libraries under `lib/`, which keep their own licenses; the fonts in
`site/fonts/`, which are under the SIL Open Font License ([`OFL.txt`](site/fonts/OFL.txt)); and the
logos in `site/logos/` and the token images in `site/tokens/` other than `liquid.svg`, which belong
to their owners.

## Reporting a problem

If you find a fault in a contract, please report it privately before publishing it: send a direct
message to [@xliquidreserve](https://x.com/xliquidreserve) on X.
