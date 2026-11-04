// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";

interface IMezoPool {
    function getAmountOut(uint256 amountIn, address tokenIn) external view returns (uint256);
    function getReserves() external view returns (uint256 reserve0, uint256 reserve1, uint256 blockTimestampLast);
    function token0() external view returns (address);
    function token1() external view returns (address);
}

/// @dev MUSD protocol PriceFeed (BTC/USD, 18 decimals). Reverts when the oracle is unusable.
interface IMusdPriceFeed {
    function fetchPrice() external view returns (uint256);
}

/// @title MusdPegGuard
/// @notice Read-only depeg detector for MUSD, built from two Mezo primitives:
///         1. the MUSD/mUSDC stable pool: what 1 MUSD actually sells for, in mUSDC;
///         2. the MUSD protocol's PriceFeed against the MUSD/BTC pool: the USD value of MUSD implied
///            by the BTC price the protocol itself uses for collateral.
///         MezoDeposit refuses MUSD deposits, and MezoRebalancer refuses to swap, while this reports
///         unhealthy. Any read that fails counts as unhealthy (fail closed).
/// @dev Spot prices can be pushed around inside one transaction. That can only make the guard
///      trip (pausing MUSD intake), never make a depegged MUSD look healthy, because both venues
///      must agree. Values are in basis points of $1 (10000 = $1.00).
contract MusdPegGuard is Ownable2Step {
    uint256 internal constant BPS = 10_000;
    /// @dev MUSD has 18 decimals, mUSDC has 6, the BTC pool's BTC side has 18.
    uint256 internal constant MUSD_UNIT = 1e18;

    address public immutable musd;
    address public immutable musdc;
    address public immutable musdt;
    IMezoPool public immutable stablePool; // MUSD/mUSDC
    IMezoPool public immutable usdtPool; // MUSD/mUSDT
    IMezoPool public immutable btcPool; // BTC/MUSD
    address public immutable btc;
    IMusdPriceFeed public immutable priceFeed;

    /// @notice MUSD is unhealthy when it sells for less than (10000 - this) bps of $1 in either stable pool (mUSDC, mUSDT).
    uint256 public maxStableDeviationBps;
    /// @notice Same, for the value implied by the BTC pool and the protocol's PriceFeed. Looser,
    ///         because a volatile pool lags the oracle when BTC moves fast.
    uint256 public maxBtcDeviationBps;

    event DeviationsUpdated(uint256 maxStableDeviationBps, uint256 maxBtcDeviationBps);

    error ZeroAddress();
    error InvalidDeviation();
    error PoolMismatch();

    /// @param tokens [MUSD, mUSDC, mUSDT, BTC]
    /// @param pools [MUSD/mUSDC, MUSD/mUSDT, BTC/MUSD]
    constructor(address owner_, address[4] memory tokens, address[3] memory pools, address priceFeed_, uint256 stableDev, uint256 btcDev)
        Ownable(owner_)
    {
        for (uint256 i; i < 4; i++) if (tokens[i] == address(0)) revert ZeroAddress();
        for (uint256 i; i < 3; i++) if (pools[i] == address(0)) revert ZeroAddress();
        if (priceFeed_ == address(0)) revert ZeroAddress();
        (address musd_, address musdc_, address musdt_, address btc_) = (tokens[0], tokens[1], tokens[2], tokens[3]);
        musd = musd_;
        musdc = musdc_;
        musdt = musdt_;
        stablePool = IMezoPool(pools[0]);
        usdtPool = IMezoPool(pools[1]);
        address btcPool_ = pools[2];
        btcPool = IMezoPool(btcPool_);
        btc = btc_;
        priceFeed = IMusdPriceFeed(priceFeed_);
        _checkPair(IMezoPool(pools[0]), musd_, musdc_);
        _checkPair(IMezoPool(pools[1]), musd_, musdt_);
        _checkPair(IMezoPool(btcPool_), btc_, musd_);
        _setDeviations(stableDev, btcDev);
    }

    /// @notice Tune the thresholds. Each must be between 1 and 5000 bps.
    function setDeviations(uint256 stableDev, uint256 btcDev) external onlyOwner {
        _setDeviations(stableDev, btcDev);
    }

    /// @notice True when MUSD is trading close enough to $1 on both venues.
    function isHealthy() external view returns (bool healthy) {
        (healthy,,,) = status();
    }

    /// @notice Current readings. A reading of 0 means the read failed.
    /// @return healthy Both readings are present and at or above their floors.
    /// @return stableBps What 1 MUSD sells for in the mUSDC pool, as bps of $1 (mUSDC treated as $1).
    /// @return usdtBps Same for the mUSDT pool (mUSDT treated as $1).
    /// @return btcBps MUSD's USD value implied by the BTC pool and PriceFeed, as bps of $1.
    function status() public view returns (bool healthy, uint256 stableBps, uint256 usdtBps, uint256 btcBps) {
        stableBps = _stableBps(stablePool);
        usdtBps = _stableBps(usdtPool);
        btcBps = _btcBps();
        uint256 floor = BPS - maxStableDeviationBps;
        healthy = stableBps >= floor && usdtBps >= floor && btcBps != 0 && btcBps >= BPS - maxBtcDeviationBps;
    }

    function _stableBps(IMezoPool pool) private view returns (uint256) {
        try pool.getAmountOut(MUSD_UNIT, musd) returns (uint256 outMicro) {
            return (outMicro * BPS) / 1e6;
        } catch {
            return 0;
        }
    }

    function _btcBps() private view returns (uint256) {
        uint256 btcUsd;
        try priceFeed.fetchPrice() returns (uint256 p) {
            btcUsd = p;
        } catch {
            return 0;
        }
        uint256 r0;
        uint256 r1;
        try btcPool.getReserves() returns (uint256 a, uint256 b, uint256) {
            (r0, r1) = (a, b);
        } catch {
            return 0;
        }
        (uint256 rBtc, uint256 rMusd) = btcPool.token0() == btc ? (r0, r1) : (r1, r0);
        if (rBtc == 0 || rMusd == 0 || btcUsd == 0) return 0;
        // MUSD per BTC (18 decimals) = rMusd * 1e18 / rBtc; USD per MUSD = btcUsd / thatRatio.
        uint256 musdPerBtc = (rMusd * 1e18) / rBtc;
        if (musdPerBtc == 0) return 0;
        return (btcUsd * BPS) / musdPerBtc;
    }

    function _setDeviations(uint256 stableDev, uint256 btcDev) private {
        if (stableDev == 0 || stableDev > 5000 || btcDev == 0 || btcDev > 5000) revert InvalidDeviation();
        maxStableDeviationBps = stableDev;
        maxBtcDeviationBps = btcDev;
        emit DeviationsUpdated(stableDev, btcDev);
    }

    function _checkPair(IMezoPool pool, address a, address b) private view {
        address t0 = pool.token0();
        address t1 = pool.token1();
        if (!((t0 == a && t1 == b) || (t0 == b && t1 == a))) revert PoolMismatch();
    }
}
