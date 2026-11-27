// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {CoreLib} from "./CoreLib.sol";
import {HedgeLib} from "./HedgeLib.sol";
import {FlowLib} from "./FlowLib.sol";
import {KeepLib} from "./KeepLib.sol";
import "./HedgedTypes.sol";

/// @title HedgedVault
/// @notice HyperEVM. A liquidity vault whose value is built not to follow the price of the asset it
/// holds ("direction-neutral"). USDC in, USDC out.
///
/// It keeps one range in a Uniswap-v3-style pool of the asset against USDC, and a short on the
/// asset's perpetual on HyperCore that is as large as the asset it holds. The vault contract is
/// its own HyperCore account: it sends its own orders and reads its own position, and no key
/// exists that could trade for it.
///
/// What a holder gets is trading fees, minus what the position loses on price swings, minus the
/// cost of the hedge, plus or minus funding. That can be negative. It is not "fees only".
///
/// - Deposit USDC, receive shares at the vault's value. Token0 counts at HyperCore's oracle price
///   and the pool must agree with that price, so a pushed pool cannot buy shares cheaply.
/// - Withdraw any time: a slice of every pot. The part that sits on HyperCore is paid at once
///   from a buffer when it fits, and is otherwise owed and collected with `claim` moments later.
/// - `tend` (margin and short) and `harvest` can be called by anyone; each can only do what the
///   rules here say, and neither swaps. `deploy` (idle money into the position) and `rebalance`
///   (moving the range) swap in the pool, so they are the keeper's, who states the tick it expects.
/// - HyperCore carries out orders and transfers after the block that sends them and reports no
///   failure. So nothing here assumes an order filled or a transfer arrived: every step starts by
///   reading the account as it is.
/// - 20% of collected trading fees go to `feeRecipient`.
/// - The owner can pause deposits, cap them, name the keeper, tune the band, the margin and the
///   range width within fixed bounds, and start a wind-down. Neither owner nor keeper can move
///   funds out, add a trading key, or stop withdrawals.
contract HedgedVault is ERC20, ReentrancyGuardTransient, Ownable2Step, IHedgedVaultEvents {
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;

    Vault private _v;

    struct Params {
        address pool;
        address coreDeposit;
        address feeRecipient;
        address owner;
        address keeper;
        uint32 perp;
        uint8 szDecimals;
        int24 width;
        uint256 depositCap;
    }

    /// @dev Name and symbol are fixed in the code (see `name` and `symbol`): storing them would cost
    /// gas at creation, and the whole contract has to be created within the 2,000,000 gas that some
    /// wallets allow on HyperEVM.
    constructor(Params memory p) ERC20("", "") Ownable(p.owner) {
        if (p.pool == address(0) || p.coreDeposit == address(0) || p.feeRecipient == address(0) || p.keeper == address(0)) {
            revert ZeroAddress();
        }
        IV3Pool pool = IV3Pool(p.pool);
        uint24 poolFee = pool.fee();
        if (p.szDecimals > 6 || poolFee > 10_000) revert BadParams();
        _v.c = Config({
            pool: p.pool,
            tickSpacing: pool.tickSpacing(),
            poolFee: poolFee,
            perp: p.perp,
            szDecimals: p.szDecimals,
            entryBps: uint16(poolFee / 200 + 5), // half the pool fee, plus 0.05% for the order and the price impact
            exitBps: 5,
            asset: pool.token0(),
            usdc: pool.token1(),
            coreDeposit: p.coreDeposit,
            feeRecipient: p.feeRecipient
        });
        _v.keeper = p.keeper;
        _v.depositCap = p.depositCap;
        _set(500, 4_000, p.width);
        emit KeeperSet(p.keeper);
        emit DepositCapSet(p.depositCap);
    }

    function name() public pure override returns (string memory) {
        return "Hedged HYPE-USDC Vault";
    }

    function symbol() public pure override returns (string memory) {
        return "hHYPE-USDC";
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    // ---------------------------------------------------------------------
    // Anyone
    // ---------------------------------------------------------------------

    function deposit(uint256 assets, uint256 minShares, address receiver) external nonReentrant returns (uint256 shares) {
        if (receiver == address(0)) revert ZeroAddress();
        uint256 supply = totalSupply();
        shares = FlowLib.deposit(_v, assets, supply);
        if (supply == 0) {
            _mint(DEAD, FlowLib.MINIMUM_SHARES); // makes share-price inflation attacks uneconomic
            shares -= FlowLib.MINIMUM_SHARES;
        }
        if (shares < minShares) revert Slippage();
        _mint(receiver, shares);
        emit Deposit(msg.sender, receiver, assets, shares);
        _snapshot();
    }

    /// @param minUsdc the least USDC to receive, counting what is paid now and what is owed
    function withdraw(uint256 shares, uint256 minUsdc, address receiver)
        external
        nonReentrant
        returns (uint256 paidUsdc, uint256 paidAsset, uint256 owedNow)
    {
        if (shares == 0 || receiver == address(0)) revert BadParams();
        uint256 supply = totalSupply();
        _burn(msg.sender, shares);
        (paidUsdc, paidAsset, owedNow) = FlowLib.withdraw(_v, shares, supply, receiver);
        if (paidUsdc + owedNow < minUsdc) revert Slippage();
        emit Withdraw(msg.sender, receiver, shares, paidUsdc, paidAsset, owedNow);
        _snapshot();
    }

    function claim(address receiver) external nonReentrant returns (uint256 paid) {
        return FlowLib.claim(_v, receiver);
    }

    function tend() external nonReentrant {
        KeepLib.tend(_v);
        _snapshot();
    }

    /// @notice Collects the trading fees earned so far; `deploy` puts them back to work.
    function harvest() external nonReentrant {
        FlowLib.collectFees(_v);
        _snapshot();
    }

    // ---------------------------------------------------------------------
    // Keeper
    // ---------------------------------------------------------------------

    /// @notice Puts idle money to work. The pool tick must be within `maxDrift` of `expectedTick`.
    function deploy(int24 expectedTick, int24 maxDrift) external nonReentrant {
        if (msg.sender != _v.keeper) revert NotKeeper();
        KeepLib.deploy(_v, expectedTick, maxDrift);
        _snapshot();
    }

    /// @notice Moves the range to the pool price (during a wind-down: takes the position out and sells
    /// its token0). The pool tick must be within `maxDrift` of `expectedTick`.
    function rebalance(int24 expectedTick, int24 maxDrift) external nonReentrant {
        if (msg.sender != _v.keeper) revert NotKeeper();
        KeepLib.rebalance(_v, expectedTick, maxDrift);
        _snapshot();
    }

    // ---------------------------------------------------------------------
    // Owner: parameters only, within hard bounds
    // ---------------------------------------------------------------------

    function setKeeper(address keeper_) external onlyOwner {
        if (keeper_ == address(0)) revert ZeroAddress();
        _v.keeper = keeper_;
        emit KeeperSet(keeper_);
    }

    function setDepositsPaused(bool paused) external onlyOwner {
        _v.depositsPaused = paused;
        emit DepositsPaused(paused);
    }

    function setDepositCap(uint256 cap) external onlyOwner {
        _v.depositCap = cap;
        emit DepositCapSet(cap);
    }

    /// @param bandBps 100 to 1,000: how far off the short may be, as a share of the position's value
    /// @param marginBps 3,000 to 10,000: the margin to keep, as a share of the short
    /// @param width 2 to 2,000: half-width of the range in tick spacings, from the next rebalance on
    function setSettings(uint16 bandBps, uint16 marginBps, int24 width) external onlyOwner {
        _set(bandBps, marginBps, width);
    }

    /// @notice Starts the wind-down: no more deposits; `tend` takes the position out, closes the
    /// short and brings the margin home, and the keeper's `rebalance` sells the token0. Withdrawals go
    /// on as always, with or without the keeper. Cannot be undone.
    function windDown() external onlyOwner {
        _v.closing = true;
        emit WindDownStarted();
    }

    function _set(uint16 bandBps, uint16 marginBps, int24 width) private {
        if (bandBps < 100 || bandBps > 1_000 || marginBps < 3_000 || marginBps > 10_000 || width < 2 || width > 2_000) {
            revert BadParams();
        }
        (_v.bandBps, _v.marginBps, _v.width) = (bandBps, marginBps, width);
        emit SettingsSet(bandBps, marginBps, width);
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    function totalValue() external view returns (uint256) {
        return HedgeLib.totalValue(_v);
    }

    /// @notice The open range and its liquidity. `HedgedLens` turns this and the rest into one reading.
    function position() external view returns (int24 lower, int24 upper, uint128 liquidity) {
        return (_v.lower, _v.upper, _v.liquidity);
    }

    function owedTotal() external view returns (uint256) {
        return _v.owedTotal;
    }

    function config() external view returns (Config memory) {
        return _v.c;
    }

    function settings()
        external
        view
        returns (address keeper, uint16 bandBps, uint16 marginBps, int24 width, bool depositsPaused, bool closing, uint256 depositCap)
    {
        return (_v.keeper, _v.bandBps, _v.marginBps, _v.width, _v.depositsPaused, _v.closing, _v.depositCap);
    }

    function owed(address receiver) external view returns (uint256) {
        return _v.owed[receiver];
    }

    function totalFees() external view returns (uint256 fees0, uint256 fees1) {
        return (_v.totalFees0, _v.totalFees1);
    }

    function _snapshot() private {
        emit Snapshot(HedgeLib.totalValue(_v), totalSupply(), CoreLib.oraclePx(_v.c.perp));
    }

    // ---------------------------------------------------------------------
    // Pool callbacks: the pool asks for what a mint or a swap costs
    // ---------------------------------------------------------------------

    function uniswapV3MintCallback(uint256 owed0, uint256 owed1, bytes calldata) external {
        _pay(owed0, owed1);
    }

    function uniswapV3SwapCallback(int256 delta0, int256 delta1, bytes calldata) external {
        _pay(delta0 > 0 ? uint256(delta0) : 0, delta1 > 0 ? uint256(delta1) : 0);
    }

    /// @dev A pool only ever calls back the contract that called it, so this runs only inside a mint
    /// or a swap that the vault itself started.
    function _pay(uint256 amount0, uint256 amount1) private {
        if (msg.sender != _v.c.pool) revert NotPool();
        if (amount0 > 0) SafeERC20.safeTransfer(IERC20(_v.c.asset), msg.sender, amount0);
        if (amount1 > 0) SafeERC20.safeTransfer(IERC20(_v.c.usdc), msg.sender, amount1);
    }
}
