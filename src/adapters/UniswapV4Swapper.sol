// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {ISwapper} from "../interfaces/ISwapper.sol";

interface IWHYPE {
    function deposit() external payable;
    function withdraw(uint256 amount) external;
}

/// @title UniswapV4Swapper
/// @notice ISwapper for Elysium. Swaps through the Uniswap v4 PoolManager
/// directly (including hook pools such as Ascend's), along routes the owner
/// (the TimelockController) configures per token pair.
///
/// - The protocol only handles ERC-20s; HYPE is always WHYPE. When a pool uses
///   native HYPE, the adapter unwraps before paying and wraps after receiving.
/// - A route can also end in an ERC-4626 deposit (e.g. KNTQ -> staked KNTQ).
/// - Every hop must fill completely, or the whole swap reverts.
/// - The adapter holds no funds between calls. The caller (GuardedSwap) also
///   checks the output against the oracle, so a bad route can't underpay.
contract UniswapV4Swapper is ISwapper, IUnlockCallback, ReentrancyGuard, Ownable2Step {
    using SafeERC20 for IERC20;

    enum HopKind {
        V4_SWAP,
        VAULT_DEPOSIT
    }

    /// @param kind V4_SWAP: swap in `key`; VAULT_DEPOSIT: deposit into ERC-4626 `vault`
    /// @param zeroForOne direction of a V4 swap (true = pay currency0)
    struct Hop {
        HopKind kind;
        PoolKey key;
        bool zeroForOne;
        address vault;
    }

    IPoolManager public immutable poolManager;
    address public immutable whype;

    mapping(bytes32 routeId => Hop[]) private _routes;

    event RouteSet(address indexed tokenIn, address indexed tokenOut, uint256 hops);
    event RouteDeleted(address indexed tokenIn, address indexed tokenOut);

    error ZeroAddress();
    error NoRoute(address tokenIn, address tokenOut);
    error BadRoute(uint256 hopIndex);
    error NotPoolManager();
    error PartialFill(uint256 hopIndex, uint256 paid, uint256 expected);
    error InsufficientOutput(uint256 out, uint256 minOut);
    error UnexpectedNative();
    error UnexpectedDelta(uint256 hopIndex);

    constructor(address owner_, IPoolManager poolManager_, address whype_) Ownable(owner_) {
        if (address(poolManager_) == address(0) || whype_ == address(0)) revert ZeroAddress();
        poolManager = poolManager_;
        whype = whype_;
    }

    receive() external payable {
        if (msg.sender != whype && msg.sender != address(poolManager)) revert UnexpectedNative();
    }

    // ---------------------------------------------------------------------
    // Routes (owner)
    // ---------------------------------------------------------------------

    function setRoute(address tokenIn, address tokenOut, Hop[] calldata hops) external onlyOwner {
        if (hops.length == 0) revert BadRoute(0);
        address current = tokenIn;
        for (uint256 i; i < hops.length; ++i) {
            Hop calldata h = hops[i];
            if (h.kind == HopKind.V4_SWAP) {
                (address hopIn, address hopOut) = _hopTokens(h);
                if (hopIn != current) revert BadRoute(i);
                current = hopOut;
            } else {
                if (h.vault == address(0) || IERC4626(h.vault).asset() != current) revert BadRoute(i);
                current = h.vault;
            }
        }
        if (current != tokenOut) revert BadRoute(hops.length);

        Hop[] storage stored = _routes[routeId(tokenIn, tokenOut)];
        delete _routes[routeId(tokenIn, tokenOut)];
        for (uint256 i; i < hops.length; ++i) {
            stored.push(hops[i]);
        }
        emit RouteSet(tokenIn, tokenOut, hops.length);
    }

    function deleteRoute(address tokenIn, address tokenOut) external onlyOwner {
        delete _routes[routeId(tokenIn, tokenOut)];
        emit RouteDeleted(tokenIn, tokenOut);
    }

    function getRoute(address tokenIn, address tokenOut) external view returns (Hop[] memory) {
        return _routes[routeId(tokenIn, tokenOut)];
    }

    function routeId(address tokenIn, address tokenOut) public pure returns (bytes32) {
        return keccak256(abi.encode(tokenIn, tokenOut));
    }

    // ---------------------------------------------------------------------
    // Swap
    // ---------------------------------------------------------------------

    /// @inheritdoc ISwapper
    function swap(address tokenIn, address tokenOut, uint256 amountIn, uint256 minOut, address recipient)
        external
        nonReentrant
        returns (uint256 amountOut)
    {
        bytes32 id = routeId(tokenIn, tokenOut);
        if (_routes[id].length == 0) revert NoRoute(tokenIn, tokenOut);

        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        amountOut = abi.decode(poolManager.unlock(abi.encode(id, amountIn)), (uint256));
        if (amountOut < minOut) revert InsufficientOutput(amountOut, minOut);
        IERC20(tokenOut).safeTransfer(recipient, amountOut);
    }

    /// @dev Runs every hop inside one PoolManager unlock. Each hop is paid and
    /// collected immediately, so no delta is left open between hops.
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        (bytes32 id, uint256 amount) = abi.decode(data, (bytes32, uint256));
        Hop[] storage hops = _routes[id];
        for (uint256 i; i < hops.length; ++i) {
            Hop storage h = hops[i];
            if (h.kind == HopKind.V4_SWAP) {
                amount = _swapHop(i, h.key, h.zeroForOne, amount);
            } else {
                IERC20 asset = IERC20(IERC4626(h.vault).asset());
                asset.forceApprove(h.vault, amount);
                amount = IERC4626(h.vault).deposit(amount, address(this));
            }
        }
        return abi.encode(amount);
    }

    function _swapHop(uint256 i, PoolKey memory key, bool zeroForOne, uint256 amountIn)
        private
        returns (uint256 amountOut)
    {
        BalanceDelta delta = poolManager.swap(
            key,
            IPoolManager.SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(amountIn), // negative = exact input
                sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            ""
        );
        (int128 inDelta, int128 outDelta) =
            zeroForOne ? (delta.amount0(), delta.amount1()) : (delta.amount1(), delta.amount0());
        if (inDelta >= 0 || outDelta < 0) revert UnexpectedDelta(i);
        uint256 paid = uint256(uint128(-inDelta));
        if (paid != amountIn) revert PartialFill(i, paid, amountIn);
        amountOut = uint256(uint128(outDelta));

        (Currency cin, Currency cout) = zeroForOne ? (key.currency0, key.currency1) : (key.currency1, key.currency0);
        _pay(cin, paid);
        _collect(cout, amountOut);
    }

    function _pay(Currency currency, uint256 amount) private {
        if (currency.isAddressZero()) {
            IWHYPE(whype).withdraw(amount);
            poolManager.settle{value: amount}();
        } else {
            poolManager.sync(currency);
            IERC20(Currency.unwrap(currency)).safeTransfer(address(poolManager), amount);
            poolManager.settle();
        }
    }

    function _collect(Currency currency, uint256 amount) private {
        poolManager.take(currency, address(this), amount);
        if (currency.isAddressZero()) IWHYPE(whype).deposit{value: amount}();
    }

    /// @dev Input/output tokens of a swap hop, with native HYPE shown as WHYPE.
    function _hopTokens(Hop calldata h) private view returns (address tokenIn, address tokenOut) {
        (Currency cin, Currency cout) =
            h.zeroForOne ? (h.key.currency0, h.key.currency1) : (h.key.currency1, h.key.currency0);
        tokenIn = _asToken(cin);
        tokenOut = _asToken(cout);
    }

    function _asToken(Currency c) private view returns (address) {
        return c.isAddressZero() ? whype : Currency.unwrap(c);
    }
}
