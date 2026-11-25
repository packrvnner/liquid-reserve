// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice Elysium side of the canonical (Arbitrum Orbit) token bridge.
interface IL2GatewayRouter {
    /// @dev Burns `amount` of the L2 token from msg.sender (no approval needed)
    /// and sends it to `to` on HyperEVM once the withdrawal is confirmed.
    function outboundTransfer(address l1Token, address to, uint256 amount, bytes calldata data)
        external
        payable
        returns (bytes memory);
}

/// @notice HyperEVM side of the canonical token bridge.
interface IL1GatewayRouter {
    function getGateway(address token) external view returns (address);

    /// @dev Escrows `amount` of `token` (approve the token's gateway first) and
    /// mints it to `to` on Elysium via a retryable ticket paid for by msg.value.
    /// `data` = abi.encode(maxSubmissionCost, bytes("")).
    function outboundTransferCustomRefund(
        address token,
        address refundTo,
        address to,
        uint256 amount,
        uint256 maxGas,
        uint256 gasPriceBid,
        bytes calldata data
    ) external payable returns (bytes memory);
}
