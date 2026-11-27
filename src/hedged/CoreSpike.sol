// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {CoreLib, ICoreWriter, ICoreDepositWallet} from "./CoreLib.sol";

/// @title CoreSpike
/// @notice HyperEVM. A small contract for finding out, with a few dollars of its owner's money, how
/// HyperCore really treats a contract's account: how fast orders and transfers land, what a rejected
/// one looks like, what the smallest order is. It uses the same `CoreLib` as the hedged vault, so
/// what works here works there. Not part of the vault. Only its owner can use it, and the owner can
/// take everything back out at any time (as far as HyperCore lets a transfer through).
contract CoreSpike {
    using SafeERC20 for IERC20;

    address public immutable owner;
    IERC20 public immutable usdc;
    ICoreDepositWallet public immutable coreDeposit;
    uint32 public immutable perp;
    uint8 public immutable szDecimals;

    /// @dev HYPE sent to this address on HyperEVM is credited to the sender's spot account on HyperCore.
    address internal constant HYPE_TO_CORE = 0x2222222222222222222222222222222222222222;
    address internal constant CORE_BLOCK = 0x0000000000000000000000000000000000000809;
    address internal constant WITHDRAWABLE = 0x0000000000000000000000000000000000000803;
    address internal constant CORE_USER_EXISTS = 0x0000000000000000000000000000000000000810;

    /// @param coreBlock HyperCore's block number as this HyperEVM block saw it
    event Sent(string what, uint256 a, uint256 b, bool flag, uint64 coreBlock);

    error NotOwner();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(IERC20 usdc_, ICoreDepositWallet coreDeposit_, uint32 perp_, uint8 szDecimals_) {
        owner = msg.sender;
        (usdc, coreDeposit, perp, szDecimals) = (usdc_, coreDeposit_, perp_, szDecimals_);
    }

    receive() external payable {}

    /// @notice Takes USDC from the owner and sends it to this contract's HyperCore account.
    function fund(uint256 amount, bool toSpot) external onlyOwner {
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        usdc.forceApprove(address(coreDeposit), amount);
        coreDeposit.deposit(amount, toSpot ? CoreLib.SPOT_DEX : CoreLib.PERP_DEX);
        emit Sent("fund", amount, 0, toSpot, coreBlock());
    }

    /// @notice Sends the HYPE that comes with the call to this contract's HyperCore account (spot side).
    /// HyperCore charges a little HYPE there for sending tokens back to HyperEVM.
    function fundHype() external payable onlyOwner {
        (bool ok,) = HYPE_TO_CORE.call{value: msg.value}("");
        require(ok);
        emit Sent("fundHype", msg.value, 0, false, coreBlock());
    }

    /// @notice An immediate-or-cancel order on the perp. Size in size units, limit as a raw price.
    function order(bool isBuy, uint256 sz, uint256 limitRaw, bool reduceOnly) external onlyOwner {
        uint256 used = CoreLib.order(perp, szDecimals, isBuy, sz, limitRaw, reduceOnly);
        emit Sent(isBuy ? "buy" : "sell", sz, used, reduceOnly, coreBlock());
    }

    function perpToSpot(uint256 usdc6) external onlyOwner {
        CoreLib.perpToSpot(usdc6);
        emit Sent("perpToSpot", usdc6, 0, false, coreBlock());
    }

    function spotToEvm(uint256 usdc6) external onlyOwner {
        CoreLib.spotToEvm(usdc6);
        emit Sent("spotToEvm", usdc6, 0, false, coreBlock());
    }

    /// @notice Sends any action as it is, for the experiments this contract does not have a function for.
    function raw(bytes calldata action) external onlyOwner {
        ICoreWriter(CoreLib.CORE_WRITER).sendRawAction(action);
        emit Sent("raw", action.length, 0, false, coreBlock());
    }

    /// @notice Sends everything this contract holds of a token (address(0): HYPE) to the owner.
    function sweep(address token) external onlyOwner {
        if (token == address(0)) {
            (bool ok,) = owner.call{value: address(this).balance}("");
            require(ok);
        } else {
            IERC20(token).safeTransfer(owner, IERC20(token).balanceOf(address(this)));
        }
    }

    /// @notice The account as this block sees it. USDC amounts have 6 decimals.
    function read()
        external
        view
        returns (
            uint256 oraclePx,
            int256 positionSz,
            int256 perpValue,
            uint256 spotUsdc,
            uint256 usdcHere,
            uint256 withdrawable,
            bool existsOnCore,
            uint64 coreBlockNow
        )
    {
        oraclePx = CoreLib.oraclePx(perp);
        positionSz = CoreLib.positionSz(address(this), perp);
        perpValue = CoreLib.accountValue(address(this));
        spotUsdc = CoreLib.spotUsdc(address(this));
        usdcHere = usdc.balanceOf(address(this));
        withdrawable = _word(WITHDRAWABLE, abi.encode(address(this)));
        existsOnCore = _word(CORE_USER_EXISTS, abi.encode(address(this))) != 0;
        coreBlockNow = coreBlock();
    }

    function coreBlock() public view returns (uint64) {
        return uint64(_word(CORE_BLOCK, ""));
    }

    /// @dev A read that may not answer: it gets a limited amount of gas and counts as 0 if it fails.
    function _word(address source, bytes memory args) private view returns (uint256 value) {
        (bool ok, bytes memory out) = source.staticcall{gas: 30_000}(args);
        if (ok && out.length >= 32) value = abi.decode(out, (uint256));
    }
}
