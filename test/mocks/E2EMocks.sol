// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @dev Local end-to-end test helpers only. Never deployed to mainnet.
contract E2EToken is ERC20 {
    uint8 private immutable _dec;

    constructor(uint8 d) ERC20("mock", "mock") {
        _dec = d;
    }

    function decimals() public view override returns (uint8) {
        return _dec;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @dev Stands in for Mezo's price oracle precompile at 0x7b7c...0015. BTC fixed at $83,000.
contract E2EOracle {
    function decimals() external pure returns (uint8) {
        return 18;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (1, int256(83_000e18), block.timestamp, block.timestamp, 1);
    }
}
