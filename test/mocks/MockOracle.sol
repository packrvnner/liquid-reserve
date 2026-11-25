// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IPriceOracle} from "../../src/interfaces/IPriceOracle.sol";

/// @notice USD price table. quote() converts using prices and decimals.
contract MockOracle is IPriceOracle {
    mapping(address token => uint256) public price; // USD per whole token, 1e18-scaled

    function setPrice(address token, uint256 usdPrice) external {
        price[token] = usdPrice;
    }

    function quote(address tokenIn, address tokenOut, uint256 amountIn) public view returns (uint256) {
        uint256 pIn = price[tokenIn];
        uint256 pOut = price[tokenOut];
        if (pIn == 0 || pOut == 0) return 0;
        uint256 dIn = IERC20Metadata(tokenIn).decimals();
        uint256 dOut = IERC20Metadata(tokenOut).decimals();
        return amountIn * pIn * (10 ** dOut) / (pOut * (10 ** dIn));
    }
}
