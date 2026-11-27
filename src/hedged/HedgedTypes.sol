// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice A Uniswap-v3-style pool, as far as the hedged vault uses it.
interface IV3Pool {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function fee() external view returns (uint24);
    function tickSpacing() external view returns (int24);
    function liquidity() external view returns (uint128);
    function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool);
    function mint(address recipient, int24 tickLower, int24 tickUpper, uint128 amount, bytes calldata data)
        external
        returns (uint256 amount0, uint256 amount1);
    function burn(int24 tickLower, int24 tickUpper, uint128 amount) external returns (uint256 amount0, uint256 amount1);
    function collect(address recipient, int24 tickLower, int24 tickUpper, uint128 amount0Requested, uint128 amount1Requested)
        external
        returns (uint128 amount0, uint128 amount1);
    function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160 sqrtPriceLimitX96, bytes calldata data)
        external
        returns (int256 amount0, int256 amount1);
}

/// @notice Fixed at construction.
struct Config {
    address pool; // token0 = the hedged asset (WHYPE), token1 = USDC
    int24 tickSpacing;
    uint24 poolFee; // hundredths of a basis point
    uint32 perp; // HyperCore index of the perp that hedges token0
    uint8 szDecimals; // HyperCore size decimals of that perp
    uint16 entryBps; // kept back from a deposit, for the vault (see FlowLib)
    uint16 exitBps; // kept back from a withdrawal, for the vault
    address asset; // token0
    address usdc; // token1
    address coreDeposit; // Circle's CoreDepositWallet
    address feeRecipient;
}

/// @notice Everything the vault remembers. One instance, at a fixed place in the vault's storage;
/// the libraries work on it by reference.
struct Vault {
    Config c;
    // settings: owner only, within fixed bounds
    address keeper;
    uint16 bandBps; // resize the short when it is off by this share of the position's value
    uint16 marginBps; // margin to keep, as a share of the short
    int24 width; // half-width of the range, in tick spacings
    bool depositsPaused;
    bool closing; // wind-down started; cannot be undone
    uint256 depositCap; // USDC, 0 = none
    // the position
    int24 lower;
    int24 upper;
    uint128 liquidity;
    // money promised to people who withdrew and are waiting for it to arrive from HyperCore
    uint256 owedTotal;
    mapping(address => uint256) owed;
    // bookkeeping for things HyperCore has not carried out yet
    uint64 lastOrderBlock;
    uint64 sentBlock; // USDC sent to HyperCore in this block is not visible there yet ...
    uint128 sentAmount; // ... so it is counted here until the block is over
    uint64 pullBlock; // USDC asked back from HyperCore in this block
    uint128 pullAmount;
    uint64 lastRebalance;
    uint256 totalFees0;
    uint256 totalFees1;
}

/// @notice What the site and the bot read in one call. USDC amounts have 6 decimals.
struct State {
    uint256 totalValue;
    uint256 totalSupply;
    uint256 oraclePx; // raw price
    uint160 poolSqrtPriceX96;
    int24 poolTick;
    int24 lower;
    int24 upper;
    uint256 positionAsset; // token0 in the position
    uint256 positionUsdc; // token1 in the position
    uint256 idleAsset;
    uint256 idleUsdc;
    int256 perpValue; // the perp account's value
    uint256 spotUsdc; // USDC on the HyperCore spot side
    int256 shortSz; // size units, negative is short
    uint256 targetSz; // size units the short should have
    uint256 marginBpsNow; // perp value as a share of the short (0 when there is no short)
    uint256 owedTotal;
    bool priceInLine; // pool price within the allowed gap of the oracle price
}

interface IHedgedVaultEvents {
    event Deposit(address indexed sender, address indexed receiver, uint256 usdc, uint256 shares);
    event Withdraw(address indexed owner, address indexed receiver, uint256 shares, uint256 usdcPaid, uint256 assetPaid, uint256 usdcOwed);
    event Claimed(address indexed receiver, uint256 usdc);
    event FeesCollected(uint256 fee0, uint256 fee1, uint256 performanceFee0, uint256 performanceFee1);
    event Filled(int24 tick, int24 lower, int24 upper, uint128 liquidityAdded);
    event Removed(uint128 liquidity, uint256 amount0, uint256 amount1);
    event Swapped(bool zeroForOne, int256 amount0, int256 amount1);
    event OrderSent(bool isBuy, uint256 sz, uint256 limitPx, bool reduceOnly, int256 shortSz, uint256 targetSz);
    event MarginSent(uint256 usdc);
    event MarginAskedBack(uint256 usdc);
    event Snapshot(uint256 totalValue, uint256 totalSupply, uint256 oraclePx);
    event KeeperSet(address indexed keeper);
    event DepositsPaused(bool paused);
    event DepositCapSet(uint256 cap);
    event SettingsSet(uint16 bandBps, uint16 marginBps, int24 width);
    event WindDownStarted();
}

error ZeroAddress();
error BadParams();
error NotKeeper();
error NotPool();
error DepositsArePaused();
error Closing();
error CapExceeded(uint256 value, uint256 cap);
error ZeroShares();
error Slippage();
error NothingToDo();
error NothingOwed();
error TooSoon(uint256 availableAt);
error PriceMoved(int24 tick, int24 expectedTick);
error PriceOutOfLine(uint256 poolPx, uint256 oraclePx);
error OutOfRange();
error Underwater();
