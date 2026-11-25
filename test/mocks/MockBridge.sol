// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";

/// @notice Records Elysium -> HyperEVM withdrawals.
contract MockL2GatewayRouter {
    address public lastL1Token;
    address public lastTo;
    uint256 public lastAmount;
    uint256 public calls;

    function outboundTransfer(address l1Token, address to, uint256 amount, bytes calldata)
        external
        payable
        returns (bytes memory)
    {
        lastL1Token = l1Token;
        lastTo = to;
        lastAmount = amount;
        ++calls;
        return "";
    }
}

/// @notice Escrow side of a HyperEVM -> Elysium deposit (pulls with its allowance).
contract MockL1Gateway {
    function pull(address token, address from, uint256 amount) external {
        IERC20(token).transferFrom(from, address(this), amount);
    }
}

contract MockL1GatewayRouter {
    MockL1Gateway public immutable gateway = new MockL1Gateway();
    address public lastTo;
    address public lastRefundTo;
    uint256 public lastAmount;
    uint256 public lastValue;

    function getGateway(address) external view returns (address) {
        return address(gateway);
    }

    function outboundTransferCustomRefund(
        address token,
        address refundTo,
        address to,
        uint256 amount,
        uint256,
        uint256,
        bytes calldata
    ) external payable returns (bytes memory) {
        lastTo = to;
        lastRefundTo = refundTo;
        lastAmount = amount;
        lastValue = msg.value;
        gateway.pull(token, msg.sender, amount);
        return "";
    }
}

/// @notice Behaves like Kinetiq's sKNTQ: ERC-4626 whose redeem opens a request
/// that pays out after 7 days (request ids start at 1).
contract MockSkntq is ERC4626 {
    uint256 public constant withdrawalDelay = 7 days;

    struct Request {
        uint256 assets;
        uint256 shares;
        uint256 timestamp;
    }

    mapping(address owner => mapping(uint256 id => Request)) public withdrawalRequest;
    mapping(address owner => uint256) public nextWithdrawalRequestId;
    uint256 public pendingAssets;

    constructor(IERC20 asset_) ERC20("Staked KNTQ", "sKNTQ") ERC4626(asset_) {}

    function totalAssets() public view override returns (uint256) {
        return IERC20(asset()).balanceOf(address(this)) - pendingAssets;
    }

    function redeem(uint256 shares, address, address owner) public override returns (uint256 assets) {
        require(msg.sender == owner, "owner only");
        assets = previewRedeem(shares);
        _burn(owner, shares);
        pendingAssets += assets;
        uint256 id = nextWithdrawalRequestId[owner];
        if (id == 0) id = 1;
        withdrawalRequest[owner][id] = Request(assets, shares, block.timestamp);
        nextWithdrawalRequestId[owner] = id + 1;
    }

    function confirmWithdrawal(address owner, uint256 id) external returns (uint256 assets, uint256 shares) {
        Request memory r = withdrawalRequest[owner][id];
        require(r.assets > 0 && block.timestamp >= r.timestamp + withdrawalDelay, "not ready");
        delete withdrawalRequest[owner][id];
        pendingAssets -= r.assets;
        IERC20(asset()).transfer(owner, r.assets);
        return (r.assets, r.shares);
    }
}

interface ITicketSource {
    function pendingToElysium() external view returns (uint256);
    function arriveOnElysium() external;
}

/// The part of Arbitrum's retryable-ticket precompile (address 0x6E) that the bot uses, over a test's simulated
/// bridge: a ticket exists while the bridge still holds something for Elysium, and redeeming it delivers that.
/// The bot simulation puts this contract's code at 0x6E and points `source` (slot 0) at its BridgeSim.
contract MockArbRetryableTx {
    ITicketSource public source;

    error NoTicketWithID();

    function getTimeout(bytes32) external view returns (uint256) {
        if (source.pendingToElysium() == 0) revert NoTicketWithID();
        return block.timestamp + 7 days;
    }

    function redeem(bytes32) external returns (bytes32) {
        if (source.pendingToElysium() == 0) revert NoTicketWithID();
        source.arriveOnElysium();
        return bytes32(0);
    }
}
