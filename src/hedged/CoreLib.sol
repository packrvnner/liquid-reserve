// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

interface ICoreWriter {
    function sendRawAction(bytes calldata data) external;
}

/// @notice Circle's wallet that moves USDC from HyperEVM to a HyperCore account.
interface ICoreDepositWallet {
    /// @param destinationDex 0 = the perp account, type(uint32).max = the spot account
    function deposit(uint256 amount, uint32 destinationDex) external;
}

/// @title CoreLib
/// @notice Everything the hedged vault says to HyperCore and reads from it. HyperEVM only.
///
/// Reading: HyperCore's state is served by system addresses that take plain ABI-encoded
/// arguments (no function selector). They return the state as it was when this HyperEVM
/// block was built, so nothing sent in the current block is visible yet.
///
/// Writing: `CoreWriter.sendRawAction` only records the action. HyperCore carries it out
/// after this block, and an action it rejects fails without any error here. Code that uses
/// this library must therefore read back what happened in a later block and never assume.
///
/// Units. Perp prices come as price x 10^(6 - szDecimals) ("raw price"). Perp sizes come in
/// steps of 10^-szDecimals of the asset ("size units"). With both, a position's value in
/// USDC (6 decimals) is simply sizeUnits x rawPrice. Order fields are price and size x 10^8.
/// Perp-side USD has 6 decimals; USDC on the spot side has 8.
library CoreLib {
    address internal constant CORE_WRITER = 0x3333333333333333333333333333333333333333;
    address internal constant POSITION = 0x0000000000000000000000000000000000000800;
    address internal constant SPOT_BALANCE = 0x0000000000000000000000000000000000000801;
    address internal constant ORACLE_PX = 0x0000000000000000000000000000000000000807;
    address internal constant MARGIN_SUMMARY = 0x000000000000000000000000000000000000080F;
    /// @dev Sending spot USDC to this HyperCore address moves it to the sender's address on HyperEVM.
    address internal constant USDC_TO_EVM = 0x2000000000000000000000000000000000000000;

    uint32 internal constant SPOT_DEX = type(uint32).max;
    uint32 internal constant PERP_DEX = 0;
    uint64 internal constant USDC_TOKEN = 0;
    uint8 internal constant TIF_IOC = 3;

    uint24 private constant ACTION_ORDER = 1;
    uint24 private constant ACTION_CLASS_TRANSFER = 7;
    uint24 private constant ACTION_SEND_ASSET = 13;

    error CoreReadFailed(address source);

    // ------------------------------------------------------------------ reading

    function _read(address source, bytes memory args) private view returns (bytes memory out) {
        bool ok;
        (ok, out) = source.staticcall(args);
        if (!ok || out.length == 0) revert CoreReadFailed(source);
    }

    /// @notice The oracle price of a perp, as a raw price.
    function oraclePx(uint32 perp) internal view returns (uint256) {
        return abi.decode(_read(ORACLE_PX, abi.encode(perp)), (uint64));
    }

    /// @notice An account's position in a perp, in size units. Negative is short.
    function positionSz(address account, uint32 perp) internal view returns (int256) {
        (int64 szi,,,,) = abi.decode(_read(POSITION, abi.encode(account, uint16(perp))), (int64, uint64, int64, uint32, bool));
        return szi;
    }

    /// @notice An account's perp account value (margin plus open gains and losses), USDC 6 decimals.
    function accountValue(address account) internal view returns (int256) {
        (int64 value,,,) = abi.decode(_read(MARGIN_SUMMARY, abi.encode(PERP_DEX, account)), (int64, uint64, uint64, int64));
        return value;
    }

    /// @notice USDC on an account's spot side, converted to 6 decimals.
    function spotUsdc(address account) internal view returns (uint256) {
        (uint64 total,,) = abi.decode(_read(SPOT_BALANCE, abi.encode(account, USDC_TOKEN)), (uint64, uint64, uint64));
        return uint256(total) / 100;
    }

    // ------------------------------------------------------------------ writing

    function _send(uint24 action, bytes memory fields) private {
        ICoreWriter(CORE_WRITER).sendRawAction(abi.encodePacked(uint8(1), action, fields));
    }

    /// @notice An immediate-or-cancel order: what does not fill at once is cancelled.
    /// @param sz size units
    /// @param limitRaw raw price; rounded here to the five significant figures HyperCore accepts,
    /// downwards for a sale and upwards for a purchase
    function order(uint32 perp, uint8 szDecimals, bool isBuy, uint256 sz, uint256 limitRaw, bool reduceOnly)
        internal
        returns (uint256 limitUsed)
    {
        limitUsed = roundPx(limitRaw, isBuy);
        _send(
            ACTION_ORDER,
            abi.encode(
                perp,
                isBuy,
                uint64(limitUsed * 10 ** (2 + szDecimals)),
                uint64(sz * 10 ** (8 - szDecimals)),
                reduceOnly,
                TIF_IOC,
                uint128(0)
            )
        );
    }

    /// @notice Moves USDC from the account's perp side to its spot side.
    function perpToSpot(uint256 usdc6) internal {
        _send(ACTION_CLASS_TRANSFER, abi.encode(uint64(usdc6), false));
    }

    /// @notice Sends spot USDC of this account back to the same address on HyperEVM.
    function spotToEvm(uint256 usdc6) internal {
        _send(ACTION_SEND_ASSET, abi.encode(USDC_TO_EVM, address(0), SPOT_DEX, SPOT_DEX, USDC_TOKEN, uint64(usdc6 * 100)));
    }

    /// @notice Keeps at most five significant figures of a raw price.
    function roundPx(uint256 raw, bool up) internal pure returns (uint256 r) {
        uint256 step = 1;
        while (raw / step >= 100_000) step *= 10;
        r = raw / step * step;
        if (up && r != raw) r += step;
    }
}
