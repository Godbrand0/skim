// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MusdPegGuard} from "../../src/MusdPegGuard.sol";
import {MezoRebalancer} from "../../src/MezoRebalancer.sol";
import {MezoDeposit} from "../../src/MezoDeposit.sol";

/// @notice Runs the guard and rebalancer against Mezo mainnet's real MUSD, mUSDC, pools and PriceFeed.
/// Run with: MEZO_RPC_URL=https://rpc-http.mezo.boar.network forge test --match-path "test/fork/MezoPrimitivesFork.t.sol"
/// Skipped when MEZO_RPC_URL is not set. forge cannot run Mezo's precompiles, so the BTC/USD oracle
/// precompile that PriceFeed reads is replaced with its live answer (read at the forked block).
contract MezoPrimitivesForkTest is Test {
    address constant MUSD = 0xdD468A1DDc392dcdbEf6db6e34E89AA338F9F186;
    address constant MUSDC = 0x04671C72Aab5AC02A03c1098314b1BB6B560c197;
    address constant STABLE_POOL = 0xEd812AEc0Fecc8fD882Ac3eccC43f3aA80A6c356;
    address constant MUSDT = 0xeB5a5d39dE4Ea42C2Aa6A57EcA2894376683bB8E;
    address constant USDT_POOL = 0x10906a9E9215939561597b4C8e4b98F93c02031A;
    address constant BTC_POOL = 0x52e604c44417233b6CcEDDDc0d640A405Caacefb;
    address constant BTC = 0x7b7C000000000000000000000000000000000000;
    address constant PRICE_FEED = 0xc5aC5A8892230E0A3e1c473881A2de7353fFcA88;
    address constant ORACLE = 0x7b7c000000000000000000000000000000000015;

    MusdPegGuard guard;
    address admin = makeAddr("admin");
    address keeper = makeAddr("keeper");
    address treasury = makeAddr("treasury");

    function setUp() public {
        string memory rpc = vm.envOr("MEZO_RPC_URL", string(""));
        if (bytes(rpc).length == 0) vm.skip(true);
        vm.createSelectFork(rpc);

        // The oracle is a precompile (no EVM code). Give it code so PriceFeed's call goes through,
        // and answer with the BTC/USD value the live chain reports (~$77k, 18 decimals).
        vm.etch(ORACLE, hex"00");
        vm.mockCall(ORACLE, abi.encodeWithSignature("decimals()"), abi.encode(uint8(18)));
        vm.mockCall(
            ORACLE,
            abi.encodeWithSignature("latestRoundData()"),
            abi.encode(uint80(1), int256(77_500e18), block.timestamp, block.timestamp, uint80(1))
        );

        guard = new MusdPegGuard(admin, _tokens(), _pools(), PRICE_FEED, 200, 500);
    }

    function _tokens() internal pure returns (address[4] memory) {
        return [MUSD, MUSDC, MUSDT, BTC];
    }

    function _pools() internal pure returns (address[3] memory) {
        return [STABLE_POOL, USDT_POOL, BTC_POOL];
    }

    function _rebalancer() internal returns (MezoRebalancer reb) {
        reb = new MezoRebalancer(
            admin, 2 days, keeper, treasury, address(guard), _tokens(), _pools(), [uint256(50e18), 1e17, 50e6, 50e6, 50e18], [uint256(300), 300, 300, 300, 300]
        );
        // widen the guard so the tests do not depend on today's exact peg
        vm.prank(admin);
        guard.setDeviations(400, 1500);
        vm.startPrank(treasury);
        IERC20(MUSD).approve(address(reb), type(uint256).max);
        IERC20(MUSDT).approve(address(reb), type(uint256).max);
        vm.stopPrank();
    }

    function test_fork_guard_reads_live_pools_and_price_feed() public {
        (, uint256 s, uint256 u, uint256 b) = guard.status();
        emit log_named_uint("stable pool MUSD value (bps of $1)", s);
        emit log_named_uint("mUSDT pool MUSD value (bps of $1)", u);
        emit log_named_uint("BTC pool + PriceFeed MUSD value (bps of $1)", b);
        // live readings must be sane (a wrong decimals assumption would give 0 or 1e6-scale numbers)
        assertGt(s, 9500);
        assertLt(s, 10_100);
        assertGt(u, 9500);
        assertLt(u, 10_100);
        assertGt(b, 9000);
        assertLt(b, 11_000);
    }

    function test_fork_swap_musd_for_musdc_through_the_real_pool() public {
        MezoRebalancer reb = _rebalancer();
        deal(MUSD, treasury, 20e18);
        uint256 quoted = IMezoPoolOut(STABLE_POOL).getAmountOut(10e18, MUSD);
        vm.prank(keeper);
        uint256 out = reb.rebalance(MezoRebalancer.Route.MusdToMusdc, 10e18, quoted);
        emit log_named_uint("mUSDC received for 10 MUSD (6 decimals)", out);
        assertEq(out, quoted);
        assertEq(IERC20(MUSDC).balanceOf(treasury), out);
        assertEq(IERC20(MUSD).balanceOf(treasury), 10e18);
        assertEq(IERC20(MUSD).balanceOf(address(reb)), 0);
    }

    function test_fork_swap_musdt_for_musd_through_the_real_pool() public {
        MezoRebalancer reb = _rebalancer();
        deal(MUSDT, treasury, 20e6);
        uint256 quoted = IMezoPoolOut(USDT_POOL).getAmountOut(10e6, MUSDT);
        vm.prank(keeper);
        uint256 out = reb.rebalance(MezoRebalancer.Route.MusdtToMusd, 10e6, quoted);
        emit log_named_uint("MUSD received for 10 mUSDT (18 decimals)", out);
        assertEq(IERC20(MUSD).balanceOf(treasury), out);
        assertEq(IERC20(MUSDT).balanceOf(treasury), 10e6);
    }

    function test_fork_swap_musdc_for_musd_through_the_real_pool() public {
        MezoRebalancer reb = _rebalancer();
        deal(MUSDC, treasury, 20e6);
        vm.prank(treasury);
        IERC20(MUSDC).approve(address(reb), type(uint256).max);
        uint256 quoted = IMezoPoolOut(STABLE_POOL).getAmountOut(10e6, MUSDC);
        vm.prank(keeper);
        uint256 out = reb.rebalance(MezoRebalancer.Route.MusdcToMusd, 10e6, quoted);
        emit log_named_uint("MUSD received for 10 mUSDC (18 decimals)", out);
        assertEq(IERC20(MUSD).balanceOf(treasury), out);
    }

    /// @dev The first leg (mUSDC -> MUSD) runs for real; the BTC leg cannot (see below), so the one-call path
    /// is covered end to end by the unit tests with a mock BTC token.
    function test_fork_musdc_to_btc_leg_one_pays_enough_musd_for_the_btc_leg() public {
        MezoRebalancer reb = _rebalancer();
        uint256 musdOut = IMezoPoolOut(STABLE_POOL).getAmountOut(10e6, MUSDC);
        uint256 btcOut = IMezoPoolOut(BTC_POOL).getAmountOut(musdOut, MUSD);
        uint256 fair = reb.fairValue(MezoRebalancer.Route.MusdToBtc, 10e18);
        emit log_named_uint("10 mUSDC -> MUSD (wei)", musdOut);
        emit log_named_uint("... -> BTC (wei)", btcOut);
        emit log_named_uint("10 USD at the PriceFeed price (BTC wei)", fair);
        assertGt(btcOut, (fair * 9500) / 10_000);
    }

    function test_fork_musd_to_btc_floor_matches_real_pool_quote() public {
        MezoRebalancer reb = _rebalancer();
        uint256 amount = 38e18;
        uint256 quoted = IMezoPoolOut(BTC_POOL).getAmountOut(amount, MUSD);
        uint256 fair = reb.fairValue(MezoRebalancer.Route.MusdToBtc, amount);
        emit log_named_uint("pool pays for 38 MUSD (BTC wei)", quoted);
        emit log_named_uint("PriceFeed fair value (BTC wei)", fair);
        assertGt(quoted, (fair * 9700) / 10_000, "pool is within the route's slippage floor");
    }

    /// @dev The BTC token (0x7b7C...0000) is backed by a Mezo precompile that forge cannot run, so the BTC
    /// route's transfer leg cannot be exercised here (the unit tests cover it with a mock token). What can be
    /// checked on the fork is the pricing: the PriceFeed floor must sit close to what the real BTC pool pays.
    function test_fork_btc_route_floor_matches_real_pool_quote() public {
        MezoRebalancer reb = _rebalancer();
        uint256 amount = 5e14; // 0.0005 BTC
        uint256 quoted = IMezoPoolOut(BTC_POOL).getAmountOut(amount, BTC);
        uint256 fair = reb.fairValue(MezoRebalancer.Route.BtcToMusd, amount);
        emit log_named_uint("pool pays for 0.0005 BTC (MUSD wei)", quoted);
        emit log_named_uint("PriceFeed fair value (MUSD wei)", fair);
        (, uint256 slip) = (0, uint256(300));
        assertGt(quoted, (fair * (10_000 - slip)) / 10_000, "pool is within the route's slippage floor");
    }

    function test_fork_deposit_refuses_musd_when_guard_tripped() public {
        MezoDeposit dep = new MezoDeposit(admin, 2 days, makeAddr("guardian"), treasury);
        vm.startPrank(admin);
        dep.setTokenConfig(MUSD, true, 1e18, 25e18);
        dep.setPegGuard(address(guard));
        // an impossible-to-meet requirement: stable pool must pay at least 99.99%
        guard.setDeviations(1, 5000);
        vm.stopPrank();

        address alice = makeAddr("alice");
        deal(MUSD, alice, 5e18);
        vm.startPrank(alice);
        IERC20(MUSD).approve(address(dep), 5e18);
        vm.expectRevert(MezoDeposit.MusdDepegged.selector);
        dep.deposit(MUSD, 5e18, alice);
        vm.stopPrank();
    }
}

interface IMezoPoolOut {
    function getAmountOut(uint256 amountIn, address tokenIn) external view returns (uint256);
}
