// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {LiquidityMath} from "./LiquidityMath.sol";

interface IZapVault {
    function poolKey() external view returns (PoolKey memory);
    function token0() external view returns (address);
    function token1() external view returns (address);
    function nativePool() external view returns (bool);
    function balances() external view returns (uint256 total0, uint256 total1);
    function price() external view returns (uint160 sqrtPriceX96, int24 tick);
    function balanceOf(address) external view returns (uint256);
    function previewDeposit(uint256 amount0Max, uint256 amount1Max)
        external
        view
        returns (uint256 shares, uint256 amount0, uint256 amount1);
    function deposit(uint256 shares, uint256 amount0Max, uint256 amount1Max, address receiver)
        external
        payable
        returns (uint256 amount0, uint256 amount1);
}

/// @title VaultZap
/// @notice Deposit into a Liquid Reserve vault with ONE token. The zap swaps the
/// right share of it for the other token in the vault's own Uniswap v4 pool,
/// deposits both, and sends back whatever is left over, all in one transaction.
///
/// - It has no owner and keeps nothing between transactions.
/// - The vault's shares go straight to `receiver`; the zap never holds them.
/// - `minShares` protects the depositor: if the swap or the deposit comes out
///   worse than that (price moved, or someone pushed the pool), it all reverts.
/// - The swap pays the pool's normal fee and moves the pool price a little; on a
///   thin pool a large zap gets a worse price than a small one.
contract VaultZap is IUnlockCallback, ReentrancyGuard {
    using SafeERC20 for IERC20;

    IPoolManager public immutable poolManager;

    event Zapped(
        address indexed vault, address indexed sender, address indexed receiver, bool token0In, uint256 amountIn, uint256 shares
    );

    error ZeroAddress();
    error ZeroAmount();
    error WrongValue();
    error Slippage(uint256 shares, uint256 minShares);
    error NotPoolManager();
    error NativeTransferFailed();

    constructor(IPoolManager poolManager_) {
        if (address(poolManager_) == address(0)) revert ZeroAddress();
        poolManager = poolManager_;
    }

    /// @dev Native HYPE arrives from the pool (swap output) and from the vault (refund).
    receive() external payable {}

    /// @notice Deposit `amountIn` of one of the vault's two tokens.
    /// @param token0In True to pay in token0 (native HYPE on HYPE pools: send it as
    /// `msg.value`), false to pay in token1 (approve this contract first).
    /// @param minShares Fewest vault shares to accept.
    /// @return shares Vault shares minted to `receiver`.
    /// @return refund0 Token0 returned to the caller (native HYPE on HYPE pools).
    /// @return refund1 Token1 returned to the caller.
    function zapIn(IZapVault vault, bool token0In, uint256 amountIn, uint256 minShares, address receiver)
        external
        payable
        nonReentrant
        returns (uint256 shares, uint256 refund0, uint256 refund1)
    {
        if (receiver == address(0)) revert ZeroAddress();
        if (amountIn == 0) revert ZeroAmount();
        PoolKey memory key = vault.poolKey();
        bool native = vault.nativePool();
        IERC20 t0 = IERC20(vault.token0());
        IERC20 t1 = IERC20(vault.token1());

        // 1. Take the one token.
        if (token0In && native) {
            if (msg.value != amountIn) revert WrongValue();
        } else {
            if (msg.value != 0) revert WrongValue();
            (token0In ? t0 : t1).safeTransferFrom(msg.sender, address(this), amountIn);
        }

        // 2. Swap the share of it that the vault's current mix calls for.
        uint256 toSwap = _swapAmount(vault, key.fee, token0In, amountIn);
        if (toSwap > 0) poolManager.unlock(abi.encode(key, token0In, toSwap));

        // 3. Deposit both. The vault takes what its mix needs and returns the rest here.
        shares = _deposit(vault, native, t0, t1, receiver);
        if (shares < minShares || shares == 0) revert Slippage(shares, minShares);

        // 4. Send back whatever was not needed.
        (refund0, refund1) = _refund(native, t0, t1);
        emit Zapped(address(vault), msg.sender, receiver, token0In, amountIn, shares);
    }

    function _deposit(IZapVault vault, bool native, IERC20 t0, IERC20 t1, address receiver) private returns (uint256) {
        uint256 have0 = native ? address(this).balance : t0.balanceOf(address(this));
        uint256 have1 = t1.balanceOf(address(this));
        uint256 before = vault.balanceOf(receiver);
        (uint256 want,,) = vault.previewDeposit(have0, have1);
        want = want * 999 / 1000; // room for the vault's rounding
        if (want > 0) {
            if (have1 > 0) t1.forceApprove(address(vault), have1);
            if (native) {
                vault.deposit{value: have0}(want, 0, have1, receiver);
            } else {
                if (have0 > 0) t0.forceApprove(address(vault), have0);
                vault.deposit(want, have0, have1, receiver);
                t0.forceApprove(address(vault), 0);
            }
            t1.forceApprove(address(vault), 0);
        }
        return vault.balanceOf(receiver) - before;
    }

    function _refund(bool native, IERC20 t0, IERC20 t1) private returns (uint256 refund0, uint256 refund1) {
        refund1 = t1.balanceOf(address(this));
        if (refund1 > 0) t1.safeTransfer(msg.sender, refund1);
        if (native) {
            refund0 = address(this).balance;
            if (refund0 > 0) {
                (bool ok,) = msg.sender.call{value: refund0}("");
                if (!ok) revert NativeTransferFailed();
            }
        } else {
            refund0 = t0.balanceOf(address(this));
            if (refund0 > 0) t0.safeTransfer(msg.sender, refund0);
        }
    }

    /// @dev How much of the input to swap so that what is left, plus what the swap
    /// returns, matches the vault's mix. Uses the pool price and fee; the small
    /// error from price impact comes back to the caller as a refund.
    function _swapAmount(IZapVault vault, uint24 fee, bool token0In, uint256 amountIn) private view returns (uint256) {
        (uint256 total0, uint256 total1) = vault.balances();
        (uint160 sqrtP,) = vault.price();
        uint256 value0 = LiquidityMath.quote0In1(total0, sqrtP); // the vault's token0, counted in token1
        if (value0 == 0 && total1 == 0) (value0, total1) = (1e18, 1e18); // empty vault: half and half
        uint256 keep = 1e6 - fee; // what a swap keeps after the pool fee, in millionths
        return token0In
            ? FullMath.mulDiv(amountIn, total1, total1 + FullMath.mulDiv(value0, keep, 1e6))
            : FullMath.mulDiv(amountIn, value0, value0 + FullMath.mulDiv(total1, keep, 1e6));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        (PoolKey memory key, bool zeroForOne, uint256 amountIn) = abi.decode(data, (PoolKey, bool, uint256));
        BalanceDelta delta = poolManager.swap(
            key,
            IPoolManager.SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(amountIn),
                sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            ""
        );
        (Currency cIn, Currency cOut) = zeroForOne ? (key.currency0, key.currency1) : (key.currency1, key.currency0);
        uint256 paid = uint256(uint128(-(zeroForOne ? delta.amount0() : delta.amount1())));
        uint256 got = uint256(uint128(zeroForOne ? delta.amount1() : delta.amount0()));
        if (cIn.isAddressZero()) {
            poolManager.settle{value: paid}();
        } else {
            poolManager.sync(cIn);
            IERC20(Currency.unwrap(cIn)).safeTransfer(address(poolManager), paid);
            poolManager.settle();
        }
        poolManager.take(cOut, address(this), got);
        return "";
    }
}
