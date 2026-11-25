// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ISwapper} from "./interfaces/ISwapper.sol";
import {IPriceOracle} from "./interfaces/IPriceOracle.sol";
import {SwapConfig} from "./SwapConfig.sol";
import {LockedReserve} from "./LockedReserve.sol";

/// @title DropFeeder
/// @notice Fills "the drop" with $liquid, and burns once the drop is full.
///
/// The reserve's allocator sets a fifth of every fee aside as USDC. That USDC is passed to this contract, and
/// `feed` splits it in two:
///
/// - half buys kHYPE and locks it in the reserve, like the rest of the fee;
/// - half buys $liquid. While the drop holds less than 5% of the supply that has not been burned, the $liquid
///   goes to the drop. Whatever does not fit is sent to Ascend's burn address, for good, and counted.
///
/// So of every fee, a tenth goes to the drop or the burn and nine tenths end as staked HYPE in the reserve.
///
/// The drop is an ordinary wallet, run by the protocol's bot, because Ascend pays holder rewards to wallets
/// only. This contract cannot stop that wallet from moving its $liquid. What it does: it remembers how much it
/// has sent, and counts the drop as holding at least that much. So the most it will ever send to the drop is
/// one full line's worth: a drop that was emptied does not get a second filling.
///
/// Every purchase is held to the reserve's 30-minute average price less the slippage limit in SwapConfig, and
/// what arrives is measured. Anyone may call `feed`.
///
/// `addLiquid` puts $liquid that someone already holds through the same rule: into the drop while it has room,
/// to the burn address otherwise. The reserve's yield uses it for the share of the yield that goes to the drop.
///
/// The owner is the 48-hour timelock. It can do two things: name a different drop wallet (if the bot's wallet
/// is ever replaced), and name a successor. Once a successor is named this contract only passes the USDC on to
/// it. That exists because the USDC can only ever be sent here, so without it a fault in this contract could
/// not be worked around.
contract DropFeeder is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 private constant BPS = 10_000;
    /// @notice Share of the USDC that buys $liquid; the rest buys kHYPE for the reserve.
    uint256 public constant DROP_BPS = 5_000;
    /// @notice The drop is full when it holds this share of the supply that has not been burned.
    uint256 public constant CAP_BPS = 500;

    IERC20 public immutable usdc;
    IERC20 public immutable liquid;
    IERC20 public immutable khype;
    /// @notice Ascend's burn address for $liquid: a contract with no functions, so nothing sent there can leave.
    address public immutable burnSink;
    LockedReserve public immutable reserve;
    /// @notice The reserve's real price source and swap contract.
    IPriceOracle public immutable oracle;
    ISwapper public immutable swapper;
    /// @notice Where the slippage limit is read from.
    SwapConfig public immutable swapConfig;

    /// @notice The wallet that holds the drop.
    address public drop;
    /// @notice If set, all USDC is passed on to this address instead of being used here.
    address public successor;

    /// @notice Running totals since deployment.
    uint256 public usdcUsed;
    uint256 public khypeLocked;
    uint256 public sentToDrop;
    uint256 public burned;

    /// @notice One call of `feed`: `usdcIn` became `khypeToReserve` kHYPE locked in the reserve, `liquidToDrop`
    /// $liquid sent to the drop and `liquidBurned` $liquid sent to the burn address.
    event Fed(uint256 usdcIn, uint256 khypeToReserve, uint256 liquidToDrop, uint256 liquidBurned);
    /// @notice `from` handed over $liquid: `liquidToDrop` went to the drop and `liquidBurned` to the burn address.
    event LiquidAdded(address indexed from, uint256 liquidToDrop, uint256 liquidBurned);
    event PassedOn(address indexed successor, uint256 usdcAmount);
    event DropSet(address indexed drop);
    event SuccessorSet(address indexed successor);

    error ZeroAddress();
    error NothingToFeed();
    error ZeroAmount();
    error QuoteZero(address tokenOut, uint256 amountIn);
    error InsufficientOutput(uint256 received, uint256 minOut);

    constructor(
        address owner_,
        IERC20 usdc_,
        IERC20 liquid_,
        IERC20 khype_,
        address burnSink_,
        LockedReserve reserve_,
        IPriceOracle oracle_,
        ISwapper swapper_,
        SwapConfig swapConfig_,
        address drop_
    ) Ownable(owner_) {
        if (
            address(usdc_) == address(0) || address(liquid_) == address(0) || address(khype_) == address(0) || burnSink_ == address(0)
                || address(reserve_) == address(0) || address(oracle_) == address(0) || address(swapper_) == address(0)
                || address(swapConfig_) == address(0) || drop_ == address(0)
        ) revert ZeroAddress();
        usdc = usdc_;
        liquid = liquid_;
        khype = khype_;
        burnSink = burnSink_;
        reserve = reserve_;
        oracle = oracle_;
        swapper = swapper_;
        swapConfig = swapConfig_;
        drop = drop_;
        emit DropSet(drop_);
    }

    // ---------------------------------------------------------------------
    // The drop's level
    // ---------------------------------------------------------------------

    /// @notice $liquid that has not been burned: the total supply less what sits at the burn address.
    function unburnedSupply() public view returns (uint256) {
        return liquid.totalSupply() - liquid.balanceOf(burnSink);
    }

    /// @notice How much $liquid the drop holds when it is full: 5% of the unburned supply.
    function cap() public view returns (uint256) {
        return unburnedSupply() * CAP_BPS / BPS;
    }

    /// @notice What the drop counts as holding: its balance, and never less than what this contract has sent it.
    function held() public view returns (uint256) {
        uint256 balance = liquid.balanceOf(drop);
        return balance > sentToDrop ? balance : sentToDrop;
    }

    /// @notice How much more $liquid fits in the drop before purchases start to burn.
    function room() public view returns (uint256) {
        uint256 c = cap();
        uint256 h = held();
        return c > h ? c - h : 0;
    }

    // ---------------------------------------------------------------------
    // Feeding
    // ---------------------------------------------------------------------

    /// @notice Uses up to `maxUsdc` of the USDC waiting here: half for the reserve, half for the drop or the burn.
    /// A smaller `maxUsdc` lets a large amount go through thin pools in pieces.
    function feed(uint256 maxUsdc) external nonReentrant returns (uint256 khypeToReserve, uint256 liquidToDrop, uint256 liquidBurned) {
        uint256 amount = usdc.balanceOf(address(this));
        if (amount > maxUsdc) amount = maxUsdc;
        if (amount == 0) revert NothingToFeed();

        address next = successor;
        if (next != address(0)) {
            usdc.safeTransfer(next, amount);
            emit PassedOn(next, amount);
            return (0, 0, 0);
        }

        uint256 forDrop = amount * DROP_BPS / BPS;
        uint256 forReserve = amount - forDrop;

        if (forReserve > 0) {
            khypeToReserve = _buy(khype, forReserve);
            khype.forceApprove(address(reserve), khypeToReserve);
            // forge-lint: disable-next-line(unused-return)
            reserve.deposit(address(khype), khypeToReserve);
        }
        if (forDrop > 0) (liquidToDrop, liquidBurned) = _place(_buy(liquid, forDrop));
        usdcUsed += amount;
        khypeLocked += khypeToReserve;
        emit Fed(amount, khypeToReserve, liquidToDrop, liquidBurned);
    }

    /// @notice Takes `amount` of $liquid from the caller and puts it where a purchase would go: into the drop
    /// while it has room, to the burn address otherwise. Nothing comes back to the caller.
    function addLiquid(uint256 amount) external nonReentrant returns (uint256 liquidToDrop, uint256 liquidBurned) {
        if (amount == 0) revert ZeroAmount();
        uint256 before = liquid.balanceOf(address(this));
        liquid.safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = liquid.balanceOf(address(this)) - before;
        address next = successor;
        if (next != address(0)) {
            liquid.safeTransfer(next, received);
            return (0, 0);
        }
        (liquidToDrop, liquidBurned) = _place(received);
        emit LiquidAdded(msg.sender, liquidToDrop, liquidBurned);
    }

    /// @dev Sends `amount` of $liquid held here to the drop, as far as it fits, and the rest to the burn address.
    function _place(uint256 amount) private returns (uint256 liquidToDrop, uint256 liquidBurned) {
        uint256 space = room();
        liquidToDrop = amount > space ? space : amount;
        liquidBurned = amount - liquidToDrop;
        if (liquidToDrop > 0) {
            sentToDrop += liquidToDrop;
            liquid.safeTransfer(drop, liquidToDrop);
        }
        if (liquidBurned > 0) {
            burned += liquidBurned;
            liquid.safeTransfer(burnSink, liquidBurned);
        }
    }

    /// @dev Swaps `usdcAmount` into `tokenOut`, to this contract, at no worse than the oracle's average price less
    /// the slippage limit. Returns what actually arrived.
    function _buy(IERC20 tokenOut, uint256 usdcAmount) private returns (uint256 received) {
        uint256 expected = oracle.quote(address(usdc), address(tokenOut), usdcAmount);
        if (expected == 0) revert QuoteZero(address(tokenOut), usdcAmount);
        uint256 minOut = expected * (BPS - swapConfig.maxSlippageBps()) / BPS;

        uint256 before = tokenOut.balanceOf(address(this));
        usdc.forceApprove(address(swapper), usdcAmount);
        // The adapter's return value is ignored on purpose: what actually arrived is measured below.
        // forge-lint: disable-next-line(unused-return)
        swapper.swap(address(usdc), address(tokenOut), usdcAmount, minOut, address(this));
        usdc.forceApprove(address(swapper), 0);
        received = tokenOut.balanceOf(address(this)) - before;
        if (received < minOut) revert InsufficientOutput(received, minOut);
    }

    // ---------------------------------------------------------------------
    // Owner (the timelock)
    // ---------------------------------------------------------------------

    /// @notice Names a different wallet as the drop. What was sent before still counts towards its level.
    function setDrop(address drop_) external onlyOwner {
        if (drop_ == address(0)) revert ZeroAddress();
        drop = drop_;
        emit DropSet(drop_);
    }

    /// @notice Names the contract that takes over. From then on `feed` only passes the USDC on to it.
    /// Zero switches that off again.
    function setSuccessor(address successor_) external onlyOwner {
        successor = successor_;
        emit SuccessorSet(successor_);
    }
}
