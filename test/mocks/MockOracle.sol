// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @dev Stands in for Mezo's BTC/USD oracle precompile on a local fork, where precompiles do not run. Local testing only.
contract MockOracle {
    function decimals() external pure returns (uint8) {
        return 18;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (1, 77_500e18, block.timestamp, block.timestamp, 1);
    }
}
