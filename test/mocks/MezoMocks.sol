// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract MezoMockToken is ERC20 {
    uint8 private immutable _dec;

    constructor(string memory n, uint8 d) ERC20(n, n) {
        _dec = d;
    }

    function decimals() public view override returns (uint8) {
        return _dec;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @dev Solidly-style pool with a settable price. `rate` is output tokens (1e18 scale) per input token,
/// adjusted for decimals by the caller. Swaps pay out of the pool's own token balance.
contract MockPool {
    address public token0;
    address public token1;
    uint256 public reserve0;
    uint256 public reserve1;
    /// @dev output units per 1e18 input units, for tokenIn == token0 and token1 respectively
    uint256 public outPer1e18In0;
    uint256 public outPer1e18In1;
    bool public revertReads;

    constructor(address t0, address t1) {
        token0 = t0;
        token1 = t1;
    }

    function setReserves(uint256 r0, uint256 r1) external {
        reserve0 = r0;
        reserve1 = r1;
    }

    function setRates(uint256 in0, uint256 in1) external {
        outPer1e18In0 = in0;
        outPer1e18In1 = in1;
    }

    function setRevertReads(bool v) external {
        revertReads = v;
    }

    function getReserves() external view returns (uint256, uint256, uint256) {
        require(!revertReads, "read");
        return (reserve0, reserve1, block.timestamp);
    }

    function getAmountOut(uint256 amountIn, address tokenIn) external view returns (uint256) {
        require(!revertReads, "read");
        uint256 rate = tokenIn == token0 ? outPer1e18In0 : outPer1e18In1;
        return (amountIn * rate) / 1e18;
    }

    function swap(uint256 a0, uint256 a1, address to, bytes calldata) external {
        if (a0 > 0) ERC20(token0).transfer(to, a0);
        if (a1 > 0) ERC20(token1).transfer(to, a1);
    }
}

contract MockPriceFeed {
    uint256 public price;
    bool public broken;

    constructor(uint256 p) {
        price = p;
    }

    function set(uint256 p) external {
        price = p;
    }

    function setBroken(bool b) external {
        broken = b;
    }

    function fetchPrice() external view returns (uint256) {
        require(!broken, "oracle");
        return price;
    }
}
